import { test } from "node:test";
import assert from "node:assert/strict";
import { COLS, GAP, GridItem, Limits, ROW_H, addItem, displacedCount, compact, findSpot, flowItems, growItem, moveItem, moveItemSnap, nudgeItem, overlap, placeItem, placeItemSnap, removeItem, repairItems, resizeItem, rowsToPx, sizeRange } from "../src/grid";

const LIM: Limits = { minW: 2, maxW: 12, minH: 2, maxH: 10 };
const limitsOf = (id: string): Limits => (id.startsWith("n") ? { minW: 2, maxW: 4, minH: 2, maxH: 4 } : LIM);
const it = (id: string, x: number, y: number, w: number, h: number): GridItem => ({ id, x, y, w, h });
const pos = (items: GridItem[], id: string) => {
  const i = items.find((x) => x.id === id);
  assert.ok(i, id);
  return `${i.x},${i.y} ${i.w}x${i.h}`;
};

/** 不重叠、不越界、整数、id 不重复。自由摆放允许有空位，所以不检查“悬空” */
function assertValid(items: GridItem[], label = "") {
  const ids = new Set<string>();
  for (const a of items) {
    assert.ok(!ids.has(a.id), `${label} 重复 ${a.id}`);
    ids.add(a.id);
    assert.ok(Number.isInteger(a.x) && Number.isInteger(a.y) && Number.isInteger(a.w) && Number.isInteger(a.h), `${label} 非整数 ${JSON.stringify(a)}`);
    assert.ok(a.x >= 0 && a.y >= 0 && a.w >= 1 && a.h >= 1 && a.x + a.w <= COLS, `${label} 越界 ${JSON.stringify(a)}`);
    for (const b of items) if (a !== b) assert.ok(!overlap(a, b), `${label} 重叠 ${a.id} ${b.id}`);
  }
}

/** 没有洞：每张卡要么在第 0 行，要么被正上方一行的卡挡住（整理之后应该是这样） */
function assertTight(items: GridItem[], label = "") {
  for (const a of items) if (a.y > 0) assert.ok(items.some((b) => b !== a && overlap(b, { ...a, y: a.y - 1 })), `${label} ${a.id} 悬空在第 ${a.y} 行`);
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

test("sizeRange：右边界限制最大宽度", () => {
  assert.deepEqual(sizeRange(it("a", 9, 0, 3, 3), limitsOf), { maxW: 3, maxH: 10 });
  assert.deepEqual(sizeRange(it("n1", 0, 0, 2, 2), limitsOf), { maxW: 4, maxH: 4 });
});

test("拖动：落点就是指针所在的格子；x 夹在 0 到 12−w；最低排在所有卡的下面，不会悬在半空", () => {
  const base = [it("a", 0, 0, 4, 3), it("b", 4, 0, 4, 3)];
  assert.equal(pos(moveItem(base, "a", 8, 0), "a"), "8,0 4x3");
  assert.equal(pos(moveItem(base, "a", 99, 0), "a"), "8,0 4x3");
  assert.equal(pos(moveItem(base, "a", -5, -5), "a"), "0,0 4x3");
  assert.equal(pos(moveItem(base, "a", 0, 40), "a"), "0,3 4x3", "拖到很下面：排在所有卡的下面（b 的底边是第 3 行）");
  assert.equal(pos(moveItem(base, "a", 8, 2), "a"), "8,2 4x3", "放在空位里，想放哪就是哪，不会自动上浮");
  assert.equal(pos(moveItem(base, "a", 8, 2), "b"), "4,0 4x3");
});

test("拖动：不上浮——卡片留下的空位保持空着，别的卡不会自己补上来", () => {
  const base = [it("a", 0, 0, 12, 3), it("b", 0, 3, 12, 3), it("c", 0, 6, 12, 3)];
  const out = moveItem(base, "a", 0, 9);
  assertValid(out);
  assert.equal(pos(out, "a"), "0,9 12x3");
  assert.equal(pos(out, "b"), "0,3 12x3", "b 没动，上面留了空位");
  assert.equal(pos(out, "c"), "0,6 12x3");
  assert.deepEqual(compact(out).map((i) => `${i.id}:${i.y}`), ["b:0", "c:3", "a:6"], "整理之后才补齐");
});

test("拖动：同大小的两张卡互换，别的卡一张都不动", () => {
  const base = [it("a", 0, 0, 4, 3), it("b", 4, 0, 4, 3), it("c", 8, 0, 4, 3), it("d", 0, 3, 12, 2)];
  const out = moveItem(base, "c", 0, 0);
  assertValid(out);
  assert.equal(pos(out, "c"), "0,0 4x3");
  assert.equal(pos(out, "a"), "8,0 4x3", "a 进了 c 刚离开的位置");
  assert.equal(pos(out, "b"), "4,0 4x3");
  assert.equal(pos(out, "d"), "0,3 12x2");
  assert.equal(displacedCount(base, out, "c"), 1);
});

test("拖动：压住别的卡时，那张卡就近让开：附近有空位就挪到空位，别的卡不动", () => {
  const base = [it("a", 0, 0, 4, 3), it("b", 4, 0, 4, 3), it("c", 0, 6, 4, 3)];
  // a 拖到 b 上：b 去 a 空出来的位置（互换），不会被推到下面
  const out = moveItem(base, "a", 4, 0);
  assertValid(out);
  assert.equal(pos(out, "a"), "4,0 4x3");
  assert.equal(pos(out, "b"), "0,0 4x3");
  assert.equal(pos(out, "c"), "0,6 4x3");
});

test("拖动：压住大小不同的卡、附近又没有空位时，被压住的卡往下推，连锁推下去，但谁也不重叠、一张不少", () => {
  const base = [it("a", 0, 0, 4, 3), it("b", 4, 0, 8, 6), it("c", 0, 3, 4, 3), it("d", 4, 6, 8, 3)];
  const out = moveItem(base, "a", 6, 2);
  assertValid(out);
  assert.equal(pos(out, "a"), "6,2 4x3");
  assert.deepEqual(out.map((i) => i.id).sort(), ["a", "b", "c", "d"]);
});

test("拖动：只拖一点点，位置回到原样；落回原处什么都不变", () => {
  const base = [it("a", 0, 0, 12, 3), it("b", 0, 3, 12, 3)];
  assert.deepEqual(moveItem(base, "a", 0, 0), base);
  assert.deepEqual(moveItemSnap(base, "a", 0, 0), base);
});

test("拖动落点：指针格子会压住别的卡、而旁边一格正好有放得下的空位时，落进那个空位；否则落点不偏", () => {
  const base = [it("a", 0, 0, 4, 3), it("b", 4, 0, 4, 3), it("c", 0, 3, 4, 3)];
  // a 拖到 (7,0)：压住 b 的右半边；往右一格 (8,0) 是空位
  const snap = moveItemSnap(base, "a", 7, 0);
  assert.equal(pos(snap, "a"), "8,0 4x3");
  assert.equal(displacedCount(base, snap, "a"), 0);
  // 没有这样的空位时，不偏：压住 b，落点就是 (5,0)
  const tight = [it("a", 0, 0, 4, 3), it("b", 4, 0, 4, 3), it("c", 8, 0, 4, 3)];
  const out = moveItemSnap(tight, "a", 5, 0);
  assert.equal(pos(out, "a"), "5,0 4x3");
  assertValid(out);
});

test("调大小：夹在范围里，不超出右边界；长高把下面的卡往下推，缩回去不会自动补位", () => {
  const base = [it("n1", 8, 0, 2, 2), it("b", 0, 2, 12, 3)];
  assert.equal(pos(resizeItem(base, "n1", 9, 9, limitsOf), "n1"), "8,0 4x4", "n 类卡最大 4×4，右边也只剩 4 列");
  assert.equal(pos(resizeItem(base, "n1", 0, 0, limitsOf), "n1"), "8,0 2x2", "最小 2×2");
  const grown = resizeItem(base, "n1", 2, 4, limitsOf);
  assertValid(grown);
  assert.equal(pos(grown, "b"), "0,4 12x3");
  const back = resizeItem(grown, "n1", 2, 2, limitsOf);
  assert.equal(pos(back, "b"), "0,4 12x3", "缩回去，b 留在原处，上面留了空位");
  assert.equal(pos(compact(back), "b"), "0,2 12x3", "整理之后补上来");
});

test("调大小：往右撑到邻居，邻居向右让一让（右边没空位就让到别处），谁也不重叠", () => {
  const base = [it("a", 0, 0, 4, 3), it("b", 4, 0, 4, 3), it("c", 0, 3, 4, 3)];
  const out = resizeItem(base, "a", 6, 3, limitsOf);
  assertValid(out);
  assert.equal(pos(out, "a"), "0,0 6x3");
  assert.equal(pos(out, "b"), "6,0 4x3");
  assert.equal(pos(out, "c"), "0,3 4x3");
  const tight = resizeItem([it("a", 0, 0, 4, 3), it("b", 4, 0, 8, 3), it("c", 0, 3, 4, 3)], "a", 6, 3, limitsOf);
  assertValid(tight);
  assert.equal(pos(tight, "a"), "0,0 6x3");
});

test("调大小：下面的卡被挡住时让开，一张不少、谁也不重叠", () => {
  const base = [it("a", 0, 0, 12, 3), it("b", 0, 3, 12, 3), it("c", 0, 6, 12, 3), it("d", 0, 9, 6, 3), it("e", 6, 9, 6, 3)];
  const out = resizeItem(base, "a", 12, 5, limitsOf);
  assertValid(out);
  assert.equal(pos(out, "a"), "0,0 12x5");
  assert.ok(out.find((i) => i.id === "b")!.y >= 5);
  assert.deepEqual(out.map((i) => i.id).sort(), ["a", "b", "c", "d", "e"]);
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
  assertValid(left);
  assert.equal(pos(left, "b"), "3,0 4x3", "往左一格压到 a，a 让开");
  const grown = growItem(base, "a", 1, 1, limitsOf);
  assertValid(grown);
  assert.equal(pos(grown, "a"), "0,0 5x4");
  assert.equal(pos(grown, "b"), "5,0 4x3", "撑到邻居，邻居向右让一让");
});

test("找空位：从最上面开始先填空位，没有空位就排在所有卡的下面", () => {
  assert.deepEqual(findSpot([it("a", 0, 0, 12, 3), it("b", 0, 3, 8, 3)], 4, 3), { x: 8, y: 3 });
  assert.deepEqual(findSpot([it("a", 0, 0, 12, 3), it("b", 0, 3, 8, 3)], 6, 3), { x: 0, y: 6 });
  assert.deepEqual(findSpot([], 4, 3), { x: 0, y: 0 });
  assert.deepEqual(findSpot([it("a", 0, 0, 4, 3), it("b", 8, 0, 4, 3), it("c", 0, 3, 12, 3)], 4, 3), { x: 4, y: 0 }, "上面有空位就先填上面的");
});

test("添加和移除：添加后不重叠；移除后空位保持空着；已有的不重复加", () => {
  let l = [it("a", 0, 0, 12, 3), it("b", 0, 3, 8, 3)];
  l = addItem(l, it("c", 0, 0, 4, 3));
  assertValid(l);
  assert.equal(pos(l, "c"), "8,3 4x3");
  assert.equal(addItem(l, it("c", 0, 0, 4, 3)), l);
  l = removeItem(l, "a");
  assertValid(l);
  assert.equal(pos(l, "b"), "0,3 8x3", "移除后别的卡不动，上面留空位");
  assert.equal(pos(compact(l), "b"), "0,0 8x3", "整理之后补上来");
});

test("修复坏数据：去掉未知和重复、夹范围、拉回边界、推开重叠（不上浮）", () => {
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

test("displacedCount：不算被拖的那张，位置或大小变了才算", () => {
  const base = [it("a", 0, 0, 4, 3), it("b", 4, 0, 4, 3)];
  assert.equal(displacedCount(base, base, "a"), 0);
  assert.equal(displacedCount(base, [it("a", 8, 0, 4, 3), it("b", 4, 0, 4, 3)], "a"), 0);
  assert.equal(displacedCount(base, [it("a", 8, 0, 4, 3), it("b", 4, 0, 6, 3)], "a"), 1);
});

test("拖入新卡：落在指定格子；放在空位不影响别的卡；压住的卡就近让开；已有的不重复放", () => {
  const base = [it("a", 0, 0, 6, 4), it("b", 6, 0, 6, 4), it("c", 0, 4, 12, 3)];
  const empty = placeItem(base, it("n1", 0, 0, 4, 3), 0, 7);
  assertValid(empty);
  assert.equal(pos(empty, "n1"), "0,7 4x3", "放在最下面的空位");
  assert.equal(displacedCount(base, empty, "n1"), 0);
  assert.equal(pos(placeItem(base, it("n1", 0, 0, 4, 3), 0, 99), "n1"), "0,7 4x3", "放到很下面：排在所有卡的下面");
  const mid = placeItem(base, it("n1", 0, 0, 4, 3), 4, 0);
  assertValid(mid);
  assert.equal(pos(mid, "n1"), "4,0 4x3", "落点就是指定的格子");
  assert.ok(base.every((b) => mid.some((m) => m.id === b.id && m.w === b.w && m.h === b.h)), "老卡一张不少、大小不变");
  assert.equal(placeItem(base, it("a", 0, 0, 2, 2), 3, 3), base, "已经在的原样返回");
  const clamped = placeItem(base, it("n2", 0, 0, 5, 3), 11, -4);
  assertValid(clamped);
  assert.equal(clamped.find((m) => m.id === "n2")!.x, 7, "右边夹进栅格");
});

test("拖入新卡：旁边一格有放得下的空位就落进去，否则落点不偏", () => {
  const base = [it("a", 0, 0, 4, 3), it("b", 4, 0, 4, 3)];
  const snap = placeItemSnap(base, it("n", 0, 0, 4, 3), 7, 0);
  assert.equal(pos(snap, "n"), "8,0 4x3");
  assert.equal(displacedCount(base, snap, "n"), 0);
});

test("随机拖入和拖动 2000 次：每一步之后都不重叠、不越界，老卡一张不少、大小不变；整理之后没有洞", () => {
  const rand = rng(424242);
  const pick = (n: number) => Math.floor(rand() * n);
  for (let round = 0; round < 8; round++) {
    const entries = Array.from({ length: 3 + pick(8) }, (_, i) => ({ id: `w${i}`, w: 2 + pick(8), h: 2 + pick(4) }));
    let l = repairItems(flowItems(entries), limitsOf, () => true);
    for (let step = 0; step < 250; step++) {
      const before = l.map((i) => `${i.id}:${i.w}x${i.h}`);
      if (pick(2)) {
        const id = `x${round}-${step}`;
        l = placeItemSnap(l, it(id, 0, 0, 2 + pick(8), 2 + pick(4)), pick(14) - 1, pick(30) - 2);
      } else if (l.length) {
        const target = l[pick(l.length)];
        l = moveItemSnap(l, target.id, pick(14) - 1, pick(30) - 2);
      }
      assertValid(l, `r${round} s${step}`);
      assert.ok(before.every((b) => l.some((i) => `${i.id}:${i.w}x${i.h}` === b)), "老卡不丢、大小不变");
      if (l.length > 14) l = removeItem(l, l[pick(l.length)].id);
    }
    assertTight(compact(l), `整理 ${round}`);
  }
});

test("落点精确：除了夹进栅格和排到最后一行，卡片总是落在指针所在的格子（默认版面里任何格子）", () => {
  const base = [it("a", 0, 0, 8, 6), it("b", 8, 0, 4, 6), it("c", 0, 6, 3, 3), it("d", 3, 6, 3, 3), it("e", 6, 6, 3, 3), it("f", 9, 6, 3, 3), it("g", 0, 9, 12, 5)];
  const bottom = (id: string) => Math.max(...base.filter((i) => i.id !== id).map((i) => i.y + i.h));
  for (const c of base) for (let y = 0; y < 18; y++) for (let x = 0; x <= COLS - c.w; x++) {
    const me = moveItem(base, c.id, x, y).find((i) => i.id === c.id)!;
    assert.equal(`${me.x},${me.y}`, `${x},${Math.min(y, bottom(c.id))}`, `${c.id} → ${x},${y}`);
  }
});
