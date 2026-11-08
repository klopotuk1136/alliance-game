import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellCount, gridCells, hexDistance, inGrid, neighbors } from '../../shared/hex.ts';

test('hex distance', () => {
  assert.equal(hexDistance({ q: 0, r: 0 }, { q: 0, r: 0 }), 0);
  assert.equal(hexDistance({ q: 0, r: 0 }, { q: 1, r: 0 }), 1);
  assert.equal(hexDistance({ q: 0, r: 0 }, { q: 1, r: -1 }), 1);
  assert.equal(hexDistance({ q: 0, r: 0 }, { q: 2, r: -1 }), 2);
  assert.equal(hexDistance({ q: -3, r: 0 }, { q: 3, r: 0 }), 6);
  assert.equal(hexDistance({ q: 2, r: 1 }, { q: -1, r: -2 }), 6);
});

test('every neighbour is at distance 1', () => {
  for (const n of neighbors({ q: 2, r: -1 })) assert.equal(hexDistance(n, { q: 2, r: -1 }), 1);
  assert.equal(neighbors({ q: 0, r: 0 }).length, 6);
});

test('grid of radius 6 has 127 cells, all inside', () => {
  const cells = gridCells(6);
  assert.equal(cells.length, 127);
  assert.equal(cellCount(6), 127);
  assert.ok(cells.every((c) => inGrid(c, 6)));
  assert.equal(new Set(cells.map((c) => `${c.q},${c.r}`)).size, 127);
  assert.equal(inGrid({ q: 7, r: 0 }, 6), false);
  assert.equal(inGrid({ q: 3, r: 3 }, 6), true);
  assert.equal(inGrid({ q: 4, r: 3 }, 6), false);
});
