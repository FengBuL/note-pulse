import { test } from "node:test";
import assert from "node:assert/strict";
import { easeOut, tweenValue } from "../src/motion";

test("easeOut：两端固定，中间先快后慢", () => {
  assert.equal(easeOut(0), 0);
  assert.equal(easeOut(1), 1);
  assert.ok(easeOut(0.5) > 0.5);
});

test("tweenValue：起点、终点准确，越界的进度被夹住", () => {
  assert.equal(tweenValue(0, 757, 0), 0);
  assert.equal(tweenValue(0, 757, 1), 757);
  assert.equal(tweenValue(0, 757, 1.4), 757);
  assert.equal(tweenValue(0, 757, -0.2), 0);
});

test("tweenValue：整数之间逐帧取整，不出现小数", () => {
  for (let t = 0; t <= 1; t += 0.05) assert.ok(Number.isInteger(tweenValue(3, 16, t)));
});

test("tweenValue：数值变小也能平滑过渡（自动刷新后字数减少）", () => {
  const mid = tweenValue(2_000_000, 1_990_000, 0.5);
  assert.ok(mid < 2_000_000 && mid > 1_990_000);
});
