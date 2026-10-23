import { test } from "node:test";
import assert from "node:assert/strict";
import { SIZE_SPAN, WIDGETS, addWidget, defaultLayout, hiddenWidgets, moveWidget, normalizeLayout, placeWidget, removeWidget, sameLayout, setSize } from "../src/widgets";

test("默认布局：1.8 的卡片在前且位置不变，6 张新卡片默认打开，每行不超过 12 列", () => {
  const d = defaultLayout();
  assert.deepEqual(d.items.slice(0, 9).map((i) => `${i.id}:${i.size}`), [
    "hero:l", "tasks:m", "notes:s", "words:s", "taskRate:s", "month:s", "heat:xl", "trend:l", "tags:m",
  ]);
  for (const id of ["topLinked", "rhythm", "activity", "taskNotes", "density", "folders"]) assert.ok(d.items.some((i) => i.id === id), id);
  assert.equal(hiddenWidgets(d).length, 0, "默认所有卡片都在看板上");
  // 按顺序摆：一行放不下就换行
  let row = 0;
  for (const i of d.items) {
    const span = SIZE_SPAN[i.size];
    if (row + span > 12) row = 0;
    row += span;
    assert.ok(row <= 12);
  }
});

test("每张卡的默认档位在它支持的档位里", () => {
  for (const w of WIDGETS) assert.ok(w.sizes.length > 0, w.id);
  for (const i of defaultLayout().items) assert.ok(WIDGETS.find((w) => w.id === i.id)?.sizes.includes(i.size), `${i.id}:${i.size}`);
});

test("读布局：坏数据回到默认；未知卡片、重复项去掉；不支持的档位换成默认档位", () => {
  assert.ok(sameLayout(normalizeLayout(null), defaultLayout()));
  assert.ok(sameLayout(normalizeLayout({ items: "x" }), defaultLayout()));
  const n = normalizeLayout({ items: [{ id: "heat", size: "s" }, { id: "gone", size: "m" }, { id: "heat", size: "xl" }, { id: "density", size: "s" }, 7] });
  assert.deepEqual(n.items, [{ id: "heat", size: "xl" }, { id: "density", size: "s" }]);
  assert.deepEqual(normalizeLayout({ items: [] }).items, [], "用户把卡片全隐藏了也保留");
});

test("编辑：换尺寸只接受支持的档位；隐藏、添加、移动、拖放", () => {
  let l = defaultLayout();
  assert.ok(sameLayout(setSize(l, "density", "xl"), l), "链接密度只有 S");
  l = setSize(l, "tags", "l");
  assert.equal(l.items.find((i) => i.id === "tags")?.size, "l");
  l = removeWidget(l, "rhythm");
  assert.deepEqual(hiddenWidgets(l).map((w) => w.id), ["rhythm"]);
  l = addWidget(l, "rhythm");
  assert.deepEqual(l.items.at(-1), { id: "rhythm", size: "m" }, "加到最后，用默认档位");
  assert.ok(sameLayout(addWidget(l, "rhythm"), l), "已经在的不重复加");
  const first = l.items[0].id;
  assert.ok(sameLayout(moveWidget(l, first, -1), l), "第一张不能再往前");
  assert.equal(moveWidget(l, first, 1).items[1].id, first);
  const placed = placeWidget(l, "reports", "hero");
  assert.equal(placed.items[0].id, "reports");
  assert.equal(placeWidget(l, "hero", null).items.at(-1)?.id, "hero");
});
