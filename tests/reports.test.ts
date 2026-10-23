import { test } from "node:test";
import { reportFixture } from "./helpers/report-fixture";
import assert from "node:assert/strict";
import { App, TFile, TFolder } from "obsidian";
import { DEFAULT_SETTINGS, migrateWritingSettings } from "../src/settings";
import { addDays, computeStats, dayKey, isCheckinDay, VaultStats } from "../src/stats";
import { buildWritingReport, reportPeriod, summarizePeriod, writingReportOverview } from "../src/report-logic";
import { createReport, latestWritingReport, overwriteReport, reportPath } from "../src/report-storage";

(globalThis as unknown as { window: unknown }).window = { setTimeout };
const date = (value: string) => new Date(value + "T12:00:00");
const time = (value: string) => new Date(value + "T00:00:00").getTime();

test("最近报告按类型或旧文件名识别，只查报告目录并取最近修改的一篇", () => {
  const files: TFile[] = [];
  const types = new Map<TFile, unknown>();
  const add = (path: string, modified: number, type?: unknown) => {
    const file = new TFile();
    file.path = path;
    file.stat.mtime = modified;
    files.push(file);
    types.set(file, type);
    return file;
  };
  const app = {
    vault: { getMarkdownFiles: () => files },
    metadataCache: { getFileCache: (file: TFile) => ({ frontmatter: { type: types.get(file) } }) },
  } as unknown as App;
  assert.equal(latestWritingReport(app, "Note Pulse"), null);
  add("Note Pulse/普通笔记.md", 100);
  add("Note Pulse archive/写作周报 2026-10-19 至 2026-10-25.md", 200);
  add("别处/周报.md", 300, "写作周报");
  assert.equal(latestWritingReport(app, "Note Pulse"), null);
  const legacy = add("Note Pulse/写作周报 2026-10-12 至 2026-10-18 (2).md", 5);
  assert.equal(latestWritingReport(app, "Note Pulse"), legacy);
  const renamed = add("Note Pulse/归档/我的月度回顾.md", 10, "写作月报");
  assert.equal(latestWritingReport(app, " Note Pulse/ "), renamed);
  assert.equal(latestWritingReport(app, "Note Pulse\\"), renamed);
  assert.equal(latestWritingReport(app, ""), files[2]);
  assert.equal(latestWritingReport(app, "../Note Pulse"), null);
  assert.equal(latestWritingReport(app, "bad:folder"), null);
});

test("最近报告允许元数据尚未缓存，时间相同保持确定的顺序", () => {
  const file = (path: string) => Object.assign(new TFile(), { path });
  const first = file("Reports/写作周报 A.md");
  const second = file("Reports/写作月报 B.md");
  const app = {
    vault: { getMarkdownFiles: () => [second, first] },
    metadataCache: { getFileCache: () => null },
  } as unknown as App;
  const expected = [first, second].sort((a, b) => a.path.localeCompare(b.path))[0];
  assert.equal(latestWritingReport(app, "Reports"), expected);
});

function fixture() {
  const files: TFile[] = [];
  const text = new Map<string, string>();
  const metadata = new Map<string, { tags: { tag: string }[] }>();
  function add(path: string, words: number, created: string, modified = created, tags = ["#写作"]) {
    const file = new TFile();
    file.path = path;
    file.stat = { ctime: time(created), mtime: time(modified), size: words * 3 };
    files.push(file);
    text.set(path, "字".repeat(words));
    metadata.set(path, { tags: tags.map((tag) => ({ tag })) });
  }
  const now = new Date();
  const today = dayKey(now);
  const monday = dayKey(reportPeriod("week", now).start);
  const previous = dayKey(addDays(reportPeriod("week", now).start, -1));
  add("写作.md", 300, monday, today);
  add("零字数.md", 0, monday);
  add(`Daily/${today}.md`, 10, today);
  add("上周.md", 20, previous);
  add("采集/文章.md", 600, today);
  add(`采集/${previous}.md`, 300, previous);
  add("排除/秘密.md", 900, today);
  add(`大笔记/${today}.md`, 2200, today);
  const app = {
    vault: {
      getMarkdownFiles: () => files,
      cachedRead: async (file: TFile) => text.get(file.path) ?? "",
    },
    metadataCache: { getFileCache: (file: TFile) => metadata.get(file.path) },
  } as unknown as App;
  const settings = { ...DEFAULT_SETTINGS, excludedFolders: "排除", clippingFolders: "采集", outlierWords: 1000, dailyWordGoal: 500 };
  return { app, settings, today, monday, previous };
}

test("周一为起点，周日、跨年和闰月的日期范围正确", () => {
  const week = reportPeriod("week", date("2027-01-03"));
  assert.equal(dayKey(week.start), "2026-12-28");
  assert.equal(dayKey(week.end), "2027-01-04");
  assert.equal(dayKey(reportPeriod("week", date("2027-01-04")).start), "2027-01-04");
  const previous = reportPeriod("month", date("2024-03-31"), -1);
  assert.equal(dayKey(previous.start), "2024-02-01");
  assert.equal(dayKey(previous.end), "2024-03-01");
});

test("旧设置补齐默认值，明确关闭的周目标和根目录保留", () => {
  const old = { ...DEFAULT_SETTINGS, weeklyWordGoal: undefined, reportFolder: undefined, reportWeekExpanded: undefined, reportMonthExpanded: "true" };
  const migrated = old as unknown as typeof DEFAULT_SETTINGS;
  migrateWritingSettings(migrated);
  assert.equal(migrated.weeklyWordGoal, 1500);
  assert.equal(migrated.reportFolder, "Note Pulse");
  assert.equal(migrated.reportWeekExpanded, false);
  assert.equal(migrated.reportMonthExpanded, undefined);
  migrated.reportWeekExpanded = true;
  migrated.weeklyWordGoal = 0;
  migrated.reportFolder = "";
  migrateWritingSettings(migrated);
  assert.equal(migrated.weeklyWordGoal, 0);
  assert.equal(migrated.reportFolder, "");
  assert.equal(migrated.reportWeekExpanded, true);
  assert.equal(migrated.reportMonthExpanded, undefined);
});

test("本周显示方式：旧设置默认圆点，已选的柱状保留", () => {
  const old = { ...DEFAULT_SETTINGS, weekStyle: undefined } as unknown as typeof DEFAULT_SETTINGS;
  migrateWritingSettings(old);
  assert.equal(old.weekStyle, "dots");
  old.weekStyle = "bars";
  migrateWritingSettings(old);
  assert.equal(old.weekStyle, "bars");
});

test("旧的独立展开状态合并一次，后续共享收起不被旧月报状态覆盖", () => {
  for (const week of [false, true]) {
    for (const month of [false, true]) {
      const settings = { ...DEFAULT_SETTINGS, reportWeekExpanded: week, reportMonthExpanded: month };
      migrateWritingSettings(settings);
      assert.equal(settings.reportWeekExpanded, week || month);
      assert.equal(Object.hasOwn(settings, "reportMonthExpanded"), false);
      settings.reportWeekExpanded = false;
      migrateWritingSettings(settings);
      assert.equal(settings.reportWeekExpanded, false);
    }
  }
});

for (const mode of ["mtime", "delta", "auto"] as const) {
  test(`报告使用看板结果，遵守排除和日记打卡规则：${mode}`, async () => {
    const { app, settings, today, previous } = fixture();
    settings.heatmapMode = mode;
    const stats = await computeStats(app, settings, new Map(), {
      wordLog: { [today]: 123, [previous]: 42 }, wordLogBig: { [today]: 2200 },
      logInitialized: true, logStartDay: today, seedOnly: true,
    });
    const period = reportPeriod("week", new Date(stats.generatedAt));
    const summary = summarizePeriod(stats, settings, period);
    assert.equal(summary.words, stats.dayWords[today]);
    assert.equal(summary.words, mode === "mtime" ? 310 : 123);
    assert.equal(summary.checkins, 1); // 不足每日目标，但有日记
    assert.equal(stats.dailyNotes[previous], undefined); // 采集日记不算打卡
    assert.equal(summary.created, 4); // 超大笔记仍计笔记数，采集不计
    assert.equal(summary.topNote?.file.path, "写作.md");
    assert.equal(summary.topTags[0][1], 3);
    assert.equal(summary.modified.some((f) => f.collected || f.big), false);
    const report = buildWritingReport(stats, settings, "week", 0, true);
    assert.match(report.markdown, /总字数/);
    assert.match(report.markdown, /\[\[写作\]\]/);
    assert.match(report.markdown, /\[!note\]- 修改过的笔记/g);
    assert.doesNotMatch(report.markdown, /\[\[采集|\[\[排除|\[\[大笔记/);
    assert.doesNotMatch(buildWritingReport(stats, settings, "month", -1, false).markdown, /\[!note\]- 修改过的笔记/g);
    settings.outlierMode = "off";
    assert.equal(summarizePeriod(stats, settings, period).topNote?.big, true);
  });
}

test("关闭每日目标时有写作即打卡；没有数据时报告不产生无效百分比", async () => {
  const { app, settings, today } = fixture();
  const stats = await computeStats(app, settings, new Map(), { wordLog: {}, wordLogBig: {}, logInitialized: false, logStartDay: "" });
  assert.equal(isCheckinDay({ ...stats, dailyNotes: {}, dayWords: { [today]: 1 } }, 0, today), true);
  assert.equal(isCheckinDay({ ...stats, dailyNotes: {}, dayWords: {} }, 0, today), false);
  const empty: VaultStats = { ...stats, files: [], dayWords: {}, dailyNotes: {}, dayCreated: {} };
  const markdown = buildWritingReport(empty, settings, "month", -1, true).markdown;
  assert.match(markdown, /上期无记录/);
  assert.match(markdown, /暂无笔记/);
  assert.doesNotMatch(markdown, /NaN|Infinity/);
});

function storage() {
  const entries = new Map<string, TFile | TFolder>();
  const contents = new Map<string, string>();
  const app = {
    vault: {
      getAbstractFileByPath: (path: string) => entries.get(path) ?? null,
      createFolder: async (path: string) => { entries.set(path, new TFolder(path)); },
      create: async (path: string, value: string) => {
        if (entries.has(path)) throw new Error("文件已存在");
        const file = new TFile();
        file.path = path;
        entries.set(path, file);
        contents.set(path, value);
        return file;
      },
      process: async (file: TFile, fn: (value: string) => string) => {
        contents.set(file.path, fn(contents.get(file.path) ?? ""));
      },
    },
  } as unknown as App;
  return { app, entries, contents };
}

test("创建多层目录，同名默认拒绝覆盖，另存递增编号", async () => {
  const { app, contents } = storage();
  const path = reportPath("Note Pulse/报告", "写作周报");
  const first = await createReport(app, path, "第一版", false);
  await assert.rejects(() => createReport(app, path, "不应覆盖", false));
  assert.equal(contents.get(first.path), "第一版");
  assert.equal((await createReport(app, path, "第二版", true)).path, "Note Pulse/报告/写作周报 (2).md");
  assert.equal((await createReport(app, path, "第三版", true)).path, "Note Pulse/报告/写作周报 (3).md");
  await overwriteReport(app, first, "第一版", "已确认覆盖");
  assert.equal(contents.get(first.path), "已确认覆盖");
  await assert.rejects(() => overwriteReport(app, first, "第一版", "过期操作"));
  assert.equal(contents.get(first.path), "已确认覆盖");
});

test("根目录可用，非法路径及被文件占用的目录不会写入", async () => {
  const { app, entries } = storage();
  assert.equal(reportPath("", "报告"), "报告.md");
  assert.throws(() => reportPath("../外部", "报告"));
  assert.throws(() => reportPath("不合法:名称", "报告"));
  entries.set("Note Pulse", new TFile());
  await assert.rejects(() => createReport(app, "Note Pulse/报告.md", "内容", false));
});

test("原生 Markdown 属性、千分位概览和折叠列表完整，保存标题保持兼容", () => {
  const stats = reportFixture();
  const report = buildWritingReport(stats, DEFAULT_SETTINGS, "week", 0, true);
  assert.equal(report.title, "写作周报 2026-10-19 至 2026-10-25");
  assert.equal(report.periodLabel, "2026-W43");
  assert.match(report.markdown, /^---\ntype: 写作周报\nperiod: 2026-W43\nstart: 2026-10-19\nend: 2026-10-25\nwords: 3820\ncheckins: 3\nnew_notes: 1\ntags: \[note-pulse\]\n---\n/);
  assert.match(report.markdown, /# 写作周报 · 2026-W43\n\n2026-10-19 — 2026-10-25/);
  assert.match(report.markdown, /> \[!summary\] 概览\n> \*\*3,820 字\*\* · 总字数 · ↓ 20%/);
  assert.match(report.markdown, /> \[!note\]- 修改过的笔记（7 篇）\n> - \[\[/);
  assert.match(report.markdown, /> \[!info\]- 统计说明/);
  assert.match(report.markdown, /本期尚未结束/);
  assert.doesNotMatch(report.markdown, /<\/?(?:div|table|span)|```|dataview|NaN|Infinity/);
  const previous = buildWritingReport(stats, DEFAULT_SETTINGS, "week", -1, false).markdown;
  assert.doesNotMatch(previous, /本期尚未结束|\[!note\]/);
});

test("周节奏从周一到周日，日记打卡与未来日期独立显示", () => {
  const stats = reportFixture();
  // 故意注入未来数据，验证呈现与汇总都不提前计入。
  stats.dayWords["2026-10-22"] = 9999;
  const markdown = buildWritingReport(stats, DEFAULT_SETTINGS, "week", 0, false).markdown;
  assert.match(markdown, /周一 → 周日　■■■····/);
  assert.match(markdown, /\| 10-19 周一 \| 2,480 \| ■ \|/);
  assert.match(markdown, /\| 10-20 周二 \| 80 \| ■ \|/);
  assert.match(markdown, /\| 10-22 周四 \| — \| · \|/);
  assert.doesNotMatch(markdown, /9,999/);
  assert.equal((markdown.match(/^\| 10-/gm) || []).length, 7);
});

test("月报覆盖闰月所有日期；ISO 周号跨年归属正确", () => {
  const stats = reportFixture();
  stats.generatedAt = date("2024-03-03").getTime();
  const month = buildWritingReport(stats, DEFAULT_SETTINGS, "month", -1, false);
  assert.equal(month.periodLabel, "2024-02");
  assert.match(month.markdown, /end: 2024-02-29/);
  assert.equal((month.markdown.match(/^\| 02-/gm) || []).length, 29);
  assert.match(month.markdown, /\| 02-29 周四 \| 0 \| □ \|/);
  for (const [day, expected] of [["2027-01-03", "2026-W53"], ["2027-01-04", "2027-W01"], ["2025-12-29", "2026-W01"]]) {
    stats.generatedAt = date(day).getTime();
    assert.equal(buildWritingReport(stats, DEFAULT_SETTINGS, "week", 0, false).periodLabel, expected);
  }
});

test("对比取整百分比，覆盖增加、减少、持平及零基数", () => {
  const stats = { ...reportFixture(), dayWords: { "2026-10-19": 12480, "2026-10-12": 10000 }, dayCreated: {}, dailyNotes: {} };
  let markdown = buildWritingReport(stats, DEFAULT_SETTINGS, "week", 0, false).markdown;
  assert.match(markdown, /\*\*12,480 字\*\* · 总字数 · ↑ 25%/);
  assert.match(markdown, /\*\*1 天\*\* · 打卡 · 持平 0%/);
  assert.match(markdown, /\*\*0 篇\*\* · 新建笔记 · 上期无记录/);
  stats.dayWords["2026-10-19"] = 0;
  markdown = buildWritingReport(stats, DEFAULT_SETTINGS, "week", 0, false).markdown;
  assert.match(markdown, /\*\*0 字\*\* · 总字数 · ↓ 100%/);
});

test("笔记按当前字数取前五，特殊双链与标签不破坏表格", () => {
  const stats = reportFixture();
  stats.files[0].file.path = "文章/特殊|[标题]#块^引用&\n换行.md";
  stats.files[0].tags = ["#标签|分隔\n换行", "#<script>"];
  const report = buildWritingReport(stats, DEFAULT_SETTINGS, "week", 0, true);
  const top = report.markdown.split("## 字数最多的笔记\n")[1].split("## 常用标签")[0];
  assert.match(top, /\| 1 \| \[\[文章\/特殊&#124;&#91;标题&#93;&#35;块&#94;引用&amp; 换行\]\] \| 12,480 \|/);
  assert.match(top, /\| 5 \| \[\[读书\/阅读与思考\]\] \| 1,250 \|/);
  assert.doesNotMatch(top, /下一篇文章|日记\/2026/);
  assert.equal((top.match(/^\| \d/gm) || []).length, 5);
  assert.match(report.markdown, /#标签\\\|分隔 换行/);
  assert.match(report.markdown, /#&lt;script&gt;/);
});


test("概览共享全部五项指标，周月报告与格式化数据完全一致", () => {
  const stats = reportFixture();
  for (const kind of ["week", "month"] as const) {
    const overview = writingReportOverview(stats, DEFAULT_SETTINGS, kind);
    assert.equal(overview.metrics.length, 5);
    const markdown = buildWritingReport(stats, DEFAULT_SETTINGS, kind, 0, false).markdown;
    for (const metric of overview.metrics) {
      assert.ok(markdown.includes(`> **${metric.value}${metric.unit ? ` ${metric.unit}` : ""}** · ${metric.label} · ${metric.detail}`));
    }
    assert.deepEqual(overview.current, summarizePeriod(stats, DEFAULT_SETTINGS, overview.period));
  }
  const week = writingReportOverview(stats, DEFAULT_SETTINGS, "week");
  assert.equal(week.current.elapsedDays, 3);
  assert.equal(week.current.dailyAverage, 1273);
  assert.deepEqual(week.current.bestDay, { date: "2026-10-19", words: 2480 });
  assert.equal(week.metrics[3].value, "1,273");
  assert.equal(week.metrics[0].trend, "down");
});

test("日均含无写作日，未来数据不计；最佳日并列取较早日期，空周期安全", () => {
  const stats = { ...reportFixture(), dayWords: { "2026-10-19": 1000, "2026-10-21": 1000, "2026-10-22": 9999 }, dayCreated: {}, dailyNotes: {} };
  const overview = writingReportOverview(stats, DEFAULT_SETTINGS, "week");
  assert.equal(overview.current.dailyAverage, 667);
  assert.deepEqual(overview.current.bestDay, { date: "2026-10-19", words: 1000 });
  assert.equal(overview.metrics[0].detail, "上期无记录");
  assert.equal(overview.metrics[0].trend, "neutral");
  const empty = writingReportOverview(stats, DEFAULT_SETTINGS, "month", -1);
  assert.equal(empty.current.elapsedDays, 30);
  assert.equal(empty.current.dailyAverage, 0);
  assert.equal(empty.current.bestDay, null);
  assert.equal(empty.metrics[4].value, "暂无记录");
  const future = writingReportOverview(stats, DEFAULT_SETTINGS, "week", 1);
  assert.equal(future.current.elapsedDays, 0);
  assert.equal(future.current.dailyAverage, 0);
  assert.equal(future.current.bestDay, null);
});

test("完整闰月与跨年周按日历日计日均，上期对比颜色区分涨跌持平及零基数", () => {
  const stats = reportFixture();
  stats.generatedAt = date("2024-03-03").getTime();
  stats.dayWords = { "2024-02-29": 2900 };
  const month = writingReportOverview(stats, DEFAULT_SETTINGS, "month", -1);
  assert.equal(month.current.elapsedDays, 29);
  assert.equal(month.current.dailyAverage, 100);
  assert.deepEqual(month.current.bestDay, { date: "2024-02-29", words: 2900 });
  stats.generatedAt = date("2027-01-03").getTime();
  stats.dayWords = { "2026-12-28": 700, "2026-12-21": 350 };
  assert.equal(writingReportOverview(stats, DEFAULT_SETTINGS, "week").current.dailyAverage, 100);
  for (const [words, trend, detail] of [[700, "up", "↑ 100%"], [350, "neutral", "持平 0%"], [0, "down", "↓ 100%"]] as const) {
    stats.dayWords["2026-12-28"] = words;
    const total = writingReportOverview(stats, DEFAULT_SETTINGS, "week").metrics[0];
    assert.equal(total.trend, trend);
    assert.equal(total.detail, detail);
  }
});
