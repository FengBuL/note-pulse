/* 2.0 小组件系统交互原型：尺寸档位、编辑看板、6 张新卡片。数字全部由示例库数据算出（和主预览同一份）。
 * 只用于确认设计；正式实现会把这里的卡片定义搬进 src/。 */
import { stats } from "./sample";
import { setLanguage, L, weekdayName, count, unit } from "../../src/i18n";
import { bigNumber, drawSparkline, fmtFull, fmtNum } from "../../src/charts";
import { folderShares, linkDensity, noteActivity, weekdayRhythm, weeklyWords } from "../../src/dashboard-logic";

const q = new URLSearchParams(location.search);
setLanguage(q.get("lang") === "en" ? "en" : "zh");
const NOW = new Date(stats.generatedAt);

type Size = "s" | "m" | "l" | "xl";
interface Widget {
  id: string;
  name: () => string;
  desc: () => string;
  sizes: Size[];
  isNew?: boolean;
  render: (body: HTMLElement, size: Size) => void;
}

/* ---------- 卡片内容 ---------- */

const head = (card: HTMLElement, icon: string, title: string) => {
  const h = card.createDiv({ cls: "vp-card-head" });
  const t = h.createDiv({ cls: "vp-card-title" });
  t.createSpan({ cls: "wg-icon", text: icon });
  t.createSpan({ text: title });
  return h;
};
/** 设计说明：放进卡片标题旁的“?”气泡（悬停看），不占卡片里的空间——卡片内容就是实际上线的样子 */
const sizeNote = (body: HTMLElement, text: string) => {
  const title = body.parentElement?.querySelector(".vp-card-title");
  if (title) title.createSpan({ cls: "wg-why", text: "?", attr: { title: text, "aria-label": text } });
};

/** 今日写作（现有卡片的多档位示意） */
function renderToday(body: HTMLElement, size: Size) {
  const today = stats.dayWords[Object.keys(stats.dayWords).sort().pop() as string] || 0;
  const row = body.createDiv({ cls: "wg-row" });
  const ring = row.createDiv({ cls: "wg-ring", attr: { style: `--p:${Math.min(1, today / 500)}` } });
  bigNumber(ring, today, undefined, "vp-num vp-num-sm");
  if (size !== "s") {
    const st = row.createDiv();
    st.createDiv({ cls: "vp-label", text: L("连续打卡", "Streak") });
    bigNumber(st, "3", unit("days", 3), "vp-num");
  }
  if (size === "l") {
    const wk = body.createDiv({ cls: "wg-week" });
    [1320, 2050, 380, 1730, 1700, 640, 0].forEach((v, i) => {
      const c = wk.createDiv({ cls: "wg-week-day" + (v >= 500 ? " is-done" : "") });
      c.createDiv({ cls: "wg-week-dot", text: v >= 500 ? "✓" : v ? `${Math.floor((v / 500) * 100)}%` : "" });
      c.createDiv({ cls: "wg-week-label", text: weekdayName([1, 2, 3, 4, 5, 6, 0][i]) });
    });
    const chips = body.createDiv({ cls: "wg-chips" });
    chips.createDiv({ cls: "vp-label", text: L("今天写过", "Worked on today") });
    const row2 = chips.createDiv({ cls: "vp-chips" });
    for (const n of ["读书笔记 · 思考，快与慢", "2026-10-24", "周报模板改成双栏"]) row2.createSpan({ cls: "vp-chip", text: n });
  }
  sizeNote(body, size === "s" ? L("S：今日字数 + 环", "S: today's words + ring") : size === "m" ? L("M：+ 连续打卡", "M: + streak") : L("L：+ 本周七天（现在看板上的样子）", "L: + this week (as on today's dashboard)"));
}

/** 总字数（现有 S/M 卡片） */
function renderWords(body: HTMLElement, size: Size) {
  const row = body.createDiv({ cls: "vp-kpi-row" });
  bigNumber(row.createDiv(), stats.totalWords, unit("words"));
  if (size === "m") {
    const w = weeklyWords(stats, 12, NOW);
    drawSparkline(body.createDiv({ cls: "vp-kpi-viz" }), w.map((p) => p.value));
  } else row.createSpan({ cls: "vp-delta is-up", text: "+18.4K" });
}

/** ★ 最常被链接：排名列表，条形长度=被链接次数 */
function renderTopLinked(body: HTMLElement, size: Size) {
  const items: [string, number][] = [
    ["知识地图MOC", 64], ["harness/README", 41], ["pandas常用函数-重构版", 27], ["LangGraph入门完全指南", 22],
    ["API调用速查表", 18], ["RAG 代码落地-重构版", 15], ["Claude Code 使用指南", 12], ["股票数据获取完整指南", 9],
  ];
  const max = items[0][1];
  const list = body.createDiv({ cls: "vp-barlist" });
  for (const [name, n] of items.slice(0, size === "l" ? 6 : 2)) {
    const r = list.createDiv({ cls: "vp-barrow" });
    const top = r.createDiv({ cls: "vp-barrow-top" });
    top.createSpan({ cls: "vp-barlabel", text: name });
    top.createSpan({ cls: "vp-barvalue", text: L(`${n} 处链接`, `${n} links`) });
    r.createDiv({ cls: "vp-bartrack" }).createDiv({ cls: "vp-barfill", attr: { style: `--vp-bar-width:${(n / max) * 100}%` } });
  }
  sizeNote(body, L("数据：links.topLinked（已经在算，从没展示过）。示例里用的是你库里的笔记名。", "Data: links.topLinked (already computed, never shown). Names are from your vault as an example."));
}

/** ★ 写作节奏：七根竖条，突出最常写的一天 */
function renderRhythm(body: HTMLElement, size: Size) {
  const r = weekdayRhythm(stats, NOW, 12);
  const max = Math.max(...r.map((x) => x.average), 1);
  const best = r.reduce((a, b) => (b.average > a.average ? b : a));
  if (size === "s") {
    const row = body.createDiv({ cls: "vp-kpi-row" });
    bigNumber(row.createDiv(), weekdayName(best.day), undefined);
    row.createSpan({ cls: "vp-kpi-caption", text: L(`平均 ${fmtFull(best.average)} 字`, `${fmtFull(best.average)} words avg`) });
  }
  const bars = body.createDiv({ cls: "wg-rhythm" + (size === "s" ? " is-mini" : "") });
  for (const x of r) {
    const c = bars.createDiv({ cls: "wg-rhythm-col" + (x === best ? " is-best" : ""), attr: { title: `${weekdayName(x.day)} · ${fmtFull(x.average)}` } });
    if (size !== "s") c.createDiv({ cls: "wg-rhythm-val", text: x === best ? fmtNum(x.average) : "" });
    c.createDiv({ cls: "wg-rhythm-bar", attr: { style: `--h:${Math.max(4, (x.average / max) * 100)}%` } });
    if (size !== "s") c.createDiv({ cls: "wg-rhythm-label", text: weekdayName(x.day) });
  }
  if (size !== "s") sizeNote(body, L(`近 12 周每个星期几的平均字数。最常写：${weekdayName(best.day)}。`, `Average words per weekday over 12 weeks. Busiest: ${weekdayName(best.day)}.`));
}

/** ★ 笔记活跃度：新建 vs 修改，两个数字 + 一条分段条（不用两段的环） */
function renderActivity(body: HTMLElement, size: Size) {
  const a = noteActivity(stats, NOW);
  const total = Math.max(1, a.created + a.edited);
  const row = body.createDiv({ cls: "wg-pair" });
  const one = (label: string, n: number, cls: string) => {
    const x = row.createDiv({ cls: "wg-pair-item" });
    x.createDiv({ cls: "vp-label", text: label });
    bigNumber(x, n, unit("notes", n), `vp-num ${size === "s" ? "vp-num-sm" : ""}`);
    x.addClass(cls);
  };
  one(L("新建", "New"), a.created, "is-a");
  one(L("改旧的", "Edited"), a.edited, "is-b");
  const bar = body.createDiv({ cls: "wg-split", attr: { role: "img", "aria-label": L(`新建 ${a.created}，修改 ${a.edited}`, `${a.created} new, ${a.edited} edited`) } });
  bar.createDiv({ cls: "wg-split-a", attr: { style: `--w:${(a.created / total) * 100}%` } });
  bar.createDiv({ cls: "wg-split-b", attr: { style: `--w:${(a.edited / total) * 100}%` } });
  if (size === "m") sizeNote(body, L("近 30 天。看你是在写新的，还是在改旧的。数据：created / mtime（已有）。", "Last 30 days: writing new notes or reworking old ones. Data: created / mtime (already available)."));
}

/** ★ 任务最多的笔记：列表 + 每行完成进度 */
function renderTaskNotes(body: HTMLElement, size: Size) {
  const items: [string, number, number][] = [
    ["墨笔-更新版/待办", 48, 31], ["harness/Track C/TG04", 22, 9], ["工作/需求评审", 15, 12], ["个人网站改版", 12, 4],
    ["年度旅行", 9, 7], ["家庭账本", 8, 8],
  ];
  const list = body.createDiv({ cls: "vp-rows" });
  for (const [name, total, done] of items.slice(0, size === "l" ? 6 : 2)) {
    const r = list.createDiv({ cls: "vp-row vp-group-row" });
    r.createSpan({ cls: "vp-row-name", text: name });
    r.createDiv({ cls: "vp-meter is-inline" }).createDiv({ cls: "vp-meter-fill", attr: { style: `--vp-meter-width:${(done / total) * 100}%` } });
    r.createSpan({ cls: "vp-row-meta vp-tabular wg-nowrap", text: L(`待办 ${total - done}`, `${total - done} open`) });
  }
  sizeNote(body, L("数据：tasks.byNote（已经在算，从没展示过）。“接下来”按日期，这张按笔记。", "Data: tasks.byNote (already computed, never shown). Next up sorts by date; this one by note."));
}

/** ★ 链接密度：一个数字的卡片，不画仪表盘（一个数就是图） */
function renderDensity(body: HTMLElement) {
  const d = linkDensity(stats);
  const row = body.createDiv({ cls: "vp-kpi-row" });
  bigNumber(row.createDiv(), String(d.perNote), L("个/篇", "per note"));
  row.createSpan({ cls: "vp-kpi-caption", text: L(`${d.connected}% 的笔记连着别的笔记`, `${d.connected}% of notes are linked`) });
  sizeNote(body, L("数据：totalLinks、孤立笔记数（已有）。", "Data: totalLinks and orphans (already available)."));
}

/** ★ 文件夹构成：堆叠横条，最多 4 个文件夹 + 其他；带图例，颜色已通过色盲安全校验 */
function renderFolders(body: HTMLElement, size: Size) {
  const demo = { ...stats, folders: [
    { folder: "harness", notes: 96, words: 0 }, { folder: "日常总结", notes: 58, words: 0 }, { folder: "大模型学习", notes: 31, words: 0 },
    { folder: "pandas", notes: 18, words: 0 }, { folder: "python知识", notes: 12, words: 0 }, { folder: "x", notes: 9, words: 0 }, { folder: "墨笔-更新版", notes: 7, words: 0 },
  ] };
  const parts = folderShares(demo, 4);
  const bar = body.createDiv({ cls: "wg-stack", attr: { role: "img", "aria-label": parts.map((p) => `${p.other ? L("其他", "Other") : p.folder} ${Math.round(p.share * 100)}%`).join(", ") } });
  parts.forEach((p, i) => bar.createDiv({ cls: `wg-stack-seg ${p.other ? "is-other" : `is-c${i + 1}`}`, attr: { style: `--w:${p.share * 100}%`, title: `${p.folder || L("其他", "Other")} · ${p.notes}` } }));
  const legend = body.createDiv({ cls: "wg-legend" + (size === "l" ? " is-list" : "") });
  parts.forEach((p, i) => {
    const it = legend.createDiv({ cls: "wg-legend-item" });
    it.createSpan({ cls: `wg-swatch ${p.other ? "is-other" : `is-c${i + 1}`}` });
    it.createSpan({ cls: "wg-legend-name", text: p.other ? L("其他", "Other") : p.folder });
    it.createSpan({ cls: "wg-legend-val", text: `${Math.round(p.share * 100)}%${size === "l" ? ` · ${count(p.notes, "notes")}` : ""}` });
  });
  sizeNote(body, L("按笔记数。前 4 个文件夹各一色，其余并成“其他”（灰）。示例用你库里的文件夹名。", "By note count. Top 4 folders get a color each, the rest is Other (gray). Folder names from your vault as an example."));
}

/* ---------- 卡片目录 ---------- */

const WIDGETS: Widget[] = [
  { id: "today", name: () => L("今日写作", "Today"), desc: () => L("已有。三档信息量不同。", "Existing. Three densities."), sizes: ["s", "m", "l"], render: renderToday },
  { id: "words", name: () => L("总字数", "Words"), desc: () => L("已有。", "Existing."), sizes: ["s", "m"], render: renderWords },
  { id: "topLinked", name: () => L("最常被链接", "Most linked"), desc: () => L("哪些笔记是你的核心", "Which notes are your hubs"), sizes: ["m", "l"], isNew: true, render: renderTopLinked },
  { id: "rhythm", name: () => L("写作节奏", "Writing rhythm"), desc: () => L("一般星期几写", "Which weekdays you write"), sizes: ["s", "m"], isNew: true, render: renderRhythm },
  { id: "activity", name: () => L("笔记活跃度", "Note activity"), desc: () => L("写新的还是改旧的", "New notes or reworking old ones"), sizes: ["s", "m"], isNew: true, render: renderActivity },
  { id: "taskNotes", name: () => L("任务最多的笔记", "Notes with most tasks"), desc: () => L("任务压在哪几篇", "Where tasks pile up"), sizes: ["m", "l"], isNew: true, render: renderTaskNotes },
  { id: "density", name: () => L("链接密度", "Link density"), desc: () => L("库连得紧不紧", "How connected the vault is"), sizes: ["s"], isNew: true, render: renderDensity },
  { id: "folders", name: () => L("文件夹构成", "Folder mix"), desc: () => L("内容都在哪些文件夹", "Where your notes live"), sizes: ["m", "l"], isNew: true, render: renderFolders },
];

/* ---------- 布局与编辑 ---------- */

const SIZE_LABEL: Record<Size, string> = { s: "S", m: "M", l: "L", xl: "XL" };
let layout: { id: string; size: Size }[] = [
  { id: "today", size: "l" }, { id: "rhythm", size: "s" }, { id: "density", size: "s" },
  { id: "activity", size: "m" }, { id: "topLinked", size: "m" }, { id: "folders", size: "m" },
  { id: "words", size: "s" }, { id: "taskNotes", size: "m" },
];
let editing = q.get("edit") === "1";

const root = document.getElementById("app") as HTMLElement;
root.addClass("vp-root", "wg-root");

function render() {
  root.empty();
  const shell = root.createDiv({ cls: "vp-shell" });
  const bar = shell.createDiv({ cls: "wg-bar" });
  const title = bar.createDiv();
  title.createEl("h1", { cls: "vp-title", text: L("2.0 小组件 · 设计原型", "2.0 widgets · design prototype") });
  title.createDiv({ cls: "vp-subtitle", text: L("示例数据。★ 是新卡片。点“编辑看板”试试换尺寸、隐藏、添加。", "Sample data. ★ marks new cards. Try Edit to change sizes, hide and add.") });
  const btn = bar.createEl("button", { cls: "vp-btn" + (editing ? " is-primary" : ""), text: editing ? L("完成", "Done") : L("编辑看板", "Edit") });
  btn.addEventListener("click", () => {
    editing = !editing;
    render();
  });

  const grid = shell.createDiv({ cls: "wg-grid" + (editing ? " is-editing" : "") });
  for (const item of layout) {
    const w = WIDGETS.find((x) => x.id === item.id);
    if (!w) continue;
    const card = grid.createDiv({ cls: `vp-card wg-card is-${item.size}` });
    const h = head(card, w.isNew ? "★" : "•", w.name());
    if (editing) {
      const tools = h.createDiv({ cls: "wg-tools" });
      const seg = tools.createDiv({ cls: "vp-seg" });
      for (const sz of w.sizes) {
        const b = seg.createEl("button", { cls: "vp-seg-btn" + (sz === item.size ? " is-active" : ""), text: SIZE_LABEL[sz], attr: { "aria-label": L(`尺寸 ${SIZE_LABEL[sz]}`, `Size ${SIZE_LABEL[sz]}`) } });
        b.addEventListener("click", () => {
          item.size = sz;
          render();
        });
      }
      const hide = tools.createEl("button", { cls: "vp-icon-btn is-small", text: "×", attr: { "aria-label": L("隐藏", "Hide") } });
      hide.addEventListener("click", () => {
        layout = layout.filter((x) => x !== item);
        render();
      });
    }
    w.render(card.createDiv({ cls: "vp-card-body" }), item.size);
  }

  if (editing) {
    const hidden = WIDGETS.filter((w) => !layout.some((x) => x.id === w.id));
    const add = shell.createDiv({ cls: "vp-card wg-add" });
    add.createDiv({ cls: "vp-card-title", text: L("添加卡片", "Add a card") });
    if (!hidden.length) add.createDiv({ cls: "wg-note", text: L("所有卡片都在看板上了。", "Every card is on the dashboard.") });
    const list = add.createDiv({ cls: "wg-add-list" });
    for (const w of hidden) {
      const b = list.createEl("button", { cls: "wg-add-item" });
      b.createDiv({ cls: "wg-add-name", text: `${w.isNew ? "★ " : ""}${w.name()}` });
      b.createDiv({ cls: "wg-add-desc", text: `${w.desc()} · ${w.sizes.map((s) => SIZE_LABEL[s]).join(" / ")}` });
      b.addEventListener("click", () => {
        layout.push({ id: w.id, size: w.sizes[Math.min(1, w.sizes.length - 1)] });
        render();
      });
    }
  }
  document.body.dataset.ready = "1";
}
render();
