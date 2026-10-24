import { test } from "node:test";
import assert from "node:assert/strict";
import { addAgendaItem, isDateKey, keyOf, monthGrid, removeAgendaItem, sanitizeAgenda, shiftMonth, toggleAgendaItem } from "../src/agenda";

test("日期键：只认真实存在的日期", () => {
  assert.ok(isDateKey("2026-10-24"));
  assert.ok(isDateKey("2028-02-29"));
  assert.ok(!isDateKey("2026-02-30"));
  assert.ok(!isDateKey("2026-13-01"));
  assert.ok(!isDateKey("2026-1-1"));
  assert.equal(keyOf(2026, 9, 4), "2026-10-04");
});

test("日程：添加、勾选、删除；空文字不加；删到空了日期就没了", () => {
  let a = addAgendaItem({}, "2026-10-24", "  交周报  ", "a");
  a = addAgendaItem(a, "2026-10-24", "买菜", "b");
  assert.deepEqual(a["2026-10-24"].map((i) => i.text), ["交周报", "买菜"]);
  assert.equal(addAgendaItem(a, "2026-10-24", "   ", "c"), a);
  assert.equal(addAgendaItem(a, "bad", "x", "c"), a);
  const t = toggleAgendaItem(a, "2026-10-24", "a");
  assert.ok(t["2026-10-24"][0].done);
  assert.ok(!toggleAgendaItem(t, "2026-10-24", "a")["2026-10-24"][0].done);
  assert.equal(toggleAgendaItem(a, "2026-10-24", "zz"), a);
  assert.ok(!a["2026-10-24"][0].done, "不改原对象");
  const r = removeAgendaItem(removeAgendaItem(a, "2026-10-24", "a"), "2026-10-24", "b");
  assert.deepEqual(r, {});
  assert.equal(addAgendaItem({}, "2026-10-24", "x".repeat(500), "a")["2026-10-24"][0].text.length, 200);
});

test("读日程：坏数据修复（非法日期、空条目、重复 id、缺 id）", () => {
  const a = sanitizeAgenda({
    "2026-10-24": [{ id: "a", text: "好", done: true }, { id: "a", text: "重复 id", done: false }, { text: "缺 id" }, { id: "z", text: "  " }, 5, null],
    "2026-02-30": [{ id: "q", text: "不存在的日期" }],
    nope: [],
    "2026-10-25": [],
    "2026-10-26": "x",
  });
  assert.deepEqual(Object.keys(a), ["2026-10-24"]);
  const items = a["2026-10-24"];
  assert.equal(items.length, 3);
  assert.equal(new Set(items.map((i) => i.id)).size, 3, "id 不重复");
  assert.ok(items[0].done);
  assert.ok(!items[1].done);
  assert.deepEqual(sanitizeAgenda(null), {});
  assert.deepEqual(sanitizeAgenda([]), {});
});

test("月历：6 周 × 7 天，周一在前，补齐前后月份；日期连续", () => {
  const g = monthGrid(2026, 9); // 2026 年 10 月，1 日是周四
  assert.equal(g.length, 42);
  assert.equal(g[0].key, "2026-09-28", "周一开头");
  assert.deepEqual(g.slice(0, 4).map((c) => c.inMonth), [false, false, false, true]);
  assert.equal(g[3].key, "2026-10-01");
  assert.equal(g.filter((c) => c.inMonth).length, 31);
  for (let i = 1; i < g.length; i++) {
    const a = new Date(g[i - 1].key + "T00:00:00").getTime();
    const b = new Date(g[i].key + "T00:00:00").getTime();
    assert.ok(b > a && b - a < 26 * 3600e3, "逐日递增（夏令时也不会错）");
  }
  assert.equal(monthGrid(2026, 1)[0].key, "2026-01-26", "2026 年 2 月，1 日是周日，前面补 6 天");
  assert.equal(monthGrid(2026, 5).filter((c) => c.inMonth).length, 30);
});

test("翻月：跨年", () => {
  assert.deepEqual(shiftMonth(2026, 11, 1), { year: 2027, month: 0 });
  assert.deepEqual(shiftMonth(2026, 0, -1), { year: 2025, month: 11 });
  assert.deepEqual(shiftMonth(2026, 5, 0), { year: 2026, month: 5 });
});
