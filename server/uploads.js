import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as machines from './machines.js';

export const MAX_FILE_COUNT = 5;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

export function safeUploadName(value) {
  const base = String(value || 'attachment').replaceAll('\\', '/').split('/').pop().trim();
  return (base.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 160) || 'attachment').replace(/^\.+$/, 'attachment');
}

export function decodeUploads(input) {
  if (!Array.isArray(input)) throw Object.assign(new Error('附件格式無效'), { status: 400 });
  if (input.length > MAX_FILE_COUNT) throw Object.assign(new Error(`每則訊息最多 ${MAX_FILE_COUNT} 個檔案`), { status: 413 });
  let total = 0;
  return input.map((item) => {
    const data = String(item?.data || '');
    if (!data || data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw Object.assign(new Error('附件內容無效'), { status: 400 });
    const bytes = Buffer.from(data, 'base64');
    if (!bytes.length || bytes.length > MAX_FILE_BYTES) throw Object.assign(new Error('單一檔案不得超過 10 MB'), { status: 413 });
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) throw Object.assign(new Error('附件總大小不得超過 20 MB'), { status: 413 });
    return { name: safeUploadName(item?.name), mimeType: String(item?.mimeType || 'application/octet-stream').slice(0, 120), size: bytes.length, data, bytes };
  });
}

export async function materializeUploads(session, input) {
  const files = decodeUploads(input || []);
  if (!files.length) return [];
  if (session.machineId) {
    const result = await machines.rpc(session.machineId, 'workspace.upload', { sessionId: session.id, files: files.map(({ bytes: _bytes, ...file }) => file) });
    return result.files || [];
  }
  const dir = path.join(os.tmpdir(), 'agent-hub-uploads', session.id.replace(/[^a-zA-Z0-9_-]/g, '_'));
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const out = [];
  for (const file of files) {
    const target = path.join(dir, `${crypto.randomBytes(5).toString('hex')}-${file.name}`);
    await fs.promises.writeFile(target, file.bytes, { mode: 0o600 });
    out.push({ name: file.name, mimeType: file.mimeType, size: file.size, path: target, sha256: crypto.createHash('sha256').update(file.bytes).digest('hex') });
  }
  return out;
}

export function promptWithUploads(text, files = []) {
  if (!files.length) return text;
  const list = files.map((file) => `- ${file.name} (${file.size} bytes): ${file.path}`).join('\n');
  return `${text ? `${text}\n\n` : ''}<attached_files>\nThe user uploaded these files. Read them from the listed local paths before responding.\n${list}\n</attached_files>`;
}
