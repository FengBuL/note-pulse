import type { DashboardSettings } from "./settings";
import { addDays, dayKey, isCheckinDay, startOfDay } from "./stats";
import type { FileStat, VaultStats } from "./stats";

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
  const lastDay = dayKey(stats.generatedAt);
  for (let d = period.start; d < period.end; d = addDays(d, 1)) {
    const key = dayKey(d);
    if (key > lastDay) break;
    words += stats.dayWords[key] || 0;
    checkins += isCheckinDay(stats, settings.dailyWordGoal, key) ? 1 : 0;
    created += stats.dayCreated[key] || 0;
  }
  return { words, checkins, created };
}

export function summarizePeriod(stats: VaultStats, settings: DashboardSettings, period: ReportPeriod) {
  const { words, checkins, created } = summarizeWritingDays(stats, settings, period);
  const inPeriod = (time: number) => time >= period.start.getTime() && time < period.end.getTime() && time <= stats.generatedAt;
  const eligible = stats.files.filter((f) => !f.collected && !(settings.outlierMode === "exclude" && f.big));
  const modified = eligible.filter((f) => inPeriod(f.mtime)).sort((a, b) => a.file.path.localeCompare(b.file.path));
  const touched = eligible.filter((f) => inPeriod(f.mtime) || inPeriod(f.created));
  const topNote = [...touched].sort((a, b) => b.words - a.words || a.file.path.localeCompare(b.file.path))[0];
  const tags = new Map<string, number>();
  for (const file of touched) {
    for (const tag of file.tags) tags.set(tag, (tags.get(tag) || 0) + 1);
  }
  const topTags = [...tags].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5);
  return { words, checkins, created, topNote, topTags, modified };
}

function change(current: number, previous: number, unit: string): string {
  const delta = current - previous;
  const difference = delta === 0 ? "持平" : `${delta > 0 ? "增加" : "减少"} ${Math.abs(delta)} ${unit}`;
  return previous > 0 ? `${difference}（${delta > 0 ? "+" : ""}${Math.round(delta / previous * 100)}%）` : `${difference}（上一期为 0）`;
}

function noteLink(file: FileStat): string {
  // 避免特殊文件名改变 Markdown 的行结构或双链含义。
  return `[[${file.file.path.replace(/\.md$/i, "").replace(/[\r\n]/g, " ").replace(/\|/g, "&#124;").replace(/\]/g, "&#93;").replace(/\[/g, "&#91;")}]]`;
}

export function buildWritingReport(stats: VaultStats, settings: DashboardSettings, kind: ReportKind, offset: number, includeNotes: boolean) {
  const period = reportPeriod(kind, new Date(stats.generatedAt), offset);
  const previous = reportPeriod(kind, period.start, -1);
  const current = summarizePeriod(stats, settings, period);
  const prev = summarizePeriod(stats, settings, previous);
  const title = `写作${kind === "week" ? "周报" : "月报"} ${dayKey(period.start)} 至 ${dayKey(addDays(period.end, -1))}`;
  const lines = [
    `# ${title}`, "",
    `统计截至 ${dayKey(stats.generatedAt)}。${offset === 0 ? "本期尚未结束，以下为截至今天的结果。" : ""}`, "",
    `- 期间总字数：${current.words} 字`,
    `- 打卡天数：${current.checkins} 天`,
    `- 新建笔记：${current.created} 篇`,
    `- 字数最多的笔记：${current.topNote ? `${noteLink(current.topNote)}（当前 ${current.topNote.words} 字）` : "暂无"}`,
    `- 最常用标签：${current.topTags.length ? current.topTags.map(([tag, count]) => `${tag.replace(/[\r\n]/g, " ")}（${count} 篇）`).join("、") : "暂无"}`,
    "", "## 与上一期相比", "",
    `上一期：${dayKey(previous.start)} 至 ${dayKey(addDays(previous.end, -1))}。${offset === 0 ? "本期未结束，与上一完整周期比较。" : ""}`, "",
    `- 字数：${change(current.words, prev.words, "字")}`,
    `- 打卡：${change(current.checkins, prev.checkins, "天")}`,
    `- 新建笔记：${change(current.created, prev.created, "篇")}`,
    "", "## 统计说明", "",
    "字数、打卡和新建笔记数沿用看板的设置。排除的文件夹不参与；采集文件夹不计入写作和新建笔记数；超大笔记是否计入字数取决于设置，新建笔记数与看板一样保留。",
    settings.heatmapMode === "mtime" ? "字数按笔记最后修改日计入全文，修改旧笔记会改变过去的结果。" : settings.heatmapMode === "delta" ? "字数只包含启用记录后保存的每日新增字数；未记录的日期不代表没有写作。" : `字数优先使用每日新增记录${stats.estimatedBefore ? `，${stats.estimatedBefore} 之前按最后修改日估算` : ""}。`,
    `每日新增字数从${stats.logStartDay || "启用记录之日"}开始记录；之前没有实测记录，不代表没有写作。`,
    "达到每日字数目标或有当天日记就算打卡。字数最多的笔记和常用标签取自期间新建或最后修改的笔记，使用当前内容；修改列表只依据当前保存的最后修改时间，无法还原所有历史编辑。它们同样排除采集文件夹及设置中排除的超大笔记。",
  ];
  if (includeNotes) {
    lines.push("", "## 修改过的笔记", "", ...current.modified.map((f) => `- ${noteLink(f)}`));
    if (!current.modified.length) lines.push("暂无。");
  }
  return { title, markdown: lines.join("\n") + "\n" };
}
