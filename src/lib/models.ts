// Single source of truth for Meta Model API identifiers.
// Nothing else in src/ may hardcode a model string (enforced by review, not tooling).
// If Meta renames a model, change it here once.

export const META_BASE_URL = "https://api.meta.ai/v1";

// Video-segmentation model for the responses-based tracking call.
export const SAM_MODEL = "sam-3.1";

// Chat-completions model for asset tagging + defect-report analysis.
export const SPARK_MODEL = "muse-spark-1.3";

// Images model used only by standalone smoke-test scripts; it is not part of
// the active report workflow.
export const IMAGE_MODEL = "muse-image-1.0";

// Model + REST path for diarized voice transcription (raw fetch, not SDK).
export const ASR_MODEL = "muse-voice-transcribe-1.0";
export const ASR_TRANSCRIBE_PATH = "/asr/transcribe";

// ============ Spark provider switch (open-weight eligible) ============
// Env var SPARK_PROVIDER selects the chat-completions endpoint for tagging +
// report generation. "meta" is the current default and behaves exactly as before.
// "baseten"/"modal" serve Muse Spark Open via an inference partner.
// Resolution is pure (takes env, no process access) so tests inject freely.
// CRITICAL: Baseten's hackathon model id is "meta-models/muse-spark-open-1026",
// NOT "meta-models/muse-spark-open".
// Modal Shared Endpoint model id is "meta-models/Muse-Spark-Open-816B-A42B"
// (see https://modal.com/library/meta/muse-spark-open). MODAL_ENDPOINT_URL is
// the OpenAI-compatible base ending in /v1 (e.g. https://xxx.modal.run/v1).

export type SparkProvider = "meta" | "baseten" | "modal";

// Exact model identifier for the Modal Shared Endpoint (case-sensitive).
export const MODAL_SHARED_MODEL = "meta-models/Muse-Spark-Open-816B-A42B";

export interface SparkConfig {
  provider: SparkProvider;
  baseURL: string;
  model: string;
  apiKeyEnv: string; // env var NAME, never the value
}

const BASETEN_DEFAULT_BASE_URL = "https://inference.baseten.co/v1";
const BASETEN_DEFAULT_MODEL = "meta-models/muse-spark-open-1026";

export function resolveSparkConfig(env: Record<string, string | undefined>): SparkConfig {
  const provider = env.SPARK_PROVIDER ?? "meta";
  if (provider === "meta") {
    return {
      provider,
      baseURL: META_BASE_URL,
      model: env.SPARK_MODEL ?? SPARK_MODEL,
      apiKeyEnv: "MODEL_API_KEY",
    };
  }
  if (provider === "baseten") {
    return {
      provider,
      baseURL: env.BASETEN_BASE_URL ?? BASETEN_DEFAULT_BASE_URL,
      model: env.BASETEN_MODEL ?? BASETEN_DEFAULT_MODEL,
      apiKeyEnv: "BASETEN_API_KEY",
    };
  }
  if (provider === "modal") {
    // Shared Endpoint: MODAL_ENDPOINT_URL preferred (must end in /v1),
    // MODAL_BASE_URL kept as legacy fallback. Never guess the URL.
    const rawBase = env.MODAL_ENDPOINT_URL ?? env.MODAL_BASE_URL;
    if (!rawBase) {
      throw new Error(
        "SPARK_PROVIDER=modal requires MODAL_ENDPOINT_URL (or legacy MODAL_BASE_URL) (see .env.example).",
      );
    }
    const baseURL = rawBase.replace(/\/+$/, "");
    const model = env.MODAL_MODEL;
    if (!model) {
      throw new Error(
        `SPARK_PROVIDER=modal requires MODAL_MODEL (expected "${MODAL_SHARED_MODEL}") (see .env.example).`,
      );
    }
    return { provider, baseURL, model, apiKeyEnv: "MODAL_API_KEY" };
  }
  throw new Error(
    `Unknown SPARK_PROVIDER=${provider} (expected "meta", "baseten", or "modal").`,
  );
}

// Reads process.env. Pure resolution — key presence is checked at client creation.
export function getSparkConfig(): SparkConfig {
  return resolveSparkConfig(process.env);
}

// Resolved Spark model id for the active provider.
export function sparkModel(): string {
  return getSparkConfig().model;
}
