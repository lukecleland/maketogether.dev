import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const context = { exports: {} };
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/utils/participantPanels.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, context);
const { participantPanelsForReceiver } = context.exports;
const plain = value => JSON.parse(JSON.stringify(value));
const host = { x: 602, y: -30, width: 512, height: 288, z: 24 };
const alex = { x: -125, y: 220, width: 200, height: 360, z: 22 };
const sam = { x: 920, y: 110, width: 420, height: 260, z: 26 };
const fallback = { x: 20, y: 112, width: 300, height: 400, z: 10 };

test('joining clients inherit identical world geometry with their own AV identity mapped to local', () => {
  const fixed = { local: host, remote: fallback }, peers = { alex, sam };
  const a = participantPanelsForReceiver(fixed, peers, 'host', 'alex');
  const s = participantPanelsForReceiver(fixed, peers, 'host', 'sam');
  assert.deepEqual(plain(a.fixedPanels.local), alex);
  assert.deepEqual(plain(s.fixedPanels.local), sam);
  assert.deepEqual(plain(a.remotePanels), { host, sam });
  assert.deepEqual(plain(s.remotePanels), { host, alex });
  assert.deepEqual(fixed, { local: host, remote: fallback });
  assert.deepEqual(peers, { alex, sam }, 'mapping must not mutate the host snapshot');
});

test('geometry remains identical when another participant supplies the snapshot after taking over', () => {
  const a = participantPanelsForReceiver({ local: host, remote: fallback }, { alex, sam }, 'host', 'alex');
  const s = participantPanelsForReceiver(a.fixedPanels, a.remotePanels, 'alex', 'sam');
  assert.deepEqual(plain(s.fixedPanels.local), sam);
  assert.deepEqual(plain(s.remotePanels), { host, alex });
});

test('older snapshots without per-peer geometry use the sender remote slot for the joining client', () => {
  const next = participantPanelsForReceiver({ local: host, remote: fallback }, undefined, 'host', 'new-guest');
  assert.deepEqual(plain(next.fixedPanels.local), fallback);
  assert.deepEqual(plain(next.remotePanels), { host });
});
