"use client";

/**
 * Live (streaming) speech-to-text — the "words appear as you speak" path.
 *
 * ChatGPT, Claude and friends don't wait for you to stop talking: they hold a
 * socket open, push raw PCM up every ~100ms and paint the partial hypotheses the
 * recogniser sends back, replacing them as it revises. This is that, for Sarvam's
 * realtime endpoint (`transcript.partial` / `transcript.final`).
 *
 * The browser never sees SARVAM_API_KEY — it talks to the small relay in
 * `scripts/stt-relay.mjs`, which holds the key and speaks Sarvam's protocol.
 * (Next.js route handlers can't host a WebSocket: the connection is closed as
 * soon as the handler returns, so a separate listener is unavoidable.)
 *
 * Wire protocol with the relay — deliberately tiny:
 *   client → relay   binary frames  raw Int16LE PCM, 16 kHz, mono
 *                    {"type":"end"} stop sending audio, flush the recogniser
 *   relay → client   {"type":"ready"}
 *                    {"type":"partial","text":…}   unstable, replaces the last partial
 *                    {"type":"final","text":…}     committed, appended
 *                    {"type":"done"} | {"type":"error","message":…}
 *
 * The transcriber is a *tap*: it never owns the MediaStream, so the existing
 * Recorder/VAD pipeline keeps working untouched and the recorded blob is still
 * available as a fallback if streaming yields nothing.
 */

import { getAudioContext } from "./lipsync";

const TARGET_RATE = 16000;
/** ~10s of queued 100ms chunks, for audio spoken while the socket connects. */
const QUEUE_MAX = 100;
/** Worklet module is fetched once per AudioContext. */
let workletReady: Promise<void> | null = null;
/**
 * Remembered across utterances: if the relay isn't running there's no point
 * re-dialling it (and eating a connect timeout) on every turn. Forgotten after
 * a minute so a relay started mid-session is picked up without a reload.
 */
let relayDownUntil = 0;
const RELAY_RETRY_MS = 60000;

export type LiveSttEvents = {
  /** Cumulative transcript so far (committed finals + the live partial). */
  onText?: (text: string) => void;
  onError?: (err: Error) => void;
};

/** Where the relay lives, given what /api/config reported. */
export function relayUrl(cfg: { sttRelayUrl: string | null; sttRelayPort: number } | null): string | null {
  if (!cfg) return null;
  if (cfg.sttRelayUrl) return cfg.sttRelayUrl;
  if (typeof window === "undefined") return null;
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.hostname}:${cfg.sttRelayPort}/stt`;
}

/** Has a recent attempt proved the relay unreachable? */
export function liveSttUnavailable(): boolean {
  return Date.now() < relayDownUntil;
}

function join(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return /\s$/.test(a) ? a + b : `${a} ${b}`;
}

async function ensureWorklet(ctx: AudioContext): Promise<void> {
  if (!workletReady) {
    workletReady = ctx.audioWorklet.addModule("/pcm-worklet.js").catch((e) => {
      workletReady = null; // let a later attempt retry
      throw e;
    });
  }
  return workletReady;
}

/**
 * Fetch and register the resampler worklet ahead of time. Called once the app
 * knows live transcription is on offer, so the first mic press doesn't pay for
 * a module fetch while the student is already talking. Failures are ignored —
 * attachTap falls back to a ScriptProcessor.
 */
export function prewarmLiveStt(): void {
  const ctx = getAudioContext();
  if (ctx) void ensureWorklet(ctx).catch(() => {});
}

export class LiveTranscriber {
  private ws: WebSocket | null = null;
  private node: AudioWorkletNode | ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private sink: GainNode | null = null;
  private finals = "";
  private partial = "";
  private settled = false;
  private ready = false;
  private queue: ArrayBuffer[] = [];
  private endResolve: ((text: string) => void) | null = null;
  private endTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private url: string,
    private language: string,
    private events: LiveSttEvents = {},
  ) {}

  /** Everything heard so far: committed text plus the unstable tail. */
  get text(): string {
    return join(this.finals, this.partial).trim();
  }

  /**
   * Open the socket and start streaming `stream`'s audio.
   * Resolves once the relay says it's connected; rejects if it isn't there —
   * callers treat a rejection as "no live text this turn", nothing more.
   *
   * The microphone tap is built *before* the socket finishes negotiating, and
   * audio recorded in the meantime is queued and flushed on connect. Without
   * that, the second or two spent dialling the relay silently eats the start
   * of the sentence — and since the streamed transcript is the one we send to
   * the tutor, the question would arrive beheaded.
   */
  async start(stream: MediaStream, signal?: AbortSignal): Promise<void> {
    const ctx = getAudioContext();
    if (!ctx) throw new Error("Web Audio unavailable");
    if (ctx.state === "suspended") await ctx.resume().catch(() => {});

    const ws = new WebSocket(`${this.url}?language=${encodeURIComponent(this.language)}`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    const tap = this.attachTap(ctx, stream);

    await new Promise<void>((resolve, reject) => {
      const CONNECT_TIMEOUT_MS = 4000;
      const timer = setTimeout(() => {
        relayDownUntil = Date.now() + RELAY_RETRY_MS;
        try {
          ws.close();
        } catch {}
        reject(new Error("Live transcription relay did not respond"));
      }, CONNECT_TIMEOUT_MS);
      const fail = (msg: string) => {
        clearTimeout(timer);
        reject(new Error(msg));
      };
      ws.onerror = () => {
        relayDownUntil = Date.now() + RELAY_RETRY_MS;
        fail("Could not reach the live transcription relay");
      };
      ws.onclose = () => {
        // Closed before "ready" — either the relay is absent or it rejected us.
        this.finishNow();
        fail("Live transcription closed before it was ready");
      };
      ws.onmessage = (ev) => {
        const msg = parse(ev.data);
        if (!msg) return;
        if (msg.type === "ready") {
          clearTimeout(timer);
          relayDownUntil = 0;
          ws.onclose = () => this.finishNow();
          ws.onerror = null;
          this.ready = true;
          for (const chunk of this.queue) ws.send(chunk);
          this.queue = [];
          resolve();
        } else if (msg.type === "error") {
          clearTimeout(timer);
          this.events.onError?.(new Error(msg.message ?? "Live transcription error"));
          reject(new Error(msg.message ?? "Live transcription error"));
        }
      };
      signal?.addEventListener("abort", () => fail("aborted"), { once: true });
    });

    // Past "ready": from here on messages are transcript updates.
    ws.onmessage = (ev) => {
      const msg = parse(ev.data);
      if (!msg) return;
      if (msg.type === "partial") {
        this.partial = msg.text ?? "";
        this.events.onText?.(this.text);
      } else if (msg.type === "final") {
        this.finals = join(this.finals, msg.text ?? "");
        this.partial = "";
        this.events.onText?.(this.text);
      } else if (msg.type === "done") {
        this.finishNow();
      } else if (msg.type === "error") {
        this.events.onError?.(new Error(msg.message ?? "Live transcription error"));
      }
    };

    await tap;
  }

  /** Build mic → resampler → (silent sink) and pump PCM into the socket. */
  private async attachTap(ctx: AudioContext, stream: MediaStream): Promise<void> {
    this.source = ctx.createMediaStreamSource(stream);
    // A node is only pulled by the graph if it reaches the destination, so the
    // tap ends in a muted gain — the mic is never audible through the speakers.
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    this.sink.connect(ctx.destination);

    const send = (buf: ArrayBuffer) => {
      if (this.ready && this.ws?.readyState === WebSocket.OPEN) this.ws.send(buf);
      // Still connecting: hold the audio back rather than dropping it. Capped at
      // QUEUE_MAX so a relay that never answers can't grow the buffer forever.
      else if (!this.settled && this.queue.length < QUEUE_MAX) this.queue.push(buf);
    };

    try {
      await ensureWorklet(ctx);
      const node = new AudioWorkletNode(ctx, "pcm-downsampler", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { targetRate: TARGET_RATE },
      });
      node.port.onmessage = (e) => send(e.data as ArrayBuffer);
      this.source.connect(node);
      node.connect(this.sink);
      this.node = node;
      return;
    } catch {
      // AudioWorklet unavailable (older Safari, or the module failed to load).
    }

    // ScriptProcessor fallback: deprecated but universally present.
    const SIZE = 4096;
    const sp = ctx.createScriptProcessor(SIZE, 1, 1);
    const ratio = ctx.sampleRate / TARGET_RATE;
    let carry = new Float32Array(0);
    let pos = 0;
    sp.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      const buf = new Float32Array(carry.length + input.length);
      buf.set(carry, 0);
      buf.set(input, carry.length);
      const out = new Int16Array(Math.ceil((buf.length - pos) / ratio));
      let n = 0;
      let p = pos;
      while (p + 1 < buf.length) {
        const i = p | 0;
        const f = p - i;
        const s = Math.max(-1, Math.min(1, buf[i] * (1 - f) + buf[i + 1] * f));
        out[n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        p += ratio;
      }
      const consumed = p | 0;
      carry = buf.slice(consumed);
      pos = p - consumed;
      if (n) send(out.buffer.slice(0, n * 2));
    };
    this.source.connect(sp);
    sp.connect(this.sink);
    this.node = sp;
  }

  /**
   * Stop sending audio and wait (briefly) for the recogniser to commit its last
   * words. Resolves with the full transcript — "" if nothing was heard.
   */
  finish(timeoutMs = 2000): Promise<string> {
    this.detach();
    const ws = this.ws;
    if (this.settled || ws?.readyState !== WebSocket.OPEN) return Promise.resolve(this.text);
    // Always let the recogniser close the utterance itself: audio it has buffered
    // but not yet scored would otherwise be lost. It answers within a few hundred
    // ms in practice, so the timeout is a backstop, not the normal path.
    return new Promise<string>((resolve) => {
      this.endResolve = resolve;
      this.endTimer = setTimeout(() => this.finishNow(), timeoutMs);
      try {
        ws.send(JSON.stringify({ type: "end" }));
      } catch {
        this.finishNow();
      }
    });
  }

  /** Drop everything without waiting. Safe at any time, idempotent. */
  abort(): void {
    this.detach();
    this.finishNow();
  }

  private detach(): void {
    // Deliberately no flush of the worklet's sub-chunk tail: that would arrive
    // after the "end" frame below and be audio the recogniser has already
    // closed the book on. It is at most 100ms, and VAD only ends a turn after
    // far more silence than that.
    try {
      this.source?.disconnect();
    } catch {}
    try {
      this.node?.disconnect();
      if ("port" in (this.node ?? {})) (this.node as AudioWorkletNode).port.postMessage("stop");
      else if (this.node) (this.node as ScriptProcessorNode).onaudioprocess = null;
    } catch {}
    try {
      this.sink?.disconnect();
    } catch {}
    this.source = null;
    this.node = null;
    this.sink = null;
  }

  private finishNow(): void {
    if (this.settled) return;
    this.settled = true;
    this.ready = false;
    this.queue = [];
    if (this.endTimer) clearTimeout(this.endTimer);
    this.endTimer = null;
    const resolve = this.endResolve;
    this.endResolve = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      try {
        ws.close();
      } catch {}
    }
    resolve?.(this.text);
  }
}

type RelayMessage = { type: string; text?: string; message?: string };

function parse(data: unknown): RelayMessage | null {
  if (typeof data !== "string") return null;
  try {
    return JSON.parse(data) as RelayMessage;
  } catch {
    return null;
  }
}
