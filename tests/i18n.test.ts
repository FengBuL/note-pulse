import { test } from "node:test";
import assert from "node:assert/strict";
import { App, TFile } from "obsidian";
import { reportFixture } from "./helpers/report-fixture";
import { DEFAULT_SETTINGS, DashboardSettings, migrateLanguage } from "../src/settings";
import { L, count, isZh, setLanguage, unit, weekdayLetter, weekdayName } from "../src/i18n";
import { fmtNum, splitNum } from "../src/charts";
import { buildWritingReport, writingReportOverview } from "../src/report-logic";
import { latestWritingReport } from "../src/report-storage";
import { busiestWeekday, weekDays } from "../src/dashboard-logic";
import { t as dedupeT } from "../src/dedupe/i18n";

/** 每个用例结束后回到中文，避免影响其它测试文件（它们默认中文） */
function inEnglish(fn: () => void) {
  setLanguage("en");
  try {
    fn();
  } finally {
    setLanguage("zh");
  }
}

test("所有用户默认跟随 Obsidian；版本 5 之后用户自己的选择保留，非法值回到跟随", () => {
  const old = { ...DEFAULT_SETTINGS, language: undefined } as unknown as DashboardSettings;
  migrateLanguage(old, true, 3);
  assert.equal(old.language, "auto", "1.6.0 之前的老用户也跟随 Obsidian");
  // 测试替身里 Obsidian 是中文
  assert.ok(isZh());

  const devBuild = { ...DEFAULT_SETTINGS, language: "zh" } as DashboardSettings;
  migrateLanguage(devBuild, true, 4);
  assert.equal(devBuild.language, "auto", "开发版迁移成的中文改回跟随");

  const fresh = { ...DEFAULT_SETTINGS } as DashboardSettings;
  migrateLanguage(fresh, false, 1);
  assert.equal(fresh.language, "auto");

  const chose = { ...DEFAULT_SETTINGS, language: "en" } as DashboardSettings;
  migrateLanguage(chose, true, 5);
  assert.equal(chose.language, "en", "之后用户自己选的语言不被改");
  assert.ok(!isZh());

  const bad = { ...DEFAULT_SETTINGS, language: "fr" } as unknown as DashboardSettings;
  migrateLanguage(bad, true, 5);
  assert.equal(bad.language, "auto");
  setLanguage("zh");
});

test("L 按语言取文案；单位分单复数", () => {
  assert.equal(L("字", "words"), "字");
  inEnglish(() => {
    assert.equal(L("字", "words"), "words");
    assert.equal(count(1, "notes"), "1 note");
    assert.equal(count(3, "notes"), "3 notes");
    assert.equal(unit("days", 1), "day");
  });
  assert.equal(count(3, "notes"), "3 篇");
});

test("大数字：中文用万 / 亿，英文用 K / M，单位位置不同", () => {
  assert.equal(fmtNum(23456), "2.3万");
  assert.deepEqual(splitNum(2_000_000, "字"), { value: "200", unit: "万字" });
  inEnglish(() => {
    assert.equal(fmtNum(9999), "9,999");
    assert.equal(fmtNum(23456), "23.5K");
    assert.equal(fmtNum(234_567), "235K");
    assert.equal(fmtNum(2_000_000), "2M");
    assert.deepEqual(splitNum(2_000_000, "words"), { value: "2M", unit: "words" });
  });
});

test("星期：本周格子用单字母，完整名用 Mon；最活跃的一天跟着语言", () => {
  inEnglish(() => {
    assert.equal(weekdayLetter(1), "M");
    assert.equal(weekdayName(0), "Sun");
    const s = reportFixture();
    const days = weekDays(s, 300, new Date(2026, 9, 21, 12));
    assert.deepEqual(days.map((d) => d.label), ["M", "T", "W", "T", "F", "S", "S"]);
    assert.match(busiestWeekday(s, new Date(2026, 8, 1), new Date(2026, 9, 21)) ?? "", /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/);
  });
});

test("英文写作报告：标题、属性、各节标题都是英文，没有残留中文", () => {
  inEnglish(() => {
    const stats = reportFixture();
    const report = buildWritingReport(stats, DEFAULT_SETTINGS, "week", 0, true);
    assert.equal(report.title, "Weekly writing report 2026-10-19 to 2026-10-25");
    assert.match(report.markdown, /^---\ntype: Weekly writing report\nperiod: 2026-W43\n/);
    assert.match(report.markdown, /> \[!summary\] Overview\n> \*\*3,820 words\*\* · Words · ↓ 20%/);
    assert.match(report.markdown, /## Daily rhythm/);
    assert.match(report.markdown, /\| Date \| Words \| Streak \|/);
    assert.match(report.markdown, /\[!note\]- Modified notes \(7\)/);
    assert.match(report.markdown, /\[!info\]- How this is counted/);
    // 笔记名和标签来自示例库，本身是中文；去掉它们后不应再有中文
    const chrome = report.markdown.replace(/\[\[[^\]]*\]\]/g, "").replace(/#[^\s|]+/g, "");
    assert.doesNotMatch(chrome, /[一-鿿]/);
    const month = writingReportOverview(stats, DEFAULT_SETTINGS, "month");
    assert.deepEqual(month.metrics.map((m) => m.label), ["Words", "Streak days", "New notes", "Daily average", "Best day"]);
  });
});

test("最近报告：中文和英文报告都能找到", () => {
  const files: TFile[] = [];
  const add = (path: string, mtime: number) => {
    const f = new TFile();
    f.path = path;
    f.stat.mtime = mtime;
    files.push(f);
    return f;
  };
  const app = {
    vault: { getMarkdownFiles: () => files },
    metadataCache: { getFileCache: () => null },
  } as unknown as App;
  add("Note Pulse/写作周报 2026-10-12 至 2026-10-18.md", 1);
  const en = add("Note Pulse/Monthly writing report 2026-10-01 to 2026-10-31.md", 2);
  assert.equal(latestWritingReport(app, "Note Pulse"), en);
  add("Note Pulse/Weekly writing reports archive.md", 3);
  assert.equal(latestWritingReport(app, "Note Pulse"), en, "名字只是以 Weekly writing report 开头的不算");
});

test("重复内容清理跟随同一个语言设置", () => {
  assert.equal(dedupeT("pluginName"), "重复内容清理");
  inEnglish(() => assert.equal(dedupeT("pluginName"), "Duplicate cleanup"));
});
