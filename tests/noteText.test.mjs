import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/utils/noteText.ts', import.meta.url), 'utf8');
const context = { exports: {} };
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, context);
const { fitNoteText } = context.exports;

function field(value, width = 240, height = 180) {
  return {
    value, clientWidth: width, clientHeight: height, style: { fontSize: '14px', overflow: 'auto' },
    get scrollWidth() { return this.clientWidth; },
    get scrollHeight() {
      const size = parseFloat(this.style.fontSize);
      const columns = Math.max(1, Math.floor(this.clientWidth / (size * 0.6)));
      const lines = this.value.split('\n').reduce((total, line) => total + Math.max(1, Math.ceil(line.length / columns)), 0);
      return Math.max(this.clientHeight, Math.ceil(lines * size * 1.375));
    },
  };
}

test('short notes grow; more text shrinks; removing text grows again', () => {
  const note = field('Hello');
  fitNoteText(note);
  const shortSize = parseFloat(note.style.fontSize);
  assert.ok(shortSize > 14);
  note.value = 'A longer note with words that wrap. '.repeat(12);
  fitNoteText(note);
  assert.ok(parseFloat(note.style.fontSize) < shortSize);
  assert.equal(note.scrollHeight, note.clientHeight);
  note.value = 'Hello';
  fitNoteText(note);
  assert.equal(parseFloat(note.style.fontSize), shortSize);
  assert.equal(note.style.overflow, 'auto');
});

test('resizing and explicit line breaks constrain the fitted font', () => {
  const note = field('First\nSecond\nThird', 240, 180);
  fitNoteText(note);
  const largeSize = parseFloat(note.style.fontSize);
  assert.equal(note.scrollHeight, note.clientHeight);
  note.clientWidth = 120;
  note.clientHeight = 80;
  fitNoteText(note);
  assert.ok(parseFloat(note.style.fontSize) < largeSize);
  assert.equal(note.scrollHeight, note.clientHeight);
});

test('empty and hidden notes remain stable; oversized content stays scrollable', () => {
  const note = field('');
  fitNoteText(note);
  assert.equal(note.style.fontSize, '14px');
  note.clientWidth = 0;
  note.value = 'Hidden';
  fitNoteText(note);
  assert.equal(note.style.fontSize, '14px');
  note.clientWidth = 240;
  note.value = 'Very long content '.repeat(1000);
  fitNoteText(note);
  assert.equal(note.style.fontSize, '8px');
  assert.equal(note.style.overflow, 'auto');
});
