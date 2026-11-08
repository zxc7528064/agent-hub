export const MAX_ATTACHMENT_COUNT = 5;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export type AttachmentView = {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  sha256: string;
  createdAt: string;
};

export function safeFileName(value: string) {
  const base = value.replaceAll("\\", "/").split("/").pop()?.trim() || "attachment";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 180);
  return cleaned || "attachment";
}

export function normalizedMimeType(value: string) {
  const mime = value.trim().toLowerCase().slice(0, 120);
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime) ? mime : "application/octet-stream";
}

export function contentDispositionFileName(value: string) {
  const fallback = safeFileName(value).replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(safeFileName(value))}`;
}

export function bytesLabel(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
