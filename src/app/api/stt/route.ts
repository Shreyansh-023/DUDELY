import { toSarvamLang, toWhisperLang } from "@/lib/languages";

export const maxDuration = 30;

/**
 * POST /api/stt  (multipart: file, language)
 * Sarvam Saaras v4 when SARVAM_API_KEY is set (22 Indic languages, Hinglish
 * code-mixing, auto-detect), else Groq Whisper, else 501 so the browser uses
 * the Web Speech API.
 */
export async function POST(req: Request) {
  const fd = await req.formData();
  const file = fd.get("file");
  const language = String(fd.get("language") ?? "unknown");
  if (!(file instanceof Blob) || file.size === 0) {
    return Response.json({ error: "No audio" }, { status: 400 });
  }

  // MediaRecorder tags blobs as "audio/webm;codecs=opus". Sarvam (and some others)
  // exact-match the content type against an allow-list that has "audio/webm" but not
  // the "...;codecs=opus" variant, so strip the codec parameter before forwarding.
  const EXT: Record<string, string> = {
    "audio/webm": "webm",
    "video/webm": "webm",
    "audio/ogg": "ogg",
    "audio/mp4": "m4a",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
  };
  const cleanType = (file.type || "audio/webm").split(";")[0].trim().toLowerCase();
  const ext = EXT[cleanType] ?? "webm";
  const audio = new Blob([await file.arrayBuffer()], { type: cleanType });
  const filename = `speech.${ext}`;

  const sarvam = process.env.SARVAM_API_KEY;
  if (sarvam) {
    const out = new FormData();
    out.append("file", audio, filename);
    out.append("model", process.env.SARVAM_STT_MODEL || "saaras:v4");
    // Hinglish speakers pick "Hinglish" (en-IN); let Sarvam auto-detect the code-mixing
    // there. "English only" (en) forces the English model via toSarvamLang → en-IN.
    out.append("language_code", language === "en-IN" || language === "auto" ? "unknown" : toSarvamLang(language));
    const r = await fetch("https://api.sarvam.ai/speech-to-text", {
      method: "POST",
      headers: { "api-subscription-key": sarvam },
      body: out,
    });
    if (!r.ok) return new Response(`Sarvam STT error ${r.status}: ${await r.text()}`, { status: 502 });
    const data = (await r.json()) as { transcript?: string; language_code?: string | null };
    return Response.json({ transcript: data.transcript ?? "", language: data.language_code ?? null, provider: "sarvam" });
  }

  const groq = process.env.GROQ_API_KEY;
  if (groq) {
    const out = new FormData();
    out.append("file", audio, filename);
    out.append("model", "whisper-large-v3-turbo");
    const iso = toWhisperLang(language);
    if (iso) out.append("language", iso);
    out.append("response_format", "json");
    const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { authorization: `Bearer ${groq}` },
      body: out,
    });
    if (!r.ok) return new Response(`Groq STT error ${r.status}: ${await r.text()}`, { status: 502 });
    const data = (await r.json()) as { text?: string };
    return Response.json({ transcript: data.text ?? "", language: null, provider: "groq" });
  }

  return Response.json({ error: "No server STT configured" }, { status: 501 });
}
