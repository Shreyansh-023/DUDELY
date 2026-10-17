/**
 * Live speech-to-text relay — the piece that makes words appear as you speak.
 *
 * The browser streams raw PCM here; this process forwards it to Sarvam's
 * realtime WebSocket and pushes partial/final transcripts straight back. It
 * exists as a separate listener because Next.js route handlers cannot hold a
 * WebSocket open (the connection dies with the response), and because
 * SARVAM_API_KEY must never reach the browser.
 *
 *   browser  ──binary PCM16@16k──►  relay  ──{"event":"audio_input"}──►  Sarvam
 *            ◄──{"type":"partial"}──       ◄──{"event":"transcript.partial"}──
 *
 * Run:  node scripts/stt-relay.mjs          (npm run dev starts it for you)
 * Env:  SARVAM_API_KEY              required — without it the relay refuses clients
 *       STT_RELAY_PORT              default 8787
 *       SARVAM_STT_REALTIME_MODEL   default saaras:v3-realtime
 *       SARVAM_STT_REALTIME_STREAM  fast | balanced (default fast — lowest latency partials)
 *       SARVAM_STT_REALTIME_MODE    transcribe | translate | verbatim | translit | codemix
 */

import http from "node:http";
import { WebSocketServer } from "ws";

// The relay is its own process, so Next's .env loading doesn't apply to it.
for (const f of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(f);
  } catch {
    // missing or unreadable — the next one (or the real environment) may have it
  }
}

const PORT = Number(process.env.STT_RELAY_PORT || 8787);
const KEY = process.env.SARVAM_API_KEY;
const MODEL = process.env.SARVAM_STT_REALTIME_MODEL || "saaras:v3-realtime";
const STREAM_TYPE = process.env.SARVAM_STT_REALTIME_STREAM || "fast";
const MODE = process.env.SARVAM_STT_REALTIME_MODE || "transcribe";
const UPSTREAM = "wss://api.sarvam.ai/speech-to-text-realtime/ws";
const PING_MS = 20000; // Sarvam closes idle sockets (1008); keep ours warm

/**
 * App language code → the code Sarvam's realtime endpoint expects.
 * - "en-IN" is our Hinglish setting: `auto` lets Sarvam handle the code-mixing,
 *   exactly as /api/stt passes `unknown` on the batch endpoint.
 * - Odia is `od-IN` in the batch API but `or-IN` in the realtime one.
 */
function sarvamRealtimeLang(code) {
  if (!code || code === "auto" || code === "en-IN") return "auto";
  if (code === "en") return "en-IN";
  if (code === "od-IN") return "or-IN";
  return code;
}

const server = http.createServer((req, res) => {
  if (req.url?.startsWith("/health")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, configured: Boolean(KEY), model: MODEL }));
    return;
  }
  res.writeHead(426, { "content-type": "text/plain" });
  res.end("This endpoint speaks WebSocket only.");
});

const wss = new WebSocketServer({ server, path: "/stt" });

wss.on("connection", (client, req) => {
  const send = (obj) => {
    if (client.readyState === client.OPEN) client.send(JSON.stringify(obj));
  };

  if (!KEY) {
    send({ type: "error", message: "SARVAM_API_KEY is not set on the server" });
    client.close();
    return;
  }

  const language = sarvamRealtimeLang(new URL(req.url, "http://relay").searchParams.get("language"));
  const qs = new URLSearchParams({
    language_code: language,
    model: MODEL,
    stream_type: STREAM_TYPE,
    mode: MODE,
    encoding: "linear16",
    sample_rate: "16000",
    endpointing: "vad",
  });

  // Node 22 ships a standards WebSocket client. Sarvam documents subprotocol
  // auth for browsers; it works the same here and avoids custom-header support.
  const up = new WebSocket(`${UPSTREAM}?${qs}`, [`api-subscription-key.${KEY}`]);

  /** Audio that arrived before the upstream handshake finished. */
  let pending = [];
  let ready = false;
  let closed = false;
  let endRequested = false;
  const ping = setInterval(() => {
    if (ready && up.readyState === WebSocket.OPEN) up.send(JSON.stringify({ event: "ping" }));
  }, PING_MS);

  const shutdown = (reason) => {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    try {
      up.close();
    } catch {}
    if (reason) send({ type: "error", message: reason });
    send({ type: "done" });
    try {
      client.close();
    } catch {}
  };

  up.addEventListener("open", () => {
    ready = true;
    for (const chunk of pending) up.send(chunk);
    pending = [];
    send({ type: "ready" });
    if (endRequested) up.send(JSON.stringify({ event: "end" }));
  });

  up.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8"));
    } catch {
      return;
    }
    switch (msg.event) {
      case "transcript.partial":
        if (msg.text) send({ type: "partial", text: msg.text });
        break;
      case "transcript.final":
        if (msg.text) send({ type: "final", text: msg.text });
        break;
      case "session.end":
        shutdown();
        break;
      case "error":
        send({ type: "error", message: msg.message || msg.code || "Sarvam error" });
        if (msg.is_fatal) shutdown();
        break;
      default:
        break; // session.begin, vad.*, config.updated, pong — nothing for the client
    }
  });

  up.addEventListener("error", () => {
    if (!closed) shutdown("Could not reach Sarvam realtime STT");
  });

  up.addEventListener("close", (ev) => {
    // 1003 = bad/exhausted key, 4000 = rejected parameters. Say so rather than
    // letting the browser show an empty transcript with no explanation.
    const why =
      ev.code === 1003
        ? "Sarvam rejected the key, or the quota is exhausted"
        : ev.code === 4000
          ? `Sarvam rejected the stream settings: ${ev.reason || "invalid parameter"}`
          : null;
    shutdown(why);
  });

  client.on("message", (data, isBinary) => {
    if (isBinary) {
      const audio = JSON.stringify({ event: "audio_input", audio: data.toString("base64") });
      if (ready && up.readyState === WebSocket.OPEN) up.send(audio);
      // Cap the pre-handshake buffer at ~5s of audio so a dead upstream can't grow it forever.
      else if (pending.length < 50) pending.push(audio);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type === "end") {
      endRequested = true;
      if (ready && up.readyState === WebSocket.OPEN) up.send(JSON.stringify({ event: "end" }));
    }
  });

  client.on("close", () => shutdown());
  client.on("error", () => shutdown());
});

server.listen(PORT, () => {
  const state = KEY ? `Sarvam ${MODEL} (${STREAM_TYPE})` : "NO SARVAM_API_KEY — clients will be refused";
  console.log(`[stt-relay] ws://localhost:${PORT}/stt → ${state}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    server.close();
    process.exit(0);
  });
}
