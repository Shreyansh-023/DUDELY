import { isSupportedLanguage, sarvamVoice, toSarvamLang } from "@/lib/languages";

export const maxDuration = 30;

/**
 * POST /api/tts  { text, lang }
 * Sarvam TTS, returns MP3. The model + voice are chosen per language by
 * sarvamVoice(): Bulbul v4 Flash (~1/3 v3's cost, adds pitch/loudness) where a
 * voice exists, falling back to v3 for Tamil/Malayalam/Odia/Punjabi which v4
 * doesn't cover yet. SARVAM_TTS_MODEL / SARVAM_TTS_SPEAKER force one value for
 * all languages. 204 when no key is set so the browser uses speechSynthesis.
 */
export async function POST(req: Request) {
  const key = process.env.SARVAM_API_KEY;
  if (!key) return new Response(null, { status: 204 });

  const { text, lang } = (await req.json()) as { text?: string; lang?: string };
  const clean = (text ?? "").trim();
  if (!clean) return new Response(null, { status: 204 });

  const language_code = lang && isSupportedLanguage(lang) ? toSarvamLang(lang) : "hi-IN";

  // Per-language model + voice. Env vars force a single value across all languages.
  const voice = sarvamVoice(lang ?? "");
  const model = process.env.SARVAM_TTS_MODEL || voice.model;
  const speaker = process.env.SARVAM_TTS_SPEAKER || voice.speaker;

  const body: Record<string, unknown> = {
    text: clean.slice(0, 2400),
    language_code,
    speaker,
    model,
    pace: Number(process.env.SARVAM_TTS_PACE || 1.0),
    output_audio_codec: "mp3",
    speech_sample_rate: 22050,
  };
  // pitch (-0.5..0.5) and loudness (0.1..2.5) exist only on v4; v3 rejects them.
  if (model.startsWith("bulbul:v4")) {
    body.pitch = Number(process.env.SARVAM_TTS_PITCH || 0.0);
    body.loudness = Number(process.env.SARVAM_TTS_LOUDNESS || 1.0);
  }

  const r = await fetch("https://api.sarvam.ai/text-to-speech", {
    method: "POST",
    headers: { "api-subscription-key": key, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) return new Response(`Sarvam TTS error ${r.status}: ${await r.text()}`, { status: 502 });
  const data = (await r.json()) as { audios?: string[] };
  const b64 = data.audios?.[0];
  if (!b64) return new Response("Sarvam TTS returned no audio", { status: 502 });
  const bytes = Buffer.from(b64, "base64");
  return new Response(bytes, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
}
