import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

function audio(globals) {
  const context = { exports: {}, ...globals };
  const source = readFileSync(new URL('../src/utils/dawAudio.ts', import.meta.url), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, context);
  return context.exports;
}

test('DAW selects the shared playback/capture route before creating Web Audio', () => {
  const events = [];
  let type = 'auto';
  const audioSession = { get type() { return type; }, set type(next) { type = next; events.push(next); } };
  const daw = audio({ navigator: { audioSession }, AudioContext: class { constructor() { events.push('context'); } } });
  daw.createDawAudioContext();
  assert.deepEqual(events, ['play-and-record', 'context']);
  assert.equal(type, 'play-and-record');
});

test('Safari interrupted contexts require recovery and gesture unlock primes output synchronously', async () => {
  const events = [], source = { connect() { events.push('connect'); }, start() { events.push('start'); }, disconnect() { events.push('disconnect'); } };
  const ctx = {
    state: 'interrupted', sampleRate: 44100, destination: {},
    resume() { events.push('resume'); return Promise.resolve(); },
    createBufferSource() { return source; },
    createBuffer(channels, frames, rate) { assert.deepEqual([channels, frames, rate], [1, 1, 44100]); return {}; },
  };
  const daw = audio({});
  assert.equal(daw.dawAudioNeedsGesture(ctx), true);
  const pending = daw.resumeDawAudio(ctx, true);
  assert.deepEqual(events, ['resume', 'connect', 'start'], 'unlock must happen before an await or permission prompt');
  await pending; source.onended();
  assert.equal(events.at(-1), 'disconnect');
  for (const state of ['suspended', 'interrupted']) assert.equal(daw.dawAudioNeedsGesture({ state }), true);
  for (const state of ['running', 'closed']) assert.equal(daw.dawAudioNeedsGesture({ state }), false);
});

test('unsupported/rejected audio-session configuration and prefixed Safari constructors are supported', () => {
  const ctx = {};
  const fallback = audio({ webkitAudioContext: function () { return ctx; } });
  assert.equal(fallback.createDawAudioContext(), ctx);
  const rejecting = audio({ AudioContext: function () { return ctx; }, navigator: { audioSession: { set type(_value) { throw new Error('Unsupported'); } } } });
  assert.equal(rejecting.createDawAudioContext(), ctx);
  assert.throws(() => audio({}).createDawAudioContext(), /not supported/);
});

test('already running contexts and remote retries do not create extra unlock sources', async () => {
  const daw = audio({}), ctx = { state: 'running', resume: async () => {} };
  await daw.resumeDawAudio(ctx, true);
  ctx.state = 'interrupted';
  await daw.resumeDawAudio(ctx);
});
