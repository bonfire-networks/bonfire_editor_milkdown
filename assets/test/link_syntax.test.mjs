import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ATOM, closingParen, linkCandidates } from '../js/link_syntax.js';

const sources = text => linkCandidates(text).map(({ start, end }) => text.slice(start, end));

test('a plain link is a candidate, with its offsets', () => {
  assert.deepEqual(linkCandidates('see [a](https://example.com) ok'), [{ start: 4, labelEnd: 6, end: 28 }]);
});

test('brackets in the URL must balance', () => {
  assert.deepEqual(sources('[w](https://en.wikipedia.org/wiki/Foo_(bar)) x'), ['[w](https://en.wikipedia.org/wiki/Foo_(bar))']);
  assert.deepEqual(sources('[w](https://en.wikipedia.org/wiki/Foo_(bar)'), []);
});

test('a quoted title may hold a closing bracket', () => {
  assert.deepEqual(sources('[a](https://example.com "x)")'), ['[a](https://example.com "x)")']);
});

test('images, escaped brackets and empty labels are not candidates', () => {
  assert.deepEqual(sources('![a](https://example.com/x.png)'), []);
  assert.deepEqual(sources('\\[a](https://example.com)'), []);
  assert.deepEqual(sources('[](https://example.com)'), []);
});

test('a backslash pair before a link is not an escape', () => {
  assert.deepEqual(sources('C:\\\\[docs](https://example.com)'), ['[docs](https://example.com)']);
});

test('a leaf node ends the search', () => {
  assert.deepEqual(sources(`[a](https://exa${ATOM}mple.com)`), []);
  assert.deepEqual(sources(`[a${ATOM}b](https://example.com)`), []);
});

test('closingParen skips escaped brackets', () => {
  assert.equal(closingParen('a\\)b)', 0), 4);
  assert.equal(closingParen('no close', 0), -1);
});
