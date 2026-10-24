/* 本地预览“重复内容清理”页：用几篇构造的笔记跑真实的分析代码（analyze），再用真实的页面代码渲染 */
import "./obsidian-dom";
import { analyze, FileRecord } from "../../src/dedupe/core/group";
import { tokenize } from "../../src/dedupe/core/tokenize";
import { DEFAULT_SETTINGS } from "../../src/dedupe/settings";
import { groupKey } from "../../src/dedupe/core/summary";
import { ClipDedupeView } from "../../src/dedupe/view";
import { setLanguage } from "../../src/i18n";

const q = new URLSearchParams(location.search);
setLanguage(q.get("lang") === "en" ? "en" : "zh");
const opts = { ignoreFrontmatter: true, ignoreCode: true, ignoreHeadings: true, ignoreLinkOnly: true, minLength: 80, detectStatusIds: true };
const para = (s: string) => `${s}。${"这是一段用来凑够长度的内容，保证它超过最小长度的限制。".repeat(3)}`;
const notes: Record<string, string> = {};
// 两篇几乎一样的笔记（同一篇文章剪藏了两次）
const body = ["Building effective agents", "上下文工程", "评估循环", "成本与适用边界", "术语表"].map(para);
notes["2026-08-15 TG01 workflow 与 agent 边界.md"] = body.join("\n\n");
notes["2026-08-16 TG01 剪藏副本.md"] = body.join("\n\n") + "\n\n" + para("副本里多出来的一段");
// 一篇引用了别人的一段，其余是自己的内容
const ref = para("Building effective agents, Anthropic Engineering, https://www.anthropic.com/engineering/building-effective-agents");
for (let i = 1; i <= 12; i++) notes[`2026-08-1${i % 9} 笔记${i}.md`] = `${ref}\n\n${para(`第 ${i} 篇的独立内容甲`)}\n\n${para(`第 ${i} 篇的独立内容乙`)}\n\n${para(`第 ${i} 篇的独立内容丙`)}`;
const files: FileRecord[] = Object.entries(notes).map(([path, text], i) => {
  const t = tokenize(text, opts);
  return { path, ctime: Date.UTC(2026, 7, 15 + (i % 5)), mtime: Date.UTC(2026, 7, 15 + (i % 5)), len: text.length, lines: t.lines, totalW: t.totalW, blocks: t.blocks };
});
const analysis = analyze(files);
const settings = { ...DEFAULT_SETTINGS, ignored: [] as string[] };
let version = 1;
const plugin = {
  analysis, scanning: false, stale: false, latestBackup: null, analysisVersion: version, settings,
  get app() { return {}; },
  ignoredSet: () => new Set(settings.ignored),
  openHelp() {}, openSettings() {}, async scan() {}, cancelScan() {}, async undoLast() {}, folderList: () => [], async setScope() {},
  startCleanup(items: unknown[], mode?: string) { console.log("startCleanup", items.length, mode); (window as unknown as { __cleanup: unknown[] }).__cleanup = items; },
  pairItems: (ids: string[], older: string, newer: string) => ids.map((id) => ({ id, older, newer })),
  async openBoth(a: string, b: string) { console.log("openBoth", a, b); },
  async openNote(path: string) { console.log("openNote", path); },
  async ignoreGroup(g: { occs: unknown[] }) { settings.ignored.push(groupKey(g as never)); view.refresh(); },
  async ignorePair(p: { groupIds: string[] }) { for (const id of p.groupIds) { const g = analysis.groups.find((x) => x.id === id); if (g) settings.ignored.push(groupKey(g)); } view.refresh(); },
  async restoreIgnored() { settings.ignored = []; plugin.settings.ignored = []; view.refresh(); },
  async readBlock(o: { path: string; block: { s: number; e: number } }) { const text = notes[o.path] ?? ""; return text.split("\n").slice(o.block.s, o.block.e + 1).join("\n"); },
};
const host = document.getElementById("app") as HTMLElement;
host.classList.add("workspace-leaf-content");
const view = new ClipDedupeView({ app: {}, host } as never, plugin as never);
void view.onOpen().then(() => {
  document.body.dataset.ready = "1";
});
(window as unknown as { dedupeView: unknown; dedupeAnalysis: unknown }).dedupeView = view;
(window as unknown as { dedupeAnalysis: unknown }).dedupeAnalysis = { groups: analysis.groups.length, pairs: analysis.pairs.length };
