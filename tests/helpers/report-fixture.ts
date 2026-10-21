import type { TFile } from "obsidian";
import type { FileStat, VaultStats } from "../../src/stats";
import { addDays, dayKey } from "../../src/stats";

/** 固定本地日期，涵盖上月、本月、上周、本周和日记打卡。 */
export function reportFixture(): VaultStats {
  const timestamp = (value: string) => new Date(`${value}T12:00:00`).getTime();
  const entries: [string, number, string, string, string[]][] = [
    ["文章/把写作变成日常.md", 12480, "2026-10-03", "2026-10-20", ["#写作", "#习惯"]],
    ["研究/城市里的慢生活.md", 5860, "2026-09-22", "2026-10-19", ["#观察", "#写作"]],
    ["文章/秋日散步.md", 3240, "2026-10-19", "2026-10-21", ["#随笔", "#生活"]],
    ["草稿/一间书店的下午.md", 1680, "2026-10-20", "2026-10-20", ["#随笔"]],
    ["读书/阅读与思考.md", 1250, "2026-10-01", "2026-10-19", ["#阅读", "#写作"]],
    ["想法/下一篇文章.md", 420, "2026-10-21", "2026-10-21", ["#写作"]],
    ["日记/2026-10-20.md", 80, "2026-10-20", "2026-10-20", ["#生活"]],
    ["文章/九月小结.md", 2800, "2026-09-28", "2026-09-30", ["#写作", "#生活"]],
  ];
  const files: FileStat[] = entries.map(([path, words, created, modified, tags]) => ({
    file: { path } as TFile, words, writeWords: words, created: timestamp(created), mtime: timestamp(modified),
    collected: false, big: false, folder: path.slice(0, path.lastIndexOf("/")), tags, links: 3,
  }));
  const dayWords: Record<string, number> = {};
  const dayCreated: Record<string, number> = {};
  const daily = [680, 1240, 0, 920, 340, 1580, 0];
  let index = 0;
  for (let d = new Date(2026, 8, 1); d <= new Date(2026, 9, 21); d = addDays(d, 1)) {
    dayWords[dayKey(d)] = daily[index % daily.length];
    dayCreated[dayKey(d)] = index % 3 === 0 ? 1 : 0;
    index++;
  }
  Object.assign(dayWords, { "2026-10-19": 2480, "2026-10-20": 80, "2026-10-21": 1260 });
  return {
    generatedAt: timestamp("2026-10-21"), durationMs: 38,
    totalNotes: files.length, totalWords: 27810, writeWordsTotal: 27810,
    created7: 4, created30: 7, modified7: 7, modified30: 7, totalLinks: 24, uniqueTags: 6, tagOccurrences: 14,
    files, dayWords, dayCreated, dayModified: {},
    dailyNotes: { "2026-10-20": { path: "日记/2026-10-20.md" } as TFile },
    estimatedBefore: "2026-09-01", logStartDay: "2026-09-01",
    outliers: { count: 0, words: 0, top: [], threshold: 20000, mode: "exclude" }, hints: [],
    tasks: { total: 0, done: 0, pending: 0, cancelled: 0, overdue: [], dueSoon: [], byFolder: [], byNote: [] },
    tags: [], links: { topLinked: [], orphans: [], unresolvedCount: 0, topUnresolved: [] }, folders: [],
  };
}
