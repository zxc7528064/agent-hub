// Read Codex Desktop/CLI conversations from ~/.codex and expose them in the
// hub.  They stay read-only while another Codex process owns the thread's
// writer lock.  Once the lock is free, the hub can claim the conversation and
// let the ACP adapter resume the native Codex thread id.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as store from './store.js';
import * as runner from './runner.js';

const POLL_MS = 3_000;
const MAX_THREADS = 120;

const importedId = (threadId) => `codex_${threadId}`;

function jsonLines(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function textOf(content, wanted) {
  return (content || [])
    .filter((part) => wanted.includes(part.type) && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

// Codex Desktop records ambient UI context together with the user's actual
// request.  The Desktop UI hides that envelope; the hub should do the same.
export function visibleUserText(text) {
  const marker = '\n## My request:\n';
  const at = text.lastIndexOf(marker);
  return (at === -1 ? text : text.slice(at + marker.length)).trim();
}

export function parseCodexRollout(file, index = {}) {
  const rows = jsonLines(file);
  const metaRow = rows.find((r) => r.type === 'session_meta')?.payload || {};
  const threadId = metaRow.id || metaRow.session_id || index.id;
  if (!threadId) return null;
  const events = [];
  let busy = false;
  let n = 0;
  for (const row of rows) {
    if (row.type === 'event_msg' && row.payload?.type === 'task_started') busy = true;
    if (row.type === 'event_msg' && row.payload?.type === 'task_complete') busy = false;
    if (row.type !== 'response_item' || row.payload?.type !== 'message') continue;
    const role = row.payload.role;
    if (role !== 'user' && role !== 'assistant') continue;
    let text = textOf(row.payload.content, role === 'user' ? ['input_text', 'text'] : ['output_text', 'text']);
    if (role === 'user') text = visibleUserText(text);
    if (!text) continue;
    events.push({
      id: `cxev_${threadId}_${n++}`,
      ts: Date.parse(row.timestamp) || Date.now(),
      type: role === 'user' ? 'user' : 'text',
      text,
      ...(role === 'user' ? { source: 'codex-app' } : {}),
    });
  }
  const firstUser = events.find((e) => e.type === 'user')?.text.replace(/\s+/g, ' ').slice(0, 80);
  const stat = fs.statSync(file);
  return {
    threadId,
    title: index.thread_name || firstUser || 'Codex 對話',
    cwd: metaRow.cwd || '',
    originator: metaRow.originator || 'Codex',
    createdAt: Date.parse(metaRow.timestamp) || stat.birthtimeMs || stat.mtimeMs,
    updatedAt: Math.max(stat.mtimeMs, events.at(-1)?.ts || 0, Date.parse(index.updated_at) || 0),
    busy,
    events,
    file,
  };
}

function walk(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file, out);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(file);
  }
  return out;
}

export function discoverCodexRollouts(codexHome = path.join(os.homedir(), '.codex'), cache = new Map()) {
  const index = new Map();
  for (const row of jsonLines(path.join(codexHome, 'session_index.jsonl'))) {
    if (row.id) index.set(row.id, row);
  }
  const wanted = [...index.values()]
    .sort((a, b) => Date.parse(b.updated_at || 0) - Date.parse(a.updated_at || 0))
    .slice(0, MAX_THREADS);
  const ids = new Set(wanted.map((x) => x.id));
  const newest = new Map();
  for (const file of walk(path.join(codexHome, 'sessions'))) {
    const id = [...ids].find((candidate) => path.basename(file).includes(candidate));
    if (!id) continue;
    const old = newest.get(id);
    if (!old || fs.statSync(file).mtimeMs > fs.statSync(old).mtimeMs) newest.set(id, file);
  }
  return wanted
    .map((entry) => {
      const file = newest.get(entry.id);
      if (!file) return null;
      const stat = fs.statSync(file);
      const old = cache.get(file);
      if (old?.size === stat.size && old?.mtimeMs === stat.mtimeMs) return { ...old.record, title: entry.thread_name || old.record.title };
      const record = parseCodexRollout(file, entry);
      if (record) cache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, record });
      return record;
    })
    .filter(Boolean);
}

export function threadIsActive(threadId, codexHome = path.join(os.homedir(), '.codex')) {
  const lock = path.join(codexHome, 'thread-writer-locks', `${threadId}.lock`);
  if (!fs.existsSync(lock)) return false;
  try {
    const r = spawnSync('lsof', ['-F', 'p', '--', lock], { encoding: 'utf8', timeout: 1500 });
    if (!r.error) return /^p\d+/m.test(r.stdout || '');
  } catch {}
  // If lsof is unavailable, fail closed: a present lock is treated as active.
  return true;
}

export function claimCodexSession(session, { active, persist = () => {}, broadcast = () => {} }) {
  const source = session.meta?.codexSource;
  if (!source || source.claimed) return session;
  if (active(source.threadId)) {
    throw Object.assign(new Error('這個對話仍在 Codex App 裡使用；請先關閉桌面版的這個對話，再從網頁傳送訊息。'), { status: 409 });
  }
  session.meta = { ...session.meta, owner: null, controllable: true, readOnly: false, codexSource: { ...source, claimed: true } };
  session.status = 'idle';
  persist(session);
  broadcast({ t: 'session', session: runner.summarize(session) });
  return session;
}

export function createCodexSync({
  codexHome = path.join(os.homedir(), '.codex'),
  active = (id) => threadIsActive(id, codexHome),
  interval = POLL_MS,
  broadcast = () => {},
} = {}) {
  let timer = null;
  let syncing = false;
  const cache = new Map();

  const sync = async () => {
    if (syncing) return;
    syncing = true;
    try {
      const records = discoverCodexRollouts(codexHome, cache);
      const nativeIds = new Set(
        store
          .listSessions()
          .filter((s) => !s.meta?.codexSource && s.state?.acpSessionId)
          .map((s) => s.state.acpSessionId),
      );
      const seen = new Set();
      for (const record of records) {
        if (nativeIds.has(record.threadId)) continue;
        const id = importedId(record.threadId);
        seen.add(id);
        const previous = store.getSession(id);
        if (previous?.meta?.codexSource?.claimed) continue;
        const locked = active(record.threadId);
        const session = {
          id,
          title: record.title,
          titled: true,
          status: record.busy ? 'running' : 'idle',
          permissionMode: 'ask',
          allowedTools: [],
          events: record.events,
          seq: (previous?.seq || 0) + 1,
          state: { acpSessionId: record.threadId },
          usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
          agentId: 'codex-acp',
          cwd: record.cwd,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          meta: {
            ...(previous?.meta || {}),
            owner: locked ? 'codex-app' : null,
            controllable: !locked,
            readOnly: locked,
            readOnlyTitle: '這個對話正在 Codex App 裡使用',
            readOnlyText: '網頁會即時同步內容。關閉桌面版的這個對話後，就能從網頁接手繼續。',
            agentInfo: { name: 'codex', title: 'Codex App' },
            protocol: 'Codex App 同步',
            codexSource: { threadId: record.threadId, file: record.file, originator: record.originator, claimed: false },
          },
        };
        const changed = !previous || previous.updatedAt !== session.updatedAt || previous.meta?.readOnly !== locked || previous.status !== session.status;
        store.upsertEphemeralSession(session);
        if (changed) {
          broadcast({ t: 'session', session: runner.summarize(session) });
          if (previous) broadcast({ t: 'reset', sid: id, seq: session.seq });
        }
      }
      for (const session of store.listSessions()) {
        if (!session.meta?.codexSource || session.meta.codexSource.claimed || seen.has(session.id)) continue;
        store.deleteSession(session.id);
        broadcast({ t: 'deleted', sid: session.id });
      }
    } finally {
      syncing = false;
    }
  };

  const claim = (session) => {
    return claimCodexSession(session, { active, persist: store.claimEphemeralSession, broadcast });
  };

  return {
    sync,
    claim,
    async start() {
      await sync();
      timer = setInterval(() => sync().catch((err) => console.warn(`[codex-sync] ${err.message}`)), interval);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}
