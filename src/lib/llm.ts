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
 * Hard context window of the doubt model, as the endpoint reports it
 * ("This model's maximum context length is 1000000 tokens"). We keep the request
 * well under it — see `fitDoubtContext`.
 */
export const DOUBT_CONTEXT_TOKENS = 1_000_000;

/**
 * Per-role NVIDIA Nemotron tiers for the staged lesson flow (see `TutorMode`).
 *
 * Three Nemotron sizes form the primary chain, biggest first:
 *   - PLAN_MODEL ("550"): the deepest-reasoning Ultra tier, used ONLY for plan
 *     mode where thinking budget is worth it. Env-overridable (PLAN_MODEL).
 *   - LESSON_MODEL ("120"): Nemotron 3.5 Super VL. Primary for teach/explain
 *     and doubt; fallback for plan.
 *   - DOUBT_MODEL ("30"): Nemotron 3.5 Lightning, small fast MoE. Primary for
 *     doubt was 30B; now the 120 opens doubt and the 30 is its fast fallback.
 *   - OTHER_NVIDIA_MODEL: a final NVIDIA-hosted model (e.g. Kimi K3) tried
 *     after the three Nemotrons, before leaving the NVIDIA endpoint entirely.
 *     Env-overridable (OTHER_NVIDIA_MODEL).
 *
 * The three-model NVIDIA chain is the design: biggest model that is likely to
 * think best, falling back to progressively smaller / faster ones when the
 * previous one is overloaded or silent. Groq/Google remain as a last-resort
 * off-provider fallback (getLessonFallbacks below).
 */
const PLAN_MODEL = process.env.PLAN_MODEL || "nvidia/nemotron-3-ultra-550b-a55b";
const LESSON_MODEL =
  process.env.LESSON_MODEL ||
  process.env.LLM_MODEL ||
  "nvidia/nemotron-3.5-super-vl-120b-a12b";
const DOUBT_MODEL = process.env.DOUBT_MODEL || "nvidia/nemotron-3.5-lightning-30b-a3b";
const OTHER_NVIDIA_MODEL = process.env.OTHER_NVIDIA_MODEL || "moonshotai/kimi-k3";

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
  const id = process.env.LLM_MODEL || DEFAULT_MODELS[provider];
  return id.startsWith(`${provider}/`) ? id : `${provider}/${id}`;
}

export function getModel(): { model: LanguageModel; label: string } {
  const provider = detectProvider();
  if (!provider) {
    throw new Error(
      "No LLM configured. Set NVIDIA_API_KEY (recommended), GOOGLE_GENERATIVE_AI_API_KEY, GROQ_API_KEY, OPENAI_API_KEY or ANTHROPIC_API_KEY in .env.local",
    );
  }
  const id = process.env.LLM_MODEL || DEFAULT_MODELS[provider];
  // Ids may already carry their vendor prefix (NVIDIA requires it). Don't double
  // it: getLessonFallbacks dedupes on this label, so "nvidia/nvidia/x" would make
  // the default look like a different model and get retried after the primary.
  const label = id.startsWith(`${provider}/`) ? id : `${provider}/${id}`;

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
 * Build an NVIDIA-hosted model entry by id, with optional thinking-off wrapper.
 * `thinking: false` injects `chat_template_kwargs.enable_thinking: false` into
 * the outgoing body (NVIDIA's chat template understands it; other providers
 * never see this fetch).
 */
function nvidiaModel(id: string, opts?: { thinking?: boolean }): { model: LanguageModel; label: string } {
  return {
    model: createOpenAI({
      baseURL: NVIDIA_BASE_URL,
      apiKey: process.env.NVIDIA_API_KEY,
      name: "nvidia",
      ...(opts?.thinking === false ? { fetch: noThinkingFetch } : {}),
    }).chat(id),
    label: id,
  };
}

/**
 * The planner/teacher model on NVIDIA. Kept for callers that want a single
 * model (the chain-building path uses getModelChain instead).
 *
 * `thinking` picks the reasoning budget per stage, which is the whole latency
 * story of the staged flow:
 *   - PLAN (thinking ON, the default): runs once, off the critical path behind
 *     filler speech, and is where the pedagogy is decided — worth the wait.
 *   - TEACH/EXPLAIN (thinking OFF): runs once per step inside the window where
 *     the previous step is still being spoken, so it has to come back in seconds.
 *     The step's "what to teach" was already reasoned out by the planner, so the
 *     teacher only has to render it as beats.
 */
export function getLessonModel(opts?: { thinking?: boolean }): { model: LanguageModel; label: string } {
  if (process.env.NVIDIA_API_KEY) return nvidiaModel(LESSON_MODEL, opts);
  return getModel();
}

/**
 * How fast Indica speaks, as a multiplier on normal pace. Deliberately below 1:
 * a student following a new idea on a whiteboard needs time to look at what was
 * just drawn, and the slower delivery is also what buys the pipeline room to
 * generate the next step before this one finishes. Read by /api/tts (Sarvam's
 * `pace`) and handed to the browser via /api/config for speechSynthesis `rate`,
 * so both voices are paced from one number.
 */
export function ttsPace(): number {
  const raw = Number(process.env.TTS_PACE ?? process.env.SARVAM_TTS_PACE ?? 0.9);
  if (!Number.isFinite(raw)) return 0.9;
  return Math.min(1.5, Math.max(0.5, raw));
}

/**
 * The doubt model: by default now the Nemotron Super 120 opens doubt (per the
 * configured chain — see getModelChain("doubt")), with thinking disabled so
 * the first beat arrives immediately. Kept as a single-model accessor for
 * callers that don't want the chain.
 *
 * `enable_thinking` lives in the chat template, not in the OpenAI schema, so
 * the AI SDK's provider options (a strict schema) can't carry it — we inject
 * it into the request body with a wrapping fetch instead. Verified against
 * the endpoint: with it off, responses come back with `reasoning_content:
 * null` and `reasoning_tokens: 0`.
 *
 * Falls back to the generic default when there is no NVIDIA key, so an
 * interruption is always answerable.
 */
export function getDoubtModel(): { model: LanguageModel; label: string } {
  if (!process.env.NVIDIA_API_KEY) return getModel();
  return nvidiaModel(LESSON_MODEL, { thinking: false });
}

/** Adds `chat_template_kwargs.enable_thinking: false` to an outgoing chat-completions body. */
const noThinkingFetch: typeof fetch = async (input, init) => {
  if (init?.body && typeof init.body === "string") {
    try {
      const body = JSON.parse(init.body);
      body.chat_template_kwargs = { ...(body.chat_template_kwargs ?? {}), enable_thinking: false };
      init = { ...init, body: JSON.stringify(body) };
    } catch {
      /* not JSON we can touch — send it through untouched */
    }
  }
  return fetch(input, init);
};

/**
 * Keeps a doubt request inside the model's context window.
 *
 * In practice a doubt turn is tiny (a system prompt with a few textbook passages
 * plus the lesson history — low thousands of tokens against a 1M window), so this
 * is a backstop, not routine trimming: it only bites if history or retrieval grows
 * pathologically. Oldest history messages go first, since the student's latest
 * message and the board rules are what the answer depends on.
 *
 * Token counts are estimated at ~4 chars/token — fine for a safety margin that
 * leaves room for the reply.
 */
export function fitDoubtContext<T extends { content: unknown }>(
  system: string,
  messages: T[],
  reserveForOutput = 4000,
): { system: string; messages: T[]; trimmed: number } {
  const budgetChars = (DOUBT_CONTEXT_TOKENS - reserveForOutput) * 4;
  const size = (m: T) => JSON.stringify(m.content).length;
  let total = system.length + messages.reduce((n, m) => n + size(m), 0);
  if (total <= budgetChars) return { system, messages, trimmed: 0 };

  // Drop oldest messages, always keeping the final (current) one.
  const kept = [...messages];
  let trimmed = 0;
  while (kept.length > 1 && total > budgetChars) {
    total -= size(kept.shift() as T);
    trimmed++;
  }
  // Still over? The system prompt (passages) is the only thing left to cut.
  let out = system;
  if (total > budgetChars) {
    out = system.slice(0, Math.max(0, system.length - (total - budgetChars)));
  }
  return { system: out, messages: kept, trimmed };
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
 * The ordered model chain for a tutor mode. The route walks it top-to-bottom:
 * if a model is overloaded / silent / errors out, the next one takes the turn.
 *
 * NVIDIA Nemotron tiers come first, biggest → smallest, matching the
 * configured per-mode preference:
 *
 *   plan           -> [Ultra 253B ("550"), Super 120B, Lightning 30B, other-NVIDIA]
 *   teach / explain-> [Super 120B,         Lightning 30B, other-NVIDIA]
 *   doubt          -> [Super 120B,         Lightning 30B, other-NVIDIA]   (all thinking-OFF)
 *   checkpoint/grade-> [Lightning 30B,      Super 120B,    other-NVIDIA]   (thinking-OFF, small JSON)
 *   ask (legacy)   -> [configured default model]
 *
 * After the NVIDIA chain exhausts, Groq / Google / the generic default are
 * appended as a last-resort off-provider rescue so a wedged NVIDIA endpoint
 * never silently drops a turn. If NVIDIA_API_KEY isn't set, we fall straight
 * to those off-provider models.
 *
 * `thinking` on plan is ON (the one place reasoning is worth the latency);
 * everywhere else it is OFF — a teach step or doubt has to come back within
 * the few seconds of slack the current speech is buying.
 */
export function getModelChain(mode: string): { model: LanguageModel; label: string }[] {
  const out: { model: LanguageModel; label: string }[] = [];
  const seen = new Set<string>();
  const push = (m: { model: LanguageModel; label: string }) => {
    if (seen.has(m.label)) return;
    seen.add(m.label);
    out.push(m);
  };

  if (process.env.NVIDIA_API_KEY) {
    if (mode === "plan") {
      push(nvidiaModel(PLAN_MODEL, { thinking: true }));
      push(nvidiaModel(LESSON_MODEL, { thinking: true }));
      push(nvidiaModel(DOUBT_MODEL, { thinking: true }));
      push(nvidiaModel(OTHER_NVIDIA_MODEL));
    } else if (mode === "teach" || mode === "explain" || mode === "solve") {
      // Solve sits with teach: the reasoning is already done (the book's method is
      // in the prompt), so thinking stays off and the first beat arrives fast.
      push(nvidiaModel(LESSON_MODEL, { thinking: false }));
      push(nvidiaModel(DOUBT_MODEL, { thinking: false }));
      push(nvidiaModel(OTHER_NVIDIA_MODEL));
    } else if (mode === "doubt" || mode === "solvedoubt") {
      push(nvidiaModel(LESSON_MODEL, { thinking: false }));
      push(nvidiaModel(DOUBT_MODEL, { thinking: false }));
      push(nvidiaModel(OTHER_NVIDIA_MODEL));
    } else if (mode === "checkpoint" || mode === "grade") {
      // Both are small closed judgements that return one JSON object, and both
      // sit in the student's way: the checkpoint runs in the gap after a step
      // (where the alternative is silence), and the grade runs with the student
      // waiting to hear whether they were right. So thinking is OFF and the
      // smaller tier leads — Lightning answers these in well under a second,
      // and the decision criteria are spelled out in the prompt rather than
      // being something the model has to reason its way to.
      push(nvidiaModel(DOUBT_MODEL, { thinking: false }));
      push(nvidiaModel(LESSON_MODEL, { thinking: false }));
      push(nvidiaModel(OTHER_NVIDIA_MODEL));
    } else {
      // ask: keep the legacy "configured default" (which may itself be NVIDIA).
      try {
        push(getModel());
      } catch {
        /* fall through to off-provider rescue */
      }
    }
  }

  // Off-provider rescue, same for every mode: a wedged NVIDIA endpoint should
  // not take the whole lesson down. These are last, so NVIDIA is always tried
  // first when the key is set.
  for (const m of getLessonFallbacks([...seen].join(","))) push(m);

  return out;
}

/**
 * Off-provider rescue models (Groq / Google / configured default). Used as the
 * tail of every chain built by getModelChain, and kept exported for any caller
 * that wants only the off-NVIDIA list. `primaryLabel` is deduped against so a
 * previously-included model isn't re-added.
 */
export function getLessonFallbacks(primaryLabel: string): { model: LanguageModel; label: string }[] {
  const out: { model: LanguageModel; label: string }[] = [];
  const seen = new Set(primaryLabel.split(",").filter(Boolean));
  const push = (m: { model: LanguageModel; label: string }) => {
    if (seen.has(m.label)) return;
    seen.add(m.label);
    out.push(m);
  };
  try {
    if (process.env.GROQ_API_KEY) {
      const id = process.env.GROQ_LESSON_MODEL || "openai/gpt-oss-120b";
      push({ model: createGroq({ apiKey: process.env.GROQ_API_KEY })(id), label: `groq/${id}` });
    }
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
    // One pace for both voices (Sarvam `pace` and speechSynthesis `rate`).
    ttsPace: ttsPace(),
    // Set STT_RELAY_URL when the relay runs somewhere other than this host
    // (a separate container, say); otherwise the browser derives it from the
    // page's own hostname so phones on the LAN reach it too.
    sttRelayUrl: process.env.STT_RELAY_URL || null,
    sttRelayPort: Number(process.env.STT_RELAY_PORT || 8787),
  };
}
