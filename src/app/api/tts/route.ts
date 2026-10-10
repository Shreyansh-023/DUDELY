import { isSupportedLanguage, toSarvamLang } from "@/lib/languages";

export const maxDuration = 30;

/**
 * POST /api/tts  { text, lang }
 * Sarvam Bulbul v3 (natural Indic voices, handles Hinglish). Returns MP3.
 * 204 when no key is configured so the browser falls back to speechSynthesis.
 */
export async function POST(req: Request) {
  const key = process.env.SARVAM_API_KEY;
  if (!key) return new Response(null, { status: 204 });

  const { text, lang } = (await req.json()) as { text?: string; lang?: string };
  const clean = (text ?? "").trim();
  if (!clean) return new Response(null, { status: 204 });

  const language_code = lang && isSupportedLanguage(lang) ? toSarvamLang(lang) : "hi-IN";
  const r = await fetch("https://api.sarvam.ai/text-to-speech", {
    method: "POST",
    headers: { "api-subscription-key": key, "content-type": "application/json" },
    body: JSON.stringify({
      text: clean.slice(0, 2400),
      language_code,
      speaker: process.env.SARVAM_TTS_SPEAKER || "priya",
      model: process.env.SARVAM_TTS_MODEL || "bulbul:v3",
      pace: Number(process.env.SARVAM_TTS_PACE || 1.0),
      output_audio_codec: "mp3",
      speech_sample_rate: 22050,
    }),
  });
  if (!r.ok) return new Response(`Sarvam TTS error ${r.status}: ${await r.text()}`, { status: 502 });
  const data = (await r.json()) as { audios?: string[] };
  const b64 = data.audios?.[0];
  if (!b64) return new Response("Sarvam TTS returned no audio", { status: 502 });
  const bytes = Buffer.from(b64, "base64");
  return new Response(bytes, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
}
