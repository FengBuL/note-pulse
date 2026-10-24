import { test } from "node:test";
import assert from "node:assert/strict";
import { CLOUD_FONT_PX, cloudExtent, cloudLayout, cloudLevels, cloudTagSize } from "../src/cloud";

const tags = Array.from({ length: 40 }, (_, i) => ({ name: `标签${i}`, n: Math.round(200 / (i + 1)) + 1 }));

function build(width: number, height: number, bounded = true) {
  const levels = cloudLevels(tags.map((t) => t.n));
  const sizes = tags.map((t, i) => cloudTagSize(t.name, CLOUD_FONT_PX[levels[i] - 1]));
  return { levels, sizes, spots: cloudLayout(sizes, { width, height, bounded }) };
}

test("字号档位：用得越多档位越高，最多的是最大一档，最少的是最小一档", () => {
  const lv = cloudLevels([100, 50, 10, 2, 1]);
  assert.equal(lv[0], CLOUD_FONT_PX.length);
  assert.equal(lv[4], 1);
  for (let i = 1; i < lv.length; i++) assert.ok(lv[i] <= lv[i - 1]);
  assert.deepEqual(cloudLevels([]), []);
  assert.equal(cloudLevels([5, 5, 5])[0], 3, "用量都一样时取中间档");
});

test("标签云：用得最多的在正中间；放下的标签互不重叠、都在范围里", () => {
  const { sizes, spots } = build(420, 260);
  assert.deepEqual(spots[0], { x: 0, y: 0 });
  const placed = spots.map((p, i) => (p ? { ...p, ...sizes[i] } : null)).filter((p) => p !== null);
  assert.ok(placed.length >= 20, `至少放下 20 个，实际 ${placed.length}`);
  for (const a of placed) {
    assert.ok(Math.abs(a.x) + a.w / 2 <= 210 && Math.abs(a.y) + a.h / 2 <= 130, "在范围内");
    for (const b of placed) if (a !== b) assert.ok(Math.abs(a.x - b.x) >= (a.w + b.w) / 2 || Math.abs(a.y - b.y) >= (a.h + b.h) / 2, "不重叠");
  }
});

test("标签云：越往外用得越少（前 5 个的平均距离小于最后放下的 5 个）", () => {
  const { spots } = build(520, 320);
  const dist = spots.filter((p) => p).map((p) => Math.hypot(p!.x, p!.y));
  const head = dist.slice(0, 5).reduce((s, d) => s + d, 0) / 5;
  const tail = dist.slice(-5).reduce((s, d) => s + d, 0) / 5;
  assert.ok(head < tail, `中心 ${head.toFixed(0)} < 外围 ${tail.toFixed(0)}`);
});

test("标签云：范围太小放不下的返回 null；不限高度时全部放得下，高度可以量出来", () => {
  const small = build(160, 80);
  assert.ok(small.spots.some((p) => p === null), "小范围放不下的是 null");
  const open = build(300, 80, false);
  assert.ok(open.spots.every((p) => p !== null), "不限高度全部放下");
  const ext = cloudExtent(open.sizes, open.spots);
  assert.ok(ext.bottom - ext.top > 80, "展开后比原来高");
});

test("标签云：横长的范围里云也是横着长开的", () => {
  const wide = build(700, 200);
  const xs = wide.spots.filter((p) => p).map((p) => Math.abs(p!.x));
  const ys = wide.spots.filter((p) => p).map((p) => Math.abs(p!.y));
  assert.ok(Math.max(...xs) > Math.max(...ys) * 1.5);
});
