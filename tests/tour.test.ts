import { test } from "node:test";
import assert from "node:assert/strict";
import { GUIDE_VERSION, placeCard, tourSteps, visibleRect } from "../src/tour-logic";

test("引导步骤（电脑）：id 不重复，文字不为空；先讲看、再进编辑、再讲添加，最后回到看板；展开面板时一定在编辑模式里", () => {
  const steps = tourSteps(true);
  const ids = steps.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const s of steps) {
    assert.ok(s.title.length > 0 && s.body.length > 10, s.id);
    if (s.state.addOpen) assert.ok(s.state.editing, `${s.id} 展开面板必须在编辑模式`);
    if (s.demo) assert.ok(s.target, `${s.id} 有演示就要有目标`);
  }
  const at = (id: string) => ids.indexOf(id);
  assert.ok(at("edit") > at("greeting") && at("drag") > at("edit") && at("resize") > at("drag") && at("add") > at("switch") && at("library") > at("add") && at("done") > at("library"));
  assert.equal(steps[0].target, undefined, "第一步没有目标（欢迎）");
  assert.equal(steps[steps.length - 1].target, undefined, "最后一步没有目标");
  assert.deepEqual(steps[steps.length - 1].state, { editing: false, addOpen: false }, "最后回到普通看板");
  assert.equal(steps.find((s) => s.id === "library")!.state.addOpen, true);
  assert.equal(steps.find((s) => s.id === "drag")!.state.addOpen, false);
});

test("引导步骤（手机、窄面板）：只讲看得到的，不进编辑模式", () => {
  const steps = tourSteps(false);
  assert.ok(steps.length >= 3 && steps.length < tourSteps(true).length);
  for (const s of steps) {
    assert.equal(s.state.editing, false, s.id);
    assert.equal(s.demo, undefined, s.id);
  }
  assert.ok(!steps.some((s) => ["edit", "drag", "resize", "add", "library", "done"].includes(s.id)));
});

test("可能找不到目标的步骤（提醒、带切换的卡片）标成可选，其余必有目标的不可选", () => {
  for (const wide of [true, false]) {
    for (const s of tourSteps(wide)) {
      if (["alerts", "cards", "switch"].includes(s.id)) assert.ok(s.optional, s.id);
      if (["greeting", "edit", "drag", "resize", "add", "library", "done"].includes(s.id)) assert.ok(!s.optional, s.id);
    }
  }
});

test("引导版本号不为空", () => {
  assert.ok(GUIDE_VERSION.length > 0);
});

const VP = { w: 1200, h: 800 };
const CARD = { w: 340, h: 200 };

test("提示卡定位：没有目标放正中；目标上方空间够就放下面，否则放上面；水平夹在屏幕里", () => {
  assert.deepEqual(placeCard(null, CARD, VP), { x: 430, y: 300, side: "center" });
  const top = placeCard({ x: 100, y: 50, w: 200, h: 40 }, CARD, VP);
  assert.equal(top.side, "below");
  assert.equal(top.y, 50 + 40 + 14);
  const bottom = placeCard({ x: 100, y: 700, w: 200, h: 40 }, CARD, VP);
  assert.equal(bottom.side, "above");
  assert.equal(bottom.y, 700 - 14 - 200);
  const edge = placeCard({ x: 1150, y: 50, w: 40, h: 40 }, CARD, VP);
  assert.ok(edge.x + CARD.w <= VP.w - 14, "不超出右边");
  const left = placeCard({ x: 0, y: 50, w: 20, h: 40 }, CARD, VP);
  assert.ok(left.x >= 14, "不超出左边");
});

test("提示卡定位：目标又高又宽时放到右边或左边，再不行压在屏幕下部；永远不出屏幕", () => {
  const tall = placeCard({ x: 20, y: 20, w: 300, h: 760 }, CARD, VP);
  assert.equal(tall.side, "right");
  const huge = placeCard({ x: 10, y: 10, w: 1180, h: 780 }, CARD, VP);
  assert.equal(huge.side, "over");
  for (const t of [{ x: 10, y: 10, w: 1180, h: 780 }, { x: 900, y: 10, w: 290, h: 780 }, { x: 5, y: 790, w: 10, h: 10 }]) {
    const p = placeCard(t, CARD, VP);
    assert.ok(p.x >= 0 && p.y >= 0 && p.x + CARD.w <= VP.w && p.y + CARD.h <= VP.h, JSON.stringify(t));
  }
  const small = placeCard(null, CARD, { w: 300, h: 180 });
  assert.ok(small.x >= 0 && small.y >= 0, "屏幕比提示卡还小也不出现负坐标");
});

test("高亮框只取屏幕里看得见的部分", () => {
  assert.deepEqual(visibleRect({ x: -20, y: 700, w: 100, h: 300 }, VP), { x: 0, y: 700, w: 80, h: 100 });
  assert.deepEqual(visibleRect({ x: 10, y: 10, w: 50, h: 50 }, VP), { x: 10, y: 10, w: 50, h: 50 });
  assert.equal(visibleRect({ x: 2000, y: 10, w: 50, h: 50 }, VP).w, 0);
});
