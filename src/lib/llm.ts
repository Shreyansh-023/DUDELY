import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

/**
 * Picks the reasoning model from environment variables.
 *
 *   LLM_PROVIDER = nvidia | google | groq | openai | anthropic | ollama | mock
 *                  (auto-detected from API keys if unset; ollama is never auto-detected)
 *   LLM_MODEL    = provider-specific model id            (sensible default per provider)
 *   OLLAMA_BASE_URL = where Ollama runs (default http://localhost:11434)
 *
 * Gemini Flash is the default for Bharat: strong Indic language coverage, image
 * input for the student's drawings, native structured output, low latency.
 * `ollama` runs a free open model on this machine's GPU: no API key, no quota,
 * and student conversations never leave the computer.
 */
export type Provider = "nvidia" | "google" | "groq" | "openai" | "anthropic" | "ollama" | "mock";

const DEFAULT_MODELS: Record<Provider, string> = {
  nvidia: "moonshotai/kimi-k3",
  google: "gemini-3.5-flash",
  groq: "openai/gpt-oss-120b",
  openai: "gpt-4.1-mini",
  anthropic: "claude-sonnet-5-5",
  // gemma4:e4b with a 16k context; create it with `ollama create dudely-gemma4 -f ollama/gemma4.Modelfile`
  ollama: "dudely-gemma4",
  mock: "canned-lesson",
};

/** NVIDIA's OpenAI-compatible inference endpoint (integrate.api.nvidia.com). */
const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";

/** Ollama serves an OpenAI-compatible chat-completions API under /v1. */
export const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";

export function detectProvider(): Provider | null {
  const forced = process.env.LLM_PROVIDER?.toLowerCase();
  if (
    forced === "nvidia" ||
    forced === "google" ||
    forced === "groq" ||
    forced === "openai" ||
    forced === "anthropic" ||
    forced === "ollama" ||
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
      "No LLM configured. Set NVIDIA_API_KEY (recommended), GOOGLE_GENERATIVE_AI_API_KEY, GROQ_API_KEY, OPENAI_API_KEY or ANTHROPIC_API_KEY in .env.local, or LLM_PROVIDER=ollama for a free local model",
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
    case "ollama":
      // Same chat-completions path as NVIDIA. Ollama ignores the key, but the SDK requires one.
      return {
        model: createOpenAI({ baseURL: `${OLLAMA_BASE_URL}/v1`, apiKey: "ollama", name: "ollama" }).chat(id),
        label,
      };
  }
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
