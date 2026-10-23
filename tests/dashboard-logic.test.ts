import { test } from "node:test";
import assert from "node:assert/strict";
import type { TFile } from "obsidian";
import { busiestWeekday, checkupModel, headline, monthWriting, trendModel, weekDays, weekStart, weeklyCheckins, weeklyNotes, weeklyWords } from "../src/dashboard-logic";
import { dayKey } from "../src/stats";
import type { FileStat, VaultStats } from "../src/stats";

// 2026-10-24 是星期六
const NOW = new Date(2026, 9, 24, 21, 0);
const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).getTime();

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

test("weekStart 取本地周一", () => {
  assert.equal(dayKey(weekStart(NOW)), "2026-10-19");
  assert.equal(dayKey(weekStart(new Date(2026, 9, 19))), "2026-10-19");
  assert.equal(dayKey(weekStart(new Date(2026, 9, 25))), "2026-10-19");
});

test("本周七天：达标、未达标百分比、未来日", () => {
  const s = stats({ dayWords: { "2026-10-19": 600, "2026-10-21": 380, "2026-10-24": 500 } });
  const days = weekDays(s, 500, NOW);
  assert.deepEqual(days.map((d) => d.label), ["一", "二", "三", "四", "五", "六", "日"]);
  assert.equal(days[0].done, true);
  assert.equal(days[1].done, false);
  assert.equal(days[1].pct, null, "没写的日子不显示百分比");
  assert.equal(days[2].pct, 76);
  assert.equal(days[5].isToday, true);
  assert.equal(days[5].done, true);
  assert.equal(days[6].future, true);
  assert.equal(days[6].done, false);
});

test("本周七天：写了日记也算打卡", () => {
  const s = stats({ dailyNotes: { "2026-10-22": { path: "日记/2026-10-22.md" } as TFile } });
  assert.equal(weekDays(s, 500, NOW)[3].done, true);
});

test("页首：本周字数与上周同期比较", () => {
  const s = stats({
    dayWords: { "2026-10-19": 1000, "2026-10-24": 200, "2026-10-12": 500, "2026-10-17": 500, "2026-10-18": 9999 },
  });
  const h = headline(s, 500, NOW);
  assert.equal(h.weekWords, 1200);
  assert.equal(h.prevWords, 1000, "上周日不算在同期里");
  assert.equal(h.changePct, 20);
  assert.equal(h.todayWords, 200);
  assert.equal(h.todayDone, false);
});

test("页首：上周同期没写时不给百分比", () => {
  assert.equal(headline(stats({ dayWords: { "2026-10-20": 100 } }), 500, NOW).changePct, null);
});

test("页首：今天到期和已逾期", () => {
  const f = { path: "a.md" } as TFile;
  const s = stats();
  s.tasks.dueSoon = [{ file: f, line: 0, text: "a", status: "pending", due: "2026-10-24" }, { file: f, line: 1, text: "b", status: "pending", due: "2026-10-25" }];
  s.tasks.overdue = [{ file: f, line: 2, text: "c", status: "pending", due: "2026-10-20" }];
  const h = headline(s, 500, NOW);
  assert.equal(h.dueToday, 1);
  assert.equal(h.overdue, 1);
});

test("小趋势线：每周结束时的累计笔记数和当周新增", () => {
  const s = stats({
    files: [
      file("old.md", at(2026, 1, 1), 100),
      file("a.md", at(2026, 10, 13), 200),
      file("b.md", at(2026, 10, 20), 300),
      file("c.md", at(2026, 10, 24), 400),
      file("clip.md", at(2026, 10, 24), 9000, { collected: true }),
    ],
  });
  const notes = weeklyNotes(s, 3, NOW);
  assert.deepEqual(notes.map((p) => dayKey(p.start)), ["2026-10-05", "2026-10-12", "2026-10-19"]);
  assert.deepEqual(notes.map((p) => p.value), [1, 2, 4]);
  assert.deepEqual(notes.map((p) => p.extra), [0, 1, 2]);
  assert.equal(dayKey(notes[2].end), "2026-10-24", "本周截止到今天");
  const words = weeklyWords(s, 3, NOW);
  assert.deepEqual(words.map((p) => p.value), [100, 300, 1000]);
});

test("小趋势线：每周打卡天数和当周字数", () => {
  const s = stats({ dayWords: { "2026-10-13": 600, "2026-10-14": 100, "2026-10-20": 700, "2026-10-21": 800 } });
  const pts = weeklyCheckins(s, 500, 2, NOW);
  assert.deepEqual(pts.map((p) => p.value), [1, 2]);
  assert.deepEqual(pts.map((p) => p.extra), [700, 1500]);
});

test("本月写作：打卡天数与日均", () => {
  const s = stats({ dayWords: { "2026-10-01": 600, "2026-10-24": 600, "2026-09-30": 9000 } });
  assert.deepEqual(monthWriting(s, 500, NOW), { days: 2, words: 1200, elapsed: 24, average: 50 });
});

test("每周写作：半年按周汇总、找出最高一周", () => {
  const s = stats({ dayWords: { "2026-10-20": 300, "2026-10-21": 200, "2026-09-15": 900 } });
  const m = trendModel(s, 182, "words", 500, NOW);
  assert.equal(m.gran, "week");
  assert.equal(m.buckets.length, 26);
  assert.equal(dayKey(m.buckets[25].start), "2026-10-19");
  assert.equal(dayKey(m.buckets[25].end), "2026-10-24");
  assert.equal(m.buckets[25].value, 500);
  assert.equal(m.total, 1400);
  assert.equal(m.best && dayKey(m.best.start), "2026-09-14");
  assert.equal(m.buckets.find((b) => dayKey(b.start) === "2026-09-14")?.checkins, 1);
});

test("每周写作：30 天按天，新建笔记口径", () => {
  const s = stats({ dayCreated: { "2026-10-24": 2, "2026-09-25": 1, "2026-09-24": 5 } });
  const m = trendModel(s, 30, "notes", 500, NOW);
  assert.equal(m.gran, "day");
  assert.equal(m.buckets.length, 30);
  assert.equal(m.total, 3, "30 天之前的不算");
});

test("最活跃的星期几", () => {
  const s = stats({ dayWords: { "2026-10-20": 300, "2026-10-13": 300, "2026-10-24": 500 } });
  assert.equal(busiestWeekday(s, new Date(2026, 9, 1), NOW), "周二");
  assert.equal(busiestWeekday(stats(), new Date(2026, 9, 1), NOW), null);
});

test("库体检：空笔记不含只有链接或嵌入的笔记，超大笔记不含采集文件夹", () => {
  const s = stats({
    files: [
      file("空.md", at(2026, 10, 1), 0),
      file("只有图片.md", at(2026, 10, 2), 0, { embeds: 1 }),
      file("只有链接.md", at(2026, 10, 3), 0, { links: 2 }),
      file("大.md", at(2026, 10, 4), 30000, { big: true }),
      file("采集.md", at(2026, 10, 5), 50000, { big: true, collected: true }),
    ],
    links: {
      topLinked: [], orphans: [], unresolvedCount: 3,
      topUnresolved: [["年度复盘", 2], ["竞品分析", 1]], unresolvedSource: { 年度复盘: "工作/周会.md" },
    },
  });
  const c = checkupModel(s);
  assert.deepEqual(c.empty.map((f) => f.file.path), ["空.md"]);
  assert.deepEqual(c.big.map((f) => f.file.path), ["大.md"]);
  assert.deepEqual(c.unresolved, [
    { name: "年度复盘", count: 2, source: "工作/周会.md", fix: null, from: [] },
    { name: "竞品分析", count: 1, source: null, fix: null, from: [] },
  ]);
});

test("库体检：能修的断链排在前面，同名笔记和未引用附件透传", () => {
  const fix = { name: "竞品分析", target: "工作/竞品分析.md", kind: "exact" as const };
  const s = stats({
    links: {
      topLinked: [], orphans: [], unresolvedCount: 3,
      topUnresolved: [["年度复盘", 2], ["竞品分析", 1]],
      unresolvedFrom: { 竞品分析: ["a.md"] },
      suggestions: { 竞品分析: fix },
      sameName: [["a/README.md", "b/README.md"]],
      unusedAttachments: [],
    },
  });
  const c = checkupModel(s);
  assert.deepEqual(c.unresolved.map((x) => x.name), ["竞品分析", "年度复盘"]);
  assert.deepEqual(c.unresolved[0].fix, fix);
  assert.deepEqual(c.unresolved[0].from, ["a.md"]);
  assert.deepEqual(c.sameName, [["a/README.md", "b/README.md"]]);
});
