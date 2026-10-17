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
 *   - PLANNER/TEACHER: NVIDIA lesson model. Prefer LESSON_MODEL, else the user's
 *     LLM_MODEL when on NVIDIA, else Nemotron Super (Ultra is often capacity-
 *     constrained / "Service temporarily overloaded").
 *   - DOUBT: Groq gpt-oss-120b — fastest + most consistent in our benchmarks — so
 *     a student's interruption is answered quickly. Override with DOUBT_MODEL.
 * Each falls back to the default provider/model when its preferred key is missing.
 */
const LESSON_MODEL =
  process.env.LESSON_MODEL ||
  process.env.LLM_MODEL ||
  "nvidia/nemotron-3-super-120b-a12b";
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
 * The planner/teacher model on NVIDIA. Falls back to the default model when
 * there is no NVIDIA key. `mode` only labels the returned model for the meta event.
 */
export function getLessonModel(): { model: LanguageModel; label: string } {
  if (process.env.NVIDIA_API_KEY) {
    const id = LESSON_MODEL.replace(/^nvidia\//, "");
    return {
      model: createOpenAI({
        baseURL: NVIDIA_BASE_URL,
        apiKey: process.env.NVIDIA_API_KEY,
        name: "nvidia",
      }).chat(id),
      label: `nvidia/${id}`,
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

/** True when the provider is at capacity / rate-limited — worth trying another model. */
export function isOverloadedError(msg: string | null | undefined): boolean {
  if (!msg) return false;
  const m = msg.toLowerCase();
  return (
    m.includes("overloaded") ||
    m.includes("capacity") ||
    m.includes("too many requests") ||
    m.includes("rate limit") ||
    m.includes("529") ||
    m.includes("503")
  );
}

/**
 * Alternate models to try when the primary lesson/plan model is overloaded.
 * Prefers Groq (fast, you already use it for doubts), then Google, then the
 * generic default — skipping anything already tried.
 */
export function getLessonFallbacks(primaryLabel: string): { model: LanguageModel; label: string }[] {
  const out: { model: LanguageModel; label: string }[] = [];
  const seen = new Set([primaryLabel]);
  const push = (m: { model: LanguageModel; label: string }) => {
    if (seen.has(m.label)) return;
    seen.add(m.label);
    out.push(m);
  };
  try {
    if (process.env.GROQ_API_KEY) push(getDoubtModel());
  } catch {
    /* ignore */
  }
  try {
    if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
      const id = process.env.GOOGLE_LESSON_MODEL || "gemini-3.5-flash";
      push({
        model: createGoogle({ apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY })(id),
        label: `google/${id}`,
      });
    }
  } catch {
    /* ignore */
  }
  try {
    push(getModel());
  } catch {
    /* ignore */
  }
  return out;
}

/** Which speech services are configured. Read by the browser via /api/config. */
export function describeVoice() {
  const stt: "sarvam" | "groq" | "browser" = process.env.SARVAM_API_KEY
    ? "sarvam"
    : process.env.GROQ_API_KEY
      ? "groq"
      : "browser";
  const tts: "sarvam" | "browser" = process.env.SARVAM_API_KEY ? "sarvam" : "browser";
  return { stt, tts };
}
