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
