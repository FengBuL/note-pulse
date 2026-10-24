/* 用示例数据渲染真实的看板代码（src/view.ts + styles.css），只用于本地看效果和截图 */
import { mk, q, stats } from "./sample";
import { DashboardView } from "../../src/view";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { setLanguage } from "../../src/i18n";
import { WidgetLayout, withItems } from "../../src/widgets";

const lang = (q.get("lang") === "en" ? "en" : "zh") as "en" | "zh";
setLanguage(lang);
const settings = { ...DEFAULT_SETTINGS, language: lang, dailyWordGoal: 500, weeklyWordGoal: 10000, onboarded: true, weekStyle: (q.get("week") === "bars" ? "bars" : "dots") as "dots" | "bars" };
const dedupe = {
  scanning: false, stale: false, analysis: null as unknown, ignoredSet: () => new Set<string>(),
  openReport: async () => undefined, startCleanup: () => undefined,
};
const app = {
  vault: { getName: () => "我的知识库", getMarkdownFiles: () => [], getAbstractFileByPath: (p: string) => mk(p, 0) },
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

// 测试用：把布局换成指定的几张卡（位置和大小自己定），并重画
(window as unknown as { previewLayout: (items: { id: string; x: number; y: number; w: number; h: number }[]) => void }).previewLayout = (items) => {
  settings.layout = withItems(items) as WidgetLayout;
  view.render(stats);
};
