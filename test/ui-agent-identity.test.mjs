import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const transcript = fs.readFileSync(path.join(root, 'public/js/transcript.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');

test('working status uses the selected agent identity instead of a Kimi-only label', () => {
  assert.doesNotMatch(transcript, /Kimi 正在處理/);
  assert.match(transcript, /`\$\{agentName\} 正在處理`/);
  assert.match(app, /agentName: agentIdentity\(\{ summary \}\)\.name/);
});
