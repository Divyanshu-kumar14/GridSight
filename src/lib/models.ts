// Single source of truth for Meta Model API identifiers.
// Nothing else in src/ may hardcode a model string (enforced by review, not tooling).
//
// VERIFY status (2026-10-27): each value below is what this repo has used
// successfully in live calls (Files upload, SAM tracking, Spark chat,
// Image edit, ASR transcription). They could NOT be re-verified against Meta's
// public docs from this environment — doc search was inconclusive and no quota
// was burned to probe them. If Meta renames a model, change it here once.

export const META_BASE_URL = "https://api.meta.ai/v1";

// VERIFY: video-segmentation model for the responses-based tracking call.
export const SAM_MODEL = "sam-3.1";

// VERIFY: chat-completions model for asset tagging + defect-report analysis.
export const SPARK_MODEL = "muse-spark-1.3";

// VERIFY: images model for defect annotation (off the report critical path).
export const IMAGE_MODEL = "muse-image-1.0";

// VERIFY: model + REST path for diarized voice transcription (raw fetch, not SDK).
export const ASR_MODEL = "muse-voice-transcribe-1.0";
export const ASR_TRANSCRIBE_PATH = "/asr/transcribe";

// ============ Spark provider switch (open-weight eligible) ============
// Env var SPARK_PROVIDER selects the chat-completions endpoint for tagging +
// report generation. "meta" is the current default and behaves exactly as before.
// "baseten"/"modal" serve Muse Spark Open via an inference partner.
// Resolution is pure (takes env, no process access) so tests inject freely.
// CRITICAL: Baseten's hackathon model id is "meta-models/muse-spark-open-1026",
// NOT "meta-models/muse-spark-open".

export type SparkProvider = "meta" | "baseten" | "modal";

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
    const baseURL = env.MODAL_BASE_URL;
    if (!baseURL) {
      throw new Error("SPARK_PROVIDER=modal requires MODAL_BASE_URL (see .env.example).");
    }
    const model = env.MODAL_MODEL;
    if (!model) {
      throw new Error("SPARK_PROVIDER=modal requires MODAL_MODEL (see .env.example).");
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
