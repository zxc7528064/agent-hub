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

// A synchronized conversation can later be claimed and continued from the
// Hub.  If Codex Desktop subsequently owns the native thread again, keep the
// claimed Hub copy intact and expose the live Desktop view under a separate,
// deterministic id instead of silently suppressing synchronization.
export function syncedSessionId(threadId, lookup = (id) => store.getSession(id)) {
  const base = importedId(threadId);
  return lookup(base)?.meta?.codexSource?.claimed ? `codex_sync_${threadId}` : base;
}

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

// Rollout files can grow to hundreds of megabytes because they also contain
// tool payloads and UI context that Agent Hub never displays.  Reading the
// whole file and calling String.split() on every poll duplicates that data
// several times in V8 and can stall the server.  Scan complete JSONL records
// in fixed-size buffers instead, discard irrelevant rows before decoding, and
// retain the byte offset so later polls only consume newly appended records.
const SCAN_CHUNK = 1024 * 1024;

function relevantRolloutLine(line) {
  return (
    line.includes('"type":"session_meta"') ||
    (line.includes('"type":"event_msg"') && (line.includes('"type":"task_started"') || line.includes('"type":"task_complete"'))) ||
    (line.includes('"type":"response_item"') && line.includes('"type":"message"'))
  );
}

function newRolloutState(index = {}) {
  return {
    offset: 0,
    partial: Buffer.alloc(0),
    meta: {},
    threadId: index.id || '',
    events: [],
    busy: false,
    nextEvent: 0,
  };
}

function consumeRolloutRow(state, row) {
  if (row.type === 'session_meta') {
    state.meta = row.payload || {};
    state.threadId = state.meta.id || state.meta.session_id || state.threadId;
    return;
  }
  if (row.type === 'event_msg' && row.payload?.type === 'task_started') state.busy = true;
  if (row.type === 'event_msg' && row.payload?.type === 'task_complete') state.busy = false;
  if (row.type !== 'response_item' || row.payload?.type !== 'message') return;
  const role = row.payload.role;
  if (role !== 'user' && role !== 'assistant') return;
  let value = textOf(row.payload.content, role === 'user' ? ['input_text', 'text'] : ['output_text', 'text']);
  if (role === 'user') value = visibleUserText(value);
  if (!value) return;
  state.events.push({
    id: `cxev_${state.threadId}_${state.nextEvent++}`,
    ts: Date.parse(row.timestamp) || Date.now(),
    type: role === 'user' ? 'user' : 'text',
    text: value,
    ...(role === 'user' ? { source: 'codex-app' } : {}),
  });
}

function scanRollout(file, state, size) {
  const fd = fs.openSync(file, 'r');
  const chunk = Buffer.allocUnsafe(SCAN_CHUNK);
  let position = state.offset;
  let pending = state.partial;
  try {
    while (position < size) {
      const wanted = Math.min(chunk.length, size - position);
      const read = fs.readSync(fd, chunk, 0, wanted, position);
      if (!read) break;
      position += read;
      const data = pending.length ? Buffer.concat([pending, chunk.subarray(0, read)]) : chunk.subarray(0, read);
      let start = 0;
      for (;;) {
        const newline = data.indexOf(10, start);
        if (newline === -1) break;
        const line = data.subarray(start, newline);
        start = newline + 1;
        if (!line.length || !relevantRolloutLine(line)) continue;
        try {
          consumeRolloutRow(state, JSON.parse(line.toString('utf8')));
        } catch {}
      }
      pending = start < data.length ? Buffer.from(data.subarray(start)) : Buffer.alloc(0);
    }
  } finally {
    fs.closeSync(fd);
  }
  state.offset = position;
  state.partial = pending;
  return state;
}

function recordFromState(file, index, state, stat) {
  const threadId = state.meta.id || state.meta.session_id || state.threadId || index.id;
  if (!threadId) return null;
  const firstUser = state.events.find((e) => e.type === 'user')?.text.replace(/\s+/g, ' ').slice(0, 80);
  return {
    threadId,
    title: index.thread_name || firstUser || 'Codex 對話',
    cwd: state.meta.cwd || '',
    originator: state.meta.originator || 'Codex',
    createdAt: Date.parse(state.meta.timestamp) || stat.birthtimeMs || stat.mtimeMs,
    updatedAt: Math.max(stat.mtimeMs, state.events.at(-1)?.ts || 0, Date.parse(index.updated_at) || 0),
    busy: state.busy,
    events: state.events,
    file,
  };
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
  const stat = fs.statSync(file);
  const state = scanRollout(file, newRolloutState(index), stat.size);
  return recordFromState(file, index, state, stat);
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
      const state = !old?.state || stat.size < old.state.offset ? newRolloutState(entry) : old.state;
      scanRollout(file, state, stat.size);
      const record = recordFromState(file, entry, state, stat);
      if (record) cache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, record, state });
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
        const id = syncedSessionId(record.threadId);
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
