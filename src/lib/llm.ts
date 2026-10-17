import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

/**
 * Picks the reasoning model from environment variables.
 *
 *   LLM_PROVIDER = google | groq | openai | anthropic   (auto-detected from keys if unset)
 *   LLM_MODEL    = provider-specific model id            (sensible default per provider)
 *
 * Gemini Flash is the default for Bharat: strong Indic language coverage, image
 * input for the student's drawings, native structured output, low latency.
 */
export type Provider = "nvidia" | "google" | "groq" | "openai" | "anthropic" | "mock";

const DEFAULT_MODELS: Record<Provider, string> = {
  nvidia: "moonshotai/kimi-k3",
  google: "gemini-3.5-flash",
  groq: "openai/gpt-oss-120b",
  openai: "gpt-4.1-mini",
  anthropic: "claude-sonnet-5-5",
  mock: "canned-lesson",
};

/** NVIDIA's OpenAI-compatible inference endpoint (integrate.api.nvidia.com). */
const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";

/**
 * Per-role models for the staged lesson flow (see schema `TutorMode`):
 *   - PLANNER/TEACHER: Nemotron Ultra 550B on NVIDIA. It designs the lesson once
 *     (slow is fine) and teaches each step. Override with LESSON_MODEL.
 *   - DOUBT: Groq gpt-oss-120b — fastest + most consistent in our benchmarks — so
 *     a student's interruption is answered quickly. Override with DOUBT_MODEL.
 * Each falls back to the default provider/model when its preferred key is missing.
 */
const LESSON_MODEL = process.env.LESSON_MODEL || "nvidia/nemotron-3-ultra-550b-a55b";
const DOUBT_MODEL = process.env.DOUBT_MODEL || "openai/gpt-oss-120b";

export function detectProvider(): Provider | null {
  const forced = process.env.LLM_PROVIDER?.toLowerCase();
  if (
    forced === "nvidia" ||
    forced === "google" ||
    forced === "groq" ||
    forced === "openai" ||
    forced === "anthropic" ||
    forced === "mock"
  ) {
    return forced;
  }
  // NVIDIA first: it hosts Kimi and other frontier models and is the default here.
  if (process.env.NVIDIA_API_KEY) return "nvidia";
  if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) return "google";
  if (process.env.GROQ_API_KEY) return "groq";
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  return null;
}

export function describeModel(): string | null {
  const provider = detectProvider();
  if (!provider) return null;
  return `${provider}/${process.env.LLM_MODEL || DEFAULT_MODELS[provider]}`;
}

export function getModel(): { model: LanguageModel; label: string } {
  const provider = detectProvider();
  if (!provider) {
    throw new Error(
      "No LLM configured. Set NVIDIA_API_KEY (recommended), GOOGLE_GENERATIVE_AI_API_KEY, GROQ_API_KEY, OPENAI_API_KEY or ANTHROPIC_API_KEY in .env.local",
    );
  }
  const id = process.env.LLM_MODEL || DEFAULT_MODELS[provider];
  const label = `${provider}/${id}`;

  switch (provider) {
    case "mock":
      throw new Error("mock provider has no model; the tutor route serves a canned lesson instead");
    case "nvidia":
      // OpenAI-compatible chat-completions API; force .chat() since NVIDIA has no /responses endpoint.
      return {
        model: createOpenAI({
          baseURL: NVIDIA_BASE_URL,
          apiKey: process.env.NVIDIA_API_KEY,
          name: "nvidia",
        }).chat(id),
        label,
      };
    case "google":
      return { model: createGoogle({ apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY })(id), label };
    case "groq":
      return { model: createGroq({ apiKey: process.env.GROQ_API_KEY })(id), label };
    case "openai":
      return { model: createOpenAI({ apiKey: process.env.OPENAI_API_KEY })(id), label };
    case "anthropic":
      return { model: createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })(id), label };
  }
}

/**
 * The planner/teacher model: Nemotron Ultra on NVIDIA. Falls back to the default
 * model when there is no NVIDIA key, so the staged flow still runs on whatever is
 * configured. `mode` only labels the returned model for the meta event.
 */
export function getLessonModel(): { model: LanguageModel; label: string } {
  if (process.env.NVIDIA_API_KEY) {
    return {
      model: createOpenAI({
        baseURL: NVIDIA_BASE_URL,
        apiKey: process.env.NVIDIA_API_KEY,
        name: "nvidia",
      }).chat(LESSON_MODEL),
      label: `nvidia/${LESSON_MODEL}`.replace("nvidia/nvidia/", "nvidia/"),
    };
  }
  return getModel();
}

/**
 * The doubt model: Groq gpt-oss-120b (fast). Falls back to NVIDIA, then to the
 * default, so an interruption is always answerable even without a Groq key.
 */
export function getDoubtModel(): { model: LanguageModel; label: string } {
  if (process.env.GROQ_API_KEY) {
    return { model: createGroq({ apiKey: process.env.GROQ_API_KEY })(DOUBT_MODEL), label: `groq/${DOUBT_MODEL}` };
  }
  return getModel();
}

/** Which speech services are configured. Read by the browser via /api/config. */
export function describeVoice() {
  const stt: "sarvam" | "groq" | "browser" = process.env.SARVAM_API_KEY
    ? "sarvam"
    : process.env.GROQ_API_KEY
      ? "groq"
      : "browser";
  const tts: "sarvam" | "browser" = process.env.SARVAM_API_KEY ? "sarvam" : "browser";
  // Live ("words appear as you speak") transcription. The browser path gets it
  // free from the Web Speech API; the Sarvam path needs the relay in
  // scripts/stt-relay.mjs, since a Next route handler can't hold a socket open.
  // We can't probe whether that process is actually up from here — the client
  // tries the socket once and quietly falls back to batch STT if it isn't.
  const liveStt: "sarvam" | "browser" | null =
    stt === "sarvam" && process.env.STT_LIVE !== "off" ? "sarvam" : stt === "browser" ? "browser" : null;
  return {
    stt,
    tts,
    liveStt,
    // Set STT_RELAY_URL when the relay runs somewhere other than this host
    // (a separate container, say); otherwise the browser derives it from the
    // page's own hostname so phones on the LAN reach it too.
    sttRelayUrl: process.env.STT_RELAY_URL || null,
    sttRelayPort: Number(process.env.STT_RELAY_PORT || 8787),
  };
}
