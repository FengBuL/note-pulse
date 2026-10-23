/* 用示例数据渲染真实的看板代码（src/view.ts + styles.css），只用于本地看效果和截图 */
import "./obsidian-dom";
import { TFile } from "obsidian";
import { DashboardView } from "../../src/view";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { addDays, dayKey, startOfDay } from "../../src/stats";
import type { FileStat, TaskInfo, VaultStats } from "../../src/stats";

const q = new URLSearchParams(location.search);
const theme = q.get("theme") === "dark" ? "dark" : "light";
document.body.classList.add(`theme-${theme}`);
const NOW = new Date(2026, 9, 24, 21, 30);
// 固定“今天”：Date.now() 和 new Date() 都返回示例日期
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...a: unknown[]) {
    if (a.length === 0) super(NOW.getTime());
    else super(...(a as [number]));
  }
  static now() {
    return NOW.getTime();
  }
}
(globalThis as unknown as { Date: DateConstructor }).Date = FixedDate as unknown as DateConstructor;

let seed = 11;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const mk = (path: string, mtime: number) => Object.assign(new TFile(), { path, stat: { mtime, ctime: mtime, size: 100 }, parent: { path: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "/" } });

const today = startOfDay(NOW);
const dayWords: Record<string, number> = {};
const dayCreated: Record<string, number> = {};
const dayModified: Record<string, TFile[]> = {};
for (let i = 370; i >= 0; i--) {
  const d = addDays(today, -i);
  const r = 1 - i / 370;
  if (rnd() < 0.2 + r * 0.55) dayWords[dayKey(d)] = Math.round(rnd() * 2600 * (0.35 + r));
  if (rnd() < 0.35) dayCreated[dayKey(d)] = 1 + Math.floor(rnd() * 3);
}
// 本周：一 1320、二 2050、三 380、四 1730、五 1700、六（今天）640
const wk = [1320, 2050, 380, 1730, 1700, 640];
wk.forEach((v, i) => (dayWords[dayKey(addDays(today, -5 + i))] = v));
dayCreated[dayKey(today)] = 2;

// ?big=1：按真实库的数量级放大列表（孤立笔记、断链、标签、待办），用来测展开 / 收起
const big = q.get("big") === "1";
const names = ["读书笔记 · 思考，快与慢", "2026-10-24", "周报模板改成双栏", "个人网站改版", "咖啡店选址想法", "键盘配列草稿", "2026-09 播客摘录", "未命名 3", "Readwise 导出", "年度旅行", "需求评审", "TypeScript 类型体操"];
const files: FileStat[] = [];
for (let i = 0; i < 757; i++) {
  const created = addDays(today, -Math.floor(Math.pow(rnd(), 1.6) * 900)).getTime() + 3600_000;
  const name = i < names.length ? names[i] : `笔记 ${i}`;
  const words = name === "未命名 3" ? 0 : name === "Readwise 导出" ? 214000 : Math.round(200 + rnd() * 4000);
  const f = mk(`${i % 3 ? "工作" : "读书"}/${name}.md`, i < 7 ? NOW.getTime() - i * 900_000 : created);
  files.push({ file: f, created, mtime: f.stat.mtime, words, writeWords: words > 20000 ? 0 : words, collected: false, big: words > 20000, folder: i % 3 ? "工作" : "读书", tags: i % 4 ? ["日记"] : ["读书", "ai"], links: name === "未命名 3" ? 0 : 2, embeds: 0 });
}
dayModified[dayKey(today)] = files.slice(0, 7).map((f) => f.file);
const task = (due: string, text: string, note: string): TaskInfo => ({ file: mk(`工作/${note}.md`, 0), line: 3, text: `${text} 📅 ${due}`, status: "pending", due });
const k = (n: number) => dayKey(addDays(today, n));

const stats: VaultStats = {
  generatedAt: NOW.getTime(), durationMs: 120, totalNotes: 757, totalWords: 2_004_000, writeWordsTotal: 1_790_000,
  created7: 12, created30: 110, modified7: 60, modified30: 210, totalLinks: 2020, uniqueTags: 17, tagOccurrences: 824,
  files, dayWords, estimatedBefore: k(-6), logStartDay: k(-6), dayModified, dayCreated,
  dailyNotes: { [k(0)]: files[1].file },
  outliers: { count: 1, words: 214000, top: [], threshold: 20000, mode: "exclude" }, hints: [],
  tasks: {
    total: 1175, done: 825, pending: 350, cancelled: 4,
    overdue: [task(k(-4), "更新年度旅行预算", "年度旅行"), task(k(-3), "检查家庭账本链接", "家庭账本")],
    dueSoon: [task(k(0), "整理读书笔记", "读书"), task(k(1), "周报模板改成双栏", "工作"), task(k(3), "回复个人网站改版评论", "个人网站改版"), task(k(5), "预约体检", "生活"), task(k(6), "需求评审", "需求评审")],
    byFolder: [{ key: "工作", total: 400, done: 260, pending: 140 }, { key: "读书", total: 200, done: 150, pending: 50 }], byNote: [],
  },
  tags: big ? Array.from({ length: 60 }, (_, i): [string, number] => [`标签${i + 1}`, 400 - i * 6]) : [["日记", 184], ["读书", 120], ["ai", 66], ["产品", 50], ["写作", 50], ["效率", 41], ["学习", 38], ["旅行", 20]],
  links: {
    topLinked: [], orphans: big ? files.slice(20, 260).map((f) => f.file) : [files[4].file, files[6].file, files[5].file], unresolvedCount: big ? 420 : 40,
    topUnresolved: big ? Array.from({ length: 10 }, (_, i): [string, number] => [`断链 ${i + 1}`, 30 - i * 2]) : [["年度复盘 2025", 3], ["竞品分析-v2", 2], ["TypeScript 类型", 1], ["周会纪要", 1]],
    unresolvedSource: { "年度复盘 2025": "工作/周会.md" },
  },
  folders: [{ folder: "工作", notes: 505, words: 1_200_000 }, { folder: "读书", notes: 252, words: 800_000 }],
};

const settings = { ...DEFAULT_SETTINGS, dailyWordGoal: 500, weeklyWordGoal: 10000, onboarded: true, weekStyle: (q.get("week") === "bars" ? "bars" : "dots") as "dots" | "bars" };
const dedupe = {
  scanning: false, stale: false, analysis: null as unknown, ignoredSet: () => new Set<string>(),
  openReport: async () => undefined, startCleanup: () => undefined,
};
const app = {
  vault: { getName: () => "我的知识库", getMarkdownFiles: () => [] },
  metadataCache: { getFileCache: () => null },
  workspace: { openLinkText: async () => undefined },
  fileManager: { trashFile: async () => undefined },
};
const plugin = {
  settings, lastStats: stats, dedupe,
  requestRefresh: async () => undefined, openSettings: () => undefined, openFile: async () => undefined, openSearch: () => undefined,
  revealFolder: () => undefined, saveSettings: async () => undefined, saveViewSetting: async () => undefined, openWritingReport: async () => undefined,
  setClippingFolder: async () => undefined, excludeFolder: async () => undefined, dismissHint: async () => undefined, setOutlierExclusion: async () => undefined,
};
const host = document.getElementById("app") as HTMLElement;
host.classList.add("workspace-leaf-content");
const view = new DashboardView({ app, host } as never, plugin as never);
void view.onOpen().then(() => {
  view.render(stats);
  document.body.dataset.ready = "1";
});
// 模拟一次自动刷新：总字数 + delta，其余不变（验证“只有变了的数字才动”）
(window as unknown as { previewRefresh: (delta: number) => void }).previewRefresh = (delta) => {
  stats.totalWords += delta;
  view.render({ ...stats, generatedAt: stats.generatedAt });
};
