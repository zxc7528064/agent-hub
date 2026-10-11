import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claimCodexSession, discoverCodexRollouts, parseCodexRollout, visibleUserText } from '../server/codex-sync.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-codex-sync-'));
  const home = path.join(root, '.codex');
  const sessions = path.join(home, 'sessions', '2026', '10', '11');
  fs.mkdirSync(sessions, { recursive: true });
  const id = '01a11111-2222-7333-8444-555555555555';
  const file = path.join(sessions, `rollout-2026-10-11T10-00-00-${id}.jsonl`);
  const rows = [
    { timestamp: '2026-10-11T02:00:00.000Z', type: 'session_meta', payload: { id, session_id: id, cwd: '/tmp/project', originator: 'Codex Desktop' } },
    { timestamp: '2026-10-11T02:00:01.000Z', type: 'event_msg', payload: { type: 'task_started' } },
    {
      timestamp: '2026-10-11T02:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '<in-app-browser-context>hidden</in-app-browser-context>\n\n## My request:\n幫我同步' }],
      },
    },
    { timestamp: '2026-10-11T02:00:03.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '已完成' }] } },
  ];
  fs.writeFileSync(file, `${rows.map(JSON.stringify).join('\n')}\n`);
  fs.writeFileSync(path.join(home, 'session_index.jsonl'), `${JSON.stringify({ id, thread_name: '同步測試', updated_at: '2026-10-11T02:00:03.000Z' })}\n`);
  return { root, home, id, file };
}

test('Codex user text hides the Desktop ambient context envelope', () => {
  assert.equal(visibleUserText('context\n\n## My request:\n真正的問題'), '真正的問題');
  assert.equal(visibleUserText('一般訊息'), '一般訊息');
});

test('Codex rollout becomes the normalized conversation shown by Agent Hub', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const record = parseCodexRollout(f.file, { id: f.id, thread_name: '同步測試' });
  assert.equal(record.threadId, f.id);
  assert.equal(record.title, '同步測試');
  assert.equal(record.cwd, '/tmp/project');
  assert.equal(record.busy, true);
  assert.deepEqual(record.events.map((e) => [e.type, e.text]), [
    ['user', '幫我同步'],
    ['text', '已完成'],
  ]);
});

test('Codex discovery follows session_index and reuses unchanged parsed files', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const cache = new Map();
  const first = discoverCodexRollouts(f.home, cache);
  assert.equal(first.length, 1);
  assert.equal(first[0].threadId, f.id);
  const cached = cache.get(f.file).record;
  const second = discoverCodexRollouts(f.home, cache);
  assert.equal(second[0].events, cached.events, 'an unchanged 85MB-style rollout is not reparsed every poll');
});

test('the UI exposes a generic read-only note for a Codex App owned thread', () => {
  const composer = fs.readFileSync(new URL('../public/js/composer.js', import.meta.url), 'utf8');
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  assert.match(composer, /externalReadOnly/);
  assert.match(composer, /readOnlyTitle/);
  assert.match(app, /readOnly: Boolean\(meta\.readOnly\)/);
});

test('a native Codex conversation cannot be claimed while Desktop owns its writer lock', () => {
  const session = { id: 'codex_test', status: 'idle', meta: { readOnly: true, codexSource: { threadId: 'native-thread', claimed: false } } };
  assert.throws(
    () => claimCodexSession(session, { active: () => true }),
    (err) => err.status === 409 && /Codex App/.test(err.message),
  );
  assert.equal(session.meta.codexSource.claimed, false);
});

test('an unlocked native Codex conversation is durably claimed before ACP resumes it', () => {
  const session = { id: 'codex_test', title: 'Native', agentId: 'codex-acp', status: 'idle', meta: { readOnly: true, codexSource: { threadId: 'native-thread', claimed: false } } };
  let persisted = null;
  let announced = null;
  claimCodexSession(session, { active: () => false, persist: (s) => (persisted = s), broadcast: (m) => (announced = m) });
  assert.equal(session.meta.codexSource.claimed, true);
  assert.equal(session.meta.readOnly, false);
  assert.equal(persisted, session);
  assert.equal(announced.session.id, session.id);
});
