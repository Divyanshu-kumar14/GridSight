// Client-side stash for the uploaded video File so the workspace page can
// play it back via object URL (server only keeps the Meta file_id).
// Normal: set → get → URL. Empty: get unknown id → null. Invalid: set without File → throws.
const stash = new Map<string, File>();

export function stashVideoFile(sessionId: string, file: File): void {
  if (!(file instanceof File)) throw new Error("stashVideoFile: expected a File.");
  stash.set(sessionId, file);
}

export function getVideoFile(sessionId: string): File | null {
  return stash.get(sessionId) ?? null;
}

export function videoObjectUrl(sessionId: string): string | null {
  const file = stash.get(sessionId);
  return file ? URL.createObjectURL(file) : null;
}
