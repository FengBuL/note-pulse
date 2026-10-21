import { test } from "node:test";
import assert from "node:assert/strict";
import { App, TFile, TFolder } from "obsidian";
import { DEFAULT_SETTINGS, migrateWritingSettings } from "../src/settings";
import { addDays, computeStats, dayKey, isCheckinDay, VaultStats } from "../src/stats";
import { buildWritingReport, reportPeriod, summarizePeriod } from "../src/report-logic";
import { createReport, overwriteReport, reportPath } from "../src/report-storage";

(globalThis as unknown as { window: unknown }).window = { setTimeout };
const date = (value: string) => new Date(value + "T12:00:00");
const time = (value: string) => new Date(value + "T00:00:00").getTime();

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
  const old = { ...DEFAULT_SETTINGS, weeklyWordGoal: undefined, reportFolder: undefined };
  const migrated = old as unknown as typeof DEFAULT_SETTINGS;
  migrateWritingSettings(migrated);
  assert.equal(migrated.weeklyWordGoal, 1500);
  assert.equal(migrated.reportFolder, "Note Pulse");
  migrated.weeklyWordGoal = 0;
  migrated.reportFolder = "";
  migrateWritingSettings(migrated);
  assert.equal(migrated.weeklyWordGoal, 0);
  assert.equal(migrated.reportFolder, "");
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
    assert.match(report.markdown, /期间总字数/);
    assert.match(report.markdown, /\[\[写作\]\]/);
    assert.match(report.markdown, /## 修改过的笔记/);
    assert.doesNotMatch(report.markdown, /\[\[采集|\[\[排除|\[\[大笔记/);
    assert.doesNotMatch(buildWritingReport(stats, settings, "month", -1, false).markdown, /## 修改过的笔记/);
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
  assert.match(markdown, /上一期为 0/);
  assert.match(markdown, /字数最多的笔记：暂无/);
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
