import test from "node:test";
import assert from "node:assert/strict";
import { createGameEngine } from "../src/games.mjs";
const e = createGameEngine(() => .42);
test("2048 一步中每张牌只合并一次，且不改变输入", () => {
  const board = [2, 2, 2, 2, 4, 4, 8, 0, ...Array(8).fill(0)];
  const r = e.slide(board, "left");
  assert.deepEqual(r.board.slice(0, 8), [4, 4, 0, 0, 8, 8, 0, 0]); assert.equal(r.points, 16); assert.equal(board[0], 2);
  assert.deepEqual(e.slide(board, "right").board.slice(0, 4), [0, 0, 4, 4]);
  assert.equal(e.over2048({ board: [2,4,2,4,4,2,4,2,2,4,2,4,4,2,4,2] }), true);
});
test("扫雷首击安全、插旗阻止翻开、71个安全格通关", () => {
  const s = e.newMines(); e.flag(s, 40); e.reveal(s, 40); assert.equal(s.started, false);
  e.flag(s, 40); e.reveal(s, 40); assert.equal(e.count(s, 40), 0); assert.equal(s.bombs.length, 10);
  for (let i = 0; i < 81; i++) if (!s.bombs.includes(i)) e.reveal(s, i);
  assert.equal(s.won, true); assert.equal(s.open.length, 71);
});
test("接龙发牌守恒、翻牌循环、合法移动翻开底牌、拒绝非法移动", () => {
  const s = e.newSolitaire(); assert.equal(s.stock.length, 24);
  assert.equal(new Set([...s.stock, ...s.columns.flat()].map(c => c.id)).size, 52);
  assert.deepEqual(s.columns.map(p => p.filter(c => c.up).length), Array(7).fill(1));
  const stock = s.stock.map(c => c.id); for (let i = 0; i < 24; i++) e.draw(s); e.draw(s); assert.deepEqual(s.stock.map(c => c.id), stock);
  const c = (rank, suit, up = true) => ({ rank, suit, up });
  const x = { columns: [[c(9, 0, false), c(5, 1), c(4, 0)], [c(6, 3)], []], waste: [c(1, 2)], foundations: [[], [], [], []] };
  assert.equal(e.transfer(x, { kind: "column", pile: 0, index: 1 }, { kind: "column", pile: 2 }), false);
  assert.equal(e.transfer(x, { kind: "column", pile: 0, index: 1 }, { kind: "column", pile: 1 }), true);
  assert.equal(x.columns[0][0].up, true);
  assert.equal(e.transfer(x, { kind: "waste", index: 0 }, { kind: "foundation", pile: 0 }), true);
});
