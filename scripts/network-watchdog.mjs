#!/usr/bin/env node
// Keep the public Agent Hub route alive across Wi-Fi, VPN, DNS and sleep/wake
// changes. The watchdog never restarts Agent Hub: it only rebuilds cloudflared
// when localhost is reachable but the public route is not.

import dns from 'node:dns';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export class RecoveryPolicy {
  constructor({ threshold = 3, cooldownMs = 5 * 60_000 } = {}) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
    this.failures = 0;
    this.lastRestart = 0;
  }

  observe({ localOk, publicOk, networkChanged = false, now = Date.now() }) {
    if (!localOk) {
      this.failures = 0;
      return 'hub-down';
    }
    if (publicOk) {
      this.failures = 0;
      return 'healthy';
    }
    this.failures = networkChanged ? this.threshold : this.failures + 1;
    if (this.failures < this.threshold) return 'wait';
    if (this.lastRestart && now - this.lastRestart < this.cooldownMs) return 'cooldown';
    this.failures = 0;
    this.lastRestart = now;
    return 'restart-tunnel';
  }
}

export function networkSignature() {
  const addresses = [];
  for (const [name, rows] of Object.entries(os.networkInterfaces())) {
    for (const row of rows || []) {
      if (!row.internal) addresses.push(`${name}:${row.family}:${row.address}`);
    }
  }
  return JSON.stringify({ addresses: addresses.sort(), dns: dns.getServers().sort() });
}

async function probe(url, token, timeoutMs) {
  try {
    const res = await fetch(url, {
      headers: token ? { 'x-hub-token': token } : {},
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    });
    // A 401/404 still proves that the request reached Agent Hub. Only network
    // errors and 5xx responses indicate a broken origin/tunnel path.
    return { ok: res.status >= 200 && res.status < 500, status: res.status };
  } catch (err) {
    return { ok: false, error: err.name || 'network-error' };
  }
}

function readToken() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'hub.json'), 'utf8')).token || '';
  } catch {
    return '';
  }
}

const stamp = () => new Date().toISOString();

export async function runWatchdog({
  once = false,
  dryRun = false,
  intervalMs = Number(process.env.AGENT_HUB_WATCHDOG_INTERVAL_MS || 30_000),
  localUrl = process.env.AGENT_HUB_LOCAL_HEALTH_URL || 'http://127.0.0.1:8787/api/config',
  publicUrl = process.env.AGENT_HUB_PUBLIC_HEALTH_URL || 'https://agent.noth.tech/api/config',
  tunnelLabel = process.env.AGENT_HUB_TUNNEL_LABEL || 'com.cloudflare.cloudflared',
} = {}) {
  const policy = new RecoveryPolicy();
  let previousSignature = networkSignature();
  let lastReport = '';

  const tick = async () => {
    const currentSignature = networkSignature();
    const networkChanged = currentSignature !== previousSignature;
    previousSignature = currentSignature;
    const token = readToken();
    const local = await probe(localUrl, token, 5_000);
    const remote = local.ok ? await probe(publicUrl, token, 15_000) : { ok: false, error: 'hub-down' };
    const action = policy.observe({ localOk: local.ok, publicOk: remote.ok, networkChanged });
    const report = `${action}:${local.status || local.error}:${remote.status || remote.error}`;
    if (report !== lastReport || networkChanged || action === 'restart-tunnel') {
      console.log(`${stamp()} ${networkChanged ? 'network-changed ' : ''}local=${local.status || local.error} public=${remote.status || remote.error} action=${action}`);
      lastReport = report;
    }
    if (action === 'restart-tunnel') {
      if (dryRun) return;
      const target = `gui/${process.getuid()}/${tunnelLabel}`;
      try {
        await execFileAsync('/bin/launchctl', ['kickstart', '-k', target], { timeout: 20_000 });
        console.log(`${stamp()} tunnel-restarted label=${tunnelLabel}`);
      } catch (err) {
        console.error(`${stamp()} tunnel-restart-failed code=${err.code || 'unknown'}`);
      }
    }
  };

  await tick();
  if (once) return;
  const timer = setInterval(() => void tick(), intervalMs);
  await new Promise((resolve) => {
    process.once('SIGTERM', resolve);
    process.once('SIGINT', resolve);
  });
  clearInterval(timer);
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) {
  runWatchdog({ once: process.argv.includes('--once'), dryRun: process.argv.includes('--dry-run') }).catch((err) => {
    console.error(`${stamp()} watchdog-fatal ${err.message}`);
    process.exitCode = 1;
  });
}
