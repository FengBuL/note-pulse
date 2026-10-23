/* 预览用的示例库数据：主看板（main.ts）和 2.0 小组件原型（widgets.ts）共用 */
import "./obsidian-dom";
import { TFile } from "obsidian";
import { addDays, dayKey, startOfDay } from "../../src/stats";
import type { FileStat, TaskInfo, VaultStats } from "../../src/stats";
export const q = new URLSearchParams(location.search);
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
export const mk = (path: string, mtime: number) => Object.assign(new TFile(), { path, stat: { mtime, ctime: mtime, size: 100 }, parent: { path: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "/" } });

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
// ?lang=en：英文界面
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

export const stats: VaultStats = {
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
    unresolvedFrom: { "竞品分析-v2": ["工作/周会.md", "工作/需求评审.md"] },
    suggestions: { "竞品分析-v2": { name: "竞品分析-v2", target: "工作/竞品分析 v2.md", kind: "loose" } },
    sameName: [["harness/README.md", "墨笔/README.md"], ["harness/Track C/TG03-边界与确认门.md", "harness/公众号文章/TG03-边界与确认门.md"]],
    unusedAttachments: [
      Object.assign(mk("大模型学习/附件/Pasted image 20260325130021.png", 0), { name: "Pasted image 20260325130021.png", stat: { mtime: 0, ctime: 0, size: 412_000 } }),
      Object.assign(mk("大模型学习/大模型学习顺序.svg", 0), { name: "大模型学习顺序.svg", stat: { mtime: 0, ctime: 0, size: 38_000 } }),
    ],
  },
  folders: [{ folder: "工作", notes: 505, words: 1_200_000 }, { folder: "读书", notes: 252, words: 800_000 }],
};

