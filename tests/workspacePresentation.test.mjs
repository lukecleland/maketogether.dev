import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
function load(path, imports = {}) {
  const scope = { exports: {}, require: name => imports[name] };
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, scope);
  return scope.exports;
}
test('landing sequence shuffles on load, returns to make every six displays, and preserves the lyric', () => {
  const { buildBrandWords, BRAND_WORD_DURATION } = load('src/utils/brandWords.ts');
  assert.equal(BRAND_WORD_DURATION, 2600);
  const expected = ['make','work','watch','create','record','jam','learn','sing','laugh','party','sketch','build','develop','write','compose','code','grow','produce','decide','teach','come','talk','stop','collaborate','listen'].sort();
  let seed = 12345;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const orders = new Set();
  for (let load = 0; load < 100; load++) {
    const words = Array.from(buildBrandWords(random));
    assert.equal(words.length, 30);
    assert.deepEqual([...new Set(words)].sort(), expected);
    for (let index = 0; index < words.length * 3; index++) {
      assert.equal(words[index % words.length] === 'make', index % 6 === 0);
    }
    const start = words.indexOf('stop');
    assert.deepEqual(words.slice(start, start + 3), ['stop', 'collaborate', 'listen']);
    orders.add(words.join(','));
  }
  assert.ok(orders.size > 90, 'separate page loads should receive different sequences');
});
test('overview fits mixed panels in desktop/mobile slots without changing their geometry', () => {
  const { layoutOverview } = load('src/utils/panelOverview.ts');
  const items = [{ id: 'video', label: 'You', width: 300, height: 400 }, { id: 'daw', label: 'DAW', width: 900, height: 480 }, { id: 'audio', label: 'Track', width: 360, height: 220 }, { id: 'pdf', label: 'PDF', width: 560, height: 720 }];
  const before = JSON.stringify(items);
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 1000 }]) {
    const frames = Object.values(layoutOverview(items, viewport));
    for (const frame of frames) {
      assert.ok(frame.x >= 0 && frame.y >= 0 && frame.width > 0 && frame.height > 0);
      assert.ok(frame.x + frame.width <= viewport.width);
      assert.ok(frame.y + frame.height + 28 <= viewport.height - 80);
    }
    for (let a = 0; a < frames.length; a++) for (let b = a + 1; b < frames.length; b++) {
      const x = frames[a], y = frames[b];
      assert.ok(x.x + x.width <= y.x || y.x + y.width <= x.x || x.y + x.height <= y.y || y.y + y.height <= x.y);
    }
  }
  assert.equal(JSON.stringify(items), before);
});
test('audio themes survive portable room exports and reject unknown themes', () => {
  const { serialiseRoomBundle, parseRoomBundle } = load('src/utils/roomBundle.ts', { './roomPersistence': { ROOM_STATE_VERSION: 2 } });
  const state = { x: 0, y: 0, width: 400, height: 400, z: 1 };
  const snapshot = { version: 2, savedAt: 1, viewport: { width: 1440, height: 1000 }, fixedPanels: { local: state, remote: state }, panels: [{ id: 'audio', type: 'audio', state, audioTheme: 'tape' }], drawings: [], positionTags: [], dockedIds: [], panelLabels: {}, customLabels: {}, canvas: { x: 0, y: 0, scale: 1 } };
  assert.equal(parseRoomBundle(serialiseRoomBundle(snapshot)).panels[0].audioTheme, 'tape');
  snapshot.panels[0].audioTheme = 'bad'; assert.throws(() => parseRoomBundle(serialiseRoomBundle(snapshot)), /damaged/);
  delete snapshot.panels[0].audioTheme; assert.equal(parseRoomBundle(serialiseRoomBundle(snapshot)).panels[0].audioTheme, undefined);
});
