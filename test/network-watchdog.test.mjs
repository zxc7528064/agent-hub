import test from 'node:test';
import assert from 'node:assert/strict';
import { RecoveryPolicy } from '../scripts/network-watchdog.mjs';

test('watchdog never restarts the tunnel when the local hub is down', () => {
  const p = new RecoveryPolicy({ threshold: 2 });
  assert.equal(p.observe({ localOk: false, publicOk: false }), 'hub-down');
  assert.equal(p.failures, 0);
});

test('watchdog restarts after bounded consecutive public failures', () => {
  const p = new RecoveryPolicy({ threshold: 3, cooldownMs: 1000 });
  assert.equal(p.observe({ localOk: true, publicOk: false, now: 1000 }), 'wait');
  assert.equal(p.observe({ localOk: true, publicOk: false, now: 1100 }), 'wait');
  assert.equal(p.observe({ localOk: true, publicOk: false, now: 1200 }), 'restart-tunnel');
});

test('a network change triggers immediate recovery but obeys cooldown', () => {
  const p = new RecoveryPolicy({ threshold: 3, cooldownMs: 5000 });
  assert.equal(p.observe({ localOk: true, publicOk: false, networkChanged: true, now: 10_000 }), 'restart-tunnel');
  assert.equal(p.observe({ localOk: true, publicOk: false, networkChanged: true, now: 11_000 }), 'cooldown');
  assert.equal(p.observe({ localOk: true, publicOk: false, networkChanged: true, now: 16_000 }), 'restart-tunnel');
});

test('a healthy public response resets the failure counter', () => {
  const p = new RecoveryPolicy({ threshold: 2 });
  assert.equal(p.observe({ localOk: true, publicOk: false }), 'wait');
  assert.equal(p.observe({ localOk: true, publicOk: true }), 'healthy');
  assert.equal(p.observe({ localOk: true, publicOk: false }), 'wait');
});
