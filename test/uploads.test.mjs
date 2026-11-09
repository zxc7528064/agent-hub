import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { decodeUploads, materializeUploads, promptWithUploads, safeUploadName } from '../server/uploads.js';

const encoded = (text) => Buffer.from(text).toString('base64');

test('upload validation sanitizes names and preserves exact bytes', async () => {
  const files = decodeUploads([{ name: '../../report.txt', mimeType: 'text/plain', data: encoded('hello') }]);
  assert.equal(files[0].name, 'report.txt');
  assert.equal(files[0].bytes.toString(), 'hello');
  assert.equal(safeUploadName('..'), 'attachment');
});

test('invalid base64 and excessive counts fail closed', () => {
  assert.throws(() => decodeUploads([{ name: 'x', data: 'not base64' }]), /附件內容無效/);
  assert.throws(() => decodeUploads(Array.from({ length: 6 }, (_, i) => ({ name: `${i}.txt`, data: encoded('x') }))), /最多 5/);
});

test('local uploads are materialized outside the workspace with digest and prompt path', async () => {
  const session = { id: `test_${Date.now()}` };
  const [file] = await materializeUploads(session, [{ name: 'notes.md', mimeType: 'text/markdown', data: encoded('# Notes') }]);
  try {
    assert.equal(fs.readFileSync(file.path, 'utf8'), '# Notes');
    assert.equal(file.sha256, '360aa5ebfa18efd19f60eb2432c11d53e21586ff3a392ca246980970de15f0c4');
    assert.ok(file.path.startsWith(path.join(os.tmpdir(), 'agent-hub-uploads')));
    const prompt = promptWithUploads('請分析', [file]);
    assert.match(prompt, /<attached_files>/);
    assert.match(prompt, /notes\.md/);
    assert.match(prompt, new RegExp(file.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    fs.rmSync(path.dirname(file.path), { recursive: true, force: true });
  }
});
