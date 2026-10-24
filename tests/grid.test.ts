import { test } from "node:test";
import assert from "node:assert/strict";
import { COLS, GAP, GridItem, Limits, ROW_H, addItem, compact, findSpot, flowItems, growItem, moveItem, nudgeItem, overlap, removeItem, repairItems, resizeItem, rowsToPx, sizeRange } from "../src/grid";

const LIM: Limits = { minW: 2, maxW: 12, minH: 2, maxH: 10 };
const limitsOf = (id: string): Limits => (id.startsWith("n") ? { minW: 2, maxW: 4, minH: 2, maxH: 4 } : LIM);
const it = (id: string, x: number, y: number, w: number, h: number): GridItem => ({ id, x, y, w, h });
const pos = (items: GridItem[], id: string) => {
  const i = items.find((x) => x.id === id);
  assert.ok(i, id);
  return `${i.x},${i.y} ${i.w}x${i.h}`;
};

/** 不重叠、不越界、没有洞（每张卡要么在第 0 行，要么被正上方一行的卡挡住） */
function assertValid(items: GridItem[], label = "") {
  const ids = new Set<string>();
  for (const a of items) {
    assert.ok(!ids.has(a.id), `${label} 重复 ${a.id}`);
    ids.add(a.id);
    assert.ok(Number.isInteger(a.x) && Number.isInteger(a.y) && Number.isInteger(a.w) && Number.isInteger(a.h), `${label} 非整数 ${JSON.stringify(a)}`);
    assert.ok(a.x >= 0 && a.y >= 0 && a.w >= 1 && a.h >= 1 && a.x + a.w <= COLS, `${label} 越界 ${JSON.stringify(a)}`);
    for (const b of items) if (a !== b) assert.ok(!overlap(a, b), `${label} 重叠 ${a.id} ${b.id}`);
    if (a.y > 0) assert.ok(items.some((b) => b !== a && overlap(b, { ...a, y: a.y - 1 })), `${label} ${a.id} 悬空在第 ${a.y} 行`);
  }
}

/** 固定种子的随机数，失败了能复现 */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test("行高：h 行 = 40h + 16(h−1)，3 行正好 152px", () => {
  assert.equal(ROW_H, 40);
  assert.equal(GAP, 16);
  assert.equal(rowsToPx(3), 152);
  assert.equal(rowsToPx(1), 40);
});

test("上浮：悬空的卡往上补；已经紧凑的不动；再来一次结果不变", () => {
  const out = compact([it("a", 0, 0, 6, 3), it("b", 0, 7, 6, 2), it("c", 6, 5, 6, 2)]);
  assert.equal(pos(out, "b"), "0,3 6x2");
  assert.equal(pos(out, "c"), "6,0 6x2");
  assertValid(out);
  assert.deepEqual(compact(out), out);
});

test("拖动：往下拖过一张卡，两张换位置", () => {
  const base = [it("a", 0, 0, 12, 3), it("b", 0, 3, 12, 3), it("c", 0, 6, 12, 3)];
  const out = moveItem(base, "a", 0, 4);
  assertValid(out);
  assert.deepEqual(out.map((i) => i.id), ["b", "a", "c"]);
  assert.equal(pos(out, "a"), "0,3 12x3");
});

test("拖动：只拖一点点，位置回到原样", () => {
  const base = [it("a", 0, 0, 12, 3), it("b", 0, 3, 12, 3)];
  assert.deepEqual(moveItem(base, "a", 0, 1), base);
  assert.deepEqual(moveItem(base, "a", 0, 0), base);
});

test("拖动：往上拖到另一张卡上面，两张换位置", () => {
  const base = [it("a", 0, 0, 12, 3), it("b", 0, 3, 12, 3)];
  const out = moveItem(base, "b", 0, 1);
  assertValid(out);
  assert.deepEqual(out.map((i) => i.id), ["b", "a"]);
});

test("拖动：拖到右边空位，不影响别的卡；拖到页面外被夹住；拖到很下面会上浮", () => {
  const base = [it("a", 0, 0, 4, 3), it("b", 4, 0, 4, 3)];
  const right = moveItem(base, "a", 8, 0);
  assert.equal(pos(right, "a"), "8,0 4x3");
  assert.equal(pos(right, "b"), "4,0 4x3");
  assert.equal(pos(moveItem(base, "a", 99, 0), "a"), "8,0 4x3", "x 夹在 0 到 12−w");
  assert.equal(pos(moveItem(base, "a", -5, -5), "a"), "0,0 4x3");
  assert.equal(pos(moveItem(base, "a", 0, 40), "a"), "0,0 4x3", "没有东西挡着就上浮");
});

test("拖动：没被挡住的卡原地不动", () => {
  const base = [it("a", 0, 0, 4, 3), it("b", 4, 0, 4, 3), it("c", 8, 0, 4, 3), it("d", 0, 3, 12, 2)];
  const out = moveItem(base, "a", 4, 0);
  assertValid(out);
  assert.equal(pos(out, "c"), "8,0 4x3");
  assert.equal(pos(out, "a"), "4,0 4x3");
});

test("调大小：夹在范围里，不超出右边界；长高把下面的卡往下推", () => {
  const base = [it("n1", 8, 0, 2, 2), it("b", 0, 2, 12, 3)];
  assert.equal(pos(resizeItem(base, "n1", 9, 9, limitsOf), "n1"), "8,0 4x4", "n 类卡最大 4×4，右边也只剩 4 列");
  assert.equal(pos(resizeItem(base, "n1", 0, 0, limitsOf), "n1"), "8,0 2x2", "最小 2×2");
  const grown = resizeItem(base, "n1", 2, 4, limitsOf);
  assertValid(grown);
  assert.equal(pos(grown, "b"), "0,4 12x3");
  const back = resizeItem(grown, "n1", 2, 2, limitsOf);
  assert.equal(pos(back, "b"), "0,2 12x3", "缩回去，下面的卡补上来");
});

test("调大小：往右撑到邻居，邻居被推到下面，不会跑到上面去", () => {
  const base = [it("a", 0, 0, 4, 3), it("b", 4, 0, 4, 3), it("c", 0, 3, 4, 3)];
  const out = resizeItem(base, "a", 6, 3, limitsOf);
  assertValid(out);
  assert.equal(pos(out, "a"), "0,0 6x3");
  assert.equal(pos(out, "b"), "4,3 4x3");
});

test("sizeRange：右边界限制最大宽度", () => {
  assert.deepEqual(sizeRange(it("a", 9, 0, 3, 3), limitsOf), { maxW: 3, maxH: 10 });
  assert.deepEqual(sizeRange(it("n1", 0, 0, 2, 2), limitsOf), { maxW: 4, maxH: 4 });
});

test("键盘：方向键移动一格，Shift + 方向键调大小", () => {
  const base = [it("a", 0, 0, 4, 3), it("b", 4, 0, 4, 3)];
  assert.equal(pos(nudgeItem(base, "a", 0, 0), "a"), "0,0 4x3");
  assert.equal(pos(nudgeItem(base, "b", 1, 0), "b"), "5,0 4x3");
  const left = nudgeItem(base, "b", -1, 0);
  assert.equal(pos(left, "b"), "3,0 4x3", "往左一格压到 a，a 被挤到下面");
  assert.equal(pos(left, "a"), "0,3 4x3");
  const grown = growItem(base, "a", 1, 1, limitsOf);
  assert.equal(pos(grown, "a"), "0,0 5x4");
  assert.equal(pos(grown, "b"), "4,4 4x3", "撑到邻居，邻居被推到下面");
});

test("找空位：最后一行右边有空位就放那里，否则另起一行", () => {
  assert.deepEqual(findSpot([it("a", 0, 0, 12, 3), it("b", 0, 3, 8, 3)], 4, 3), { x: 8, y: 3 });
  assert.deepEqual(findSpot([it("a", 0, 0, 12, 3), it("b", 0, 3, 8, 3)], 6, 3), { x: 0, y: 6 });
  assert.deepEqual(findSpot([], 4, 3), { x: 0, y: 0 });
});

test("添加和移除：添加后不重叠；移除后下面的卡补上来；已有的不重复加", () => {
  let l = [it("a", 0, 0, 12, 3), it("b", 0, 3, 8, 3)];
  l = addItem(l, it("c", 0, 0, 4, 3));
  assertValid(l);
  assert.equal(pos(l, "c"), "8,3 4x3");
  assert.equal(addItem(l, it("c", 0, 0, 4, 3)), l);
  l = removeItem(l, "a");
  assertValid(l);
  assert.equal(pos(l, "b"), "0,0 8x3");
});

test("修复坏数据：去掉未知和重复、夹范围、拉回边界、推开重叠、上浮", () => {
  const raw = [
    { id: "a", x: 0, y: 0, w: 6, h: 3 },
    { id: "a", x: 6, y: 0, w: 6, h: 3 },
    { id: "gone", x: 0, y: 0, w: 2, h: 2 },
    { id: "b", x: 3, y: 1, w: 6, h: 3 },
    { id: "c", x: 11, y: 9, w: 99, h: 99 },
    { id: "d", x: "x", y: NaN, w: null, h: undefined },
    7,
    null,
  ];
  const out = repairItems(raw, limitsOf, (id) => id !== "gone");
  assertValid(out);
  assert.deepEqual(out.map((i) => i.id).sort(), ["a", "b", "c", "d"]);
  assert.equal(pos(out, "a"), "0,0 6x3", "重复的只留第一张");
  const c = out.find((i) => i.id === "c")!;
  assert.equal(c.w, 12);
  assert.equal(c.h, 10);
  assert.equal(c.x, 0);
  const d = out.find((i) => i.id === "d")!;
  assert.equal(d.w, 2, "没写宽高的用最小值");
  assert.equal(d.h, 2);
});

test("修复坏数据：已经合法的布局原样返回", () => {
  const ok = compact([it("a", 0, 0, 8, 6), it("b", 8, 0, 4, 6), it("c", 0, 6, 12, 5)]);
  assert.deepEqual(repairItems(ok, limitsOf, () => true), ok);
});

test("旧档位布局 → 网格：按顺序从左到右、从上到下，一行放不下就换行，矮卡下面的卡补上来", () => {
  const out = flowItems([
    { id: "a", w: 8, h: 6 },
    { id: "b", w: 4, h: 6 },
    { id: "c", w: 3, h: 3 },
    { id: "d", w: 3, h: 3 },
    { id: "e", w: 3, h: 3 },
    { id: "f", w: 3, h: 3 },
    { id: "g", w: 12, h: 5 },
    { id: "h", w: 8, h: 7 },
    { id: "i", w: 4, h: 7 },
  ]);
  assertValid(out);
  assert.equal(pos(out, "c"), "0,6 3x3");
  assert.equal(pos(out, "f"), "9,6 3x3");
  assert.equal(pos(out, "g"), "0,9 12x5");
  assert.equal(pos(out, "i"), "8,14 4x7");
});

test("旧档位布局 → 网格：高度不一样时，下一行排在这一行最高的卡下面再上浮", () => {
  const out = flowItems([{ id: "a", w: 6, h: 6 }, { id: "b", w: 6, h: 2 }, { id: "c", w: 6, h: 3 }, { id: "d", w: 6, h: 3 }]);
  assertValid(out);
  assert.equal(pos(out, "c"), "0,6 6x3");
  assert.equal(pos(out, "d"), "6,2 6x3", "b 矮，d 上浮补进 b 下面");
});

test("随机操作 2000 次：每一步之后都不重叠、不越界、没有洞，尺寸始终在范围里", () => {
  const rand = rng(20261024);
  const pick = (n: number) => Math.floor(rand() * n);
  for (let round = 0; round < 8; round++) {
    const entries = Array.from({ length: 4 + pick(12) }, (_, i) => ({ id: `${i % 3 === 0 ? "n" : "w"}${i}`, w: 2 + pick(8), h: 2 + pick(4) }));
    let l = repairItems(flowItems(entries), limitsOf, () => true);
    assertValid(l, `起点 ${round}`);
    const spare = Array.from({ length: 6 }, (_, i) => `s${round}-${i}`);
    for (let step = 0; step < 250; step++) {
      const target = l.length ? l[pick(l.length)].id : "";
      const op = pick(6);
      let label = `r${round} s${step} op${op}`;
      if (op <= 1 && target) {
        l = moveItem(l, target, pick(15) - 2, pick(40) - 3);
        label += ` move ${target}`;
      } else if (op === 2 && target) {
        l = resizeItem(l, target, pick(16) - 2, pick(14) - 2, limitsOf);
        label += ` resize ${target}`;
      } else if (op === 3 && target) {
        l = pick(2) ? nudgeItem(l, target, pick(3) - 1, pick(3) - 1) : growItem(l, target, pick(3) - 1, pick(3) - 1, limitsOf);
      } else if (op === 4 && l.length > 1) {
        l = removeItem(l, target);
        spare.push(target);
      } else if (spare.length) {
        const id = spare.pop() as string;
        const lim = limitsOf(id);
        l = addItem(l, it(id, 0, 0, Math.min(lim.maxW, 2 + pick(8)), Math.min(lim.maxH, 2 + pick(5))));
      }
      assertValid(l, label);
      for (const i of l) {
        const lim = limitsOf(i.id);
        assert.ok(i.w >= lim.minW && i.w <= lim.maxW && i.h >= lim.minH && i.h <= lim.maxH, `${label} ${JSON.stringify(i)}`);
      }
    }
  }
});

test("拖动结果只取决于起点布局和当前位置，和中间走过的路径无关", () => {
  const rand = rng(7);
  const pick = (n: number) => Math.floor(rand() * n);
  const base = repairItems(flowItems(Array.from({ length: 10 }, (_, i) => ({ id: `w${i}`, w: 2 + pick(8), h: 2 + pick(4) }))), limitsOf, () => true);
  for (let k = 0; k < 50; k++) {
    const id = base[pick(base.length)].id;
    const x = pick(12);
    const y = pick(20);
    for (let wander = 0; wander < 5; wander++) moveItem(base, id, pick(12), pick(20));
    assert.deepEqual(moveItem(base, id, x, y), moveItem(base, id, x, y));
  }
});
