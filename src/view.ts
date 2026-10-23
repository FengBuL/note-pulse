import { ItemView, Notice, Platform, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type NotePulsePlugin from "./main";
import { ConfirmModal } from "./dedupe/modals";
import { writingReportOverview } from "./report-logic";
import { latestWritingReport } from "./report-storage";
import { overview as dedupeOverview } from "./dedupe/core/summary";
import { groupItem } from "./dedupe/core/plan";
import {
  TrendMetric,
  TrendRange,
  busiestWeekday,
  checkupModel,
  folderShares,
  linkDensity,
  noteActivity,
  weekdayRhythm,
  headline,
  monthWriting,
  trendModel,
  weekDays,
  weekStart,
  weeklyCheckins,
  weeklyNotes,
  weeklyWords,
} from "./dashboard-logic";
import { GroupStat, Hint, TaskInfo, VaultStats, addDays, dayKey, isCheckinDay, pad2, startOfDay } from "./stats";
import { WidgetId, WidgetLayout, WidgetSize, addWidget, defaultLayout, hiddenWidgets, moveWidget, placeWidget, removeWidget, sameLayout, setSize, widgetInfo } from "./widgets";
import { MOTION, SegRect, animateHeight, countUp, drawLines, markStagger, reducedMotion, segRect, slideSeg } from "./motion";
import {
  BarItem,
  SeriesPoint,
  Tooltip,
  bigNumber,
  drawBarList,
  drawRing,
  drawSparkline,
  drawTrendChart,
  fmtFull,
  fmtNum,
  splitNum,
  srLabel,
  svgEl,
} from "./charts";
import { baseName } from "./checkup-logic";
import { L, UnitKind, count, fullDate, monthDay, monthShort, plural, unit, weekdayName, weekdayShort } from "./i18n";

let reportDetailsId = 0;

/** 统计里根目录的分组名（stats.ts 生成，作为键使用，不能翻译）；显示时换成当前语言 */
const ROOT_FOLDER = "(根目录)"; // i18n-skip
const folderName = (key: string) => (key === ROOT_FOLDER ? L("(根目录)", "(vault root)") : key);
/** “收起”按钮的文字；moreLink 靠它决定箭头朝上 */
const COLLAPSE = () => L("收起", "Show less");
const fmtSize = (bytes: number) => (bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`);
/** 卡片名字和一句说明（编辑看板、添加卡片里用） */
const WIDGET_TEXT: Record<WidgetId, [() => string, () => string]> = {
  hero: [() => L("今日写作", "Today"), () => L("今日字数、连续打卡、本周七天", "Today's words, streak, this week")],
  tasks: [() => L("接下来", "Next up"), () => L("逾期和 7 天内到期的任务", "Overdue tasks and those due within 7 days")],
  notes: [() => L("笔记", "Notes"), () => L("笔记总数和近 12 周走势", "Note count and 12-week trend")],
  words: [() => L("总字数", "Words"), () => L("总字数和近 12 周走势", "Word count and 12-week trend")],
  taskRate: [() => L("任务完成率", "Tasks done"), () => L("已完成任务的比例", "Share of tasks done")],
  month: [() => L("本月写作", "This month"), () => L("本月打卡天数和日均字数", "Streak days and daily average this month")],
  heat: [() => L("写作热力图", "Writing heatmap"), () => L("最多一年的每日写作", "Daily writing for up to a year")],
  trend: [() => L("每周写作", "Weekly writing"), () => L("每周或每天的字数、新建笔记", "Words or new notes per week or day")],
  tags: [() => L("常用标签", "Top tags"), () => L("标签和文件夹排行", "Tag and folder ranking")],
  checkup: [() => L("库体检", "Vault checkup"), () => L("断链、孤立笔记、重复内容等", "Broken links, orphans, duplicates and more")],
  reports: [() => L("写作回顾", "Writing review"), () => L("周报和月报", "Weekly and monthly reports")],
  topLinked: [() => L("最常被链接", "Most linked"), () => L("哪些笔记是你的核心", "Which notes are your hubs")],
  rhythm: [() => L("写作节奏", "Writing rhythm"), () => L("一般星期几写", "Which weekdays you write")],
  activity: [() => L("笔记活跃度", "Note activity"), () => L("写新的还是改旧的", "New notes or reworking old ones")],
  taskNotes: [() => L("任务最多的笔记", "Notes with most tasks"), () => L("任务压在哪几篇", "Where tasks pile up")],
  density: [() => L("链接密度", "Link density"), () => L("库连得紧不紧", "How connected the vault is")],
  folders: [() => L("文件夹构成", "Folder mix"), () => L("内容都在哪些文件夹", "Where your notes live")],
};
const widgetName = (id: WidgetId) => WIDGET_TEXT[id][0]();
const widgetDesc = (id: WidgetId) => WIDGET_TEXT[id][1]();
const sizeName = (s: WidgetSize) => ({ s: L("小", "Small"), m: L("中", "Medium"), l: L("大", "Large"), xl: L("整行", "Full width") })[s];

/** "2026-10-24" → 星期几（0 是周日） */
const dayIndex = (key: string) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).getDay();
};

export const VIEW_TYPE_PULSE = "note-pulse-view";

type TaskTab = "due" | "folder";
type TagTab = "tags" | "folders";
type LinkTab = "top" | "orphans" | "unresolved";


interface Checkin {
  isActive: (k: string) => boolean;
  todayKey: string;
  todayWords: number;
  current: number;
  longest: number;
  activeDays: number;
  diaryMonth: number;
  last7: { key: string; label: string; active: boolean; isToday: boolean }[];
}

export class DashboardView extends ItemView {
  plugin: NotePulsePlugin;
  private range: TrendRange = 182;
  private metric: TrendMetric = "words";
  private taskTab: TaskTab = "due";
  private tagTab: TagTab = "tags";
  private linkTab: LinkTab = "top";
  private selectedDay: string | null = null;
  /** 热力图选中某天后，当天修改的笔记是否全部展开 */
  private dayExpanded = false;
  private bodyEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private subtitleEl!: HTMLElement;
  private refreshBtn!: HTMLElement;
  private stats: VaultStats | null = null;
  private renderedDay = "";
  private parts = new Map<string, HTMLElement>();
  private renderers = new Map<string, (host: HTMLElement) => void>();
  private partObservers = new Map<string, ResizeObserver[]>();
  private currentPart = "";
  private bodyHost!: HTMLElement;
  private helpPop: HTMLElement | null = null;
  private helpAnchor: HTMLElement | null = null;
  /**
   * 动效模式：intro 首次打开（卡片依次出现、数字从 0 滚动）；update 自动刷新（只有变了的数字滚动）；
   * swap 切换标签页 / 范围（新内容淡入、图表重新长出）；resize 展开收起（只过渡高度）
   */
  private motionMode: "intro" | "update" | "swap" | "resize" = "intro";
  private introPlayed = false;
  private introUntil = 0;
  private introElapsed = 0;
  /** 上一次画出来的数字，用来判断数值有没有变 */
  private lastNums = new Map<string, number>();
  private enterOrder = 0;
  private motionTimers: number[] = [];
  private tapGuardCleanup: (() => void) | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: NotePulsePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_PULSE;
  }
  getDisplayText(): string {
    return "Note Pulse";
  }
  getIcon(): string {
    return "layout-dashboard";
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("vp-root");
    if (Platform.isMobile) root.addClass("is-mobile");
    const shell = root.createDiv({ cls: "vp-shell" });

    const header = shell.createDiv({ cls: "vp-header" });
    const titleWrap = header.createDiv({ cls: "vp-header-text" });
    titleWrap.createEl("h1", { cls: "vp-title", text: "Note Pulse" });
    this.subtitleEl = titleWrap.createDiv({ cls: "vp-subtitle" });
    this.updateSubtitle();

    const actions = header.createDiv({ cls: "vp-header-actions" });
    this.statusEl = actions.createSpan({ cls: "vp-status" });
    this.editBtn = this.iconButton(actions, "pencil", L("编辑看板", "Edit dashboard"), () => this.toggleEditing());
    this.refreshBtn = this.iconButton(actions, "refresh-cw", L("刷新数据", "Refresh data"), () => void this.plugin.requestRefresh(true));
    this.iconButton(actions, "settings", L("看板设置", "Dashboard settings"), () => this.plugin.openSettings());

    this.bodyEl = shell.createDiv({ cls: "vp-body vp-held-height" });
    // 跨过午夜后，“今天”变了，需要重新统计
    this.registerInterval(
      window.setInterval(() => {
        if (this.renderedDay && this.renderedDay !== dayKey(Date.now()) && this.isVisible()) void this.plugin.requestRefresh(false);
      }, 60000)
    );

    // 说明气泡：滚动或点击别处时收起（触屏没有悬停，靠点击问号查看）
    this.registerDomEvent(root, "scroll", () => this.hideHelp(), { capture: true });
    this.registerDomEvent(root.ownerDocument, "pointerdown", (e: Event) => {
      if (!(e.target as HTMLElement | null)?.closest?.(".vp-help")) this.hideHelp();
    });

    if (Platform.isMobile) this.installTapGuard(root);

    this.introPlayed = false;
    this.introUntil = 0;
    if (this.plugin.lastStats) this.render(this.plugin.lastStats);
    else this.showLoading(L("正在统计…", "Counting…"));
    void this.plugin.requestRefresh(false);
  }

  /**
   * 真正在滚动的那个元素：通常是 contentEl 自己（.view-content），
   * 但某些主题 / 平台下滚动的是外层容器，所以向上找第一个能滚动的祖先，找不到就用 contentEl。
   */
  private scroller(): HTMLElement {
    const root = this.contentEl;
    for (let el: HTMLElement | null = root; el && el !== el.ownerDocument.body; el = el.parentElement) {
      const oy = el.ownerDocument.defaultView?.getComputedStyle(el).overflowY;
      if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 1) return el;
    }
    return root;
  }

  /** 执行 fn（会重绘 DOM），之后把滚动位置放回去；下一帧再校正一次，应对图表异步量宽后的高度变化 */
  private keepScroll(fn: () => void) {
    const sc = this.scroller();
    const top = sc.scrollTop;
    fn();
    if (sc.scrollTop !== top) sc.scrollTop = top;
    const win = sc.ownerDocument.defaultView;
    win?.requestAnimationFrame(() => {
      if (Math.abs(sc.scrollTop - top) > 1 && !this.userTouching) sc.scrollTop = top;
    });
  }

  private userTouching = false;

  /**
   * 轻点保护：手指没有移动的一次点按之后，如果页面滚动位置在极短时间内被改动（浏览器聚焦滚动、重排夹紧等），
   * 就恢复到点按前的位置。真正的拖动 / 惯性滚动不受影响（一旦手指移动或浏览器取消触摸就立刻停用）。
   */
  private installTapGuard(root: HTMLElement) {
    this.tapGuardCleanup?.();
    const doc = root.ownerDocument;
    let start: { x: number; y: number; top: number; sc: HTMLElement } | null = null;
    let until = 0;
    let moved = false;
    const down = (e: PointerEvent) => {
      this.userTouching = true;
      const sc = this.scroller();
      start = { x: e.clientX, y: e.clientY, top: sc.scrollTop, sc };
      moved = false;
      until = Number.POSITIVE_INFINITY;
    };
    const move = (e: PointerEvent) => {
      if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 6) moved = true;
    };
    const up = () => {
      this.userTouching = false;
      until = Date.now() + 500;
    };
    const cancel = () => {
      this.userTouching = false;
      moved = true;
    };
    const onScroll = (e: Event) => {
      if (!start || moved || Date.now() > until || e.target !== start.sc) return;
      if (start.sc.scrollTop !== start.top) start.sc.scrollTop = start.top;
    };
    root.addEventListener("pointerdown", down, true);
    root.addEventListener("pointermove", move, true);
    root.addEventListener("pointerup", up, true);
    root.addEventListener("pointercancel", cancel, true);
    root.addEventListener("wheel", cancel, { capture: true, passive: true });
    // scroll 事件不冒泡，用捕获在 document 上接，这样不用提前知道到底是哪个元素在滚动
    doc.addEventListener("scroll", onScroll, { capture: true, passive: true });
    this.tapGuardCleanup = () => {
      root.removeEventListener("pointerdown", down, true);
      root.removeEventListener("pointermove", move, true);
      root.removeEventListener("pointerup", up, true);
      root.removeEventListener("pointercancel", cancel, true);
      root.removeEventListener("wheel", cancel, true);
      doc.removeEventListener("scroll", onScroll, true);
    };
  }

  async onClose() {
    for (const t of this.motionTimers) window.clearTimeout(t);
    this.motionTimers = [];
    this.tapGuardCleanup?.();
    this.tapGuardCleanup = null;
    this.disconnectObservers();
    this.helpPop?.remove();
    this.helpPop = null;
    this.contentEl.empty();
  }

  isVisible(): boolean {
    return this.containerEl.isShown();
  }

  private disconnectObservers(key?: string) {
    for (const [k, list] of this.partObservers) {
      if (key !== undefined && k !== key) continue;
      for (const o of list) o.disconnect();
      this.partObservers.delete(k);
    }
  }

  private updateSubtitle() {
    const d = new Date();
    const vault = this.app.vault.getName();
    this.subtitleEl.setText(L(`${vault} · ${fullDate(d)} 星期${weekdayShort(d.getDay())}`, `${vault} · ${weekdayShort(d.getDay())}, ${fullDate(d)}`));
  }

  private iconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): HTMLElement {
    const b = parent.createEl("button", { cls: "vp-icon-btn", attr: { "aria-label": label } });
    setIcon(b, icon);
    b.addEventListener("click", onClick);
    return b;
  }

  showLoading(msg: string) {
    this.refreshBtn?.addClass("is-spinning");
    if (!this.plugin.lastStats) {
      this.bodyEl.empty();
      const l = this.bodyEl.createDiv({ cls: "vp-loading", attr: { role: "status" } });
      l.createDiv({ cls: "vp-spinner" });
      l.createDiv({ cls: "vp-loading-text", text: msg });
    }
    this.statusEl.setText(msg);
  }

  setProgress(done: number, total: number) {
    const msg = L(`正在读取笔记 ${done}/${total}`, `Reading notes ${done}/${total}`);
    this.statusEl.setText(msg);
    if (!this.plugin.lastStats) {
      const t = this.bodyEl.querySelector(".vp-loading-text");
      if (t) t.textContent = msg;
    }
  }

  showError() {
    this.refreshBtn?.removeClass("is-spinning");
    this.statusEl.setText(L("统计失败", "Counting failed"));
    if (this.plugin.lastStats) return;
    this.bodyEl.empty();
    const e = this.bodyEl.createDiv({ cls: "vp-card vp-fullempty", attr: { role: "alert" } });
    this.empty(e, "alert-triangle", L("统计时出错了，详情见开发者控制台", "Something went wrong while counting. See the developer console for details."));
    const b = e.createEl("button", { cls: "vp-btn", text: L("重试", "Retry") });
    b.addEventListener("click", () => void this.plugin.requestRefresh(true));
  }

  /* ================= 渲染 ================= */

  render(stats: VaultStats) {
    // 重绘期间把内容区高度撑住，避免清空 → 重建的瞬间页面塌缩、滚动位置被夹到顶部
    const hold = this.bodyEl.offsetHeight;
    if (hold > 0) this.bodyEl.setCssProps({ "--vp-held-height": `${hold}px` });
    const motion = this.motionOn();
    // 打开看板时 onOpen 先用缓存画一次，紧接着 requestRefresh 再画一次：
    // 第二次落在首次动画期间时整体按首次处理，否则首次动画会被打断、数字直接跳到终点
    const now = performance.now();
    const inIntro = now < this.introUntil;
    this.motionMode = motion && (!this.introPlayed || inIntro) ? "intro" : "update";
    this.contentEl.toggleClass("vp-motion", motion);
    this.enterOrder = 0;
    if (this.motionMode === "intro" && !inIntro) {
      this.introPlayed = true;
      this.introUntil = now + MOTION.introTotal;
      this.flagFor(this.contentEl, "is-intro", MOTION.introTotal);
    }
    // 重绘落在首次动画期间：CSS 动画从已经播放到的位置接着放（负延迟），数字从 0 起算但跳过已经过去的时间
    this.introElapsed = inIntro ? MOTION.introTotal - (this.introUntil - now) : 0;
    this.contentEl.setCssProps({ "--vp-intro-offset": `${this.introElapsed}ms` });
    this.keepScroll(() => this.renderNow(stats));
    // 之后的局部重绘（悬停读数恢复、展开收起）不再按首次打开处理
    this.motionMode = "update";
    if (hold > 0) {
      const win = this.contentEl.ownerDocument.defaultView;
      win?.requestAnimationFrame(() => {
        this.keepScroll(() => this.bodyEl.setCssProps({ "--vp-held-height": "" }));
      });
    }
  }

  private renderNow(stats: VaultStats) {
    this.hideHelp();
    this.stats = stats;
    this.disconnectObservers();
    this.parts.clear();
    this.renderers.clear();
    this.refreshBtn?.removeClass("is-spinning");
    const d = new Date(stats.generatedAt);
    this.renderedDay = dayKey(Date.now());
    this.statusEl.setText(L(`更新于 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`, `Updated ${pad2(d.getHours())}:${pad2(d.getMinutes())}`));
    this.statusEl.setAttr("aria-label", L(`统计耗时 ${stats.durationMs} ms`, `Counted in ${stats.durationMs} ms`));
    this.updateSubtitle();

    const body = this.bodyEl;
    body.empty();

    if (stats.totalNotes === 0) {
      const e = body.createDiv({ cls: "vp-card vp-fullempty" });
      this.empty(e, "files", L("没有可统计的笔记。先写一篇笔记，或检查设置里的“排除的文件夹”。", "No notes to count yet. Write a note, or check Excluded folders in settings."));
      const b = e.createEl("button", { cls: "vp-btn", text: L("打开设置", "Open settings") });
      b.addEventListener("click", () => this.plugin.openSettings());
      this.renderReports(body);
      return;
    }

    const ck = this.computeCheckin(stats);
    this.bodyHost = body;
    this.define("hints", body, (h) => this.renderHints(h, stats));
    this.define("headline", body, (h) => this.renderHeadline(h, stats, ck));
    const grid = body.createDiv({ cls: "vp-grid" });
    this.gridEl = grid;
    grid.toggleClass("is-editing", this.editing);
    for (const item of this.plugin.settings.layout.items) {
      const fn = this.widgetRenderer(item.id, stats, ck);
      if (fn) this.define(item.id, grid, fn);
    }
    if (this.editing) this.renderAddPanel(body);
    else if (this.plugin.settings.layout.items.length === 0) {
      const e = body.createDiv({ cls: "vp-card vp-fullempty" });
      this.empty(e, "layout-dashboard", L("看板上没有卡片。点右上角的铅笔添加。", "The dashboard has no cards. Use the pencil at the top right to add some."));
    }
  }

  /** 看板栅格（编辑模式要在上面挂类） */
  private gridEl: HTMLElement | null = null;
  private editBtn: HTMLElement | null = null;
  /** 编辑看板：卡片上出现尺寸、隐藏、移动，底部出现“添加卡片” */
  private editing = false;

  private toggleEditing() {
    this.editing = !this.editing;
    this.editBtn?.toggleClass("is-active", this.editing);
    this.editBtn?.setAttr("aria-pressed", String(this.editing));
    if (this.stats) this.render(this.stats);
  }

  /** 改布局：立刻保存（随 data.json 同步），用已有统计重画 */
  private applyLayout(next: WidgetLayout, focusId?: string) {
    if (sameLayout(next, this.plugin.settings.layout)) return;
    this.plugin.settings.layout = next;
    void this.plugin.saveViewSetting();
    if (this.stats) this.render(this.stats);
    if (focusId) this.contentEl.querySelector<HTMLElement>(`[data-fid="${focusId}"]`)?.focus({ preventScroll: true });
  }

  /** 编辑模式下每张卡片右上角的工具条：尺寸、前移、后移、隐藏；整张卡可以拖动换位置 */
  private editTools(el: HTMLElement, id: WidgetId) {
    const info = widgetInfo(id);
    if (!info) return;
    const layout = this.plugin.settings.layout;
    const size = layout.items.find((i) => i.id === id)?.size;
    const idx = layout.items.findIndex((i) => i.id === id);
    const name = widgetName(id);
    el.addClass("is-editing");
    const bar = el.createDiv({ cls: "vp-w-tools", attr: { role: "toolbar", "aria-label": L(`${name}：编辑`, `Edit ${name}`) } });
    el.prepend(bar);
    bar.createSpan({ cls: "vp-w-name", text: L(`拖动或用箭头换位置`, "Drag or use the arrows to move") });
    if (info.sizes.length > 1) {
      const seg = bar.createDiv({ cls: "vp-seg", attr: { role: "radiogroup", "aria-label": L("尺寸", "Size") } });
      for (const sz of ["s", "m", "l", "xl"] as WidgetSize[]) {
        if (!info.sizes.includes(sz)) continue;
        const b = seg.createEl("button", {
          cls: "vp-seg-btn" + (sz === size ? " is-active" : ""),
          text: sz.toUpperCase(),
          attr: { type: "button", role: "radio", "aria-checked": String(sz === size), "aria-label": `${sizeName(sz)}`, "data-fid": `edit:${id}:${sz}` },
        });
        b.addEventListener("click", () => this.applyLayout(setSize(this.plugin.settings.layout, id, sz), `edit:${id}:${sz}`));
      }
    }
    const btn = (icon: string, label: string, fid: string, disabled: boolean, fn: () => void) => {
      const b = bar.createEl("button", { cls: "vp-icon-btn is-small", attr: { type: "button", "aria-label": label, "data-fid": fid } });
      setIcon(b, icon);
      if (disabled) b.setAttr("disabled", "true");
      b.addEventListener("click", fn);
    };
    btn("chevron-up", L("往前挪", "Move earlier"), `edit:${id}:up`, idx <= 0, () => this.applyLayout(moveWidget(this.plugin.settings.layout, id, -1), `edit:${id}:up`));
    btn("chevron-down", L("往后挪", "Move later"), `edit:${id}:down`, idx >= layout.items.length - 1, () => this.applyLayout(moveWidget(this.plugin.settings.layout, id, 1), `edit:${id}:down`));
    btn("x", L("从看板上移除", "Remove from dashboard"), `edit:${id}:hide`, false, () => this.applyLayout(removeWidget(this.plugin.settings.layout, id)));
    // 拖动换位置（鼠标）；键盘用上面的前移 / 后移
    el.setAttr("draggable", "true");
    el.addEventListener("dragstart", (e) => {
      if ((e.target as HTMLElement).closest?.(".vp-w-tools")) return;
      e.dataTransfer?.setData("text/plain", id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      el.addClass("is-dragging");
    });
    el.addEventListener("dragend", () => el.removeClass("is-dragging"));
    el.addEventListener("dragover", (e) => {
      e.preventDefault();
      el.addClass("is-drop");
    });
    el.addEventListener("dragleave", () => el.removeClass("is-drop"));
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      el.removeClass("is-drop");
      const from = e.dataTransfer?.getData("text/plain") as WidgetId | undefined;
      if (from && from !== id) this.applyLayout(placeWidget(this.plugin.settings.layout, from, id));
    });
  }

  /** 编辑模式：看板最下面的“添加卡片”和“恢复默认布局” */
  private renderAddPanel(parent: HTMLElement) {
    const panel = parent.createDiv({ cls: "vp-card vp-add-panel" });
    const head = panel.createDiv({ cls: "vp-card-head" });
    const t = head.createDiv({ cls: "vp-card-title" });
    setIcon(t.createSpan({ cls: "vp-card-icon", attr: { "aria-hidden": "true" } }), "plus");
    t.createSpan({ text: L("添加卡片", "Add a card") });
    const reset = head.createEl("button", { cls: "vp-link", text: L("恢复默认布局", "Restore default layout"), attr: { type: "button" } });
    reset.addEventListener("click", () => this.applyLayout(defaultLayout()));
    const hidden = hiddenWidgets(this.plugin.settings.layout);
    if (hidden.length === 0) {
      panel.createDiv({ cls: "vp-kpi-caption", text: L("所有卡片都在看板上了。点卡片右上角的 × 可以移除。", "Every card is on the dashboard. Use × on a card to remove it.") });
    }
    const list = panel.createDiv({ cls: "vp-add-list" });
    for (const w of hidden) {
      const b = list.createEl("button", { cls: "vp-add-item", attr: { type: "button", "data-fid": `add:${w.id}` } });
      b.createDiv({ cls: "vp-add-name", text: widgetName(w.id) });
      b.createDiv({ cls: "vp-add-desc", text: `${widgetDesc(w.id)} · ${w.sizes.map((x) => x.toUpperCase()).join(" / ")}` });
      b.addEventListener("click", () => this.applyLayout(addWidget(this.plugin.settings.layout, w.id)));
    }
    const done = panel.createDiv({ cls: "vp-card-foot" });
    const fin = done.createEl("button", { cls: "vp-btn is-primary", text: L("完成", "Done"), attr: { type: "button" } });
    fin.addEventListener("click", () => this.toggleEditing());
  }

  /** 每张卡片的渲染函数；尺寸由 mount 挂到卡片根元素上（is-s / is-m / is-l / is-xl） */
  private widgetRenderer(id: WidgetId, stats: VaultStats, ck: Checkin): ((host: HTMLElement) => void) | null {
    switch (id) {
      case "hero":
        return (h) => this.renderHero(h, stats, ck);
      case "tasks":
        return (h) => this.renderTasks(h, stats);
      case "notes":
      case "words":
      case "taskRate":
      case "month":
        return (h) => this.renderKpi(h, stats, id);
      case "heat":
        return (h) => this.renderHeatmap(h, stats, ck);
      case "trend":
        return (h) => this.renderTrend(h, stats);
      case "tags":
        return (h) => this.renderTags(h, stats);
      case "checkup":
        return (h) => this.renderCheckup(h, stats);
      case "reports":
        return (h) => this.renderReports(h);
      case "topLinked":
        return (h) => this.renderTopLinked(h, stats);
      case "rhythm":
        return (h) => this.renderRhythm(h, stats);
      case "activity":
        return (h) => this.renderActivity(h, stats);
      case "taskNotes":
        return (h) => this.renderTaskNotes(h, stats);
      case "density":
        return (h) => this.renderDensity(h, stats);
      case "folders":
        return (h) => this.renderFolders(h, stats);
      default:
        return null;
    }
  }

  /** 这张卡片当前的尺寸 */
  private sizeOf(id: string): WidgetSize | null {
    return this.plugin.settings.layout.items.find((i) => i.id === id)?.size ?? null;
  }

  /** 登记并渲染一个区块；每个渲染函数必须恰好生成一个根元素 */
  private define(key: string, parent: HTMLElement, fn: (host: HTMLElement) => void) {
    this.renderers.set(key, fn);
    this.mount(key, parent, fn);
  }

  private mount(key: string, parent: HTMLElement, fn: (host: HTMLElement) => void) {
    const prev = this.currentPart;
    this.currentPart = key;
    // 首次打开：各区块按顺序依次浮现，区块里的数字和图表跟着这个延迟开始
    const intro = this.motionMode === "intro";
    const enter = intro ? Math.min(0.6, this.enterOrder / 14) : 0;
    this.enterDelay = enter * MOTION.stagger - this.introElapsed;
    try {
      fn(parent);
    } finally {
      this.currentPart = prev;
    }
    const el = parent.lastElementChild as HTMLElement | null;
    if (!el) return;
    this.parts.set(key, el);
    const size = this.sizeOf(key);
    if (size) {
      el.addClass("vp-w", `is-${size}`);
      el.setAttr("data-widget", key);
      if (this.editing) this.editTools(el, key as WidgetId);
    }
    if (intro) {
      markStagger(el);
      drawLines(el, this.enterDelay);
    }
    if (intro) {
      el.addClass("vp-enter");
      el.setCssProps({ "--vp-enter": String(Math.min(0.6, this.enterOrder++ / 14)) });
    }
  }

  /** 首次打开时当前区块的入场延迟（毫秒），数字滚动用 */
  private enterDelay = 0;

  private motionOn(): boolean {
    return this.plugin.settings.motion && !reducedMotion(this.contentEl.ownerDocument.defaultView);
  }

  /** 给元素加一个类，过一会儿自动去掉（动效只在那一瞬间生效，之后的重绘不再重播） */
  private flagFor(el: HTMLElement, cls: string, ms: number) {
    el.addClass(cls);
    this.motionTimers.push(window.setTimeout(() => el.removeClass(cls), ms));
  }

  /**
   * 数字：首次打开从 0 滚到当前值；自动刷新时只有变了的才从旧值滚过去并闪一下强调色；
   * 切换标签页时新出现的数字从 0 滚动。el 是 bigNumber 返回的元素。
   */
  private tweenNum(key: string, el: HTMLElement, value: number, unit = "") {
    const prev = this.lastNums.get(key);
    this.lastNums.set(key, value);
    const m = this.motionMode;
    if (!this.motionOn() || m === "resize") return;
    let from: number | null = null;
    if (m === "intro") from = 0;
    else if (prev !== undefined && prev !== value) from = prev;
    else if (prev === undefined && m === "swap") from = 0;
    if (from === null || from === value) return;
    countUp(el, from, value, unit, MOTION.count, m === "intro" ? this.enterDelay : 0);
    if (m === "update") this.flagFor(el, "is-changed", MOTION.count + 600);
  }

  /** 圆环：从 0（首次）或旧比例画到新比例 */
  private tweenRing(key: string, wrap: HTMLElement, ratio: number) {
    const v = Math.max(0, Math.min(1, ratio));
    const prev = this.lastNums.get(key);
    this.lastNums.set(key, v);
    const circle = wrap.querySelector<SVGCircleElement>(".vp-ring-value");
    const m = this.motionMode;
    if (!circle || !circle.animate || !this.motionOn() || m === "resize") return;
    const from = m === "intro" ? 0 : prev;
    if (from === undefined || Math.abs(from - v) < 0.001) return;
    const c = parseFloat(circle.getAttribute("stroke-dasharray")?.split(" ")[1] ?? "0");
    if (!c) return;
    circle.animate([{ strokeDasharray: `${c * from} ${c}` }, { strokeDasharray: `${c * v} ${c}` }], {
      duration: MOTION.count + 200,
      delay: m === "intro" ? this.enterDelay : 0,
      easing: MOTION.ease,
      fill: "backwards",
    });
  }

  /**
   * 只重绘一个区块，不打断其它区块，并保持键盘焦点和滚动位置。
   * mode = swap：点击标签页、切换范围 / 样式。新内容淡入、图表重新长出、分段控件的选中底色滑过去。
   * mode = resize：展开 / 收起 / 选中某天。只把卡片高度平滑过渡到新高度，不锁高度（锁了就收不回去）。
   * 没开动效时，切换标签页沿用旧办法：高度只增不减，避免整页高度塌缩、处在底部时滚动位置被夹回去；
   * 展开状态下不锁，否则切到别的标签页后卡片会停在展开时的高度。
   */
  private rerender(key: string, mode: "swap" | "resize" = "swap") {
    const old = this.parts.get(key);
    const fn = this.renderers.get(key);
    if (!old || !fn || !this.stats) return;
    const focusId = (this.contentEl.ownerDocument.activeElement as HTMLElement | null)?.getAttribute("data-fid") || null;
    const motion = this.motionOn();
    const prevH = old.getBoundingClientRect().height;
    const hold = !motion && mode === "swap" && !old.hasClass("is-expanded");
    const segs: (SegRect | null)[] = motion ? Array.from(old.querySelectorAll<HTMLElement>(".vp-seg")).map(segRect) : [];
    const prevMode = this.motionMode;
    this.motionMode = mode;
    this.keepScroll(() => {
      this.disconnectObservers(key);
      // 先用一个 display: contents 的占位容器就地渲染，这样图表量到的是最终宽度，不会闪烁
      const wrapper = createDiv();
      wrapper.setCssProps({ display: "contents" });
      old.replaceWith(wrapper);
      this.mount(key, wrapper, fn);
      const fresh = this.parts.get(key);
      if (!fresh) {
        wrapper.replaceWith(old);
        return;
      }
      wrapper.replaceWith(fresh);
      if (hold && prevH > 0) {
        fresh.addClass("vp-held-height");
        fresh.setCssProps({ "--vp-held-height": `${Math.ceil(prevH)}px` });
      }
      if (motion) {
        if (mode === "swap") {
          markStagger(fresh);
          drawLines(fresh, 0);
          this.flagFor(fresh, "is-swap", MOTION.swapTotal);
        }
        fresh.querySelectorAll<HTMLElement>(".vp-seg").forEach((seg, i) => {
          const from = segs[i];
          if (from) slideSeg(seg, from);
        });
        animateHeight(fresh, prevH);
      }
      // preventScroll：聚焦时不要让浏览器把元素滚进视野（手机上会拖着整页跳）
      if (focusId) fresh.querySelector<HTMLElement>(`[data-fid="${focusId}"]`)?.focus({ preventScroll: true });
    });
    this.motionMode = prevMode;
  }

  /* ---------- 通用组件 ---------- */

  /**
   * 小问号：悬停或键盘聚焦时在气泡里显示说明，不占版面。
   * 气泡挂在 body 上、用 fixed 定位，所以不会被卡片的 overflow 裁掉，也不会引起布局抖动。
   */
  private help(parent: HTMLElement, text: string): HTMLElement {
    const b = parent.createEl("button", {
      cls: "vp-help",
      attr: { type: "button" },
    });
    // 名称放在隐藏文字里，不用 aria-label：否则 Obsidian 会再弹一个自带的提示
    srLabel(b, L("说明", "About this"));
    setIcon(b, "circle-help");
    if (!b.querySelector("svg")) setIcon(b, "help-circle");
    if (!b.querySelector("svg")) b.setText("?");
    const show = () => this.showHelp(b, text);
    b.addEventListener("mouseenter", show);
    b.addEventListener("focus", show);
    b.addEventListener("mouseleave", () => this.hideHelp(b));
    b.addEventListener("blur", () => this.hideHelp(b));
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      show();
    });
    b.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.hideHelp(b);
    });
    return b;
  }

  private showHelp(anchor: HTMLElement, text: string) {
    const doc = anchor.ownerDocument;
    if (!this.helpPop || !this.helpPop.isConnected) {
      this.helpPop = doc.body.createDiv({ cls: "vp-help-pop", attr: { role: "tooltip", id: "vp-help-pop" } });
    }
    const pop = this.helpPop;
    pop.setText(text);
    pop.removeClass("is-visible");
    pop.setCssProps({ "--vp-help-left": "0px", "--vp-help-top": "0px" });
    this.helpAnchor = anchor;
    anchor.setAttr("aria-describedby", "vp-help-pop");
    const a = anchor.getBoundingClientRect();
    const vw = doc.documentElement.clientWidth;
    const card = anchor.closest<HTMLElement>(".vp-card")?.getBoundingClientRect();
    const pw = pop.offsetWidth,
      ph = pop.offsetHeight;
    // 尽量留在所在卡片范围内；卡片太窄时退而求其次，保证不超出窗口
    let minX = 6,
      maxX = vw - pw - 6;
    if (card && card.width >= pw + 12) {
      minX = Math.max(minX, card.left + 6);
      maxX = Math.min(maxX, card.right - pw - 6);
    }
    const left = Math.max(minX, Math.min(maxX, a.left + a.width / 2 - pw / 2));
    let top = a.top - ph - 8;
    if (top < 6) top = a.bottom + 8;
    pop.setCssProps({ "--vp-help-left": `${Math.round(left)}px` });
    pop.setCssProps({ "--vp-help-top": `${Math.round(top)}px` });
    pop.addClass("is-visible");
  }

  private hideHelp(anchor?: HTMLElement) {
    if (anchor && this.helpAnchor !== anchor) return;
    this.helpPop?.removeClass("is-visible");
    this.helpAnchor?.removeAttribute("aria-describedby");
    this.helpAnchor = null;
  }

  private card(parent: HTMLElement, cls: string, title: string, icon: string, help?: string): { el: HTMLElement; head: HTMLElement; body: HTMLElement } {
    const el = parent.createDiv({ cls: `vp-card ${cls}` });
    const head = el.createDiv({ cls: "vp-card-head" });
    const h = head.createDiv({ cls: "vp-card-title" });
    setIcon(h.createSpan({ cls: "vp-card-icon", attr: { "aria-hidden": "true" } }), icon);
    h.createSpan({ text: title });
    if (help) this.help(h, help);
    const body = el.createDiv({ cls: "vp-card-body" });
    return { el, head, body };
  }

  private segmented<T extends string | number>(parent: HTMLElement, options: [T, string][], current: T, onChange: (v: T) => void, label?: string) {
    const seg = parent.createDiv({ cls: "vp-seg", attr: { role: "tablist" } });
    if (label) srLabel(seg, label);
    for (const [v, text] of options) {
      const b = seg.createEl("button", {
        cls: "vp-seg-btn" + (v === current ? " is-active" : ""),
        text,
        attr: { role: "tab", "aria-selected": String(v === current), "data-fid": `${this.currentPart}:${v}` },
      });
      b.addEventListener("click", () => {
        if (v !== current) onChange(v);
      });
    }
    return seg;
  }

  private empty(parent: HTMLElement, icon: string, text: string) {
    const e = parent.createDiv({ cls: "vp-empty" });
    setIcon(e.createDiv({ cls: "vp-empty-icon", attr: { "aria-hidden": "true" } }), icon);
    e.createDiv({ cls: "vp-empty-text", text });
  }

  /** 让任意元素可以用鼠标、Enter 和空格操作 */
  private clickable(el: HTMLElement, label: string | null, handler: (e: MouseEvent | KeyboardEvent) => void) {
    el.addClass("is-clickable");
    el.setAttr("role", "button");
    el.setAttr("tabindex", "0");
    if (label) srLabel(el, label);
    el.addEventListener("click", (e) => handler(e));
    // 触屏上轻点不要让这一行拿到焦点：浏览器会把获得焦点的元素滚进视野，页面就会跳
    if (Platform.isMobile) el.addEventListener("mousedown", (e) => e.preventDefault());
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        handler(e);
      }
    });
  }

  private noteRow(parent: HTMLElement, file: TFile, meta?: string, line?: number): HTMLElement {
    const row = parent.createDiv({ cls: "vp-row" });
    row.createSpan({ cls: "vp-row-name", text: file.basename, attr: { title: file.path } });
    if (meta) row.createSpan({ cls: "vp-row-meta", text: meta });
    this.clickable(row, `${file.basename}${meta ? "，" + meta : ""}`, (e) => void this.plugin.openFile(file, line, e));
    return row;
  }

  /** 宽度变化时重绘（图表按真实像素绘制，文字不会被缩放） */
  private responsive(el: HTMLElement, draw: (width: number) => void) {
    let last = -1;
    const run = () => {
      const w = Math.floor(el.clientWidth);
      if (w <= 0 || Math.abs(w - last) < 4) return;
      last = w;
      draw(w);
    };
    run();
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => run());
      ro.observe(el);
      const key = this.currentPart;
      const list = this.partObservers.get(key) || [];
      list.push(ro);
      this.partObservers.set(key, list);
    }
  }

  /* ---------- 打卡计算 ---------- */

  private computeCheckin(s: VaultStats): Checkin {
    const goal = this.plugin.settings.dailyWordGoal;
    const today = startOfDay(Date.now());
    const todayKey = dayKey(today);
    const isActive = (k: string) => isCheckinDay(s, goal, k);
    let longest = 0,
      run = 0,
      activeDays = 0,
      diaryMonth = 0;
    const monthPrefix = todayKey.slice(0, 7);
    for (let d = addDays(today, -364); d.getTime() <= today.getTime(); d = addDays(d, 1)) {
      const k = dayKey(d);
      if (isActive(k)) {
        run++;
        activeDays++;
        longest = Math.max(longest, run);
      } else run = 0;
      if (s.dailyNotes[k] && k.startsWith(monthPrefix)) diaryMonth++;
    }
    let current = 0;
    let d = isActive(todayKey) ? today : addDays(today, -1);
    for (let i = 0; i < 3650 && isActive(dayKey(d)); i++) {
      current++;
      d = addDays(d, -1);
    }
    const last7 = [];
    for (let i = 6; i >= 0; i--) {
      const x = addDays(today, -i);
      const k = dayKey(x);
      last7.push({ key: k, label: weekdayShort(x.getDay()), active: isActive(k), isToday: i === 0 });
    }
    return { isActive, todayKey, todayWords: s.dayWords[todayKey] || 0, current, longest, activeDays, diaryMonth, last7 };
  }

  /* ---------- 0. 提示 / 引导 ---------- */

  private renderHints(parent: HTMLElement, s: VaultStats) {
    const wrap = parent.createDiv({ cls: "vp-hints" });
    const thr = fmtNum(s.outliers.threshold);
    const goal = this.plugin.settings.dailyWordGoal;
    const make = (h: Hint, icon: string, text: string, detail: string) => {
      const el = wrap.createDiv({ cls: "vp-hint", attr: { role: "note" } });
      setIcon(el.createSpan({ cls: "vp-hint-icon", attr: { "aria-hidden": "true" } }), icon);
      const t = el.createDiv({ cls: "vp-hint-main" });
      const line = t.createDiv({ cls: "vp-hint-text" });
      line.createSpan({ text });
      this.help(line, detail);
      const acts = el.createDiv({ cls: "vp-hint-actions" });
      const btn = (label: string, title: string, fn: () => void, primary = false) => {
        const b = acts.createEl("button", { cls: "vp-btn is-compact" + (primary ? " is-primary" : ""), text: label });
        b.addEventListener("click", fn);
      };
      // 右上角的 × 等同于“忽略”，关闭后不再出现，也不会再占位
      const close = (title: string) => {
        const x = acts.createEl("button", { cls: "vp-icon-btn is-small", attr: { "aria-label": title } });
        setIcon(x, "x");
        x.addEventListener("click", () => {
          this.hideHelp();
          el.remove();
          void this.plugin.dismissHint(h.key);
        });
      };
      return { btn, close };
    };
    for (const h of s.hints) {
      if (h.kind === "onboarding") {
        const m = make(
          h,
          "sparkles",
          L(
            `欢迎使用 Note Pulse：每天写 ${goal > 0 ? fmtFull(goal) : "任意"} 字算打卡。`,
            goal > 0 ? `Welcome to Note Pulse: writing ${fmtFull(goal)} words a day keeps your streak.` : "Welcome to Note Pulse: any writing in a day keeps your streak."
          ),
          L(
            `超过 ${thr} 字的超大笔记不计入写作统计。自动采集、网页剪藏之类的文件夹，建议在设置里标记为“采集文件夹”。`,
            `Oversized notes over ${thr} words are left out of writing stats. Mark folders of web clippings or other collected content as clipping folders in settings.`
          )
        );
        m.btn(L("打开设置", "Open settings"), "", () => this.plugin.openSettings(), true);
        m.close(L("知道了，不再显示", "Got it, don't show again"));
      } else if (h.kind === "folder" && h.target) {
        const f = h.target;
        const m = make(
          h,
          "lightbulb",
          L(
            `“${f}/” 里${h.count === h.total ? `${h.total} 篇笔记都` : ` ${h.total} 篇有 ${h.count} 篇`}超过 ${thr} 字，像是自动采集的内容。`,
            `${h.count === h.total ? `All ${h.total}` : `${h.count} of ${h.total}`} notes in "${f}/" are over ${thr} words. They look like collected content.`
          ),
          L(
            "这类笔记会让字数趋势和热力图失真。“不计入写作统计”后，笔记仍计入总数；“完全排除”则整个文件夹不参与任何统计。",
            "Notes like these distort word trends and the heatmap. \"Don't count as writing\" keeps them in the note total; \"Exclude\" leaves the whole folder out of every statistic."
          )
        );
        m.btn(L("不计入写作统计", "Don't count as writing"), "", () => void this.plugin.setClippingFolder(f), true);
        m.btn(L("完全排除", "Exclude"), "", () => void this.plugin.excludeFolder(f));
        m.close(L("忽略，不再提示这个文件夹", "Dismiss for this folder"));
      } else if (h.kind === "spike" && h.target) {
        const [, mm, dd] = h.target.split("-").map(Number);
        const m = make(
          h,
          "calendar-clock",
          L(
            `${h.count} 篇笔记的创建日期都是 ${mm} 月 ${dd} 日（占 ${Math.round(((h.count || 0) / Math.max(1, h.total || 1)) * 100)}%），趋势图会在这天陡升。`,
            `${h.count} notes (${Math.round(((h.count || 0) / Math.max(1, h.total || 1)) * 100)}%) were all created on ${monthDay(new Date(2000, mm - 1, dd))}, so the trend chart jumps on that day.`
          ),
          L(
            "可能是同步或导入重置了文件创建时间。给笔记加上 created 字段，再在设置里指定它作为创建日期，就能修正。",
            "Syncing or importing probably reset the file creation times. Add a created property to your notes and choose it as the created date in settings."
          )
        );
        m.btn(L("设置创建日期字段", "Set created date property"), "", () => this.plugin.openSettings(), true);
        m.close(L("忽略，不再提示这一天", "Dismiss for this day"));
      }
    }
  }

  /* ---------- 1. 页首一句话 ---------- */

  private renderHeadline(parent: HTMLElement, s: VaultStats, ck: Checkin) {
    const goal = this.plugin.settings.dailyWordGoal;
    const h = headline(s, goal, new Date(s.generatedAt));
    const el = parent.createDiv({ cls: "vp-headline" });
    const lead = el.createDiv({ cls: "vp-headline-lead" });
    lead.createSpan({ text: L("本周已写 ", "") });
    lead.createSpan({ cls: "vp-grad-text", text: fmtFull(h.weekWords) });
    lead.createSpan({ text: L(" 字", ` ${unit("words", h.weekWords)} this week`) });
    if (h.changePct !== null && h.changePct !== 0) {
      const pct = Math.abs(h.changePct);
      lead.createSpan({ text: L(`，比上周同期${h.changePct > 0 ? "多" : "少"} ${pct}%`, `, ${pct}% ${h.changePct > 0 ? "more" : "less"} than this point last week`) });
    } else if (h.changePct === 0) lead.createSpan({ text: L("，和上周同期持平", ", the same as this point last week") });
    lead.createSpan({ text: L("。", ".") });
    const bits: string[] = [];
    if (ck.current > 0) bits.push(L(`连续写作第 ${ck.current} 天`, `Day ${ck.current} of your streak`));
    const left = Math.max(0, goal - h.todayWords);
    bits.push(
      h.todayDone
        ? L("今天已达成目标", "Today's goal reached")
        : goal > 0
          ? L(`今天还差 ${fmtFull(left)} 字`, `${fmtFull(left)} ${unit("words", left)} to go today`)
          : L("今天还没动笔", "Nothing written yet today")
    );
    if (h.dueToday > 0) bits.push(L(`${h.dueToday} 项任务今天到期`, `${count(h.dueToday, "tasks")} due today`));
    if (h.overdue > 0) bits.push(L(`${h.overdue} 项已逾期`, `${h.overdue} overdue`));
    el.createDiv({ cls: "vp-headline-sub", text: bits.join(" · ") });
  }

  /* ---------- 2. 焦点：今日写作 ---------- */

  private renderHero(grid: HTMLElement, s: VaultStats, ck: Checkin) {
    const settings = this.plugin.settings;
    const goal = settings.dailyWordGoal;
    const now = new Date(s.generatedAt);
    const hero = grid.createDiv({ cls: "vp-card vp-hero" });
    const todayDone = ck.isActive(ck.todayKey);

    const head = hero.createDiv({ cls: "vp-card-head" });
    const ht = head.createDiv({ cls: "vp-card-title" });
    setIcon(ht.createSpan({ cls: "vp-card-icon", attr: { "aria-hidden": "true" } }), "pencil");
    ht.createSpan({ text: L("今日写作", "Today") });
    this.help(
      ht,
      L(
        `${goal > 0 ? `当天新增字数达到每日目标（${fmtFull(goal)} 字，可在设置里改）` : "当天写了任何字"}就算打卡，写了当天的日记也算。\n连续打卡从今天往前数；今天还没写不会中断，到明天才断。`,
        `${goal > 0 ? `A day counts toward your streak when the words added reach the daily goal (${fmtFull(goal)}, changeable in settings)` : "A day counts toward your streak when you write anything"}; a daily note also counts.\nThe streak counts back from today. Not having written yet today doesn't break it; it breaks tomorrow.`
      )
    );
    const pill = head.createDiv({ cls: "vp-pill " + (todayDone ? "is-success" : "is-muted") });
    setIcon(pill.createSpan({ cls: "vp-pill-icon" }), todayDone ? "check" : "clock");
    pill.createSpan({ text: todayDone ? L("已打卡", "Done") : L("还没打卡", "Not yet") });

    const main = hero.createDiv({ cls: "vp-hero-main" });

    // 今日字数 / 目标 圆环
    const ratio = goal > 0 ? ck.todayWords / goal : ck.todayWords > 0 ? 1 : 0;
    const center = drawRing(main, ratio, 132, 10, "vp-hero-ring");
    const ringWrap = center.parentElement as HTMLElement;
    this.tweenRing("hero:ring", ringWrap, ratio);
    ringWrap.setAttr("role", "img");
    srLabel(
      ringWrap,
      goal > 0
        ? L(`今日 ${fmtFull(ck.todayWords)} 字，目标 ${fmtFull(goal)} 字`, `${count(fmtFull(ck.todayWords), "words")} today, goal ${fmtFull(goal)}`)
        : L(`今日 ${fmtFull(ck.todayWords)} 字`, `${count(fmtFull(ck.todayWords), "words")} today`)
    );
    this.tweenNum("hero:today", bigNumber(center, ck.todayWords, undefined, "vp-num vp-ring-num"), ck.todayWords);
    center.createDiv({ cls: "vp-ring-caption", text: goal > 0 ? L(`目标 ${fmtNum(goal)} 字`, `of ${fmtNum(goal)}`) : L("今日字数", "words today") });

    // 连续打卡
    const streak = main.createDiv({ cls: "vp-hero-streak" });
    streak.createDiv({ cls: "vp-label", text: L("连续打卡", "Streak") });
    this.tweenNum("hero:streak", bigNumber(streak, String(ck.current), unit("days", ck.current), "vp-num vp-num-hero"), ck.current, unit("days", ck.current));
    streak.createDiv({ cls: "vp-hero-note", text: L(`最长 ${ck.longest} 天 · 近一年 ${ck.activeDays} 天`, `Longest ${ck.longest} · ${ck.activeDays} in the past year`) });
    const diary = streak.createDiv({ cls: "vp-hero-note", text: L(`本月日记 ${ck.diaryMonth} 篇`, `${ck.diaryMonth} daily ${plural(ck.diaryMonth, "note")} this month`) });
    const todayDiary = s.dailyNotes[ck.todayKey];
    if (todayDiary) this.clickable(diary, L("打开今天的日记", "Open today's daily note"), (e) => void this.plugin.openFile(todayDiary, undefined, e));

    // 本周
    main.appendChild(this.renderWeek(s, goal, now));

    // 今天动过的笔记（来自每天修改过的笔记列表；不估算单篇字数）
    const foot = hero.createDiv({ cls: "vp-hero-foot" });
    const todayCreated = s.dayCreated[ck.todayKey] || 0;
    const todayFiles = s.dayModified[ck.todayKey] || [];
    const stat = (key: string, label: string, value: number, unit: string) => {
      const x = foot.createDiv({ cls: "vp-hero-stat" });
      x.createDiv({ cls: "vp-label", text: label });
      this.tweenNum(key, bigNumber(x, String(value), unit, "vp-num vp-num-sm"), value, unit);
    };
    stat("hero:created", L("今日新建", "Created"), todayCreated, unit("notes", todayCreated));
    stat("hero:modified", L("今日改动", "Edited"), todayFiles.length, unit("notes", todayFiles.length));
    const recent = foot.createDiv({ cls: "vp-hero-recent" });
    recent.createDiv({ cls: "vp-label", text: L("今天写过", "Worked on today") });
    const chips = recent.createDiv({ cls: "vp-chips" });
    if (todayFiles.length === 0) chips.createSpan({ cls: "vp-chip-empty", text: L("今天还没有改动的笔记", "No notes edited today yet") });
    for (const f of [...todayFiles].sort((a, b) => b.stat.mtime - a.stat.mtime).slice(0, 3)) {
      const c = chips.createSpan({ cls: "vp-chip", text: f.basename, attr: { title: f.path } });
      this.clickable(c, L(`打开 ${f.basename}`, `Open ${f.basename}`), (e) => void this.plugin.openFile(f, undefined, e));
    }
  }

  /** 本周七天：圆点或柱状，用户在卡片上切换，选择记在设置里 */
  private renderWeek(s: VaultStats, goal: number, now: Date): HTMLElement {
    const settings = this.plugin.settings;
    const style = settings.weekStyle;
    const days = weekDays(s, goal, now);
    const weekWords = days.reduce((a, d) => a + d.words, 0);
    const box = createDiv({ cls: `vp-week-box is-${style}` });
    const top = box.createDiv({ cls: "vp-week-top" });
    const sum = top.createDiv({ cls: "vp-week-sum" });
    sum.createSpan({ cls: "vp-label", text: L("本周 ", "This week ") });
    sum.createSpan({ cls: "vp-week-total", text: fmtFull(weekWords) });
    if (settings.weeklyWordGoal > 0) sum.createSpan({ cls: "vp-week-goal", text: ` / ${fmtFull(settings.weeklyWordGoal)}` });
    this.segmented<"dots" | "bars">(
      top,
      [["dots", L("圆点", "Dots")], ["bars", L("柱状", "Bars")]],
      style,
      (v) => {
        settings.weekStyle = v;
        void this.plugin.saveViewSetting();
        this.rerender("hero");
      },
      L("本周显示方式", "This week display")
    );

    const row = box.createDiv({ cls: "vp-week" });
    const max = Math.max(goal, ...days.map((d) => d.words), 1);
    for (const d of days) {
      const c = row.createDiv({ cls: "vp-week-day" + (d.done ? " is-active" : "") + (d.isToday ? " is-today" : "") + (d.future ? " is-future" : "") });
      const w = count(fmtFull(d.words), "words");
      const desc = d.future
        ? L("还没到", "not yet")
        : d.done
          ? L(`已打卡，${fmtFull(d.words)} 字`, `goal met, ${w}`)
          : d.words > 0
            ? L(`${fmtFull(d.words)} 字，未达标`, `${w}, below goal`)
            : L("没有写", "nothing written");
      const dayName = weekdayName(dayIndex(d.key));
      if (style === "dots") {
        const dot = c.createDiv({ cls: "vp-week-dot", attr: { role: "img", "aria-label": `${dayName} ${desc}` } });
        if (d.done) setIcon(dot, "check");
        else if (d.pct !== null) dot.createSpan({ cls: "vp-week-pct", text: `${d.pct}%` });
      } else {
        const lane = c.createDiv({ cls: "vp-week-lane", attr: { role: "img", "aria-label": `${dayName} ${desc}` } });
        const bar = lane.createDiv({ cls: "vp-week-bar" });
        bar.setCssProps({ "--vp-week-h": `${d.future ? 0 : Math.max(4, (d.words / max) * 100)}%` });
      }
      c.createDiv({ cls: "vp-week-label", text: d.isToday ? L("今", "Today") : d.label });
    }
    if (style === "bars" && goal > 0) {
      row.addClass("has-goal");
      row.setCssProps({ "--vp-week-goal": `${(goal / max) * 100}%` });
    }

    if (settings.weeklyWordGoal > 0) {
      const pct = Math.min(100, (weekWords / settings.weeklyWordGoal) * 100);
      const meter = box.createDiv({
        cls: "vp-meter vp-week-meter",
        attr: {
          role: "progressbar",
          "aria-label": L("每周字数目标", "Weekly word goal"),
          "aria-valuemin": "0",
          "aria-valuemax": String(settings.weeklyWordGoal),
          "aria-valuenow": String(Math.min(weekWords, settings.weeklyWordGoal)),
          "aria-valuetext": L(`已写 ${weekWords} 字，目标 ${settings.weeklyWordGoal} 字`, `${weekWords} of ${settings.weeklyWordGoal} words`),
        },
      });
      meter.createDiv({ cls: "vp-meter-fill" }).setCssProps({ "--vp-meter-width": `${pct}%` });
    }
    const legend = box.createDiv({ cls: "vp-week-legend" });
    if (style === "dots") legend.setText(L("✓ 达标 · 百分比为未达标的进度 · 虚线为还没到的日子", "✓ goal met · % progress · dashed: still to come"));
    else
      legend.setText(
        goal > 0
          ? L(`实色为达标 · 虚线为每日目标 ${fmtFull(goal)} 字`, `Solid: goal met · dashed line: daily goal of ${fmtFull(goal)}`)
          : L("柱高为当天字数", "Bar height is that day's words")
      );
    return box;
  }

  /* ---------- 3. 数据卡 ---------- */

  /** 四张数据卡（2.0 起各自是一张卡片，可以分别换尺寸、隐藏、排序） */
  private renderKpi(grid: HTMLElement, s: VaultStats, which: "notes" | "words" | "taskRate" | "month") {
    const wrap = grid;
    const now = new Date(s.generatedAt);
    const goal = this.plugin.settings.dailyWordGoal;
    const today = startOfDay(now);
    const d30 = addDays(today, -29).getTime();
    let n30 = 0,
      w30 = 0;
    for (const f of s.files) {
      if (f.collected || f.created < d30) continue;
      n30++;
      w30 += f.writeWords;
    }
    const range = (a: Date, b: Date) => (dayKey(a) === dayKey(b) ? `${a.getMonth() + 1}/${a.getDate()}` : `${a.getMonth() + 1}/${a.getDate()} – ${b.getMonth() + 1}/${b.getDate()}`);

    const kpi = (icon: string, label: string, help: string) => {
      const c = wrap.createDiv({ cls: "vp-card vp-kpi", attr: { role: "group" } });
      srLabel(c, label);
      const top = c.createDiv({ cls: "vp-kpi-top" });
      setIcon(top.createSpan({ cls: "vp-card-icon", attr: { "aria-hidden": "true" } }), icon);
      top.createSpan({ cls: "vp-label", text: label });
      this.help(top, help);
      const row = c.createDiv({ cls: "vp-kpi-row" });
      const num = row.createDiv({ cls: "vp-kpi-num" });
      const side = row.createDiv({ cls: "vp-kpi-side" });
      return { c, num, side };
    };
    /** 主数字和右侧说明；悬停趋势线时换成那一周的读数，离开时恢复 */
    const readout = (
      k: { c: HTMLElement; num: HTMLElement; side: HTMLElement },
      base: () => void,
      at: (i: number) => { value: string; unit: string; date: string; note: string; up?: boolean }
    ) => {
      base();
      return (i: number | null) => {
        k.num.empty();
        k.side.empty();
        k.c.toggleClass("is-scrubbing", i !== null);
        if (i === null) return base();
        const r = at(i);
        bigNumber(k.num, r.value, r.unit);
        k.side.createSpan({ cls: "vp-date-chip", text: r.date });
        k.side.createSpan({ cls: r.up ? "vp-delta is-up" : "vp-kpi-caption", text: r.note });
      };
    };

    if (which === "notes") {
      // 笔记
      const notes = weeklyNotes(s, 12, now);
      const a = kpi(
        "files",
        L("笔记", "Notes"),
        L(
          "统计所有未被排除的 Markdown 笔记。曲线是近 12 周每周结束时的累计数（不含采集文件夹），按创建日期计。",
          "All Markdown notes that are not excluded. The line is the running total at the end of each of the last 12 weeks (clipping folders left out), by created date."
        )
      );
      const aOn = readout(
        a,
        () => {
          this.tweenNum("kpi:notes", bigNumber(a.num, s.totalNotes, unit("notes", s.totalNotes)), s.totalNotes, unit("notes", s.totalNotes));
          a.side.createSpan({ cls: "vp-kpi-caption", text: L("近 30 天", "30 days") });
          a.side.createSpan({ cls: "vp-delta is-up", text: `+${fmtFull(n30)}` });
        },
        (i) => ({
          value: fmtFull(notes[i].value),
          unit: unit("notes", notes[i].value),
          date: range(notes[i].start, notes[i].end),
          note: L(`当周 +${fmtFull(notes[i].extra)}`, `+${fmtFull(notes[i].extra)} that week`),
          up: true,
        })
      );
      drawSparkline(a.c.createDiv({ cls: "vp-kpi-viz" }), notes.map((p) => p.value), {
        onPoint: aOn,
        label: (i) =>
          L(
            `${range(notes[i].start, notes[i].end)}，累计 ${notes[i].value} 篇，当周新增 ${notes[i].extra} 篇`,
            `${range(notes[i].start, notes[i].end)}: ${count(notes[i].value, "notes")} in total, ${notes[i].extra} new that week`
          ),
      });
    }

    if (which === "words") {
      // 字数
      const words = weeklyWords(s, 12, now);
      const skipped = s.totalWords - s.writeWordsTotal;
      const b = kpi(
        "type",
        L("总字数", "Words"),
        L(
          `所有笔记的字数合计。曲线是近 12 周累计的写作字数（按笔记创建日期、用笔记当前字数计）。${
            skipped > 0 ? `\n其中 ${fmtNum(skipped)} 字来自采集文件夹或超大笔记，不计入曲线、热力图和“新增字数”。` : ""
          }`,
          `Total words in all notes. The line is the running total of writing over the last 12 weeks (by created date, using each note's current length).${
            skipped > 0 ? `\n${fmtNum(skipped)} of these words are in clipping folders or oversized notes, which are left out of the line, the heatmap and words added.` : ""
          }`
        )
      );
      const bOn = readout(
        b,
        () => {
          this.tweenNum("kpi:words", bigNumber(b.num, s.totalWords, unit("words")), s.totalWords, unit("words"));
          b.side.createSpan({ cls: "vp-kpi-caption", text: L("近 30 天", "30 days") });
          b.side.createSpan({ cls: "vp-delta is-up", text: `+${fmtNum(w30)}` });
        },
        (i) => {
          const p = splitNum(words[i].value, unit("words"));
          return { value: p.value, unit: p.unit, date: range(words[i].start, words[i].end), note: L(`当周 +${fmtNum(words[i].extra)}`, `+${fmtNum(words[i].extra)} that week`), up: true };
        }
      );
      drawSparkline(b.c.createDiv({ cls: "vp-kpi-viz" }), words.map((p) => p.value), {
        onPoint: bOn,
        label: (i) =>
          L(
            `${range(words[i].start, words[i].end)}，累计 ${words[i].value} 字，当周新增 ${words[i].extra} 字`,
            `${range(words[i].start, words[i].end)}: ${count(words[i].value, "words")} in total, ${words[i].extra} added that week`
          ),
      });
    }

    if (which === "taskRate") {
      // 任务（没有每周历史，不画走势，只画完成进度）
      const t = s.tasks;
      const rate = t.total ? Math.round((t.done / t.total) * 100) : 0;
      const c = kpi(
        "list-checks",
        L("任务完成率", "Tasks done"),
        L("已完成任务占全部任务的比例，已取消的任务不计。", "Share of all tasks that are done. Cancelled tasks are not counted.")
      );
      const rateEl = bigNumber(c.num, t.total ? String(rate) : "—", t.total ? "%" : "");
      if (t.total) this.tweenNum("kpi:rate", rateEl, rate, "%");
      c.side.createSpan({ cls: "vp-kpi-caption", text: `${fmtFull(t.done)} / ${fmtFull(t.total)}` });
      this.meter(c.c.createDiv({ cls: "vp-kpi-viz" }), t.total ? t.done / t.total : 0, "");
    }

    if (which === "month") {
      // 本月写作
      const month = monthWriting(s, goal, now);
      const weeks = weeklyCheckins(s, goal, 12, now);
      const d = kpi(
        "flame",
        L("本月写作", "This month"),
        L(
          "本月打卡的天数，和本月每天平均写的字数。曲线是近 12 周每周打卡的天数。",
          "Streak days this month and the average words per day this month. The line is the streak days in each of the last 12 weeks."
        )
      );
      const dOn = readout(
        d,
        () => {
          this.tweenNum("kpi:month", bigNumber(d.num, String(month.days), unit("days", month.days)), month.days, unit("days", month.days));
          d.side.createSpan({ cls: "vp-kpi-caption", text: L(`日均 ${fmtFull(month.average)} 字`, `${fmtFull(month.average)} words a day`) });
        },
        (i) => ({
          value: String(weeks[i].value),
          unit: unit("days", weeks[i].value),
          date: i === weeks.length - 1 ? L("本周", "This week") : range(weeks[i].start, weeks[i].end),
          note: count(fmtFull(weeks[i].extra), "words"),
        })
      );
      drawSparkline(d.c.createDiv({ cls: "vp-kpi-viz" }), weeks.map((p) => p.value), {
        onPoint: dOn,
        label: (i) =>
          L(
            `${range(weeks[i].start, weeks[i].end)}，打卡 ${weeks[i].value} 天，写了 ${weeks[i].extra} 字`,
            `${range(weeks[i].start, weeks[i].end)}: ${count(weeks[i].value, "days")} on streak, ${count(weeks[i].extra, "words")}`
          ),
      });
    }
  }

  private meter(parent: HTMLElement, ratio: number, cls: string, label?: string) {
    const m = parent.createDiv({ cls: "vp-meter-wrap" });
    if (label) m.createDiv({ cls: "vp-meter-label", text: label });
    const track = m.createDiv({ cls: `vp-meter ${cls}` });
    track.createDiv({ cls: "vp-meter-fill" }).setCssProps({ "--vp-meter-width": `${Math.max(0, Math.min(1, ratio)) * 100}%` });
  }

  /* ---------- 3. 热力图 ---------- */

  private renderHeatmap(grid: HTMLElement, s: VaultStats, ck: Checkin) {
    const goal = this.plugin.settings.dailyWordGoal;
    const hm = this.plugin.settings.heatmapMode;
    let modeTip: string;
    if (hm === "auto") {
      const st = s.logStartDay ? s.logStartDay.slice(5).replace("-", "/") : L("今天", "today");
      modeTip = L(
        `${st} 起是实测值：从启用插件那天起，按每天实际新增的字数记录（看板关着也会记）。更早的日子按笔记最后修改日估算，悬停格子会标注“估算”。`,
        `From ${st} on, values are recorded: the words actually added each day since the plugin was enabled (even with the dashboard closed). Earlier days are estimated from last-modified dates, and their tooltips say "estimated".`
      );
    } else if (hm === "delta") {
      modeTip = L("按每日新增字数：从启用插件那天开始累积。", "By daily additions: builds up from the day the plugin was enabled.");
    } else {
      modeTip = L(
        "按笔记修改日：笔记全文字数计入其最后修改日，较粗略，可在设置中切换为“智能”或“每日新增字数”。",
        "By modified date: a note's full word count goes to its last-modified day. This is rough; switch to Smart or daily additions in settings."
      );
    }
    const skippedN = s.outliers.count;
    const heatHelp = [
      modeTip,
      L(
        `颜色越深写得越多${goal > 0 ? `，目标 ${fmtNum(goal)} 字/天` : ""}。写了日记的日子也算打卡。`,
        `Darker means more writing${goal > 0 ? `; the goal is ${fmtNum(goal)} words a day` : ""}. Days with a daily note also count toward the streak.`
      ),
      skippedN > 0 ? L(`已排除 ${skippedN} 篇超大或采集笔记。`, `${count(skippedN, "notes")} excluded as oversized or clipped.`) : "",
    ]
      .filter(Boolean)
      .join("\n");
    const { el, head, body } = this.card(grid, "vp-heat-card", L("写作热力图", "Writing heatmap"), "calendar-days", heatHelp);
    const summary = head.createDiv({ cls: "vp-heat-summary" });
    const wrap = body.createDiv({ cls: "vp-heatmap-wrap" });
    const tip = new Tooltip(wrap);
    const svgHost = wrap.createDiv({ cls: "vp-heatmap-host" });
    this.responsive(wrap, (w) => {
      svgHost.empty();
      const weeks = this.drawHeatmap(svgHost, s, ck, w, tip);
      const today = startOfDay(Date.now());
      const from = addDays(today, -((today.getDay() + 6) % 7) - (weeks - 1) * 7);
      let total = 0,
        active = 0,
        days = 0;
      for (let d = new Date(from); d.getTime() <= today.getTime(); d = addDays(d, 1)) {
        const k = dayKey(d);
        total += s.dayWords[k] || 0;
        if (ck.isActive(k)) active++;
        days++;
      }
      summary.empty();
      const item = (label: string, value: string, suffix = "") => {
        const x = summary.createSpan({ cls: "vp-heat-sum" });
        x.createSpan({ text: label + " " });
        x.createEl("b", { text: value });
        if (suffix) x.createSpan({ text: " " + suffix });
      };
      const tp = splitNum(total, unit("words"));
      item(weeks >= 52 ? L("近一年", "Past year") : L(`近 ${weeks} 周`, `Past ${weeks} weeks`), tp.value, tp.unit);
      item(L("打卡", "Streak days"), String(active), L("天", ""));
      item(L("日均", "Daily avg"), fmtFull(Math.round(total / Math.max(1, days))), unit("words"));
      const busy = busiestWeekday(s, from, today);
      if (busy) item(L("最活跃", "Busiest"), busy);
    });

    const foot = body.createDiv({ cls: "vp-heat-foot" });
    const note: string[] = [];
    if (s.estimatedBefore) {
      const [, em, ed] = s.estimatedBefore.split("-").map(Number);
      note.push(L(`${em}月${ed}日之前为估算`, `Estimated before ${monthDay(new Date(2000, em - 1, ed))}`));
    }
    note.push(L("点击某天查看当天改动的笔记", "Click a day to see the notes edited that day"));
    foot.createSpan({ text: note.join(" · ") });
    const legend = foot.createDiv({ cls: "vp-heat-legend" });
    legend.createSpan({ text: L("少", "Less") });
    for (let i = 0; i <= 4; i++) legend.createSpan({ cls: `vp-heat-swatch vp-l${i}` });
    legend.createSpan({ text: L("多", "More") });
    if (this.selectedDay) {
      const k = this.selectedDay;
      const det = el.createDiv({ cls: "vp-day-detail" });
      const dh = det.createDiv({ cls: "vp-day-detail-head" });
      const [y, m, d] = k.split("-").map(Number);
      dh.createSpan({ cls: "vp-day-detail-title", text: monthDay(new Date(y, m - 1, d)) });
      dh.createSpan({
        cls: "vp-day-detail-meta",
        text: `${count(fmtFull(s.dayWords[k] || 0), "words")}${s.dailyNotes[k] ? L(" · 有日记", " · daily note") : ""}${y !== new Date().getFullYear() ? ` · ${y}` : ""}`,
      });
      const close = dh.createEl("button", { cls: "vp-icon-btn is-small", attr: { "aria-label": L("关闭", "Close") } });
      setIcon(close, "x");
      close.addEventListener("click", () => {
        this.selectedDay = null;
        this.dayExpanded = false;
        this.rerender("heat", "resize");
      });
      const list = det.createDiv({ cls: "vp-rows" });
      if (s.dailyNotes[k]) this.noteRow(list, s.dailyNotes[k], L("日记", "Daily note"));
      const mods = (s.dayModified[k] || []).filter((f) => f !== s.dailyNotes[k]);
      const shown = this.dayExpanded ? mods : mods.slice(0, 8);
      const area = this.dayExpanded && mods.length > 8 ? list.createDiv({ cls: "vp-rows vp-scroll", attr: { tabindex: "0", role: "region", "aria-label": L("当天修改的笔记", "Notes edited that day") } }) : list;
      for (const f of shown) this.noteRow(area, f, L("当天修改", "Edited"));
      if (mods.length > 8) {
        this.moreLink(det.createDiv({ cls: "vp-card-foot" }), this.dayExpanded ? COLLAPSE() : L(`展开另外 ${mods.length - 8} 篇`, `Show ${mods.length - 8} more`), () => {
          this.dayExpanded = !this.dayExpanded;
          this.rerender("heat", "resize");
        });
      }
      if (mods.length === 0 && !s.dailyNotes[k]) this.empty(list, "coffee", L("这一天没有留下笔记，休息也很重要", "No notes that day. Rest matters too."));
    }
  }

  /** 按可用宽度决定显示多少周，返回周数 */
  private drawHeatmap(host: HTMLElement, s: VaultStats, ck: Checkin, width: number, tip: Tooltip): number {
    const goal = this.plugin.settings.dailyWordGoal;
    const today = startOfDay(Date.now());
    const left = 22,
      top = 20,
      gap = 4;
    const targetCell = 14;
    const weeks = Math.max(8, Math.min(53, Math.floor((width - left + gap) / (targetCell + gap))));
    const cell = Math.min(20, Math.floor((width - left + gap) / weeks - gap));
    const gridStart = addDays(today, -((today.getDay() + 6) % 7) - (weeks - 1) * 7);
    const W = left + weeks * (cell + gap) - gap,
      H = top + 7 * (cell + gap) - gap;
    const svg = svgEl("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: "vp-heatmap" }, host);

    const values: number[] = [];
    for (let x = new Date(gridStart); x.getTime() <= today.getTime(); x = addDays(x, 1)) {
      const v = s.dayWords[dayKey(x)] || 0;
      if (v > 0) values.push(v);
    }
    values.sort((a, b) => a - b);
    const cuts = heatCuts(values, goal);
    const levelOf = (w: number, k: string): number => {
      if (w <= 0) return s.dailyNotes[k] ? 1 : 0;
      if (w <= cuts[0]) return 1;
      if (w <= cuts[1]) return 2;
      if (w <= cuts[2]) return 3;
      return 4;
    };

    const cells = new Map<string, { rect: SVGRectElement; day: Date }>();
    const showTip = (k: string) => {
      const c = cells.get(k);
      if (!c) return;
      const words = s.dayWords[k] || 0;
      const rows = [
        { label: L("写作", "Written"), value: count(fmtFull(words), "words") },
        { label: L("修改笔记", "Edited"), value: count(s.dayModified[k]?.length || 0, "notes") },
        { label: L("新建笔记", "Created"), value: count(s.dayCreated[k] || 0, "notes") },
      ];
      if (s.dailyNotes[k]) rows.push({ label: L("日记", "Daily note"), value: L("有", "Yes") });
      if (s.estimatedBefore && k < s.estimatedBefore) rows.push({ label: L("来源", "Source"), value: L("按修改日估算", "Estimated") });
      else if (s.estimatedBefore) rows.push({ label: L("来源", "Source"), value: L("实测", "Recorded") });
      const [yy, mm, dd] = k.split("-").map(Number);
      const rr = c.rect.getBoundingClientRect();
      const date = new Date(yy, mm - 1, dd);
      const title = L(`${fullDate(date)} ${weekdayName(c.day.getDay())}`, `${weekdayShort(c.day.getDay())}, ${fullDate(date)}`);
      tip.showAtClient(rr.left + rr.width / 2, rr.top, `${title}${ck.isActive(k) ? L(" · 已打卡", " · streak day") : ""}`, rows);
    };

    [
      [weekdayShort(1), 0],
      [weekdayShort(3), 2],
      [weekdayShort(5), 4],
    ].forEach(([t, r]) => {
      const tx = svgEl("text", { x: 0, y: top + (r as number) * (cell + gap) + cell / 2 + 4, class: "vp-heat-label" }, svg);
      tx.textContent = t as string;
    });

    let lastMonth = -1;
    let lastLabelX = -100;
    for (let w = 0; w < weeks; w++) {
      const weekStart = addDays(gridStart, w * 7);
      // 月份标签：放在该月第一个完整周的列上
      const m = addDays(weekStart, 6).getMonth();
      if (m !== lastMonth) {
        lastMonth = m;
        const x = left + w * (cell + gap);
        if (x - lastLabelX > 30 && x < W - 16) {
          const mt = svgEl("text", { x, y: 11, class: "vp-heat-label" }, svg);
          mt.textContent = monthShort(m);
          lastLabelX = x;
        }
      }
      for (let r = 0; r < 7; r++) {
        const day = addDays(weekStart, r);
        if (day.getTime() > today.getTime()) continue;
        const k = dayKey(day);
        const words = s.dayWords[k] || 0;
        const lvl = levelOf(words, k);
        const x = left + w * (cell + gap),
          y = top + r * (cell + gap);
        const rect = svgEl(
          "rect",
          {
            x,
            y,
            width: cell,
            height: cell,
            rx: Math.max(2, Math.round(cell / 4)),
            class: `vp-heat-cell vp-l${lvl}${k === this.selectedDay ? " is-selected" : ""}${k === ck.todayKey ? " is-today" : ""}`,
          },
          svg
        );
        cells.set(k, { rect, day });
        rect.addEventListener("mouseenter", () => showTip(k));
        rect.addEventListener("mouseleave", () => tip.hide());
        rect.addEventListener("click", () => {
          this.selectedDay = this.selectedDay === k ? null : k;
          this.dayExpanded = false;
          this.rerender("heat", "resize");
        });
      }
    }

    // 键盘：聚焦后用方向键浏览日期，回车查看当天
    svg.setAttribute("tabindex", "0");
    svg.setAttribute("role", "application");
    svg.setAttribute("data-fid", "heat:grid");
    srLabel(
      svg,
      L("写作热力图。用左右方向键切换周，上下方向键切换日，回车查看当天的笔记。", "Writing heatmap. Left and right arrows move by week, up and down by day, Enter shows that day's notes."),
      host
    );
    const live = host.createDiv({ cls: "vp-sr-only", attr: { "aria-live": "polite" } });
    let cursor: string | null = null;
    const move = (k: string | null) => {
      if (cursor) cells.get(cursor)?.rect.removeClass("is-cursor");
      cursor = k;
      if (!k) return;
      const c = cells.get(k);
      if (!c) return;
      c.rect.addClass("is-cursor");
      showTip(k);
      const [yy, mm, dd] = k.split("-").map(Number);
      live.setText(
        L(
          `${yy}年${mm}月${dd}日，${fmtFull(s.dayWords[k] || 0)} 字${ck.isActive(k) ? "，已打卡" : ""}`,
          `${fullDate(new Date(yy, mm - 1, dd))}, ${count(fmtFull(s.dayWords[k] || 0), "words")}${ck.isActive(k) ? ", streak day" : ""}`
        )
      );
    };
    svg.addEventListener("focus", () => move(this.selectedDay && cells.has(this.selectedDay) ? this.selectedDay : ck.todayKey));
    svg.addEventListener("blur", () => {
      move(null);
      tip.hide();
    });
    svg.addEventListener("keydown", (e: KeyboardEvent) => {
      const c = cursor ? cells.get(cursor) : null;
      if (!c) return;
      const delta = e.key === "ArrowLeft" ? -7 : e.key === "ArrowRight" ? 7 : e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
      if (delta) {
        e.preventDefault();
        const nk = dayKey(addDays(c.day, delta));
        if (cells.has(nk)) move(nk);
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this.selectedDay = this.selectedDay === cursor ? null : cursor;
        this.dayExpanded = false;
        this.rerender("heat", "resize");
      } else if (e.key === "Escape") {
        tip.hide();
      }
    });
    return weeks;
  }

  /* ---------- 5. 每周写作 ---------- */

  private renderTrend(grid: HTMLElement, s: VaultStats) {
    const goal = this.plugin.settings.dailyWordGoal;
    const isWords = this.metric === "words";
    const m = trendModel(s, this.range, this.metric, goal, new Date(s.generatedAt));
    const daily = m.gran === "day";
    const per = daily ? "天" : "周";
    const trendHelp = isWords
      ? L(
        `每${per}写作的字数，与热力图同一来源（排除超大和采集笔记）。最右边一根是本${daily ? "日" : "周"}，用实色标出。`,
        `Words written per ${daily ? "day" : "week"}, from the same source as the heatmap (oversized and clipped notes left out). The rightmost bar, in solid color, is ${daily ? "today" : "this week"}.`
      )
      : L(`每${per}新建的笔记数（不含采集文件夹）。`, `Notes created per ${daily ? "day" : "week"} (clipping folders left out).`);
    const title = isWords ? L(`每${per}写作`, daily ? "Daily writing" : "Weekly writing") : L(`每${per}新建笔记`, daily ? "New notes per day" : "New notes per week");
    const { head, body } = this.card(grid, "vp-trend-card", title, "trending-up", trendHelp);
    const ctrls = head.createDiv({ cls: "vp-ctrls" });
    this.segmented<TrendMetric>(
      ctrls,
      [["words", L("字数", "Words")], ["notes", L("新建笔记", "New notes")]],
      this.metric,
      (v) => {
        this.metric = v;
        this.rerender("trend");
      },
      L("指标", "Metric")
    );
    this.segmented<TrendRange>(
      ctrls,
      [[30, L("30 天", "30 days")], [182, L("半年", "6 months")], [365, L("一年", "1 year")]],
      this.range,
      (v) => {
        this.range = v;
        this.rerender("trend");
      },
      L("时间范围", "Period")
    );

    const u = isWords ? unit("words") : unit("notes");
    const rangeName = this.range === 30 ? L("30 天", "30 days") : this.range === 182 ? L("半年", "6 months") : L("一年", "1 year");
    const summary = body.createDiv({ cls: "vp-trend-summary" });
    const stat = (key: string, label: string, value: number) => {
      const x = summary.createDiv({ cls: "vp-trend-side" });
      this.tweenNum(`trend:${this.metric}:${key}`, bigNumber(x, value, u, "vp-num vp-num-sm"), value, u);
      x.createDiv({ cls: "vp-label", text: label });
    };
    stat("total", L(`${rangeName}合计`, `Total, ${rangeName}`), m.total);
    stat("avg", L(`${per}均`, daily ? "Per day" : "Per week"), m.average);
    if (m.best) stat("best", L(`最高一${per}`, daily ? "Best day" : "Best week"), m.best.value);

    const fmtDay = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;
    const points: SeriesPoint[] = m.buckets.map((bk) => {
      const title = m.gran === "day" ? monthDay(bk.start) : `${fmtDay(bk.start)} – ${fmtDay(bk.end)}`;
      const rows = [{ label: isWords ? L("写作", "Written") : L("新建笔记", "New notes"), value: count(fmtFull(bk.value), isWords ? "words" : "notes"), dot: "is-accent" }];
      if (m.gran === "week") rows.push({ label: L("打卡", "Streak days"), value: count(bk.checkins, "days"), dot: "" });
      return { label: fmtDay(bk.start), value: bk.value, tipTitle: title, tipRows: rows };
    });
    if (points.every((p) => p.value === 0)) {
      this.empty(body.createDiv({ cls: "vp-chart-empty" }), "line-chart", isWords ? L("这段时间还没有写作记录", "No writing recorded in this period") : L("这段时间还没有新建笔记", "No notes created in this period"));
    } else {
      const chartWrap = body.createDiv({ cls: "vp-chart-wrap" });
      const tip = new Tooltip(chartWrap);
      const host = chartWrap.createDiv({ cls: "vp-chart-host" });
      host.setAttr("role", "img");
      srLabel(
        host,
        L(
          `${rangeName}${isWords ? "写作字数" : "新建笔记"}柱状图，合计 ${fmtFull(m.total)} ${u}`,
          `Bar chart of ${isWords ? "words written" : "new notes"}, ${rangeName}, ${fmtFull(m.total)} ${u} in total`
        ),
        chartWrap
      );
      this.responsive(chartWrap, (w) => {
        host.empty();
        drawTrendChart(host, points, { width: w, height: 220, kind: "bar", tooltip: tip, highlightLast: true });
      });
    }
    this.renderOutlierRow(body, s);
  }

  /** 趋势卡下方：一键开关；说明文字都收进旁边的问号里 */
  private renderOutlierRow(body: HTMLElement, s: VaultStats) {
    const big = s.files.filter((f) => f.big && !f.collected);
    const collected = s.files.filter((f) => f.collected && f.words > 0);
    if (big.length === 0) return;
    const on = this.plugin.settings.outlierMode === "exclude";
    const row = body.createDiv({ cls: "vp-annot" });
    const sw = row.createEl("button", {
      cls: "vp-switch" + (on ? " is-on" : ""),
      attr: { role: "switch", "aria-checked": String(on), "data-fid": "trend:outlier" },
    });
    sw.createSpan({ cls: "vp-switch-track" }).createSpan({ cls: "vp-switch-thumb" });
    sw.createSpan({ cls: "vp-switch-label", text: L(`排除超大笔记（> ${fmtNum(s.outliers.threshold)} 字）`, `Exclude oversized notes (> ${fmtNum(s.outliers.threshold)} words)`) });
    sw.addEventListener("click", () => void this.plugin.setOutlierExclusion(!on));

    const w = big.reduce((a, f) => a + f.words, 0);
    const top = [...big, ...collected].sort((a, b) => b.words - a.words).slice(0, 3);
    const lines = [
      L(
        `字数超过 ${fmtNum(s.outliers.threshold)} 字的笔记（多为自动采集或整段粘贴）会让趋势和热力图失真。`,
        `Notes over ${fmtNum(s.outliers.threshold)} words (usually collected or pasted in bulk) distort the trends and the heatmap.`
      ),
      on
        ? L(`已排除 ${big.length} 篇 · ${fmtNum(w)} 字。`, `${count(big.length, "notes")} · ${fmtNum(w)} words excluded.`)
        : L(`目前含 ${big.length} 篇超大笔记 · ${fmtNum(w)} 字。`, `Currently includes ${big.length} oversized ${plural(big.length, "note")} · ${fmtNum(w)} words.`),
    ];
    if (collected.length > 0)
      lines.push(L(`另有 ${collected.length} 篇在采集文件夹里，始终不计入。`, `Another ${count(collected.length, "notes")} in clipping folders are never counted.`));
    lines.push(
      L(
        `字数最多：\n${top.map((f) => `${f.file.path}（${fmtNum(f.words)} 字）`).join("\n")}`,
        `Longest:\n${top.map((f) => `${f.file.path} (${fmtNum(f.words)} words)`).join("\n")}`
      )
    );
    this.help(row, lines.join("\n"));
  }

  /* ---------- 6. 接下来：任务 ---------- */

  private taskExpanded = false;

  private renderTasks(grid: HTMLElement, s: VaultStats) {
    const { el, head, body } = this.card(
      grid,
      "vp-tasks-card",
      L("接下来", "Next up"),
      "list-todo",
      L(
        "笔记里带截止日期（📅 或 [due::]）的待办：已逾期的单独列出，下面是今天起 7 天内到期的。点任务直接跳到那一行。",
        "Open tasks in your notes with a due date (📅 or [due::]). Overdue ones are listed first, then those due in the next 7 days. Click a task to jump to its line."
      )
    );
    const t = s.tasks;
    this.segmented<TaskTab>(head, [["due", L("到期", "Due")], ["folder", L("按文件夹", "By folder")]], this.taskTab, (v) => {
      this.taskTab = v;
      this.taskExpanded = false;
      this.rerender("tasks");
    });
    if (t.total === 0) {
      this.empty(body, "list-checks", L("还没有任务。在笔记里写 - [ ] 就会出现在这里", "No tasks yet. Write - [ ] in a note and it shows up here."));
      return;
    }
    const todayKey = dayKey(Date.now());
    const limit = this.taskExpanded ? 50 : 4;

    if (this.taskTab === "due") {
      const area = this.listArea(el, body, this.taskExpanded);
      if (t.overdue.length) {
        const od = area.createDiv({ cls: "vp-overdue" });
        od.createDiv({ cls: "vp-overdue-title", text: L(`已逾期 ${t.overdue.length}`, `Overdue ${t.overdue.length}`) });
        const list = od.createDiv({ cls: "vp-rows" });
        for (const it of t.overdue.slice(0, this.taskExpanded ? 50 : 2)) this.taskRow(list, it, true);
      }
      const list = area.createDiv({ cls: "vp-rows" });
      if (t.dueSoon.length === 0 && !t.overdue.length) this.empty(list, "party-popper", L("7 天内没有到期的任务", "Nothing due in the next 7 days"));
      for (const it of t.dueSoon.slice(0, limit)) this.taskRow(list, it, false, it.due === todayKey);
      const hidden = Math.max(0, t.dueSoon.length - limit) + Math.max(0, t.overdue.length - (this.taskExpanded ? 50 : 2));
      const more = body.createDiv({ cls: "vp-card-foot" });
      if (hidden > 0 || this.taskExpanded) {
        this.moreLink(more, this.taskExpanded ? COLLAPSE() : L(`展开另外 ${hidden} 项`, `Show ${hidden} more`), () => {
          this.taskExpanded = !this.taskExpanded;
          this.rerender("tasks", "resize");
        });
      }
      this.moreLink(more, L(`全部 ${fmtFull(t.pending)} 项待办`, `All ${count(fmtFull(t.pending), "tasks")}`), () => this.plugin.openSearch("task-todo:\"\""));
    } else {
      const groups: GroupStat[] = t.byFolder.filter((g) => g.pending > 0);
      const list = this.listArea(el, body, this.taskExpanded).createDiv({ cls: "vp-rows" });
      if (groups.length === 0) {
        this.empty(list, "party-popper", L("所有任务都完成了", "All tasks are done"));
        return;
      }
      for (const g of groups.slice(0, this.taskExpanded ? 50 : 6)) {
        const row = list.createDiv({ cls: "vp-row vp-group-row" });
        row.createSpan({ cls: "vp-row-name", text: folderName(g.key) });
        const m = row.createDiv({ cls: "vp-meter is-inline" });
        m.createDiv({ cls: "vp-meter-fill" }).setCssProps({ "--vp-meter-width": `${(g.done / Math.max(1, g.total)) * 100}%` });
        row.createSpan({ cls: "vp-row-meta vp-tabular", text: L(`待办 ${g.pending}`, `${g.pending} open`) });
        if (g.key !== ROOT_FOLDER) this.clickable(row, L(`${g.key}，待办 ${g.pending}`, `${g.key}, ${g.pending} open`), () => this.plugin.revealFolder(g.key));
      }
      if (groups.length > 6) {
        this.moreLink(body.createDiv({ cls: "vp-card-foot" }), this.taskExpanded ? COLLAPSE() : L(`展开另外 ${groups.length - 6} 个文件夹`, `Show ${groups.length - 6} more ${plural(groups.length - 6, "folder")}`), () => {
          this.taskExpanded = !this.taskExpanded;
          this.rerender("tasks", "resize");
        });
      }
    }
  }

  private taskRow(list: HTMLElement, it: TaskInfo, overdue: boolean, today = false) {
    const row = list.createDiv({ cls: "vp-row vp-task-row" + (overdue ? " is-overdue" : "") + (today ? " is-today" : "") });
    row.createSpan({ cls: "vp-task-box", attr: { "aria-hidden": "true" } });
    const due = it.due ? it.due.slice(5).replace("-", "/").replace(/^0/, "") : "";
    row.createSpan({ cls: "vp-due", text: today ? L("今天", "Today") : due });
    const text = cleanTaskText(it.text);
    row.createSpan({ cls: "vp-row-name", text: text || L("（空任务）", "(empty task)"), attr: { title: `${text}\n${it.file.path}` } });
    row.createSpan({ cls: "vp-row-meta", text: it.file.basename });
    this.clickable(row, `${text || L("空任务", "Empty task")}${L("，", ", ")}${it.file.basename}${overdue ? L("，已逾期", ", overdue") : ""}`, (e) => void this.plugin.openFile(it.file, it.line, e));
  }

  /**
   * 展开后的列表放进限高的滚动区：卡片最多长到大约 8 行，整页不会被拉长，
   * “收起”就在滚动区下面，不用滚过整张列表去找。
   */
  private listArea(card: HTMLElement, body: HTMLElement, expanded: boolean): HTMLElement {
    if (!expanded) return body;
    card.addClass("is-expanded");
    return body.createDiv({ cls: "vp-scroll", attr: { tabindex: "0", role: "region", "aria-label": L("展开的列表", "Expanded list") } });
  }

  /** 卡片底部的文字链接（展开 / 查看全部） */
  private moreLink(parent: HTMLElement, text: string, onClick: () => void) {
    const b = parent.createEl("button", { cls: "vp-link", attr: { type: "button" } });
    b.createSpan({ text });
    setIcon(b.createSpan({ cls: "vp-link-icon", attr: { "aria-hidden": "true" } }), text === COLLAPSE() ? "chevron-up" : "chevron-right");
    b.addEventListener("click", onClick);
    return b;
  }

  /* ---------- 7. 标签 / 文件夹 ---------- */

  private tagsExpanded = false;

  private renderTags(grid: HTMLElement, s: VaultStats) {
    const isTags = this.tagTab === "tags";
    const { el, head, body } = this.card(
      grid,
      "vp-tags-card",
      isTags ? L("常用标签", "Top tags") : L("文件夹", "Folders"),
      isTags ? "tag" : "folder",
      isTags
        ? L(
          "按使用的笔记数排列。“本周 +n”是本周新建的笔记里用到这个标签的篇数。点击标签在搜索里查看。",
          "Sorted by the number of notes using each tag. \"+n this week\" is how many notes created this week use it. Click a tag to search for it."
        )
        : L("按顶层文件夹统计笔记数和字数，点击可在文件列表里定位。", "Notes and words per top-level folder. Click to reveal the folder in the file list.")
    );
    this.segmented<TagTab>(head, [["tags", L("标签", "Tags")], ["folders", L("文件夹", "Folders")]], this.tagTab, (v) => {
      this.tagTab = v;
      this.tagsExpanded = false;
      this.rerender("tags");
    });
    const limit = this.tagsExpanded ? 30 : 6;
    let items: BarItem[];
    if (isTags) {
      const since = weekStart(new Date(s.generatedAt)).getTime();
      const fresh = new Map<string, number>();
      for (const f of s.files) if (f.created >= since) for (const t of f.tags) fresh.set(t, (fresh.get(t) || 0) + 1);
      items = s.tags.slice(0, limit).map(([tag, n]) => ({
        label: tag,
        value: n,
        valueText: fmtFull(n),
        note: fresh.get(tag) ? L(`本周 +${fresh.get(tag)}`, `+${fresh.get(tag)} this week`) : undefined,
        onClick: () => this.plugin.openSearch(`tag:${tag}`),
      }));
    } else {
      items = s.folders.slice(0, limit).map((f) => ({
        label: folderName(f.folder),
        value: f.notes,
        valueText: `${count(fmtFull(f.notes), "notes")} · ${fmtNum(f.words)} ${unit("words")}`,
        onClick: f.folder === ROOT_FOLDER ? undefined : () => this.plugin.revealFolder(f.folder),
      }));
    }
    drawBarList(
      this.listArea(el, body, this.tagsExpanded),
      items,
      isTags ? L("还没有标签。给笔记加上 #标签，这里就会热闹起来", "No tags yet. Add #tags to your notes and they show up here.") : L("仓库里还没有文件夹", "No folders in the vault yet"),
      (el) => setIcon(el.createDiv({ cls: "vp-empty-icon" }), isTags ? "tag" : "folder")
    );
    const total = isTags ? s.tags.length : s.folders.length;
    if (total > 6) {
      this.moreLink(body.createDiv({ cls: "vp-card-foot" }), this.tagsExpanded ? COLLAPSE() : L(`全部 ${total} 个${isTags ? "标签" : "文件夹"}`, `All ${count(total, isTags ? "tags" : "folders")}`), () => {
        this.tagsExpanded = !this.tagsExpanded;
        this.rerender("tags", "resize");
      });
    }
  }

  /* ---------- 8. 库体检 ---------- */

  /** 库体检里展开的那一栏：一次只展开一栏（手风琴），展开别的栏会收起这一栏 */
  private checkupOpen: string | null = null;

  private renderCheckup(grid: HTMLElement, s: VaultStats) {
    const c = checkupModel(s);
    const dd = this.plugin.dedupe;
    const dupOn = this.plugin.settings.dedupeEnabled && this.plugin.settings.dedupeCard;
    const dup = dupOn && dd.analysis ? dedupeOverview(dd.analysis, dd.ignoredSet()) : null;
    const { el: cardEl, head, body } = this.card(
      grid,
      "vp-checkup-card",
      L("库体检", "Vault checkup"),
      "heart-pulse",
      L(
        "随看板一起刷新。断链和孤立笔记来自 Obsidian 的链接索引；重复内容来自最近一次扫描。会改动笔记的操作都先确认，删除的笔记进回收站。",
        "Refreshes with the dashboard. Broken links and orphans come from Obsidian's link index; duplicates from the last scan. Anything that changes notes asks first, and deleted notes go to the trash."
      )
    );
    const live = head.createDiv({ cls: "vp-live" });
    live.createSpan({ cls: "vp-live-dot", attr: { "aria-hidden": "true" } });
    const at = new Date(s.generatedAt);
    live.createSpan({ text: L(`实时 · ${pad2(at.getHours())}:${pad2(at.getMinutes())} 更新`, `Live · updated ${pad2(at.getHours())}:${pad2(at.getMinutes())}`) });
    const extra = c.sameName.length + c.unusedAttachments.length;
    const total = c.unresolved.length + c.orphans.length + c.empty.length + c.big.length + extra + (dup ? dup.groups.length : 0);
    const todo = fmtFull(c.unresolvedCount + c.orphans.length + c.empty.length + c.big.length + extra + (dup ? dup.groups.length : 0));
    head.createDiv({ cls: "vp-card-aside", text: total ? L(`共 ${todo} 项可整理`, `${todo} to tidy up`) : L("一切正常", "All good") });

    const cols = body.createDiv({ cls: "vp-checkup" });
    const col = (key: string, title: string, count: number, sev: "warn" | "", empty: string) => {
      const el = cols.createDiv({ cls: "vp-checkup-col" });
      const h = el.createDiv({ cls: "vp-checkup-head" });
      h.createSpan({ cls: "vp-checkup-title", text: title });
      h.createSpan({ cls: "vp-count" + (count && sev ? " is-warn" : ""), text: fmtFull(count) });
      const open = this.checkupOpen === key;
      if (open) {
        el.addClass("is-open");
        cardEl.addClass("is-expanded");
      }
      const list = el.createDiv({ cls: "vp-rows" + (open ? " vp-scroll" : "") });
      if (open) {
        list.setAttr("tabindex", "0");
        list.setAttr("role", "region");
        list.setAttr("aria-label", L(`${title}，展开的列表`, `${title}, expanded list`));
      }
      if (count === 0) list.createDiv({ cls: "vp-checkup-ok", text: empty });
      return { el, list, limit: open ? 50 : 3, open };
    };
    const item = (list: HTMLElement, name: string, label: string, onOpen: (() => void) | null, actText: string, act: () => void) => {
      const row = list.createDiv({ cls: "vp-row vp-checkup-row" });
      const n = row.createSpan({ cls: "vp-row-name", text: name, attr: { title: name } });
      if (onOpen) this.clickable(n, L(`打开 ${label}`, `Open ${label}`), () => onOpen());
      const b = row.createEl("button", { cls: "vp-act", text: actText, attr: { type: "button" } });
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        act();
      });
    };
    /** shown：列表里实际有多少条可以展开（断链只保留出现最多的 10 个名字，比总处数少） */
    const foot = (k: { el: HTMLElement; open: boolean }, key: string, shown: number, kind: UnitKind) => {
      if (shown <= 3) return;
      this.moreLink(k.el.createDiv({ cls: "vp-card-foot" }), k.open ? COLLAPSE() : L(`展开 ${fmtFull(shown)} ${unit(kind)}`, `Show all ${fmtFull(shown)}`), () => {
        this.checkupOpen = k.open ? null : key;
        this.rerender("checkup", "resize");
      });
    };

    // 断链：能唯一确定指向哪篇的排在前面，一键改过去；其余照旧可以新建笔记（用 Obsidian 自己的规则）
    const u = col("unresolved", L("断链", "Broken links"), c.unresolvedCount, "warn", L("没有断开的链接", "No broken links"));
    for (const x of c.unresolved.slice(0, u.limit)) {
      const shown = x.name.replace(/\\$/, "");
      const search = () => this.plugin.openSearch(`"[[${shown}"`);
      if (x.fix) {
        const fix = x.fix;
        const to = baseName(fix.target);
        item(u.list, `[[${shown}]] → ${to}`, shown, search, L("修复", "Fix"), () => this.confirmLinkFix(shown, x.name, fix.target, x.from, x.count));
      } else {
        item(u.list, L(`[[${shown}]] · ${x.count} 处`, `[[${shown}]] · ${x.count}×`), shown, search, L("创建笔记", "Create note"), () => {
          void this.app.workspace.openLinkText(shown, x.source ?? "", "tab");
        });
      }
    }
    foot(u, "unresolved", c.unresolved.length, "links");

    // 孤立笔记
    const o = col("orphans", L("孤立笔记", "Orphans"), c.orphans.length, "", L("每篇笔记都连上了", "Every note is linked"));
    for (const f of c.orphans.slice(0, o.limit)) {
      item(o.list, f.basename, f.basename, () => void this.plugin.openFile(f), L("打开", "Open"), () => void this.plugin.openFile(f));
    }
    foot(o, "orphans", c.orphans.length, "notes");

    // 重复内容
    if (dupOn) {
      const n = dup ? dup.groups.length : 0;
      const d = col(
        "dupes",
        L("重复内容", "Duplicates"),
        n,
        "warn",
        dd.scanning ? L("正在扫描…", "Scanning…") : dd.analysis ? L("没有重复内容", "No duplicates") : L("还没扫描过", "Not scanned yet")
      );
      if (!dd.analysis && !dd.scanning) {
        item(d.list, L("扫描只读，不会改动笔记", "Read-only, changes nothing"), "", null, L("开始扫描", "Scan"), () => void dd.openReport(true));
      }
      if (dup) {
        for (const g of dup.groups.slice(0, d.limit)) {
          const first = g.occs[0];
          const base = first?.path.split("/").pop()?.replace(/\.md$/, "");
          const name = base
            ? L(`${base} 等 ${g.occs.length} 篇`, `${base} and ${g.occs.length - 1} more`)
            : count(g.occs.length, "notes");
          item(d.list, name, name, () => void dd.openReport(false), L("保留最早", "Keep oldest"), () => dd.startCleanup([groupItem(g, 0)], "mark"));
        }
      }
      if (n > 3) this.moreLink(d.el.createDiv({ cls: "vp-card-foot" }), L(`全部 ${fmtFull(n)} 段`, `All ${count(fmtFull(n), "passages")}`), () => void dd.openReport(false));
      if (dd.stale && dd.analysis) d.el.createDiv({ cls: "vp-checkup-note", text: L("笔记有改动，建议重新扫描", "Notes changed since the scan. Scan again.") });
    }

    // 空笔记与超大笔记
    const eb = c.empty.length + c.big.length;
    const e = col("emptybig", L("空笔记与超大笔记", "Empty and oversized"), eb, "", L("没有空笔记或超大笔记", "No empty or oversized notes"));
    let shown = 0;
    for (const f of c.empty) {
      if (shown++ >= e.limit) break;
      item(e.list, `${f.file.basename} · ${count(0, "words")}`, f.file.basename, () => void this.plugin.openFile(f.file), L("删除", "Delete"), () => this.trashNote(f.file));
    }
    for (const f of c.big) {
      if (shown++ >= e.limit) break;
      const folder = f.folder === ROOT_FOLDER ? null : f.folder;
      item(
        e.list,
        `${f.file.basename} · ${fmtNum(f.words)} ${unit("words")}`,
        f.file.basename,
        () => void this.plugin.openFile(f.file),
        folder ? L("整夹不计入", "Don't count") : L("打开", "Open"),
        () => (folder ? void this.plugin.setClippingFolder(folder) : void this.plugin.openFile(f.file))
      );
    }
    foot(e, "emptybig", eb, "notes");

    // 同名笔记：[[链接]] 只写名字时 Obsidian 会挑其中一篇，容易指错
    const sn = col("samename", L("同名笔记", "Same name"), c.sameName.length, "", L("没有同名笔记", "No notes share a name"));
    for (const g of c.sameName.slice(0, sn.limit)) {
      const name = baseName(g[0]);
      const first = this.app.vault.getAbstractFileByPath(g[0]);
      item(
        sn.list,
        L(`${name} · ${g.length} 篇`, `${name} · ${g.length}`),
        name,
        first instanceof TFile ? () => void this.plugin.openFile(first) : null,
        L("查看", "Show"),
        () => this.plugin.openSearch(`file:"${name}"`)
      );
    }
    foot(sn, "samename", c.sameName.length, "notes");

    // 未引用的附件：没有任何笔记链接或嵌入它
    const ua = col("unused", L("未引用的附件", "Unused attachments"), c.unusedAttachments.length, "", L("附件都有笔记在用", "Every attachment is used"));
    for (const f of c.unusedAttachments.slice(0, ua.limit)) {
      item(ua.list, `${f.name} · ${fmtSize(f.stat.size)}`, f.name, () => void this.plugin.openFile(f), L("删除", "Delete"), () => this.trashAttachment(f));
    }
    foot(ua, "unused", c.unusedAttachments.length, "notes");
  }

  /** 断链修复：先说清楚会改哪几篇，确认后改；改完可以撤销 */
  private confirmLinkFix(shown: string, name: string, target: string, from: string[], times: number) {
    const to = baseName(target);
    const notes = new Set(from).size;
    new ConfirmModal(
      this.app,
      L("修复断链", "Fix broken link"),
      L(
        `把 ${notes} 篇笔记里 ${times} 处 [[${shown}]] 改成指向“${target}”。别名、标题和嵌入保持不变。改完可以撤销。`,
        `Point ${times} ${plural(times, "link")} to [[${shown}]] in ${count(notes, "notes")} at "${target}" instead. Aliases, headings and embeds stay as they are. You can undo this.`
      ),
      L("修复", "Fix"),
      async () => {
        const r = await this.plugin.fixLink(name, target, from);
        const msg = L(`已修复 ${r.notes} 篇笔记里的 ${r.links} 处链接，现在指向 ${to}。`, `Fixed ${r.links} ${plural(r.links, "link")} in ${count(r.notes, "notes")}; they now point to ${to}.`);
        const n = new Notice(msg, 10000);
        // messageEl 要 Obsidian 1.8.7；更早的版本用 noticeEl
        const host = (n as unknown as { messageEl?: HTMLElement; noticeEl: HTMLElement }).messageEl ?? (n as unknown as { noticeEl: HTMLElement }).noticeEl;
        const undo = host.createEl("button", { cls: "vp-notice-undo", text: L("撤销", "Undo"), attr: { type: "button" } });
        undo.addEventListener("click", () => {
          n.hide();
          void this.plugin.undoLinkFix().then((u) => {
            new Notice(
              u.skipped
                ? L(`已撤销 ${u.restored} 篇；${u.skipped} 篇之后又改过，没有动。`, `Undid ${u.restored}; ${u.skipped} changed since and were left alone.`)
                : L(`已撤销，${u.restored} 篇笔记恢复原样。`, `Undone. ${count(u.restored, "notes")} restored.`)
            );
          });
        });
      }
    ).open();
  }

  /** 附件进回收站前确认 */
  private trashAttachment(file: TFile) {
    new ConfirmModal(
      this.app,
      L("删除未引用的附件", "Delete unused attachment"),
      L(`没有笔记链接或嵌入“${file.path}”。删除后会进回收站，可以从回收站找回。`, `No note links to or embeds "${file.path}". It goes to the trash, where you can restore it.`),
      L("删除", "Delete"),
      async () => {
        await this.app.fileManager.trashFile(file);
      }
    ).open();
  }

  /** 删除前确认；进系统 / Obsidian 回收站（按用户的“删除文件”设置），可以找回 */
  private trashNote(file: TFile) {
    new ConfirmModal(
      this.app,
      L("删除空笔记", "Delete empty note"),
      L(`“${file.basename}” 没有任何内容。删除后会进回收站，可以从回收站找回。`, `"${file.basename}" has no content. It goes to the trash, where you can restore it.`),
      L("删除", "Delete"),
      async () => {
        await this.app.fileManager.trashFile(file);
      }
    ).open();
  }

  /* ---------- 10. 2.0 新卡片 ---------- */

  /** 列表类卡片按尺寸放几行：M 3 行、L 6 行 */
  private rowsFor(id: string): number {
    return this.sizeOf(id) === "l" ? 6 : 3;
  }

  /** 最常被链接：哪些笔记是核心（links.topLinked） */
  private renderTopLinked(grid: HTMLElement, s: VaultStats) {
    const { body } = this.card(
      grid,
      "vp-toplinked-card",
      L("最常被链接", "Most linked"),
      "network",
      L("被其它笔记链接次数最多的笔记，通常就是你的索引页和核心笔记。点击打开。", "Notes linked from other notes the most, usually your index pages and core notes. Click to open.")
    );
    const items: BarItem[] = s.links.topLinked.slice(0, this.rowsFor("topLinked")).map(({ file, count: n }) => ({
      label: file.basename,
      title: file.path,
      value: n,
      valueText: L(`${fmtFull(n)} 处链接`, `${fmtFull(n)} ${plural(n, "link")}`),
      onClick: (e) => void this.plugin.openFile(file, undefined, e),
    }));
    drawBarList(body, items, L("还没有笔记被链接过", "No note is linked yet"), (el) => setIcon(el.createDiv({ cls: "vp-empty-icon" }), "network"));
  }

  /** 写作节奏：近 12 周每个星期几平均写多少字；单一系列，只突出最常写的一天 */
  private renderRhythm(grid: HTMLElement, s: VaultStats) {
    const size = this.sizeOf("rhythm");
    const r = weekdayRhythm(s, new Date(s.generatedAt), 12);
    const { body } = this.card(
      grid,
      "vp-rhythm-card",
      L("写作节奏", "Writing rhythm"),
      "bar-chart-3",
      L("近 12 周里，每个星期几平均写了多少字（只算开始记录之后的日子）。最常写的一天用实色标出。", "Average words written on each weekday over the last 12 weeks (only days since recording started). The busiest day is solid.")
    );
    const max = Math.max(...r.map((x) => x.average), 0);
    if (max === 0) {
      this.empty(body, "bar-chart-3", L("还没有写作记录", "No writing recorded yet"));
      return;
    }
    const best = r.reduce((a, b) => (b.average > a.average ? b : a));
    const top = body.createDiv({ cls: "vp-kpi-row" });
    bigNumber(top.createDiv({ cls: "vp-kpi-num" }), weekdayName(best.day), undefined);
    top.createSpan({ cls: "vp-kpi-caption", text: L(`平均 ${fmtFull(best.average)} 字`, `${fmtFull(best.average)} words avg`) });
    const bars = body.createDiv({ cls: "vp-rhythm" + (size === "s" ? " is-mini" : ""), attr: { role: "img" } });
    srLabel(bars, r.map((x) => `${weekdayName(x.day)} ${fmtFull(x.average)}`).join(L("，", ", ")));
    for (const x of r) {
      const c = bars.createDiv({ cls: "vp-rhythm-col" + (x === best ? " is-best" : ""), attr: { title: `${weekdayName(x.day)} · ${count(fmtFull(x.average), "words")}` } });
      c.createDiv({ cls: "vp-rhythm-bar" }).setCssProps({ "--vp-rhythm-h": `${Math.max(4, (x.average / max) * 100)}%` });
      if (size !== "s") c.createDiv({ cls: "vp-rhythm-label", text: weekdayShort(x.day) });
    }
  }

  /** 笔记活跃度：近 30 天新建和修改，两个数字 + 一条分段条（两段的环读不准，不用） */
  private renderActivity(grid: HTMLElement, s: VaultStats) {
    const a = noteActivity(s, new Date(s.generatedAt));
    const { body } = this.card(
      grid,
      "vp-activity-card",
      L("笔记活跃度", "Note activity"),
      "activity",
      L("近 30 天新建了多少篇、改了多少篇以前的笔记（新建的不重复算修改，不含采集文件夹）。看你是在写新的，还是在改旧的。", "Notes created and older notes edited in the last 30 days (new notes aren't counted again as edits; clipping folders left out): writing new or reworking old.")
    );
    const pair = body.createDiv({ cls: "vp-pair" });
    const one = (cls: string, label: string, n: number, key: string) => {
      const x = pair.createDiv({ cls: `vp-pair-item ${cls}` });
      x.createDiv({ cls: "vp-label", text: label });
      this.tweenNum(key, bigNumber(x, n, unit("notes", n), "vp-num vp-num-sm"), n, unit("notes", n));
    };
    one("is-a", L("新建", "New"), a.created, "act:new");
    one("is-b", L("改旧的", "Edited"), a.edited, "act:edit");
    const total = a.created + a.edited;
    const bar = body.createDiv({ cls: "vp-split", attr: { role: "img" } });
    srLabel(bar, L(`新建 ${a.created} 篇，修改 ${a.edited} 篇`, `${a.created} new, ${a.edited} edited`));
    if (total === 0) bar.addClass("is-empty");
    bar.createDiv({ cls: "vp-split-a" }).setCssProps({ "--vp-split-w": `${total ? (a.created / total) * 100 : 0}%` });
    bar.createDiv({ cls: "vp-split-b" }).setCssProps({ "--vp-split-w": `${total ? (a.edited / total) * 100 : 0}%` });
    body.createDiv({ cls: "vp-kpi-caption", text: L("近 30 天", "Last 30 days") });
  }

  /** 任务最多的笔记：任务压在哪几篇（tasks.byNote，按待办数排） */
  private renderTaskNotes(grid: HTMLElement, s: VaultStats) {
    const { body } = this.card(
      grid,
      "vp-tasknotes-card",
      L("任务最多的笔记", "Notes with most tasks"),
      "list-checks",
      L("待办最多的几篇笔记，条是这篇里已完成的比例。“接下来”按截止日期，这张按笔记。点击打开。", "Notes with the most open tasks; the bar shows how much of each is done. Next up sorts by due date, this card by note. Click to open.")
    );
    const groups = s.tasks.byNote.filter((g) => g.pending > 0).slice(0, this.rowsFor("taskNotes"));
    const list = body.createDiv({ cls: "vp-rows" });
    if (groups.length === 0) {
      this.empty(list, "party-popper", L("没有待办", "No open tasks"));
      return;
    }
    for (const g of groups) {
      const row = list.createDiv({ cls: "vp-row vp-group-row" });
      row.createSpan({ cls: "vp-row-name", text: g.key, attr: { title: g.file?.path ?? g.key } });
      const m = row.createDiv({ cls: "vp-meter is-inline" });
      m.createDiv({ cls: "vp-meter-fill" }).setCssProps({ "--vp-meter-width": `${(g.done / Math.max(1, g.total)) * 100}%` });
      row.createSpan({ cls: "vp-row-meta vp-tabular is-fit", text: L(`待办 ${g.pending}`, `${g.pending} open`) });
      const f = g.file;
      if (f) this.clickable(row, L(`${g.key}，待办 ${g.pending}`, `${g.key}, ${g.pending} open`), (e) => void this.plugin.openFile(f, undefined, e));
    }
  }

  /** 链接密度：一个数字的卡片（一个数就是图，不画仪表盘） */
  private renderDensity(grid: HTMLElement, s: VaultStats) {
    const d = linkDensity(s);
    const { body } = this.card(
      grid,
      "vp-density-card",
      L("链接密度", "Link density"),
      "link",
      L("平均每篇笔记有几个链接，以及有多少笔记和别的笔记连着（孤立笔记的反面）。", "Average links per note, and how many notes are connected to another note (the opposite of orphans).")
    );
    const row = body.createDiv({ cls: "vp-kpi-row" });
    // 一位小数：用字符串传，bigNumber 收到数字会取整；也不做数字滚动（滚动按整数走）
    bigNumber(row.createDiv({ cls: "vp-kpi-num" }), d.perNote.toFixed(1), L("个/篇", "per note"));
    body.createDiv({ cls: "vp-kpi-caption", text: L(`${d.connected}% 的笔记连着别的笔记`, `${d.connected}% of notes are linked`) });
  }

  /** 文件夹构成：堆叠横条，前 4 个文件夹各一色，其余并成“其他”；必须带图例 */
  private renderFolders(grid: HTMLElement, s: VaultStats) {
    const size = this.sizeOf("folders");
    const parts = folderShares(s, 4);
    const { body } = this.card(
      grid,
      "vp-folders-card",
      L("文件夹构成", "Folder mix"),
      "folder-tree",
      L("按笔记数看内容都在哪些顶层文件夹。前 4 个各一种颜色，其余合成“其他”。", "Where your notes live, by top-level folder and note count. The top 4 get a color each, the rest is Other.")
    );
    if (parts.length === 0) {
      this.empty(body, "folder", L("仓库里还没有文件夹", "No folders in the vault yet"));
      return;
    }
    const name = (p: (typeof parts)[number]) => (p.other ? L("其他", "Other") : folderName(p.folder));
    const bar = body.createDiv({ cls: "vp-stack", attr: { role: "img" } });
    srLabel(bar, parts.map((p) => `${name(p)} ${Math.round(p.share * 100)}%`).join(L("，", ", ")));
    parts.forEach((p, i) => {
      const seg = bar.createDiv({ cls: `vp-stack-seg ${p.other ? "is-other" : `is-c${i + 1}`}`, attr: { title: `${name(p)} · ${count(p.notes, "notes")}` } });
      seg.setCssProps({ "--vp-stack-w": `${p.share * 100}%` });
    });
    const legend = body.createDiv({ cls: "vp-legend" + (size === "l" ? " is-list" : "") });
    parts.forEach((p, i) => {
      const it = legend.createDiv({ cls: "vp-legend-item" });
      it.createSpan({ cls: `vp-swatch ${p.other ? "is-other" : `is-c${i + 1}`}`, attr: { "aria-hidden": "true" } });
      it.createSpan({ cls: "vp-legend-name", text: name(p) });
      it.createSpan({ cls: "vp-legend-val", text: `${Math.round(p.share * 100)}%${size === "l" ? ` · ${count(fmtFull(p.notes), "notes")}` : ""}` });
      if (!p.other && p.folder !== ROOT_FOLDER) this.clickable(it, L(`在文件列表里定位 ${p.folder}`, `Reveal ${p.folder} in the file list`), () => this.plugin.revealFolder(p.folder));
    });
  }

  /* ---------- 9. 写作回顾 ---------- */

  private renderReports(grid: HTMLElement) {
    if (!this.stats) return;
    const { head, body } = this.card(grid, "vp-report-card", L("写作回顾", "Writing review"), "notebook-pen");
    const aside = head.createDiv({ cls: "vp-card-aside vp-report-head-actions" });
    aside.createSpan({ cls: "vp-report-hint", text: L("先预览，再保存为笔记", "Preview, then save as a note") });
    const toggle = aside.createEl("button", { cls: "vp-report-toggle", attr: { type: "button" } });
    const chevron = toggle.createSpan({ cls: "vp-report-chevron", attr: { "aria-hidden": "true" } });
    const label = toggle.createSpan();
    const detailPanels: HTMLElement[] = [];
    const rows = body.createDiv({ cls: "vp-report-rows" });
    const settings = this.plugin.settings;
    const shortDate = (date: Date) => monthDay(date);
    for (const kind of ["week", "month"] as const) {
      const weekly = kind === "week";
      const title = weekly ? L("周报", "Weekly report") : L("月报", "Monthly report");
      const { period, current: summary, metrics } = writingReportOverview(this.stats, settings, kind);
      const [total, checkins] = metrics;
      const row = rows.createDiv({ cls: `vp-report-row is-${kind}` });
      const bar = row.createDiv({ cls: "vp-report-bar" });
      const heading = bar.createDiv({ cls: "vp-report-heading" });
      setIcon(heading.createSpan({ cls: "vp-report-icon", attr: { "aria-hidden": "true" } }), weekly ? "calendar-days" : "calendar-range");
      heading.createSpan({ cls: "vp-report-title", text: title });
      heading.createSpan({ cls: "vp-report-range", text: `${shortDate(period.start)}–${shortDate(addDays(period.end, -1))}` });
      const actions = bar.createDiv({ cls: "vp-report-row-actions" });
      const id = `vp-report-details-${++reportDetailsId}`;
      const generate = actions.createEl("button", { cls: "vp-btn is-compact is-primary vp-report-generate", text: L("生成", "Create"), attr: {
        type: "button", "aria-label": L(`生成${title}`, `Create ${title.toLowerCase()}`),
      } });
      generate.addEventListener("click", () => void this.plugin.openWritingReport(kind));
      const data = row.createDiv({ cls: "vp-report-summary" });
      const totalBlock = data.createDiv({ cls: "vp-report-total" });
      totalBlock.createDiv({ cls: "vp-report-metric-label", text: total.label });
      const totalValue = totalBlock.createDiv({ cls: "vp-report-metric-value" });
      const words = totalValue.createSpan({ cls: "vp-report-words" });
      words.createSpan({ cls: "vp-report-number", text: total.value });
      words.createSpan({ cls: "vp-report-unit", text: total.unit });
      totalValue.createSpan({ cls: `vp-report-change is-${total.trend}`, text: total.detail });
      const checkinBlock = data.createDiv({ cls: "vp-report-checkins" });
      checkinBlock.createDiv({ cls: "vp-report-metric-label", text: checkins.label });
      const checkinValue = checkinBlock.createDiv({ cls: "vp-report-metric-value" });
      checkinValue.createSpan({ cls: "vp-report-number", text: checkins.value });
      checkinValue.createSpan({ cls: "vp-report-unit", text: checkins.unit });
      if (weekly && settings.weeklyWordGoal > 0) {
        const goal = settings.weeklyWordGoal;
        const progress = Math.min(100, summary.words / goal * 100);
        const goalBlock = data.createDiv({ cls: "vp-report-goal" });
        goalBlock.createDiv({ cls: "vp-report-metric-label", text: L(`目标 ${Math.round(progress)}%`, `Goal ${Math.round(progress)}%`) });
        const goalValue = goalBlock.createDiv({ cls: "vp-report-metric-value" });
        const meter = goalValue.createDiv({ cls: "vp-report-meter", attr: {
          role: "progressbar", "aria-label": L("每周字数目标", "Weekly word goal"), "aria-valuemin": "0", "aria-valuemax": String(goal),
          "aria-valuenow": String(Math.min(summary.words, goal)),
          "aria-valuetext": L(`已写 ${fmtFull(summary.words)} 字，目标 ${fmtFull(goal)} 字`, `${fmtFull(summary.words)} of ${fmtFull(goal)} words`),
        } });
        meter.createDiv({ cls: "vp-report-fill" }).setCssProps({ "--vp-report-progress": `${progress}%` });
      }
      if (!weekly) {
        const days = addDays(period.end, -1).getDate();
        const elapsed = summary.elapsedDays;
        const progress = elapsed / days * 100;
        const monthBlock = data.createDiv({ cls: "vp-report-goal vp-report-month-progress" });
        monthBlock.createDiv({ cls: "vp-report-metric-label", text: L(`本月进度 ${Math.round(progress)}%`, `Month ${Math.round(progress)}%`) });
        const monthValue = monthBlock.createDiv({ cls: "vp-report-metric-value" });
        const meter = monthValue.createDiv({ cls: "vp-report-meter", attr: {
          role: "progressbar", "aria-label": L("本月进度", "Month progress"), "aria-valuemin": "0", "aria-valuemax": String(days),
          "aria-valuenow": String(elapsed), "aria-valuetext": L(`第 ${elapsed} / ${days} 天`, `Day ${elapsed} of ${days}`),
        } });
        meter.createDiv({ cls: "vp-report-fill" }).setCssProps({ "--vp-report-progress": `${progress}%` });
        monthBlock.createDiv({ cls: "vp-report-progress-detail", text: L(`第 ${elapsed} / ${days} 天`, `Day ${elapsed} of ${days}`) });
      }
      const details = row.createDiv({ cls: "vp-report-details", attr: { id } });
      detailPanels.push(details);
      for (const metric of metrics.slice(2)) {
        const stat = details.createDiv({ cls: `vp-report-stat is-${metric.id}` });
        stat.createDiv({ cls: "vp-report-stat-label", text: metric.label });
        const value = stat.createDiv({ cls: "vp-report-stat-value" });
        value.createSpan({ text: metric.value });
        if (metric.unit) value.createSpan({ cls: "vp-report-unit", text: metric.unit });
        stat.createDiv({ cls: `vp-report-stat-detail is-${metric.trend}`, text: metric.detail });
      }
    }
    toggle.setAttr("aria-controls", detailPanels.map((details) => details.id).join(" "));
    const updateExpanded = () => {
      for (const details of detailPanels) details.hidden = !settings.reportWeekExpanded;
      toggle.setAttr("aria-expanded", String(settings.reportWeekExpanded));
      label.setText(settings.reportWeekExpanded ? COLLAPSE() : L("展开", "Expand"));
      setIcon(chevron, settings.reportWeekExpanded ? "chevron-up" : "chevron-down");
    };
    updateExpanded();
    toggle.addEventListener("click", () => {
      settings.reportWeekExpanded = !settings.reportWeekExpanded;
      updateExpanded();
      void this.plugin.saveSettings();
    });
    const latest = latestWritingReport(this.app, settings.reportFolder);
    if (latest) {
      const recent = body.createDiv({ cls: "vp-report-recent" });
      setIcon(recent.createSpan({ cls: "vp-report-recent-icon", attr: { "aria-hidden": "true" } }), "history");
      recent.createSpan({ cls: "vp-report-recent-label", text: L("上次生成：", "Last created: ") });
      const link = recent.createEl("a", { cls: "vp-report-recent-link", text: latest.basename, attr: { href: latest.path } });
      link.addEventListener("click", (event) => {
        event.preventDefault();
        void this.plugin.openFile(latest, undefined, event);
      });
    }
  }
}

/** 去掉任务文本中的日期 / 优先级等标记，只保留正文 */
function cleanTaskText(t: string): string {
  return t
    .replace(/[📅⏳🛫➕✅❌]\uFE0F?\s*\d{4}-\d{2}-\d{2}/gu, "")
    .replace(/\[(?:due|scheduled|start|created|completion)::[^\]]*\]/g, "")
    .replace(/[🔺⏫🔼🔽⏬]\uFE0F?/gu, "")
    .replace(/🔁[^📅⏳🛫➕✅❌]*/gu, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function noticeError(e: unknown) {
  console.error("[note-pulse]", e);
  new Notice(L("Note Pulse：统计出错，详情见开发者控制台", "Note Pulse: counting failed. See the developer console for details."));
}


/**
 * 热力图的 3 个分档阈值（1-2、2-3、3-4 级的分界）。
 * 数据够多时按“有写作的那些天”的分位数（约 30% / 60% / 85%）来分，这样不管用户平时写多少，
 * 四个深浅都会被用到；数据太少时，退回到相对目标字数（或相对最大值）的固定比例。
 * 入参 values 必须是升序的、大于 0 的每日字数。
 */
export function heatCuts(values: number[], goal: number): [number, number, number] {
  const n = values.length;
  if (n >= 8) {
    const q = (p: number) => values[Math.min(n - 1, Math.floor(n * p))];
    return [q(0.3), q(0.6), q(0.85)];
  }
  const ref = goal > 0 ? goal : n ? values[n - 1] : 1;
  return [ref * 0.25, ref * 0.6, ref * 1.2];
}
