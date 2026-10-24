import { test } from "node:test";
import assert from "node:assert/strict";
import type { TFile } from "obsidian";
import { goalRings, hubSeries, lengthBuckets, monthCompare, recentNotes, relativeTime, weeksOf } from "../src/hub-logic";
import type { FileStat, VaultStats } from "../src/stats";

// 2026-10-24 是星期六
const NOW = new Date(2026, 9, 24, 21, 0);
const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).getTime();
const zh = (z: string) => z;
const en = (_z: string, e: string) => e;

function stats(over: Partial<VaultStats> = {}): VaultStats {
  return {
    generatedAt: NOW.getTime(), durationMs: 1, totalNotes: 0, totalWords: 0, writeWordsTotal: 0,
    created7: 0, created30: 0, modified7: 0, modified30: 0, totalLinks: 0, uniqueTags: 0, tagOccurrences: 0,
    files: [], dayWords: {}, estimatedBefore: null, logStartDay: null, dayModified: {}, dayCreated: {}, dailyNotes: {},
    outliers: { count: 0, words: 0, top: [], threshold: 20000, mode: "exclude" }, hints: [],
    tasks: { total: 0, done: 0, pending: 0, cancelled: 0, overdue: [], dueSoon: [], byFolder: [], byNote: [] },
    tags: [], links: { topLinked: [], orphans: [], unresolvedCount: 0, topUnresolved: [] }, folders: [],
    ...over,
  };
}
const file = (path: string, created: number, words: number, extra: Partial<FileStat> = {}): FileStat => ({
  file: { path, basename: path.replace(/\.md$/, ""), stat: { mtime: created, ctime: created, size: 1 } } as unknown as TFile,
  created, mtime: created, words, writeWords: words, collected: false, big: false, folder: "", tags: [], links: 0, ...extra,
});

test("写作趋势：字数和新建笔记按天（30 天）或按周；合计、平均、最高", () => {
  const s = stats({ dayWords: { "2026-10-24": 600, "2026-10-23": 200, "2026-10-01": 100 }, dayCreated: { "2026-10-24": 2, "2026-10-20": 1 } });
  const w = hubSeries(s, "words", 30, 300, NOW);
  assert.equal(w.gran, "day");
  assert.equal(w.buckets.length, 30);
  assert.equal(w.total, 900);
  assert.equal(w.best?.gain, 600);
  assert.equal(w.cumulative, false);
  const n = hubSeries(s, "notes", 182, 300, NOW);
  assert.equal(n.gran, "week");
  assert.equal(n.total, 3);
});

test("写作趋势：累计笔记和累计字数画累计值，合计是这段时间新增的；打卡天数按周", () => {
  const s = stats({
    files: [file("a.md", at(2026, 1, 5), 100), file("b.md", at(2026, 10, 21), 400), file("c.md", at(2026, 10, 23), 200)],
    dayWords: { "2026-10-20": 400, "2026-10-21": 300, "2026-10-24": 500 },
  });
  const t = hubSeries(s, "totalNotes", 30, 300, NOW);
  assert.equal(t.gran, "week");
  assert.equal(t.cumulative, true);
  assert.equal(t.buckets.length, weeksOf(30));
  assert.equal(t.buckets.at(-1)?.value, 3, "最后一周结束时一共 3 篇");
  assert.equal(t.total, 2, "这段时间新增 2 篇");
  assert.ok(t.buckets.every((b, i, a) => i === 0 || b.value >= a[i - 1].value), "累计值不会往回掉");
  const tw = hubSeries(s, "totalWords", 182, 300, NOW);
  assert.equal(tw.buckets.at(-1)?.value, 700);
  const c = hubSeries(s, "checkins", 30, 300, NOW);
  assert.equal(c.buckets.at(-1)?.value, 3, "本周 10-20、10-21、10-24 三天达标");
  assert.equal(c.total, 3);
  assert.equal(c.cumulative, false);
  assert.equal(weeksOf(182), 26);
  assert.equal(weeksOf(365), 52);
});

test("笔记长度分布：按字数分 6 档；采集文件夹里的不算", () => {
  const s = stats({
    files: [
      file("e.md", 1, 0), file("t.md", 1, 50), file("s1.md", 1, 100), file("s2.md", 1, 499), file("m.md", 1, 500), file("l.md", 1, 1999),
      file("l2.md", 1, 2000), file("h.md", 1, 10000), file("clip.md", 1, 99999, { collected: true }),
    ],
  });
  const b = lengthBuckets(s);
  assert.deepEqual(b.map((x) => [x.id, x.count]), [["empty", 1], ["tiny", 1], ["short", 2], ["medium", 2], ["long", 1], ["huge", 1]]);
  assert.equal(b.reduce((a, x) => a + x.count, 0), 8, "采集的那篇没算");
});

test("本月对比上月：同样的天数；上月是 0 时不给百分比", () => {
  const s = stats({
    dayWords: { "2026-10-02": 1000, "2026-10-24": 500, "2026-09-05": 400, "2026-09-24": 100, "2026-09-25": 99999 },
    dayCreated: { "2026-10-03": 4, "2026-09-10": 2 },
  });
  const m = monthCompare(s, 300, NOW);
  assert.equal(m.elapsed, 24);
  const words = m.rows.find((r) => r.key === "words")!;
  assert.equal(words.cur, 1500);
  assert.equal(words.prev, 500, "上月只取前 24 天，25 号那笔不算");
  assert.equal(words.changePct, 200);
  const notes = m.rows.find((r) => r.key === "notes")!;
  assert.deepEqual([notes.cur, notes.prev, notes.changePct], [4, 2, 100]);
  const checkins = m.rows.find((r) => r.key === "checkins")!;
  assert.deepEqual([checkins.cur, checkins.prev], [2, 1]);
  const none = monthCompare(stats(), 300, NOW);
  assert.ok(none.rows.every((r) => r.cur === 0 && r.prev === 0 && r.changePct === null));
  // 月初：上月比本月长也只取同样天数；3 月 31 日对比 2 月（28 天）取整月
  const late = monthCompare(stats({ dayWords: { "2026-02-28": 50, "2026-03-31": 70 } }), 300, new Date(2026, 2, 31, 9));
  assert.equal(late.rows[0].prev, 50);
  assert.equal(late.rows[0].cur, 70);
});

test("目标进度：今天、本周、本月；没设目标时写了就算满", () => {
  const s = stats({ dayWords: { "2026-10-19": 700, "2026-10-24": 150 } });
  const r = goalRings(s, { dailyGoal: 300, weeklyGoal: 1500 }, NOW);
  assert.deepEqual(r.map((x) => x.key), ["today", "week", "month"]);
  assert.equal(r[0].value, 150);
  assert.equal(r[0].ratio, 0.5);
  assert.equal(r[1].value, 850);
  assert.ok(Math.abs(r[1].ratio - 850 / 1500) < 1e-9);
  assert.equal(r[2].unit, "days");
  assert.equal(r[2].goal, 24, "本月已经过去 24 天");
  assert.equal(r[2].value, 1, "只有 10-19 一天达标");
  const open = goalRings(s, { dailyGoal: 0, weeklyGoal: 0 }, NOW);
  assert.deepEqual([open[0].ratio, open[1].ratio], [1, 1]);
  const capped = goalRings(stats({ dayWords: { "2026-10-24": 9999 } }), { dailyGoal: 300, weeklyGoal: 1500 }, NOW);
  assert.equal(capped[0].ratio, 1, "超额也最多 1");
});

test("最近编辑：最新的在前，最多取 limit 篇", () => {
  const s = stats({ files: [file("old.md", at(2026, 1, 1), 1), file("new.md", at(2026, 10, 24), 1), file("mid.md", at(2026, 6, 1), 1)] });
  assert.deepEqual(recentNotes(s, 2).map((f) => f.file.path), ["new.md", "mid.md"]);
  assert.equal(recentNotes(s).length, 3);
});

test("相对时间：刚刚、分钟、小时、昨天、天、周、月、年，中英文", () => {
  const now = new Date(2026, 9, 24, 15, 0).getTime();
  const ago = (ms: number) => now - ms;
  assert.equal(relativeTime(ago(20_000), now, zh), "刚刚");
  assert.equal(relativeTime(ago(12 * 60_000), now, zh), "12 分钟前");
  assert.equal(relativeTime(ago(3 * 3600_000), now, zh), "3 小时前");
  assert.equal(relativeTime(new Date(2026, 9, 23, 8, 0).getTime(), now, zh), "昨天");
  assert.equal(relativeTime(new Date(2026, 9, 20, 8, 0).getTime(), now, zh), "4 天前");
  assert.equal(relativeTime(new Date(2026, 9, 3, 8, 0).getTime(), now, zh), "3 周前");
  assert.equal(relativeTime(new Date(2026, 6, 1, 8, 0).getTime(), now, zh), "3 个月前");
  assert.equal(relativeTime(new Date(2024, 6, 1, 8, 0).getTime(), now, zh), "2 年前");
  assert.equal(relativeTime(ago(12 * 60_000), now, en), "12 min ago");
  assert.equal(relativeTime(new Date(2026, 9, 23, 8, 0).getTime(), now, en), "yesterday");
});
