import { test } from "node:test";
import assert from "node:assert/strict";
import { COLS, overlap } from "../src/grid";

const OPTIONAL = ["trendHub", "overview", "checkupHub", "structure", "habits", "tasksHub", "recent", "goals", "monthCompare", "lengths"];
import { WIDGETS, WidgetId, addWidget, defaultLayout, hiddenWidgets, limitsOf, normalizeLayout, readingOrder, removeWidget, sameLayout, widgetInfo } from "../src/widgets";

const at = (l: { items: { id: string; x: number; y: number; w: number; h: number }[] }, id: string) => {
  const i = l.items.find((x) => x.id === id);
  assert.ok(i, id);
  return `${i.x},${i.y} ${i.w}x${i.h}`;
};

test("默认布局：和方案第 10 节一致，全部卡片都在看板上", () => {
  const d = defaultLayout();
  assert.equal(d.version, 2);
  // 合并卡和 2.0 之后新增的卡片默认不放在看板上，在“添加卡片”里加
  assert.deepEqual(hiddenWidgets(d).map((w) => w.id).sort(), [...OPTIONAL].sort());
  assert.equal(d.items.length, WIDGETS.length - OPTIONAL.length);
  const expected: Record<string, string> = {
    hero: "0,0 8x6",
    tasks: "8,0 4x6",
    notes: "0,6 3x3",
    words: "3,6 3x3",
    taskRate: "6,6 3x3",
    month: "9,6 3x3",
    heat: "0,9 12x5",
    trend: "0,14 8x7",
    tags: "8,14 4x7",
    calendar: "0,21 4x7",
    rhythm: "4,21 4x4",
    density: "4,25 4x3",
    activity: "8,21 4x4",
    folders: "8,25 4x3",
    topLinked: "0,28 4x5",
    taskNotes: "4,28 4x5",
    brokenLinks: "8,28 4x5",
    orphans: "0,33 4x5",
    sameName: "4,33 4x5",
    emptyBig: "8,33 4x5",
    unusedFiles: "0,38 6x4",
    dupes: "6,38 6x4",
    reports: "0,42 12x4",
  };
  for (const [id, pos] of Object.entries(expected)) assert.equal(at(d, id), pos, id);
});

test("每张卡的默认大小在它自己的范围里，范围本身合理", () => {
  for (const w of WIDGETS) {
    assert.ok(w.minW >= 1 && w.minW <= w.w && w.w <= w.maxW && w.maxW <= COLS, `${w.id} 宽`);
    assert.ok(w.minH >= 1 && w.minH <= w.h && w.h <= w.maxH, `${w.id} 高`);
    assert.deepEqual(limitsOf(w.id), { minW: w.minW, maxW: w.maxW, minH: w.minH, maxH: w.maxH });
  }
  assert.equal(new Set(WIDGETS.map((w) => w.id)).size, WIDGETS.length, "id 不重复");
});

test("读布局：合法的布局原样读回（读两遍结果也不变）", () => {
  const d = defaultLayout();
  assert.deepEqual(normalizeLayout(JSON.parse(JSON.stringify(d))), d);
  assert.deepEqual(normalizeLayout(normalizeLayout(d)), d);
});

test("读布局：没有或读不懂回到默认；用户把卡片全移除也保留", () => {
  assert.ok(sameLayout(normalizeLayout(undefined), defaultLayout()));
  assert.ok(sameLayout(normalizeLayout({ items: "x" }), defaultLayout()));
  assert.deepEqual(normalizeLayout({ version: 2, items: [] }).items, []);
});

test("读布局（坏数据）：未知卡、重复卡去掉，尺寸夹进范围，重叠的推开，越界的拉回", () => {
  const n = normalizeLayout({
    version: 2,
    items: [
      { id: "heat", x: 0, y: 0, w: 99, h: 99 },
      { id: "gone", x: 0, y: 0, w: 3, h: 3 },
      { id: "heat", x: 0, y: 5, w: 6, h: 4 },
      { id: "density", x: 11, y: 0, w: 1, h: 1 },
      { id: "notes", x: 2, y: 1, w: 3, h: 3 },
      7,
    ],
  });
  assert.deepEqual(n.items.map((i) => i.id).sort(), ["density", "heat", "notes"]);
  assert.equal(at(n, "heat"), "0,0 12x6", "heat 最大 12×6");
  const d = n.items.find((i) => i.id === "density")!;
  assert.deepEqual([d.w, d.h], [2, 2], "density 最小 2×2");
  assert.ok(d.x + d.w <= COLS);
  for (const a of n.items) for (const b of n.items) if (a !== b) assert.ok(!overlap(a, b), `${a.id} ${b.id}`);
});

test("迁移：2.0 开发中的档位布局按原来的顺序摆进网格，库体检换成拆分后的 6 张卡", () => {
  const v1 = {
    version: 1,
    items: [
      ["hero", "l"], ["tasks", "m"], ["notes", "s"], ["words", "s"], ["taskRate", "s"], ["month", "s"],
      ["heat", "xl"], ["trend", "l"], ["tags", "m"], ["rhythm", "m"], ["activity", "m"], ["topLinked", "m"],
      ["folders", "m"], ["taskNotes", "m"], ["density", "s"], ["checkup", "xl"], ["reports", "xl"],
    ].map(([id, size]) => ({ id, size })),
  };
  const m = normalizeLayout(v1);
  assert.equal(m.version, 2);
  assert.equal(at(m, "hero"), "0,0 8x6");
  assert.equal(at(m, "tasks"), "8,0 4x6");
  assert.equal(at(m, "notes"), "0,6 3x3");
  assert.equal(at(m, "heat"), "0,9 12x5");
  assert.equal(at(m, "trend"), "0,14 8x7");
  assert.equal(at(m, "rhythm"), "0,21 4x4");
  assert.equal(at(m, "density"), "8,25 3x3", "链接密度按 S 的 3 列迁移");
  for (const id of ["brokenLinks", "orphans", "sameName", "emptyBig", "unusedFiles", "dupes"]) assert.ok(widgetInfo(id), id);
  const ids = m.items.map((i) => i.id);
  for (const id of ["brokenLinks", "orphans", "sameName", "emptyBig", "unusedFiles", "dupes"]) assert.ok(ids.includes(id as WidgetId), id);
  assert.ok(!ids.includes("checkup" as WidgetId));
  assert.ok(readingOrder(m).findIndex((i) => i.id === "brokenLinks") < readingOrder(m).findIndex((i) => i.id === "reports"), "拆分后的卡还在写作回顾前面");
  for (const a of m.items) for (const b of m.items) if (a !== b) assert.ok(!overlap(a, b), `${a.id} ${b.id}`);
});

test("迁移：不带 version 但带 size 的也按档位布局处理；隐藏着的卡片迁移后仍然隐藏；档位给的列数夹进范围", () => {
  const m = normalizeLayout({ items: [{ id: "hero", size: "m" }, { id: "heat", size: "s" }, { id: "gone", size: "m" }, { id: "hero", size: "xl" }] });
  assert.equal(m.version, 2);
  assert.deepEqual(m.items.map((i) => i.id), ["hero", "heat"]);
  assert.equal(at(m, "hero"), "0,0 5x6", "hero 最窄 5 列");
  assert.equal(m.items.find((i) => i.id === "heat")!.w, 6, "heat 最窄 6 列");
  assert.deepEqual(hiddenWidgets(m).map((w) => w.id).includes("tasks"), true);
});

test("编辑：添加用这张卡的默认大小，放在最后一行第一个放得下的位置；移除后下面的补上来", () => {
  let l = removeWidget(defaultLayout(), "dupes");
  assert.deepEqual(hiddenWidgets(l).map((w) => w.id).filter((id) => !OPTIONAL.includes(id)), ["dupes"]);
  l = addWidget(l, "dupes");
  assert.equal(at(l, "dupes"), "0,46 4x4", "从最后一行往下找：最后一行是满的，另起一行");
  assert.ok(sameLayout(addWidget(l, "dupes"), l), "已经在的不重复加");
  l = removeWidget(l, "reports");
  assert.equal(hiddenWidgets(l).filter((w) => !OPTIONAL.includes(w.id)).length, 1);
  l = addWidget(l, "reports");
  assert.equal(at(l, "reports"), "0,46 12x4", "整行的卡放不进最后一行，另起一行");
  const gone = removeWidget(defaultLayout(), "hero");
  assert.equal(at(gone, "notes"), "0,0 3x3", "移除后下面的卡补上来");
  for (const a of gone.items) for (const b of gone.items) if (a !== b) assert.ok(!overlap(a, b));
});

test("sameLayout：位置或大小不同就不相同", () => {
  const a = defaultLayout();
  const b = JSON.parse(JSON.stringify(a));
  assert.ok(sameLayout(a, b));
  b.items[3].w += 1;
  assert.ok(!sameLayout(a, b));
});
