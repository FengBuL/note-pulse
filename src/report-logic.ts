import type { DashboardSettings } from "./settings";
import { addDays, dayKey, isCheckinDay, startOfDay } from "./stats";
import type { FileStat, VaultStats } from "./stats";
import { L, weekdayName } from "./i18n";

export type ReportKind = "week" | "month";
export interface ReportPeriod {
  start: Date;
  end: Date;
}

/** 使用本地日历日期，结束日不包含在内，避免夏令时和跨年偏差。 */
export function reportPeriod(kind: ReportKind, now: Date, offset = 0): ReportPeriod {
  const today = startOfDay(now);
  if (kind === "week") {
    const start = addDays(today, -((today.getDay() + 6) % 7) + offset * 7);
    return { start, end: addDays(start, 7) };
  }
  const start = new Date(today.getFullYear(), today.getMonth() + offset, 1);
  return { start, end: new Date(start.getFullYear(), start.getMonth() + 1, 1) };
}

export function summarizeWritingDays(stats: VaultStats, settings: DashboardSettings, period: ReportPeriod) {
  let words = 0;
  let checkins = 0;
  let created = 0;
  let elapsedDays = 0;
  let bestDay: { date: string; words: number } | null = null;
  const lastDay = dayKey(stats.generatedAt);
  for (let d = period.start; d < period.end; d = addDays(d, 1)) {
    const key = dayKey(d);
    if (key > lastDay) break;
    const dailyWords = stats.dayWords[key] || 0;
    elapsedDays++;
    words += dailyWords;
    if (dailyWords > (bestDay?.words ?? 0)) bestDay = { date: key, words: dailyWords };
    checkins += isCheckinDay(stats, settings.dailyWordGoal, key) ? 1 : 0;
    created += stats.dayCreated[key] || 0;
  }
  return { words, checkins, created, elapsedDays, dailyAverage: elapsedDays ? Math.round(words / elapsedDays) : 0, bestDay };
}

export function summarizePeriod(stats: VaultStats, settings: DashboardSettings, period: ReportPeriod) {
  const writing = summarizeWritingDays(stats, settings, period);
  const inPeriod = (time: number) => time >= period.start.getTime() && time < period.end.getTime() && time <= stats.generatedAt;
  const eligible = stats.files.filter((f) => !f.collected && !(settings.outlierMode === "exclude" && f.big));
  const modified = eligible.filter((f) => inPeriod(f.mtime)).sort((a, b) => a.file.path.localeCompare(b.file.path));
  const touched = eligible.filter((f) => inPeriod(f.mtime) || inPeriod(f.created));
  const topNotes = [...touched].sort((a, b) => b.words - a.words || a.file.path.localeCompare(b.file.path)).slice(0, 5);
  const topNote = topNotes[0];
  const tags = new Map<string, number>();
  for (const file of touched) {
    for (const tag of file.tags) tags.set(tag, (tags.get(tag) || 0) + 1);
  }
  const topTags = [...tags].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5);
  return { ...writing, topNote, topNotes, topTags, modified };
}

const number = (value: number) => value.toLocaleString("en-US");

function change(current: number, previous: number): string {
  if (previous === 0) return L("上期无记录", "no data last period");
  const delta = current - previous;
  return delta === 0 ? L("持平 0%", "flat 0%") : `${delta > 0 ? "↑" : "↓"} ${number(Math.round(Math.abs(delta) / previous * 100))}%`;
}

export interface ReportOverviewMetric {
  id: "words" | "checkins" | "created" | "dailyAverage" | "bestDay";
  label: string;
  value: string;
  unit: string;
  detail: string;
  trend: "up" | "down" | "neutral";
}

/** 报告概览和看板共用数值、格式及对比文案。 */
export function writingReportOverview(stats: VaultStats, settings: DashboardSettings, kind: ReportKind, offset = 0) {
  const period = reportPeriod(kind, new Date(stats.generatedAt), offset);
  const previous = reportPeriod(kind, period.start, -1);
  const current = summarizePeriod(stats, settings, period);
  const prev = summarizePeriod(stats, settings, previous);
  const compared = (id: "words" | "checkins" | "created", label: string, unit: string): ReportOverviewMetric => ({
    id, label, unit, value: number(current[id]), detail: change(current[id], prev[id]),
    trend: prev[id] === 0 || current[id] === prev[id] ? "neutral" : current[id] > prev[id] ? "up" : "down",
  });
  const metrics: ReportOverviewMetric[] = [
    compared("words", L("总字数", "Words"), L("字", "words")),
    compared("checkins", L("打卡", "Streak days"), L("天", "days")),
    compared("created", L("新建笔记", "New notes"), L("篇", "notes")),
    {
      id: "dailyAverage", label: L("日均字数", "Daily average"), value: number(current.dailyAverage), unit: L("字", "words"),
      detail: L(`按已过 ${number(current.elapsedDays)} 天计算`, `over ${number(current.elapsedDays)} days so far`), trend: "neutral",
    },
    {
      id: "bestDay", label: L("写得最多的一天", "Best day"), value: current.bestDay?.date ?? L("暂无记录", "none yet"), unit: "",
      detail: L(`${number(current.bestDay?.words ?? 0)} 字`, `${number(current.bestDay?.words ?? 0)} words`), trend: "neutral",
    },
  ];
  return { period, previous, current, metrics };
}

function noteLink(file: FileStat): string {
  // 保留双链结构，防止文件名变成标题、别名、块引用或嵌入的 Markdown。
  const entities: Record<string, string> = {
    "&": "&amp;", "|": "&#124;", "]": "&#93;", "[": "&#91;",
    "#": "&#35;", "^": "&#94;", "<": "&lt;", ">": "&gt;",
  };
  const path = file.file.path.replace(/\.md$/i, "").replace(/[\r\n]/g, " ")
    .replace(/[&|[\]#^<>]/g, (character) => entities[character]);
  return `[[${path}]]`;
}

function tableText(value: string): string {
  return value.replace(/[\r\n]/g, " ").replace(/&/g, "&amp;")
    .replace(/\\/g, "&#92;").replace(/\|/g, "\\|")
    .replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/([`*_[\]])/g, "\\$1");
}

/** ISO 周号用 UTC 日历运算，避免夏令时影响周数。 */
function periodKey(kind: ReportKind, start: Date): string {
  if (kind === "month") return dayKey(start).slice(0, 7);
  const thursday = new Date(Date.UTC(start.getFullYear(), start.getMonth(), start.getDate() + 3));
  const year = thursday.getUTCFullYear();
  const week = Math.ceil(((thursday.getTime() - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

function dailyRhythm(stats: VaultStats, settings: DashboardSettings, kind: ReportKind, period: ReportPeriod): string[] {
  const days: Date[] = [];
  for (let d = period.start; d < period.end; d = addDays(d, 1)) days.push(d);
  const lastDay = dayKey(stats.generatedAt);
  const checked = (day: Date) => isCheckinDay(stats, settings.dailyWordGoal, dayKey(day));
  const symbol = (day: Date) => dayKey(day) > lastDay ? "·" : checked(day) ? "■" : "□";
  const label = (day: Date) => `${dayKey(day).slice(5)} ${weekdayName(day.getDay())}`;
  const lines = [L("## 每日节奏", "## Daily rhythm"), "", L("■ 已打卡\u3000□ 未打卡\u3000· 未到日期", "■ streak day · □ missed · · not yet"), ""];
  if (kind === "week") {
    lines.push(`${L("周一 → 周日\u3000", "Mon → Sun  ")}${days.map(symbol).join("")}`, "");
  }
  // 两种报告都保留逐日字数；月报以紧凑三列表格避免手机横向拥挤。
  lines.push(L("| 日期 | 字数 | 打卡 |", "| Date | Words | Streak |"), "| :--- | ---: | :---: |");
  for (const day of days) {
    const future = dayKey(day) > lastDay;
    lines.push(`| ${label(day)} | ${future ? "—" : number(stats.dayWords[dayKey(day)] || 0)} | ${symbol(day)} |`);
  }
  return lines;
}

export function buildWritingReport(stats: VaultStats, settings: DashboardSettings, kind: ReportKind, offset: number, includeNotes: boolean) {
  const { period, previous, current, metrics } = writingReportOverview(stats, settings, kind, offset);
  const type = kind === "week" ? L("写作周报", "Weekly writing report") : L("写作月报", "Monthly writing report");
  const start = dayKey(period.start);
  const end = dayKey(addDays(period.end, -1));
  // 文件名沿用原格式，保留同名检测与覆盖逻辑。
  const title = L(`${type} ${start} 至 ${end}`, `${type} ${start} to ${end}`);
  const periodLabel = periodKey(kind, period.start);
  const dateRange = `${start} — ${end}`;
  const lines = [
    "---", `type: ${type}`, `period: ${periodLabel}`, `start: ${start}`, `end: ${end}`,
    `words: ${current.words}`, `checkins: ${current.checkins}`, `new_notes: ${current.created}`,
    "tags: [note-pulse]", "---", "",
    `# ${type} · ${periodLabel}`, "", dateRange, "",
  ];
  if (stats.generatedAt < period.end.getTime()) {
    lines.push(
      L(`> 本期尚未结束，统计截至 ${dayKey(stats.generatedAt)}，对比上一完整周期。`, `> This period is not over yet. Counted up to ${dayKey(stats.generatedAt)} and compared with the previous full period.`),
      ""
    );
  }
  lines.push(
    L("> [!summary] 概览", "> [!summary] Overview"),
    metrics.map((metric) => `> **${metric.value}${metric.unit ? ` ${metric.unit}` : ""}** · ${metric.label} · ${metric.detail}`).join("\n>\n"),
    "", ...dailyRhythm(stats, settings, kind, period), "",
    L("## 字数最多的笔记", "## Longest notes"), "",
    L("| 排名 | 笔记 | 字数 |", "| Rank | Note | Words |"), "| ---: | :--- | ---: |",
    ...current.topNotes.map((file, index) => `| ${index + 1} | ${noteLink(file)} | ${number(file.words)} |`),
    ...(current.topNotes.length ? [] : [L("| — | 暂无笔记 | — |", "| — | No notes | — |")]),
    "", L("## 常用标签", "## Top tags"), "", L("| 标签 | 篇数 |", "| Tag | Notes |"), "| :--- | ---: |",
    ...current.topTags.map(([tag, count]) => `| ${tableText(tag)} | ${number(count)} |`),
    ...(current.topTags.length ? [] : [L("| 暂无标签 | — |", "| No tags | — |")]),
  );
  if (includeNotes) {
    lines.push("", L(`> [!note]- 修改过的笔记（${number(current.modified.length)} 篇）`, `> [!note]- Modified notes (${number(current.modified.length)})`),
      ...current.modified.map((file) => `> - ${noteLink(file)}`));
    if (!current.modified.length) lines.push(L("> 暂无。", "> None."));
  }
  const prevRange = `${dayKey(previous.start)} — ${dayKey(addDays(previous.end, -1))}`;
  const source = settings.heatmapMode === "mtime"
    ? L("> 字数按最后修改日计入笔记全文；修改旧笔记会改变过去结果。", "> Each note's full word count goes to its last-modified day, so editing an old note changes past results.")
    : settings.heatmapMode === "delta"
      ? L("> 字数为启用记录后每天保存的新增字数；空白日期不代表没有写作。", "> Words are the daily additions recorded since logging started; a blank day does not mean nothing was written.")
      : L(
        `> 字数优先使用每日新增记录${stats.estimatedBefore ? `，${stats.estimatedBefore} 之前按最后修改日估算` : ""}。`,
        `> Words come from the recorded daily additions${stats.estimatedBefore ? `; before ${stats.estimatedBefore} they are estimated from last-modified dates` : ""}.`
      );
  lines.push("", L("> [!info]- 统计说明", "> [!info]- How this is counted"),
    L(`> 对比上期：${prevRange}。`, `> Compared with: ${prevRange}.`),
    ">",
    L(
      "> 日均按本期已过的日历天数计算（含统计当天、无写作日）；最佳日只取有字数的日期，并列取较早日期。",
      "> The daily average is over the calendar days so far in this period, including today and days with no writing. The best day only considers days with words; ties go to the earlier date."
    ),
    ">",
    L(
      "> 字数、打卡、新建笔记沿用看板设置。排除文件夹不参与；采集文件夹不计写作和新建；超大笔记按设置计入字数，新建数仍保留。",
      "> Words, streak days and new notes follow the dashboard settings. Excluded folders are left out; clipping folders count toward neither writing nor new notes; oversized notes follow the setting for words but still count as new notes."
    ),
    ">",
    source,
    L(`> 每日新增从 ${stats.logStartDay || "启用记录之日"} 开始记录，此前没有实测记录。`, `> Daily additions are recorded from ${stats.logStartDay || "the day logging started"}; there is no recorded data before that.`),
    ">",
    L(
      "> 达到每日目标或有当天日记即打卡。笔记排行和标签取期间新建或最后修改的笔记，按当前内容统计；修改列表只看最后修改时间，不代表全部编辑历史。这些列表排除采集笔记及设置中排除的超大笔记。",
      "> A day counts toward the streak when it reaches the daily goal or has a daily note. The note ranking and tags use notes created or last modified in the period, counted by their current content. The modified list only looks at last-modified times, not the full edit history. These lists leave out clipped notes and oversized notes excluded in settings."
    ),
  );
  return { title, periodLabel, dateRange, markdown: lines.join("\n") + "\n" };
}
