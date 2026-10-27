// GridSight core types — verbatim from PRD §8. Do not drift without updating PRD.
import type { SparkProvider } from "./models";

// ============ Inspection Session ============

export interface InspectionSession {
  id: string; // uuid
  substationName: string;
  inspectorName: string;
  date: string; // ISO 8601
  status:
    | "uploading"
    | "tracking"
    | "transcribing"
    | "tagging"
    | "generating"
    | "complete"
    | "error";
  videoFileId: string; // Meta Files API file_id
  videoFileName: string;
  videoDurationSec: number;
  videoFps: number; // probed at upload via ffprobe; 30 when unknown
  voiceFileId?: string;
  createdAt: string;
  updatedAt: string;
}

// ============ SAM 3.1 Tracking ============

export interface TrackedObject {
  id: string; // "insulator-001"
  sessionId: string;
  category: string; // "insulator", "transformer", etc.
  color: string; // hex color for UI overlay
  firstSeenFrame: number;
  lastSeenFrame: number;
  totalFrameCount: number;
  frames: TrackedFrame[];
}

export interface TrackedFrame {
  frameIndex: number;
  timestamp: number; // seconds
  bbox: BoundingBox;
  confidence: number;
}

export interface BoundingBox {
  x: number; // top-left x (normalized 0-1)
  y: number; // top-left y (normalized 0-1)
  w: number; // width (normalized 0-1)
  h: number; // height (normalized 0-1)
}

// ============ Voice Transcription ============

export interface TranscriptSegment {
  id: string;
  sessionId: string;
  speaker: string; // "SPEAKER_0"
  startTime: number; // seconds
  endTime: number;
  text: string;
}

export interface TaggedNote {
  segmentId: string;
  text: string;
  speaker: string;
  startTime: number;
  endTime: number;
  matchedAssetId: string | null;
  matchedCategory: string | null;
  matchConfidence: number;
  matchReason: string;
}

// ============ Defect Report ============

export interface DefectReport {
  id: string;
  sessionId: string;
  inspection: InspectionMetadata;
  summary: string;
  defects: Defect[];
  statistics: ReportStatistics;
  generatedAt: string;
  // Provenance: which Spark endpoint wrote the defects (open-weight prize proof).
  // Optional so existing fixtures and stored reports still parse.
  modelRun?: { provider: SparkProvider; model: string };
  // Coverage transparency (SERVER-COMPUTED from tracking + key frames + defects,
  // never model-generated). Optional so legacy reports still parse.
  evidenceCoverage?: EvidenceCoverage;
}

// Server-computed coverage ledger for the 8-frame budget: distinguishes what was
// actually shown to the report model from what was only heard in voice notes.
export interface EvidenceCoverage {
  totalAssetsTracked: number;
  assetsRepresented: number; // distinct tracked assets with a selected key frame
  visualFindings: number; // defects with evidenceSource === "visual"
  voiceOnlyFindings: number; // defects sourced only from inspector notes
  verificationSkipped: number; // visual defects with no keep/downgrade/drop verdict
}

export interface InspectionMetadata {
  substationId: string;
  substationName: string;
  date: string;
  inspector: string;
  totalAssetsTracked: number;
  totalDefectsFound: number;
  coveragePercent: number;
}

export interface Defect {
  id: string;
  assetId: string;
  assetCategory: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  title: string;
  description: string;
  frameTimestamp: number; // seconds into video
  frameCapture?: string; // base64
  annotatedImage?: string; // base64 from Muse Image (legacy; render only as labeled illustration)
  voiceNoteExcerpt?: string;
  recommendedAction: string;
  estimatedUrgency: "Immediate" | "Next scheduled" | "Monitor";
  // Visual-evidence fields (model-cited, server-verified — see labelEvidence).
  evidenceFrameIndex?: number; // index into the report's key-frame array
  observation?: string; // what is actually visible in the cited frame
  evidenceSource?: "visual" | "voice"; // SERVER-COMPUTED, never trusted from the model
  overlayBox?: BoundingBox; // SERVER-COMPUTED tracked bbox at defect time (deterministic overlay)
  // Asset-association status (SERVER-COMPUTED via attachOverlayBox, never trusted
  // from the model). "confirmed" = exact assetId hit with a valid bbox attached.
  // "unresolved" = no exact hit or no valid bbox — finding is preserved, no box is
  // borrowed from another asset. Absent on legacy stored reports (treated as unknown).
  assetAssociation?: "confirmed" | "unresolved";
  // Second-pass audit (see verify.ts): the model re-checks its own visual claim
  // against the cited frame. Absent on voice-only findings (never verified).
  verification?: {
    verdict: "keep" | "downgrade" | "drop" | "skipped";
    reason: string;
  };
}

export interface ReportStatistics {
  critical: number;
  high: number;
  medium: number;
  low: number;
  byCategory: Record<string, number>;
  // Second-pass audit counts (present on reports generated with verification).
  verification?: { kept: number; downgraded: number; dropped: number; skipped: number };
}

// ============ Pipeline State ============

export interface PipelineState {
  sessionId: string;
  steps: {
    upload: StepStatus;
    tracking: StepStatus;
    transcription: StepStatus;
    assetTagging: StepStatus;
    reportGeneration: StepStatus;
    imageGeneration: StepStatus;
  };
}

export interface StepStatus {
  status: "pending" | "running" | "complete" | "error" | "skipped";
  progress?: number; // 0-100
  error?: string;
  startedAt?: string;
  completedAt?: string;
}
