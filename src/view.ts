import { ItemView, Notice, Platform, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type NotePulsePlugin from "./main";
import { drawAddPreview } from "./add-preview";
import { ConfirmModal } from "./dedupe/modals";
import { writingReportOverview } from "./report-logic";
import { latestWritingReport } from "./report-storage";
import { overview as dedupeOverview, pairWording, significantPairs } from "./dedupe/core/summary";
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
  weekDays,
  weekStart,
  weeklyCheckins,
  weeklyNotes,
  weeklyWords,
} from "./dashboard-logic";
import { GroupStat, Hint, TaskInfo, VaultStats, addDays, dayKey, isCheckinDay, pad2, startOfDay } from "./stats";
import { Agenda, MAX_ITEM_CHARS, addAgendaItem, itemsOn, monthGrid, removeAgendaItem, shiftMonth, toggleAgendaItem } from "./agenda";
import { ChartStyles, LENGTH_STYLES, LengthStyle, MIX_STYLES, MixStyle, RHYTHM_STYLES, RhythmStyle, TAG_STYLES, TREND_STYLES, TagStyle, TrendStyle } from "./chart-styles";
import type { WeekStyle } from "./settings";
import { HUB_METRICS, HubMetric, goalRings, hubSeries, lengthBuckets, monthCompare, recentNotes, relativeTime } from "./hub-logic";
import { DayContext, achievementText, achievements, alertText, computeAlerts, greetingTitle, pruneCelebrated } from "./moments";
import { COLS, GAP, GridItem, ROW_H, rowsToPx } from "./grid";
import { GestureHost, GridGesture, setPlace } from "./grid-edit";
import { Box, HUB_CHROME, HeroDensity, KpiDensity, activityDensity, goalRingSize, overviewDensity, calendarDensity, innerW, bodyH, densityDensity, densityKey, foldersDensity, heatDensity, heroDensity, isTight, kpiDensity, rhythmDensity, trendDensity } from "./density";
import { WidgetId, WidgetLayout, WidgetLayoutItem, addWidget, defaultLayout, hiddenWidgets, limitsOf, readingOrder, removeWidget, sameLayout, withItems } from "./widgets";
import { MOTION, SegRect, animateHeight, countUp, drawLines, markStagger, playLayout, reducedMotion, segRect, slideSeg, snapshotRects } from "./motion";
import {
  BarItem,
  SeriesPoint,
  Tooltip,
  bigNumber,
  drawBarList,
  drawRing,
  drawSparkline,
  drawTrendChart,
  drawWeekLine,
  drawDonut,
  fmtFull,
  fmtNum,
  splitNum,
  srLabel,
  svgEl,
} from "./charts";
import { baseName } from "./checkup-logic";
import { L, UnitKind, count, weekdayLetter, yearMonth, fullDate, monthDay, monthShort, plural, unit, weekdayName, weekdayShort } from "./i18n";

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
  brokenLinks: [() => L("断链", "Broken links"), () => L("指向不存在笔记的链接，能唯一确定的可以一键修复", "Links to notes that don't exist; one click fixes the unambiguous ones")],
  orphans: [() => L("孤立笔记", "Orphans"), () => L("没有任何链接进出的笔记", "Notes with no links in or out")],
  sameName: [() => L("同名笔记", "Same name"), () => L("名字相同的笔记，链接时容易指错", "Notes sharing a name, which makes links ambiguous")],
  emptyBig: [() => L("空笔记与超大笔记", "Empty and oversized"), () => L("没有内容的笔记，和字数异常多的笔记", "Notes with no content, and unusually long ones")],
  unusedFiles: [() => L("未引用的附件", "Unused attachments"), () => L("没有任何笔记链接或嵌入的附件", "Attachments no note links to or embeds")],
  dupes: [() => L("重复内容", "Duplicates"), () => L("不同笔记里重复出现的段落", "Passages repeated across notes")],
  reports: [() => L("写作回顾", "Writing review"), () => L("周报和月报", "Weekly and monthly reports")],
  topLinked: [() => L("最常被链接", "Most linked"), () => L("哪些笔记是你的核心", "Which notes are your hubs")],
  rhythm: [() => L("写作节奏", "Writing rhythm"), () => L("一般星期几写", "Which weekdays you write")],
  activity: [() => L("笔记活跃度", "Note activity"), () => L("写新的还是改旧的", "New notes or reworking old ones")],
  taskNotes: [() => L("任务最多的笔记", "Notes with most tasks"), () => L("任务压在哪几篇", "Where tasks pile up")],
  density: [() => L("链接密度", "Link density"), () => L("库连得紧不紧", "How connected the vault is")],
  folders: [() => L("文件夹构成", "Folder mix"), () => L("内容都在哪些文件夹", "Where your notes live")],
  calendar: [() => L("日历", "Calendar"), () => L("月历和每天的日程，可以自己记", "A month view with a daily agenda you can write in")],
  trendHub: [() => L("写作趋势", "Writing trends"), () => L("一张卡里切指标（字数、新建、累计、打卡）、范围和图的样子（柱状、折线、曲线、面积）", "Switch metric, period and chart style (bar, line, curve, area) in one card")],
  overview: [() => L("数据概览", "Overview"), () => L("笔记、总字数、任务完成率、本月写作四个数合在一张卡里", "Notes, words, tasks done and this month in one card")],
  checkupHub: [() => L("库体检", "Vault checkup"), () => L("断链、孤立笔记、同名笔记、空笔记与超大笔记、未引用的附件、重复内容，一张卡里切换", "Broken links, orphans, same name, empty/oversized, unused attachments and duplicates in one card")],
  structure: [() => L("笔记结构", "Vault structure"), () => L("标签、文件夹、文件夹构成、最常被链接、链接密度，一张卡里切换", "Tags, folders, folder mix, most linked and link density in one card")],
  habits: [() => L("写作习惯", "Writing habits"), () => L("写作节奏和笔记活跃度，一张卡里切换", "Writing rhythm and note activity in one card")],
  tasksHub: [() => L("任务", "Tasks"), () => L("到期、按文件夹、按笔记，一张卡里切换", "By due date, folder or note in one card")],
  recent: [() => L("最近编辑", "Recently edited"), () => L("最近改动过的笔记", "The notes you edited most recently")],
  goals: [() => L("目标进度", "Goals"), () => L("今天、本周、本月的目标进度环", "Progress rings for today, this week and this month")],
  monthCompare: [() => L("本月对比上月", "This month vs last"), () => L("字数、新建笔记、打卡天数和上月同期对比", "Words, new notes and streak days against last month")],
  lengths: [() => L("笔记长度分布", "Note length"), () => L("你的笔记大多是几百字还是几千字", "Whether your notes run to hundreds or thousands of words")],
};
const trendStyleName = (v: TrendStyle) => ({ bar: L("柱状", "Bar"), line: L("折线", "Line"), curve: L("曲线", "Curve"), area: L("面积", "Area") })[v];
const widgetName = (id: WidgetId) => WIDGET_TEXT[id][0]();
const widgetDesc = (id: WidgetId) => WIDGET_TEXT[id][1]();

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
  private greetingEl: HTMLElement | null = null;
  /** 页首问候最近一次是按几点画的：过了整点要换成新的问候 */
  private greetHour = -1;
  private statusEl!: HTMLElement;
  private refreshBtn!: HTMLElement;
  private stats: VaultStats | null = null;
  private renderedDay = "";
  private parts = new Map<string, HTMLElement>();
  private renderers = new Map<string, (host: HTMLElement) => void>();
  private partObservers = new Map<string, ResizeObserver[]>();
  /** 每张卡里按大小重画图表的函数（拖角调大小时按固定间隔手动调用） */
  private redrawers = new Map<string, (() => void)[]>();
  /** 正在拖角调大小的那张卡：它的图表不要跟着每一帧重画 */
  private freezeKey: string | null = null;
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
  /** 每张卡上次画的时候“显示什么”（见 density.ts），变了才重画 */
  private densityKeys = new Map<string, string>();
  private lastWidth = 0;

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
    this.greetingEl = header.createDiv({ cls: "vp-greeting" });
    const actions = header.createDiv({ cls: "vp-header-actions" });
    this.statusEl = actions.createSpan({ cls: "vp-status" });
    // 手机上只看不改：电脑上的布局会自动同步过来
    if (!Platform.isMobile) this.editBtn = this.iconButton(actions, "pencil", L("编辑看板", "Edit dashboard"), () => this.toggleEditing());
    if (!Platform.isMobile) this.fullscreenBtn = this.iconButton(actions, "maximize", L("全屏", "Full screen"), () => this.toggleFullscreen());
    this.refreshBtn = this.iconButton(actions, "refresh-cw", L("刷新数据", "Refresh data"), () => void this.plugin.requestRefresh(true));
    this.iconButton(actions, "settings", L("看板设置", "Dashboard settings"), () => this.plugin.openSettings());

    this.bodyEl = shell.createDiv({ cls: "vp-body vp-held-height" });
    // 跨过午夜后，“今天”变了，需要重新统计
    this.registerInterval(
      window.setInterval(() => {
        if (this.renderedDay && this.renderedDay !== dayKey(Date.now()) && this.isVisible()) void this.plugin.requestRefresh(false);
        else if (this.stats && this.greetHour >= 0 && new Date().getHours() !== this.greetHour && this.isVisible()) this.renderGreeting(this.stats, this.computeCheckin(this.stats));
      }, 60000)
    );

    // 说明气泡：滚动或点击别处时收起（触屏没有悬停，靠点击问号查看）
    this.registerDomEvent(root, "scroll", () => this.hideHelp(), { capture: true });
    this.registerDomEvent(root.ownerDocument, "pointerdown", (e: Event) => {
      if (!(e.target as HTMLElement | null)?.closest?.(".vp-help")) this.hideHelp();
    });

    if (Platform.isMobile) this.installTapGuard(root);

    // 切回看板时，看有没有刚达成、还没庆祝过的目标
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf?.view === this) this.celebrateSoon();
      })
    );
    // 全屏：按钮的图标和提示跟着状态换
    this.registerDomEvent(root.ownerDocument, "fullscreenchange", () => {
      const on = root.ownerDocument.fullscreenElement === this.containerEl;
      this.containerEl.toggleClass("vp-fullscreen", on);
      if (this.fullscreenBtn) {
        setIcon(this.fullscreenBtn, on ? "minimize" : "maximize");
        this.fullscreenBtn.setAttr("aria-label", on ? L("退出全屏", "Exit full screen") : L("全屏", "Full screen"));
      }
    });

    // 编辑看板时 Cmd / Ctrl + Z 撤销
    this.registerDomEvent(root.ownerDocument, "keydown", (e: KeyboardEvent) => {
      if (!this.editing || e.key.toLowerCase() !== "z" || !(e.metaKey || e.ctrlKey) || e.shiftKey || !this.isVisible()) return;
      const t = e.target as HTMLElement | null;
      if (t && (/^(input|textarea|select)$/i.test(t.tagName) || t.isContentEditable)) return;
      e.preventDefault();
      this.undo();
    });

    // 窗口宽度变了：卡片的实际像素大小跟着变，该换内容的换内容，列表重新截一遍
    this.lastWidth = root.clientWidth;
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => {
        if (Math.abs(root.clientWidth - this.lastWidth) < 2) return;
        this.lastWidth = root.clientWidth;
        if (this.resizeFrame) return;
        this.resizeFrame = window.requestAnimationFrame(() => {
          this.resizeFrame = 0;
          this.refit();
        });
      });
      ro.observe(root);
      this.register(() => ro.disconnect());
    }

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
    // 没有可滚动的祖先（比如本地预览，整页在滚）：用文档本身
    const doc = root.ownerDocument.scrollingElement;
    return doc instanceof HTMLElement && doc.scrollHeight > doc.clientHeight + 1 ? doc : root;
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
    window.clearTimeout(this.celebrateTimer);
    if (this.resizeFrame) window.cancelAnimationFrame(this.resizeFrame);
    this.resizeFrame = 0;
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
      this.redrawers.delete(k);
    }
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
    if (this.gesture?.active) {
      this.pendingStats = stats;
      return;
    }
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
    this.celebrateSoon();
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
    this.fitters.clear();
    this.densityKeys.clear();
    this.narrow = this.contentEl.clientWidth > 0 && this.contentEl.clientWidth < 760;
    this.refreshBtn?.removeClass("is-spinning");
    const d = new Date(stats.generatedAt);
    this.renderedDay = dayKey(Date.now());
    this.statusEl.setText(L(`更新于 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`, `Updated ${pad2(d.getHours())}:${pad2(d.getMinutes())}`));
    this.statusEl.setAttr("aria-label", L(`统计耗时 ${stats.durationMs} ms`, `Counted in ${stats.durationMs} ms`));

    const body = this.bodyEl;
    body.empty();
    this.greetingEl?.empty();

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
    this.renderGreeting(stats, ck);
    this.define("alerts", body, (h) => this.renderAlerts(h, stats, ck));
    if (this.editing && !this.narrow) this.renderEditBar(body);
    const grid = body.createDiv({ cls: "vp-grid" });
    this.gridEl = grid;
    grid.toggleClass("is-editing", this.editing && !this.narrow);
    grid.toggleClass("is-narrow", this.narrow);
    // 按阅读顺序画：窄面板里卡片就是按这个顺序排成一列
    for (const item of readingOrder(this.plugin.settings.layout)) {
      const fn = this.widgetRenderer(item.id, stats, ck);
      if (fn) this.define(item.id, grid, fn);
    }
    this.gesture = null;
    if (this.editing && !this.narrow) {
      this.gesture = new GridGesture(this.gestureHost(grid));
      this.gesture.attach();
    }
    if (this.plugin.settings.layout.items.length === 0) {
      const e = body.createDiv({ cls: "vp-card vp-fullempty" });
      this.empty(
        e,
        "layout-dashboard",
        Platform.isMobile ? L("看板上没有卡片。在电脑上用右上角的铅笔添加。", "The dashboard has no cards. Add some on a computer with the pencil at the top right.") : L("看板上没有卡片。点右上角的铅笔添加。", "The dashboard has no cards. Use the pencil at the top right to add some.")
      );
    }
  }

  /** 卡片的实际大小变了（窗口缩放、拖动调大小）：内容该变的重画，列表重新截 */
  private refit(ids?: string[], inPlace = false) {
    if (!this.stats || !this.gridEl || this.contentEl.clientWidth === 0) return;
    const narrow = this.contentEl.clientWidth < 760;
    if (narrow !== this.narrow) {
      if (narrow && this.editing) this.toggleEditing();
      else this.render(this.stats);
      return;
    }
    for (const it of this.plugin.settings.layout.items) {
      if (ids && !ids.includes(it.id)) continue;
      if (densityKey(it.id, this.box(it.id)) !== this.densityKeys.get(it.id)) this.rerender(it.id, "resize", inPlace);
      else this.fitters.get(it.id)?.();
    }
  }

  /** 看板栅格（编辑模式要在上面挂类） */
  private gridEl: HTMLElement | null = null;
  private editBtn: HTMLElement | null = null;
  /** 编辑看板：页首出现编辑栏，卡片上出现移除按钮 */
  private editing = false;
  /** “添加卡片”的面板是否打开 */
  private addOpen = false;
  /** 看板容器窄于 760px（手机、平板竖屏、分屏的窄面板）：卡片排成一列，只看不改 */
  private narrow = false;
  private resizeFrame = 0;
  /** 拖动、调大小进行中的那套布局（还没保存）；平时是 null */
  private live: WidgetLayoutItem[] | null = null;
  private gesture: GridGesture | null = null;
  /** 手势进行中收到的刷新：等手势结束再画 */
  private pendingStats: VaultStats | null = null;
  /** 编辑期间最近 20 次改动，Cmd / Ctrl + Z 撤销 */
  private undoStack: WidgetLayout[] = [];
  private undoBtn: HTMLButtonElement | null = null;
  private liveEl: HTMLElement | null = null;

  private toggleEditing() {
    if (!this.editing && this.narrow) {
      new Notice(L("把面板放宽到 760px 以上再编辑", "Make this pane wider than 760 px to edit the dashboard"));
      return;
    }
    this.editing = !this.editing;
    this.addOpen = false;
    this.undoStack = [];
    this.editBtn?.toggleClass("is-active", this.editing);
    this.editBtn?.setAttr("aria-pressed", String(this.editing));
    if (this.stats) this.render(this.stats);
  }

  /** 改布局：立刻保存（随 data.json 同步），用已有统计重画 */
  private applyLayout(next: WidgetLayout, opts: { focusId?: string; reveal?: string; noUndo?: boolean } = {}) {
    if (sameLayout(next, this.plugin.settings.layout)) return;
    if (!opts.noUndo) this.pushUndo();
    this.plugin.settings.layout = next;
    void this.plugin.saveViewSetting();
    // 卡片从原来的位置滑到新位置，新加的淡入
    const before = this.motionOn() && this.gridEl ? snapshotRects(this.gridEl) : null;
    if (this.stats) this.render(this.stats);
    if (before && this.gridEl) playLayout(this.gridEl, before);
    if (opts.focusId) this.contentEl.querySelector<HTMLElement>(`[data-fid="${opts.focusId}"]`)?.focus({ preventScroll: true });
    if (opts.reveal) this.revealCard(opts.reveal);
  }

  private pushUndo() {
    this.undoStack.push(this.plugin.settings.layout);
    if (this.undoStack.length > 20) this.undoStack.shift();
    if (this.undoBtn) this.undoBtn.disabled = false;
  }

  private undo() {
    const prev = this.undoStack.pop();
    if (this.undoBtn) this.undoBtn.disabled = this.undoStack.length === 0;
    if (prev) this.applyLayout(prev, { noUndo: true });
  }

  /** 手势保存：布局已经画在页面上了，只存设置，不重画 */
  private commitLayout(next: WidgetLayout) {
    if (sameLayout(next, this.plugin.settings.layout)) return;
    this.pushUndo();
    this.plugin.settings.layout = next;
    void this.plugin.saveViewSetting();
  }

  /** 拖动、调大小期间：只改各张卡的位置和大小，不保存，不重画内容 */
  private showLive(items: GridItem[], skip?: string) {
    this.live = items as WidgetLayoutItem[];
    for (const it of items) {
      if (it.id === skip) continue;
      const el = this.parts.get(it.id);
      if (!el) continue;
      setPlace(el, it);
      el.toggleClass("is-small", it.w <= 3);
    }
  }

  private gestureHost(grid: HTMLElement): GestureHost {
    return {
      grid,
      items: () => this.plugin.settings.layout.items,
      limitsOf,
      show: (items, skip) => this.showLive(items, skip),
      commit: (items) => this.commitLayout(withItems(items)),
      resized: (id) => {
        this.refit([id], true);
        for (const redraw of this.redrawers.get(id) ?? []) redraw();
      },
      freeze: (id) => {
        this.freezeKey = id;
      },
      announce: (id, it) => {
        const name = widgetName(id as WidgetId);
        this.liveEl?.setText(L(`${name}，第 ${it.x + 1} 列第 ${it.y + 1} 行，${it.w} × ${it.h}`, `${name}, column ${it.x + 1}, row ${it.y + 1}, ${it.w} × ${it.h}`));
      },
      remove: (id) => this.applyLayout(removeWidget(this.plugin.settings.layout, id as WidgetId)),
      ended: () => {
        this.live = null;
        const s = this.pendingStats;
        this.pendingStats = null;
        if (s) this.render(s);
      },
      scroller: () => this.scroller(),
      motion: () => this.motionOn(),
    };
  }

  /** 滚到这张卡并闪一下 */
  private revealCard(id: string) {
    const el = this.parts.get(id);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: this.motionOn() ? "smooth" : "auto" });
    this.flagFor(el, "is-flash", 1400);
  }

  /** 编辑模式下每张卡片右上角的“移除”按钮 */
  private editTools(el: HTMLElement, id: WidgetId) {
    const name = widgetName(id);
    el.addClass("is-editing");
    const it = this.itemOf(id);
    el.setAttr("tabindex", "0");
    el.setAttr("role", "group");
    el.setAttr(
      "aria-label",
      L(`${name}${it ? `，${it.w} × ${it.h}` : ""}。方向键移动，Shift 加方向键调大小，Delete 移除`, `${name}${it ? `, ${it.w} × ${it.h}` : ""}. Arrow keys move, Shift + arrow keys resize, Delete removes`)
    );
    el.createDiv({ cls: "vp-w-handle", attr: { "aria-hidden": "true", "data-fid": `edit:${id}:size` } });
    const x = el.createEl("button", { cls: "vp-w-remove", attr: { type: "button", "aria-label": L(`从看板上移除 ${name}`, `Remove ${name} from the dashboard`), "data-fid": `edit:${id}:hide` } });
    setIcon(x, "x");
    x.addEventListener("click", () => this.applyLayout(removeWidget(this.plugin.settings.layout, id)));
  }

  /** 编辑栏：恢复默认布局、添加卡片、完成；添加面板打开时列在编辑栏下面 */
  private renderEditBar(parent: HTMLElement) {
    const bar = parent.createDiv({ cls: "vp-editbar", attr: { role: "toolbar", "aria-label": L("编辑看板", "Edit dashboard") } });
    bar.createDiv({ cls: "vp-editbar-hint", text: L("拖动卡片换位置，拖右下角调大小", "Drag a card to move it, drag its corner to resize") });
    this.liveEl = bar.createDiv({ cls: "vp-sr-only", attr: { "aria-live": "polite", role: "status" } });
    const acts = bar.createDiv({ cls: "vp-editbar-actions" });
    const btn = (icon: string, text: string, fn: () => void, primary = false) => {
      const b = acts.createEl("button", { cls: "vp-btn is-compact" + (primary ? " is-primary" : ""), attr: { type: "button" } });
      if (icon) setIcon(b.createSpan({ cls: "vp-btn-icon", attr: { "aria-hidden": "true" } }), icon);
      b.createSpan({ text });
      b.addEventListener("click", fn);
      return b;
    };
    this.undoBtn = btn("undo-2", L("撤销", "Undo"), () => this.undo());
    this.undoBtn.disabled = this.undoStack.length === 0;
    this.undoBtn.setAttr("title", L("撤销（Cmd / Ctrl + Z）", "Undo (Cmd / Ctrl + Z)"));
    btn("rotate-ccw", L("恢复默认布局", "Restore default"), () => this.applyLayout(defaultLayout()));
    const add = btn("plus", L("添加卡片", "Add a card"), () => {
      this.addOpen = !this.addOpen;
      if (this.stats) this.render(this.stats);
    });
    add.setAttr("aria-expanded", String(this.addOpen));
    btn("check", L("完成", "Done"), () => this.toggleEditing(), true);
    if (this.addOpen) this.renderAddPanel(parent);
  }

  /** 添加面板：列出被移除的卡片，点一下加到最后一行第一个放得下的位置 */
  private renderAddPanel(parent: HTMLElement) {
    const panel = parent.createDiv({ cls: "vp-card vp-add-panel" });
    const hidden = hiddenWidgets(this.plugin.settings.layout);
    if (hidden.length === 0) {
      panel.createDiv({ cls: "vp-kpi-caption", text: L("所有卡片都在看板上了。点卡片右上角的 × 可以移除。", "Every card is on the dashboard. Use × on a card to remove it.") });
      return;
    }
    const list = panel.createDiv({ cls: "vp-add-list" });
    for (const w of hidden) {
      const b = list.createEl("button", { cls: "vp-add-item", attr: { type: "button", "data-fid": `add:${w.id}` } });
      drawAddPreview(b.createDiv({ cls: "vp-add-preview" }), w.id);
      b.createDiv({ cls: "vp-add-name", text: widgetName(w.id) });
      b.createDiv({ cls: "vp-add-desc", text: `${widgetDesc(w.id)} · ${w.w} × ${w.h}` });
      b.addEventListener("click", () => this.applyLayout(addWidget(this.plugin.settings.layout, w.id), { reveal: w.id }));
    }
  }

  /** 每张卡片的渲染函数；位置和大小由 mount 挂到卡片根元素上（--vp-x / --vp-y / --vp-w / --vp-h） */
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
      case "brokenLinks":
        return (h) => this.renderBrokenLinks(h, stats);
      case "orphans":
        return (h) => this.renderOrphans(h, stats);
      case "sameName":
        return (h) => this.renderSameName(h, stats);
      case "emptyBig":
        return (h) => this.renderEmptyBig(h, stats);
      case "unusedFiles":
        return (h) => this.renderUnused(h, stats);
      case "dupes":
        return (h) => this.renderDupes(h);
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
      case "calendar":
        return (h) => this.renderCalendar(h, stats);
      case "trendHub":
        return (h) => this.renderTrendHub(h, stats);
      case "overview":
        return (h) => this.renderOverview(h, stats);
      case "checkupHub":
        return (h) => this.renderCheckupHub(h, stats);
      case "structure":
        return (h) => this.renderStructure(h, stats);
      case "habits":
        return (h) => this.renderHabits(h, stats);
      case "tasksHub":
        return (h) => this.renderTasksHub(h, stats);
      case "recent":
        return (h) => this.renderRecent(h, stats);
      case "goals":
        return (h) => this.renderGoals(h, stats);
      case "monthCompare":
        return (h) => this.renderMonthCompare(h, stats);
      case "lengths":
        return (h) => this.renderLengths(h, stats);
      default:
        return null;
    }
  }

  /** 这张卡片在布局里的位置和大小 */
  private itemOf(id: string): WidgetLayoutItem | null {
    return (this.live ?? this.plugin.settings.layout.items).find((i) => i.id === id) ?? null;
  }

  /** 看板栅格现在有多宽（量不到时，比如标签页在后台，退回用面板宽度减去左右边距） */
  private gridWidth(): number {
    return this.gridEl?.clientWidth || Math.max(0, this.contentEl.clientWidth - 48) || 1200;
  }

  /**
   * 这张卡片的实际大小（像素）：列数、行数和看板宽度算出来的，不用去量 DOM。
   * 窄面板里卡片宽度是整行（或半行）、高度跟内容走，h 只是电脑上存的行数换算成像素，当作参考。
   */
  private box(id: string, chrome = 0): Box {
    const it = this.itemOf(id);
    const cols = it?.w ?? 4;
    const stored = it?.h ?? 4;
    const h = rowsToPx(stored) - chrome;
    // 扣掉了标签条（合并卡）以后，行数按剩下的高度重新算
    const rows = chrome > 0 ? Math.max(1, Math.floor((h + GAP) / (ROW_H + GAP))) : stored;
    const gw = this.gridWidth();
    if (this.narrow) {
      const half = cols <= 3;
      return { cols, rows, w: Math.round(half ? (gw - GAP) / 2 : gw), h, narrow: true };
    }
    const colW = (gw - GAP * (COLS - 1)) / COLS;
    return { cols, rows, w: Math.round(cols * colW + (cols - 1) * GAP), h, narrow: false };
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
    const item = this.itemOf(key);
    this.mountingWidget = item;
    if (item) this.densityKeys.set(key, densityKey(key, this.box(key)));
    try {
      fn(parent);
    } finally {
      this.currentPart = prev;
      this.mountingWidget = null;
    }
    const el = parent.lastElementChild as HTMLElement | null;
    if (!el) return;
    this.parts.set(key, el);
    if (item) {
      // cardRoot 已经加过；这里兜底（万一渲染函数没用 cardRoot）
      this.placeCard(el, item);
      if (this.editing && !this.narrow) this.editTools(el, key as WidgetId);
      // 列表按卡片现在的高度截一遍
      this.fitters.get(key)?.();
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
  private rerender(key: string, mode: "swap" | "resize" = "swap", inPlace = false) {
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
      // 拖角调大小时旧卡片不能离开文档（指针还捕获在它上面，一离开就会被释放），新内容画在它旁边
      if (inPlace) old.after(wrapper);
      else old.replaceWith(wrapper);
      this.mount(key, wrapper, fn);
      const fresh = this.parts.get(key);
      if (!fresh) {
        if (inPlace) wrapper.remove();
        else wrapper.replaceWith(old);
        return;
      }
      if (inPlace) {
        // 拖角调大小时：卡片元素本身不能换（指针还捕获在它上面），只换里面的内容
        const keep = Array.from(old.querySelectorAll(":scope > .vp-w-badge"));
        const gestureClasses = ["is-resizing-card", "is-dragging", "is-editing"].filter((c) => old.hasClass(c));
        old.className = fresh.className;
        for (const c of gestureClasses) old.addClass(c);
        old.replaceChildren(...Array.from(fresh.childNodes), ...keep);
        wrapper.remove();
        this.parts.set(key, old);
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

  /**
   * 建卡片根元素。正在挂载小组件时，立刻带上尺寸类（vp-w is-m 等）：
   * 图表在渲染时就量宽度，晚一步加类的话会先按一列宽（几十像素）画一遍。
   */
  private cardRoot(parent: HTMLElement, cls: string, attr?: Record<string, string>): HTMLElement {
    const el = parent.createDiv({ cls: `vp-card ${cls}`, attr });
    if (this.mountingWidget) {
      this.placeCard(el, this.mountingWidget);
      // 2 行高的卡片：内边距收小，标题缩成一行小字
      if (isTight(this.mountingWidget.h)) el.addClass("is-tight");
    }
    return el;
  }

  /** 位置和大小写成 CSS 变量，由 styles.css 摆到栅格里；窄面板里这些变量不起作用（卡片排成一列） */
  private placeCard(el: HTMLElement, it: WidgetLayoutItem) {
    el.addClass("vp-w");
    el.toggleClass("is-small", it.w <= 3);
    el.setAttr("data-widget", it.id);
    el.setCssProps({ "--vp-x": String(it.x), "--vp-y": String(it.y), "--vp-w": String(it.w), "--vp-h": String(it.h) });
  }

  /** mount 期间正在渲染的小组件 */
  private mountingWidget: WidgetLayoutItem | null = null;

  private card(parent: HTMLElement, cls: string, title: string, icon: string, help?: string): { el: HTMLElement; head: HTMLElement; body: HTMLElement } {
    const el = this.cardRoot(parent, cls);
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

  /**
   * 换图形样式的分段控件：只在编辑模式里出现，平时卡片上不放，免得误点；
   * 编辑时卡片里的内容本来不响应点击，这个控件例外（vp-style-seg），点它也不会开始拖动。
   */
  private styleSeg<T extends string | number>(parent: HTMLElement, options: [T, string][], current: T, onChange: (v: T) => void, label?: string): HTMLElement | null {
    if (!this.editing) return null;
    const seg = this.segmented(parent, options, current, onChange, label);
    seg.addClass("vp-style-seg");
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

  /**
   * 大小变化时重绘（图表按真实像素绘制，文字不会被缩放）。
   * watchHeight：高度也由卡片定死时（热力图、每周写作的图），高度变了也重绘；窄面板里高度跟内容走，给个固定值。
   */
  private responsive(el: HTMLElement, draw: (width: number, height: number) => void, watchHeight?: { narrowH: number }) {
    let lastW = -1;
    let lastH = -1;
    const key = this.currentPart;
    const run = () => {
      const w = Math.floor(el.clientWidth);
      const h = watchHeight ? (this.narrow ? watchHeight.narrowH : Math.floor(el.clientHeight)) : 0;
      if (w <= 0 || (watchHeight && h <= 0)) return;
      if (Math.abs(w - lastW) < 4 && Math.abs(h - lastH) < 4) return;
      lastW = w;
      lastH = h;
      draw(w, h);
    };
    run();
    const redraws = this.redrawers.get(key) || [];
    redraws.push(run);
    this.redrawers.set(key, redraws);
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => {
        if (this.freezeKey !== key) run();
      });
      ro.observe(el);
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

  /* ---------- 1. 页首：问候、本周小结、需要留意的提醒 ---------- */

  /** 今天的情况：问候语、提醒、庆祝都从这里取数 */
  private dayContext(s: VaultStats, ck: Checkin): DayContext {
    const set = this.plugin.settings;
    const now = new Date();
    const h = headline(s, set.dailyWordGoal, now);
    const today = startOfDay(now);
    const tomorrowKey = dayKey(addDays(today, 1));
    const active = ck.isActive(ck.todayKey);
    return {
      now,
      todayKey: ck.todayKey,
      todayWords: ck.todayWords,
      goal: set.dailyWordGoal,
      todayDone: active,
      streak: ck.current,
      // 今天已打卡：连续段从今天往回数 current 天；今天还没打卡：从昨天往回数
      streakStart: ck.current > 0 ? dayKey(addDays(today, -(ck.current - (active ? 1 : 0)))) : null,
      weekWords: h.weekWords,
      weeklyGoal: set.weeklyWordGoal,
      weekStartKey: dayKey(weekStart(now)),
      changePct: h.changePct,
      overdue: s.tasks.overdue.length,
      dueToday: s.tasks.dueSoon.filter((t) => t.due === ck.todayKey).length,
      dueTomorrow: s.tasks.dueSoon.filter((t) => t.due === tomorrowKey).length,
    };
  }

  /** 页首左边：一句问候加今天的状态，下面一行本周小结。和右边的按钮在同一行 */
  private renderGreeting(s: VaultStats, ck: Checkin) {
    const el = this.greetingEl;
    if (!el) return;
    el.empty();
    const c = this.dayContext(s, ck);
    this.greetHour = c.now.getHours();
    const box = el.createDiv({ cls: "vp-headline" });
    box.createDiv({ cls: "vp-headline-lead", text: greetingTitle(c, L) });
    const sub = box.createDiv({ cls: "vp-headline-sub" });
    sub.createSpan({ text: L("本周已写 ", "This week: ") });
    sub.createSpan({ cls: "vp-grad-text", text: fmtFull(c.weekWords) });
    sub.createSpan({ text: L(" 字", ` ${unit("words", c.weekWords)}`) });
    if (c.changePct !== null && c.changePct !== 0) {
      const pct = Math.abs(c.changePct);
      sub.createSpan({ text: L(`，比上周同期${c.changePct > 0 ? "多" : "少"} ${pct}%`, `, ${pct}% ${c.changePct > 0 ? "more" : "less"} than this point last week`) });
    } else if (c.changePct === 0) sub.createSpan({ text: L("，和上周同期持平", ", the same as this point last week") });
    const bits: string[] = [];
    if (c.streak > 0) bits.push(L(`连续写作第 ${c.streak} 天`, `Day ${c.streak} of your streak`));
    const tidy = this.tidyCount(s);
    if (tidy > 0) bits.push(L(`库里有 ${fmtFull(tidy)} 项可整理`, `${fmtFull(tidy)} to tidy up in the vault`));
    if (bits.length) sub.createSpan({ text: ` · ${bits.join(" · ")}` });
  }

  /** 需要留意的事（逾期、今天或明天到期、连续打卡快断了、本周目标快到期）：醒目的色块，点一下跳到相关的卡片 */
  private renderAlerts(parent: HTMLElement, s: VaultStats, ck: Checkin) {
    const alerts = computeAlerts(this.dayContext(s, ck));
    const wrap = parent.createDiv({ cls: "vp-alerts" });
    if (alerts.length) {
      wrap.setAttr("role", "region");
      wrap.setAttr("aria-label", L("需要留意", "Needs attention"));
    }
    for (const a of alerts) {
      const icon = a.kind === "overdue" ? "alert-triangle" : a.kind === "streak" ? "flame" : a.kind === "weekly" ? "target" : "clock";
      const target = a.kind === "streak" || a.kind === "weekly" ? "hero" : "tasks";
      const b = wrap.createEl("button", { cls: `vp-alert is-${a.severity}`, attr: { type: "button", "data-fid": `alert:${a.kind}` } });
      setIcon(b.createSpan({ cls: "vp-alert-icon", attr: { "aria-hidden": "true" } }), icon);
      b.createSpan({ cls: "vp-alert-text", text: alertText(a, L) });
      setIcon(b.createSpan({ cls: "vp-alert-go", attr: { "aria-hidden": "true" } }), "chevron-right");
      b.addEventListener("click", () => {
        if (this.parts.has(target)) this.revealCard(target);
        else if (target === "tasks") this.plugin.openSearch("task-todo:\"\"");
      });
    }
  }

  /* ---------- 庆祝：达成目标后第一次回到看板，撒花 ---------- */

  private celebrateTimer = 0;

  /** 稍等一下再看有没有该庆祝的：切到看板的瞬间先让页面画好 */
  private celebrateSoon() {
    window.clearTimeout(this.celebrateTimer);
    this.celebrateTimer = window.setTimeout(() => this.maybeCelebrate(), 450);
  }

  private maybeCelebrate() {
    if (!this.stats || !this.isVisible() || this.editing || this.stats.totalNotes === 0) return;
    const set = this.plugin.settings;
    const ck = this.computeCheckin(this.stats);
    const found = achievements(this.dayContext(this.stats, ck), new Set(set.celebrated));
    if (found.length === 0) return;
    set.celebrated = pruneCelebrated([...set.celebrated, ...found.map((a) => a.key)]);
    void this.plugin.saveViewSetting();
    this.celebrate(found.map((a) => achievementText(a, L)));
  }

  /** 撒花加一条祝贺。动效关了或系统要求减弱动态效果时，只出祝贺，不撒花 */
  private celebrate(lines: string[]) {
    const host = this.containerEl;
    host.querySelector(".vp-celebrate")?.remove();
    // 带上 vp-root：设计令牌（颜色、阴影）都定义在它上面；层自己 position: fixed，盖在整个看板面板上
    const layer = host.createDiv({ cls: "vp-celebrate vp-root", attr: { role: "status" } });
    // 只盖住看得见的那部分（面板被滚出窗口的部分不算）
    const r = host.getBoundingClientRect();
    const win = host.ownerDocument.defaultView;
    const top = Math.max(0, r.top);
    const bottom = Math.min(win?.innerHeight ?? r.bottom, r.bottom);
    layer.setCssProps({ "--vp-cel-left": `${r.left}px`, "--vp-cel-top": `${top}px`, "--vp-cel-w": `${r.width}px`, "--vp-cel-h": `${Math.max(0, bottom - top)}px` });
    const toast = layer.createDiv({ cls: "vp-celebrate-toast" });
    setIcon(toast.createSpan({ cls: "vp-celebrate-icon", attr: { "aria-hidden": "true" } }), "party-popper");
    const text = toast.createDiv({ cls: "vp-celebrate-text" });
    for (const l of lines) text.createDiv({ text: l });
    if (this.motionOn()) {
      const colors = ["accent", "rose", "peach", "success", "accent-2"];
      for (let i = 0; i < 72; i++) {
        const p = layer.createSpan({ cls: `vp-confetti is-${colors[i % colors.length]}`, attr: { "aria-hidden": "true" } });
        p.setCssProps({
          "--vp-cx": `${Math.round(Math.random() * 100)}%`,
          "--vp-cdx": `${Math.round((Math.random() - 0.5) * 160)}px`,
          "--vp-cd": `${(Math.random() * 0.7).toFixed(2)}s`,
          "--vp-ct": `${(1.8 + Math.random() * 1.4).toFixed(2)}s`,
          "--vp-cr": `${Math.round(Math.random() * 720 - 360)}deg`,
          "--vp-cw": `${6 + Math.round(Math.random() * 6)}px`,
        });
      }
    }
    window.setTimeout(() => layer.remove(), 5200);
  }

  /* ---------- 全屏 ---------- */

  private fullscreenBtn: HTMLElement | null = null;

  private toggleFullscreen() {
    const el = this.containerEl;
    const doc = el.ownerDocument;
    if (doc.fullscreenElement) void doc.exitFullscreen();
    else if (el.requestFullscreen) el.requestFullscreen().catch(() => new Notice(L("这个窗口不能全屏", "Can't go full screen here")));
    else new Notice(L("这个窗口不能全屏", "Can't go full screen here"));
  }

  /* ---------- 2. 焦点：今日写作 ---------- */

  private renderHero(grid: HTMLElement, s: VaultStats, ck: Checkin) {
    const settings = this.plugin.settings;
    const goal = settings.dailyWordGoal;
    const now = new Date(s.generatedAt);
    const dn = heroDensity(this.box("hero"));
    const hero = this.cardRoot(grid, "vp-hero");
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

    const main = hero.createDiv({ cls: "vp-hero-main" + (dn.wide ? " is-wide" : "") + (dn.stacked ? " is-stacked" : "") });

    // 今日字数 / 目标 圆环
    const ratio = goal > 0 ? ck.todayWords / goal : ck.todayWords > 0 ? 1 : 0;
    const center = drawRing(main, ratio, dn.ring, dn.ring >= 140 ? 12 : dn.ring >= 120 ? 10 : 8, "vp-hero-ring" + (dn.ring < 112 ? " is-small" : dn.ring >= 140 ? " is-large" : ""));
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

    // 窄或矮的时候只有今日字数和连续打卡；宽了加本周七天，再高加今日新建、今日改动和今天写过的笔记
    if (dn.week) main.appendChild(this.renderWeek(s, goal, now, dn));

    // 今天动过的笔记（来自每天修改过的笔记列表；不估算单篇字数）
    const foot = hero.createDiv({ cls: "vp-hero-foot" + (dn.chips ? "" : " is-short") });
    const todayCreated = s.dayCreated[ck.todayKey] || 0;
    const todayFiles = s.dayModified[ck.todayKey] || [];
    const stat = (key: string, label: string, value: number, unit: string) => {
      const x = foot.createDiv({ cls: "vp-hero-stat" });
      x.createDiv({ cls: "vp-label", text: label });
      this.tweenNum(key, bigNumber(x, String(value), unit, "vp-num vp-num-sm"), value, unit);
    };
    stat("hero:created", L("今日新建", "Created"), todayCreated, unit("notes", todayCreated));
    stat("hero:modified", L("今日改动", "Edited"), todayFiles.length, unit("notes", todayFiles.length));
    if (dn.chips) {
      const recent = foot.createDiv({ cls: "vp-hero-recent" });
      recent.createDiv({ cls: "vp-label", text: L("今天写过", "Worked on today") });
      const chips = recent.createDiv({ cls: "vp-chips" });
      if (todayFiles.length === 0) chips.createSpan({ cls: "vp-chip-empty", text: L("今天还没有改动的笔记", "No notes edited today yet") });
      for (const f of [...todayFiles].sort((a, b) => b.stat.mtime - a.stat.mtime).slice(0, 3)) {
        const c = chips.createSpan({ cls: "vp-chip", text: f.basename, attr: { title: f.path } });
        this.clickable(c, L(`打开 ${f.basename}`, `Open ${f.basename}`), (e) => void this.plugin.openFile(f, undefined, e));
      }
    }
  }

  /** 本周七天：圆点或柱状，用户在卡片上切换，选择记在设置里 */
  private renderWeek(s: VaultStats, goal: number, now: Date, dn: HeroDensity): HTMLElement {
    const settings = this.plugin.settings;
    const style = settings.weekStyle;
    const days = weekDays(s, goal, now);
    const weekWords = days.reduce((a, d) => a + d.words, 0);
    // 柱子的高度：和每天写的字数成正比，每根柱子上面写着具体字数。
    // 最高的一天超过每日目标的 4 倍时，整体改成按开方显示（0 到 1 之间开方），这样某天写了几万字也不会把别的天压成一条线，虚线（每日目标）还在看得清的高度上
    const peak = Math.max(...days.map((d) => d.words), 1);
    const squash = goal > 0 && peak > goal * 4;
    const max = goal > 0 ? Math.max(goal, peak) : peak;
    const frac = (w: number) => {
      const r = Math.min(1, w / max);
      return squash ? Math.sqrt(r) : r;
    };
    const box = createDiv({ cls: `vp-week-box is-${style}` });
    // 圆点、柱子的大小随卡片变（density.ts 按卡片高度算出来的）
    box.setCssProps({ "--vp-week-dot": `${dn.dot}px`, "--vp-week-lane": `${dn.lane}px`, "--vp-week-bar": `${dn.bar}px` });
    const top = box.createDiv({ cls: "vp-week-top" });
    const sum = top.createDiv({ cls: "vp-week-sum" });
    sum.createSpan({ cls: "vp-label", text: L("本周 ", "This week ") });
    sum.createSpan({ cls: "vp-week-total", text: fmtFull(weekWords) });
    if (settings.weeklyWordGoal > 0) sum.createSpan({ cls: "vp-week-goal", text: ` / ${fmtFull(settings.weeklyWordGoal)}` });
    // 图例放进问号里，不一直摆在外面
    this.help(
      sum,
      style === "dots"
        ? L("✓ 达标；百分比是还没达标那天的进度；虚线圆是还没到的日子。", "✓ goal met; the % is progress on days below the goal; a dashed circle is a day still to come.")
        : style === "line"
          ? L(`七天的字数连成一条线，圆点上写着当天的字数；${goal > 0 ? `虚线是每日目标 ${fmtFull(goal)} 字。` : ""}${squash ? "有一天比目标高很多，所以整体按开方显示。" : ""}`, `The seven days joined by a line, with each day's words above its dot.${goal > 0 ? ` The dashed line is the daily goal of ${fmtFull(goal)}.` : ""}${squash ? " One day is far above the goal, so heights use a square-root scale." : ""}`)
        : goal > 0
          ? L(
              `柱子高度和当天写的字数成正比，上面写着具体字数；实色是达标的日子，虚线是每日目标 ${fmtFull(goal)} 字。${squash ? "有一天比目标高很多，所以整体按开方显示，免得其它天被压成一条线。" : ""}`,
              `Bar height follows the words written that day, with the number above each bar; solid bars met the goal, the dashed line is the daily goal of ${fmtFull(goal)}.${squash ? " One day is far above the goal, so heights use a square-root scale to keep the other days visible." : ""}`
            )
          : L("柱子高度和当天写的字数成正比，上面写着具体字数。", "Bar height follows the words written that day, with the number above each bar.")
    );
    this.styleSeg<WeekStyle>(
      top,
      [["dots", L("圆点", "Dots")], ["bars", L("柱状", "Bars")], ["line", L("折线", "Line")]],
      style,
      (v) => {
        settings.weekStyle = v;
        void this.plugin.saveViewSetting();
        this.rerender("hero");
      },
      L("本周显示方式", "This week display")
    );

    const row = box.createDiv({ cls: "vp-week" + (style === "line" ? " is-line" : "") });
    // 折线：上面一块画线和圆点，下面一排星期标签
    const plot = style === "line" ? row.createDiv({ cls: "vp-weekline" }) : null;
    const labels = style === "line" ? row.createDiv({ cls: "vp-weekline-labels" }) : null;
    if (plot) {
      drawWeekLine(plot, days.map((d) => (d.future ? 0 : frac(d.words))), { area: true, goal: goal > 0 ? frac(goal) : undefined, done: days.map((d) => d.done), future: days.map((d) => d.future) });
    }
    for (const [i, d] of days.entries()) {
      if (plot && labels) {
        const w = count(fmtFull(d.words), "words");
        if (!d.future) {
          const pt = plot.createDiv({
            cls: "vp-weekline-pt" + (d.done ? " is-active" : "") + (d.isToday ? " is-today" : ""),
            attr: { role: "img", "aria-label": `${weekdayName(dayIndex(d.key))} ${d.done ? L(`已打卡，${fmtFull(d.words)} 字`, `goal met, ${w}`) : d.words > 0 ? L(`${fmtFull(d.words)} 字，未达标`, `${w}, below goal`) : L("没有写", "nothing written")}` },
          });
          pt.setCssProps({ "--vp-wl-x": `${((i + 0.5) / 7) * 100}%`, "--vp-week-f": String(Math.min(1, frac(d.words))) });
          if (d.words > 0) pt.createSpan({ cls: "vp-week-val" + (d.done ? " is-done" : ""), text: fmtNum(d.words), attr: { "aria-hidden": "true" } });
        }
        labels.createDiv({ cls: "vp-week-label" + (d.isToday ? " is-today" : ""), text: d.isToday ? L("今", "Today") : d.label });
        continue;
      }
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
        // 柱子高度占 0–1（最矮留 4%）；字数写在柱子正上方，跟着柱子高低走
        lane.setCssProps({ "--vp-week-f": String(d.future ? 0 : Math.min(1, Math.max(0.04, frac(d.words)))) });
        if (!d.future && d.words > 0) lane.createSpan({ cls: "vp-week-val" + (d.done ? " is-done" : ""), text: fmtNum(d.words), attr: { "aria-hidden": "true" } });
        lane.createDiv({ cls: "vp-week-bar" });
      }
      c.createDiv({ cls: "vp-week-label", text: d.isToday ? L("今", "Today") : d.label });
    }
    if (style === "bars" && goal > 0) {
      row.addClass("has-goal");
      row.setCssProps({ "--vp-week-gf": String(frac(goal)) });
    }

    if (settings.weeklyWordGoal > 0 && dn.weekDetail) {
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
    return box;
  }

  /* ---------- 3. 数据卡 ---------- */

  /** 四张数据卡（2.0 起各自是一张卡片，可以分别换尺寸、隐藏、排序） */
  private renderKpi(grid: HTMLElement, s: VaultStats, which: "notes" | "words" | "taskRate" | "month", tile?: KpiDensity) {
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

    // tile：画在合并卡“数据概览”的一格里（不是单独的卡片），密度由概览卡按格子大小给
    const dn = tile ?? kpiDensity(this.box(which));
    const kpi = (icon: string, label: string, help: string) => {
      const c = tile ? wrap.createDiv({ cls: "vp-kpi vp-tile" + (dn.small ? " is-small" : ""), attr: { role: "group" } }) : this.cardRoot(wrap, "vp-kpi" + (dn.small ? " is-small" : ""), { role: "group" });
      srLabel(c, label);
      const top = c.createDiv({ cls: "vp-kpi-top" });
      setIcon(top.createSpan({ cls: "vp-card-icon", attr: { "aria-hidden": "true" } }), icon);
      top.createSpan({ cls: "vp-label", text: label });
      this.help(top, help);
      const row = c.createDiv({ cls: "vp-kpi-row" });
      const num = row.createDiv({ cls: "vp-kpi-num" });
      const side = row.createDiv({ cls: "vp-kpi-side" + (dn.side ? "" : " vp-hide") });
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
      if (dn.viz) drawSparkline(a.c.createDiv({ cls: "vp-kpi-viz" }), notes.map((p) => p.value), {
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
      if (dn.viz) drawSparkline(b.c.createDiv({ cls: "vp-kpi-viz" }), words.map((p) => p.value), {
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
      if (dn.viz) this.meter(c.c.createDiv({ cls: "vp-kpi-viz" }), t.total ? t.done / t.total : 0, "");
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
      if (dn.viz) drawSparkline(d.c.createDiv({ cls: "vp-kpi-viz" }), weeks.map((p) => p.value), {
        onPoint: dOn,
        label: (i) =>
          L(
            `${range(weeks[i].start, weeks[i].end)}，打卡 ${weeks[i].value} 天，写了 ${weeks[i].extra} 字`,
            `${range(weeks[i].start, weeks[i].end)}: ${count(weeks[i].value, "days")} on streak, ${count(weeks[i].extra, "words")}`
          ),
      });
    }
  }

  /** 数据概览：笔记、总字数、任务完成率、本月写作四格合在一张卡里，格数按卡片大小定 */
  private renderOverview(grid: HTMLElement, s: VaultStats) {
    const dn = overviewDensity(this.box("overview"));
    const card = this.cardRoot(grid, "vp-overview", { role: "group" });
    srLabel(card, L("数据概览", "Overview"));
    const tiles = card.createDiv({ cls: "vp-tiles" });
    tiles.setCssProps({ "--vp-ov-cols": String(dn.cols) });
    const kd: KpiDensity = { viz: dn.viz, small: dn.tileW < 120, side: dn.tileW >= 150 };
    for (const which of (["notes", "words", "taskRate", "month"] as const).slice(0, dn.shown)) this.renderKpi(tiles, s, which, kd);
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
    this.responsive(wrap, (w, h) => {
      svgHost.empty();
      const weeks = this.drawHeatmap(svgHost, s, ck, w, h, tip);
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
    }, { narrowH: 150 });

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
  private drawHeatmap(host: HTMLElement, s: VaultStats, ck: Checkin, width: number, height: number, tip: Tooltip): number {
    const goal = this.plugin.settings.dailyWordGoal;
    const today = startOfDay(Date.now());
    const left = 22,
      top = 20,
      gap = 4;
    // 格子大小由高度定（7 行放进卡片），周数由宽度定；宽屏上周数到顶时格子横向略拉宽
    const dn = heatDensity({ w: width, h: height });
    const weeks = dn.weeks;
    const cell = dn.cell;
    const step = dn.stepX;
    const cellW = step - gap;
    const gridStart = addDays(today, -((today.getDay() + 6) % 7) - (weeks - 1) * 7);
    const W = left + weeks * step - gap,
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
        const x = left + w * step;
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
        const x = left + w * step,
          y = top + r * (cell + gap);
        const rect = svgEl(
          "rect",
          {
            x,
            y,
            width: cellW,
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

  /* ---------- 写作趋势：同一份代码画“每周写作”和合并后的“写作趋势” ---------- */

  /** 合并卡“写作趋势”选的指标和范围（单独的“每周写作”卡用 this.metric / this.range） */
  private hubMetric: HubMetric = "words";
  private hubRange: TrendRange = 182;

  /** 把图表样式存进设置（随库同步），然后重画这张卡 */
  private setChartStyle<K extends keyof ChartStyles>(key: K, value: ChartStyles[K], cardId: string) {
    const set = this.plugin.settings;
    set.chartStyles = { ...set.chartStyles, [key]: value };
    void this.plugin.saveViewSetting();
    this.rerender(cardId);
  }

  /** 一个小下拉框（选项多的时候比分段控件省地方） */
  private dropdown<T extends string>(parent: HTMLElement, options: [T, string][], current: T, onChange: (v: T) => void, label: string) {
    const sel = parent.createEl("select", { cls: "dropdown vp-select", attr: { "aria-label": label, "data-fid": `${this.currentPart}:select:${label}` } });
    for (const [v, text] of options) {
      const o = sel.createEl("option", { text, value: v });
      if (v === current) o.selected = true;
    }
    sel.addEventListener("change", () => onChange(sel.value as T));
    return sel;
  }

  private renderTrend(grid: HTMLElement, s: VaultStats) {
    this.renderTrendLike(grid, s, "trend");
  }

  private renderTrendHub(grid: HTMLElement, s: VaultStats) {
    this.renderTrendLike(grid, s, "trendHub");
  }

  private renderTrendLike(grid: HTMLElement, s: VaultStats, id: "trend" | "trendHub") {
    const hub = id === "trendHub";
    const set = this.plugin.settings;
    const goal = set.dailyWordGoal;
    const metric: HubMetric = hub ? this.hubMetric : this.metric;
    const range = hub ? this.hubRange : this.range;
    const style = set.chartStyles.trend;
    const series = hubSeries(s, metric, range, goal, new Date(s.generatedAt));
    const daily = series.gran === "day";
    const per = daily ? "天" : "周";
    const isWords = metric === "words" || metric === "totalWords";
    const u = metric === "checkins" ? unit("days") : isWords ? unit("words") : unit("notes");
    const unitKind: UnitKind = metric === "checkins" ? "days" : isWords ? "words" : "notes";
    const rangeName = range === 30 ? L("30 天", "30 days") : range === 182 ? L("半年", "6 months") : L("一年", "1 year");
    const metricName: Record<HubMetric, string> = {
      words: L("每日 / 每周写作字数", "Words written"),
      notes: L("新建笔记", "New notes"),
      totalNotes: L("笔记总数", "Total notes"),
      totalWords: L("总字数", "Total words"),
      checkins: L("每周打卡天数", "Streak days per week"),
    };
    const help: Record<HubMetric, string> = {
      words: L(
        `每${per}写作的字数，与热力图同一来源（排除超大和采集笔记）。最右边一根是本${daily ? "日" : "周"}，用实色标出。`,
        `Words written per ${daily ? "day" : "week"}, from the same source as the heatmap (oversized and clipped notes left out). The rightmost bar, in solid color, is ${daily ? "today" : "this week"}.`
      ),
      notes: L(`每${per}新建的笔记数（不含采集文件夹）。`, `Notes created per ${daily ? "day" : "week"} (clipping folders left out).`),
      totalNotes: L("每周结束时一共有多少篇笔记（不含采集文件夹），按创建日期算。曲线往上走得越陡，那段时间新建得越多。", "How many notes there were at the end of each week (clipping folders left out), by created date. The steeper the line, the more notes were created."),
      totalWords: L("每周结束时累计的写作字数（按笔记创建日期、用笔记当前字数计）。", "Running total of words written at the end of each week (by created date, using each note's current length)."),
      checkins: L("每周有几天达到打卡（达到每日目标，或写了当天的日记）。", "Days per week that counted as a streak day (daily goal met, or a daily note written)."),
    };
    const title = hub
      ? L("写作趋势", "Writing trends")
      : metric === "words"
        ? L(`每${per}写作`, daily ? "Daily writing" : "Weekly writing")
        : L(`每${per}新建笔记`, daily ? "New notes per day" : "New notes per week");
    const { head, body } = this.card(grid, "vp-trend-card", title, "trending-up", hub ? L("一张卡里切换指标、时间范围和图的样子：柱状、折线、曲线、面积。", "Switch the metric, the period and the chart style (bar, line, curve, area) in one card.") + "\n" + help[metric] : help[metric]);
    const ctrls = head.createDiv({ cls: "vp-ctrls" });
    if (hub) {
      this.dropdown<HubMetric>(
        ctrls,
        HUB_METRICS.map((m) => [m, { words: L("写作字数", "Words written"), notes: L("新建笔记", "New notes"), totalNotes: L("笔记总数", "Total notes"), totalWords: L("总字数", "Total words"), checkins: L("打卡天数", "Streak days") }[m]]),
        metric,
        (v) => {
          this.hubMetric = v;
          this.rerender(id);
        },
        L("指标", "Metric")
      );
    } else {
      this.segmented<TrendMetric>(
        ctrls,
        [["words", L("字数", "Words")], ["notes", L("新建笔记", "New notes")]],
        this.metric,
        (v) => {
          this.metric = v;
          this.rerender(id);
        },
        L("指标", "Metric")
      );
    }
    this.segmented<TrendRange>(
      ctrls,
      [[30, L("30 天", "30 days")], [182, L("半年", "6 months")], [365, L("一年", "1 year")]],
      range,
      (v) => {
        if (hub) this.hubRange = v;
        else this.range = v;
        this.rerender(id);
      },
      L("时间范围", "Period")
    );
    this.styleSeg<TrendStyle>(ctrls, TREND_STYLES.map((v) => [v, trendStyleName(v)]), style, (v) => this.setChartStyle("trend", v, id), L("图的样式", "Chart style"));

    const dn = trendDensity(this.box(id));
    if (dn.summary) {
      const summary = body.createDiv({ cls: "vp-trend-summary" });
      const stat = (key: string, label: string, value: number) => {
        const x = summary.createDiv({ cls: "vp-trend-side" });
        this.tweenNum(`${id}:${metric}:${key}`, bigNumber(x, value, u, "vp-num vp-num-sm"), value, u);
        x.createDiv({ cls: "vp-label", text: label });
      };
      if (series.cumulative) {
        stat("total", L(`${rangeName}新增`, `Added, ${rangeName}`), series.total);
        stat("avg", L("每周平均新增", "Added per week"), series.average);
        if (series.best) stat("best", L("新增最多一周", "Best week"), series.best.gain);
      } else {
        stat("total", L(`${rangeName}合计`, `Total, ${rangeName}`), series.total);
        stat("avg", L(`${per}均`, daily ? "Per day" : "Per week"), series.average);
        if (series.best) stat("best", L(`最高一${per}`, daily ? "Best day" : "Best week"), series.best.gain);
      }
    }

    const fmtDay = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;
    const points: SeriesPoint[] = series.buckets.map((bk) => {
      const tipTitle = series.gran === "day" ? monthDay(bk.start) : `${fmtDay(bk.start)} – ${fmtDay(bk.end)}`;
      const rows: { label: string; value: string; dot: string }[] = [];
      if (series.cumulative) {
        rows.push({ label: L("累计", "Total"), value: count(fmtFull(bk.value), unitKind), dot: "is-accent" });
        rows.push({ label: L("当周新增", "Added"), value: `+${fmtFull(bk.gain)}`, dot: "" });
      } else {
        rows.push({ label: metricName[metric], value: count(fmtFull(bk.value), unitKind), dot: "is-accent" });
        if (series.gran === "week" && metric !== "checkins") rows.push({ label: L("打卡", "Streak days"), value: count(bk.checkins, "days"), dot: "" });
      }
      return { label: fmtDay(bk.start), value: bk.value, tipTitle, tipRows: rows };
    });
    if (points.every((p) => p.value === 0)) {
      this.empty(body.createDiv({ cls: "vp-chart-empty" }), "line-chart", L("这段时间还没有数据", "No data in this period"));
    } else {
      const chartWrap = body.createDiv({ cls: "vp-chart-wrap" });
      const tip = new Tooltip(chartWrap);
      const host = chartWrap.createDiv({ cls: "vp-chart-host" });
      host.setAttr("role", "img");
      srLabel(
        host,
        L(`${rangeName}${metricName[metric]}${trendStyleName(style)}图，${series.cumulative ? "新增" : "合计"} ${fmtFull(series.total)} ${u}`, `${trendStyleName(style)} chart of ${metricName[metric].toLowerCase()}, ${rangeName}, ${fmtFull(series.total)} ${u} ${series.cumulative ? "added" : "in total"}`),
        chartWrap
      );
      // 图的高度等于它在卡片里分到的高度（卡片拉高，图就变高）
      this.responsive(
        chartWrap,
        (w, h) => {
          host.empty();
          if (h < 60) return; // 卡片太矮，装不下图
          drawTrendChart(host, points, { width: w, height: Math.max(64, h), kind: style, tooltip: tip, highlightLast: true, zeroBased: !series.cumulative });
        },
        { narrowH: 220 }
      );
    }
    if (dn.annot && (metric === "words" || metric === "notes")) this.renderOutlierRow(body, s);
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

  /* ---------- 列表卡片：按卡片实际高度放几行 ---------- */

  /** 展开了的列表卡片（列表在卡片里滚动，卡片高度不变） */
  private expanded = new Set<string>();
  /** 每张列表卡片的“按现在的高度重新截一遍”，卡片大小变化时调用 */
  private fitters = new Map<string, () => void>();

  /**
   * 列表类卡片：所有行都画出来，再按卡片实际高度截到放得下的行数，放不下时底部出现“还有 N 个 ›”。
   * 点开后列表在卡片里滚动，卡片高度不变；再点“收起”回去。所以展开永远不会把页面拉长。
   * host 是装着这些行的容器（高度由卡片定死），units 是可以被隐藏的行（按从上到下的顺序），foot 是卡片底部的链接行。
   */
  private fitList(id: string, host: HTMLElement, foot: HTMLElement, units: HTMLElement[]) {
    host.addClass("vp-fit");
    if (this.narrow) host.setCssProps({ "--vp-fit-max": `${Math.max(120, bodyH(this.box(id)))}px` });
    const btn = foot.createEl("button", { cls: "vp-link vp-fit-more", attr: { type: "button", "data-fid": `${id}:more` } });
    const label = btn.createSpan();
    const icon = btn.createSpan({ cls: "vp-link-icon", attr: { "aria-hidden": "true" } });
    btn.hidden = true;
    const run = () => {
      const open = this.expanded.has(id);
      for (const u of units) u.removeClass("vp-hide");
      host.toggleClass("vp-scroll", open);
      btn.hidden = !open;
      if (open) {
        label.setText(COLLAPSE());
        setIcon(icon, "chevron-up");
        host.setAttr("tabindex", "0");
        host.setAttr("role", "region");
        host.setAttr("aria-label", L("展开的列表", "Expanded list"));
        foot.removeClass("vp-hide");
        return;
      }
      host.removeAttribute("tabindex");
      host.removeAttribute("role");
      host.removeAttribute("aria-label");
      if (host.scrollHeight > host.clientHeight + 1) {
        // 底部多出一行链接，列表可用的高度随之变小，要在这之后再量；文字和图标先放上，不然链接的高度量出来偏小
        label.setText(L(`还有 ${fmtFull(units.length)} 个`, `${fmtFull(units.length)} more`));
        setIcon(icon, "chevron-right");
        btn.hidden = false;
        // 用 offsetTop 而不是 getBoundingClientRect：入场动画里卡片带缩放，后者量出来会差一点
        const limit = host.clientHeight + 0.5;
        let keep = 0;
        for (const u of units) {
          if (u.offsetTop + u.offsetHeight > limit) break;
          keep++;
        }
        units.forEach((u, i) => u.toggleClass("vp-hide", i >= keep));
        const more = units.length - keep;
        label.setText(L(`还有 ${fmtFull(more)} 个`, `${fmtFull(more)} more`));
        setIcon(icon, "chevron-right");
        btn.hidden = more <= 0;
      }
      foot.toggleClass("vp-hide", Array.from(foot.children).every((c) => (c as HTMLElement).hidden));
    };
    btn.addEventListener("click", () => {
      if (this.expanded.has(id)) this.expanded.delete(id);
      else this.expanded.add(id);
      run();
    });
    this.fitters.set(id, run);
  }

  /* ---------- 6. 接下来：任务 ---------- */

  private renderTasks(grid: HTMLElement, s: VaultStats) {
    const { head, body } = this.card(
      grid,
      "vp-tasks-card",
      L("接下来", "Next up"),
      "list-todo",
      L(
        "笔记里带截止日期（📅 或 [due::]）的待办：已逾期的单独列出，下面是今天起 7 天内到期的。点任务直接跳到那一行。",
        "Open tasks in your notes with a due date (📅 or [due::]). Overdue ones are listed first, then those due in the next 7 days. Click a task to jump to its line."
      )
    );
    this.segmented<TaskTab>(head, [["due", L("到期", "Due")], ["folder", L("按文件夹", "By folder")]], this.taskTab, (v) => {
      this.taskTab = v;
      this.expanded.delete("tasks");
      this.rerender("tasks");
    });
    this.tasksPanel(body, "tasks", s, this.taskTab);
  }

  /** 任务列表的三种看法：按到期（逾期单独列）、按文件夹、按笔记。“接下来”“任务最多的笔记”和合并卡“任务”共用 */
  private tasksPanel(body: HTMLElement, id: string, s: VaultStats, tab: "due" | "folder" | "notes") {
    const t = s.tasks;
    if (t.total === 0) {
      this.empty(body, "list-checks", L("还没有任务。在笔记里写 - [ ] 就会出现在这里", "No tasks yet. Write - [ ] in a note and it shows up here."));
      return;
    }
    const todayKey = dayKey(Date.now());
    const host = body.createDiv();
    const units: HTMLElement[] = [];
    const foot = body.createDiv({ cls: "vp-card-foot" });
    if (tab === "due") {
      if (t.overdue.length) {
        const od = host.createDiv({ cls: "vp-overdue" });
        od.createDiv({ cls: "vp-overdue-title", text: L(`已逾期 ${t.overdue.length}`, `Overdue ${t.overdue.length}`) });
        const list = od.createDiv({ cls: "vp-rows" });
        for (const it of t.overdue.slice(0, 50)) units.push(this.taskRow(list, it, true));
      }
      const list = host.createDiv({ cls: "vp-rows" });
      if (t.dueSoon.length === 0 && !t.overdue.length) this.empty(list, "party-popper", L("7 天内没有到期的任务", "Nothing due in the next 7 days"));
      for (const it of t.dueSoon.slice(0, 50)) units.push(this.taskRow(list, it, false, it.due === todayKey));
      this.fitList(id, host, foot, units);
      this.moreLink(foot, L(`全部 ${fmtFull(t.pending)} 项待办`, `All ${count(fmtFull(t.pending), "tasks")}`), () => this.plugin.openSearch("task-todo:\"\""));
      return;
    }
    const list = host.createDiv({ cls: "vp-rows" });
    if (tab === "folder") {
      const groups: GroupStat[] = t.byFolder.filter((g) => g.pending > 0);
      if (groups.length === 0) {
        this.empty(list, "party-popper", L("所有任务都完成了", "All tasks are done"));
        return;
      }
      for (const g of groups.slice(0, 50)) {
        const row = list.createDiv({ cls: "vp-row vp-group-row" });
        row.createSpan({ cls: "vp-row-name", text: folderName(g.key) });
        const m = row.createDiv({ cls: "vp-meter is-inline" });
        m.createDiv({ cls: "vp-meter-fill" }).setCssProps({ "--vp-meter-width": `${(g.done / Math.max(1, g.total)) * 100}%` });
        row.createSpan({ cls: "vp-row-meta vp-tabular", text: L(`待办 ${g.pending}`, `${g.pending} open`) });
        if (g.key !== ROOT_FOLDER) this.clickable(row, L(`${g.key}，待办 ${g.pending}`, `${g.key}, ${g.pending} open`), () => this.plugin.revealFolder(g.key));
        units.push(row);
      }
    } else {
      const groups = t.byNote.filter((g) => g.pending > 0).slice(0, 30);
      if (groups.length === 0) this.empty(list, "party-popper", L("没有待办", "No open tasks"));
      for (const g of groups) {
        const row = list.createDiv({ cls: "vp-row vp-group-row" });
        row.createSpan({ cls: "vp-row-name", text: g.key, attr: { title: g.file?.path ?? g.key } });
        const m = row.createDiv({ cls: "vp-meter is-inline" });
        m.createDiv({ cls: "vp-meter-fill" }).setCssProps({ "--vp-meter-width": `${(g.done / Math.max(1, g.total)) * 100}%` });
        row.createSpan({ cls: "vp-row-meta vp-tabular is-fit", text: L(`待办 ${g.pending}`, `${g.pending} open`) });
        const f = g.file;
        if (f) this.clickable(row, L(`${g.key}，待办 ${g.pending}`, `${g.key}, ${g.pending} open`), (e) => void this.plugin.openFile(f, undefined, e));
        units.push(row);
      }
    }
    this.fitList(id, host, foot, units);
  }

  private taskRow(list: HTMLElement, it: TaskInfo, overdue: boolean, today = false): HTMLElement {
    const row = list.createDiv({ cls: "vp-row vp-task-row" + (overdue ? " is-overdue" : "") + (today ? " is-today" : "") });
    row.createSpan({ cls: "vp-task-box", attr: { "aria-hidden": "true" } });
    const due = it.due ? it.due.slice(5).replace("-", "/").replace(/^0/, "") : "";
    row.createSpan({ cls: "vp-due", text: today ? L("今天", "Today") : due });
    const text = cleanTaskText(it.text);
    row.createSpan({ cls: "vp-row-name", text: text || L("（空任务）", "(empty task)"), attr: { title: `${text}\n${it.file.path}` } });
    row.createSpan({ cls: "vp-row-meta", text: it.file.basename });
    this.clickable(row, `${text || L("空任务", "Empty task")}${L("，", ", ")}${it.file.basename}${overdue ? L("，已逾期", ", overdue") : ""}`, (e) => void this.plugin.openFile(it.file, it.line, e));
    return row;
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

  private renderTags(grid: HTMLElement, s: VaultStats) {
    const isTags = this.tagTab === "tags";
    const { head, body } = this.card(
      grid,
      "vp-tags-card",
      isTags ? L("常用标签", "Top tags") : L("文件夹", "Folders"),
      isTags ? "tag" : "folder",
      isTags
        ? L(
          "按使用的笔记数排列。“本周 +n”是本周新建的笔记里用到这个标签的篇数。点击标签在搜索里查看。可以换成标签云。",
          "Sorted by the number of notes using each tag. \"+n this week\" is how many notes created this week use it. Click a tag to search for it. You can switch to a tag cloud."
        )
        : L("按顶层文件夹统计笔记数和字数，点击可在文件列表里定位。", "Notes and words per top-level folder. Click to reveal the folder in the file list.")
    );
    const ctrls = head.createDiv({ cls: "vp-ctrls" });
    this.segmented<TagTab>(ctrls, [["tags", L("标签", "Tags")], ["folders", L("文件夹", "Folders")]], this.tagTab, (v) => {
      this.tagTab = v;
      this.expanded.delete("tags");
      this.rerender("tags");
    });
    if (isTags) this.tagStyleSwitch(ctrls, "tags");
    this.tagsPanel(body, "tags", s, this.tagTab);
  }

  private tagStyleSwitch(parent: HTMLElement, cardId: string) {
    this.styleSeg<TagStyle>(parent, TAG_STYLES.map((v) => [v, v === "bars" ? L("条形", "Bars") : L("标签云", "Cloud")]), this.plugin.settings.chartStyles.tags, (v) => this.setChartStyle("tags", v, cardId), L("标签的样子", "Tag style"));
  }

  /** 标签排行或文件夹排行（独立的“常用标签”和合并卡“结构”共用） */
  private tagsPanel(body: HTMLElement, id: string, s: VaultStats, tab: TagTab) {
    const isTags = tab === "tags";
    if (isTags && this.plugin.settings.chartStyles.tags === "cloud") {
      this.tagCloud(body, id, s);
      return;
    }
    let items: BarItem[];
    if (isTags) {
      const since = weekStart(new Date(s.generatedAt)).getTime();
      const fresh = new Map<string, number>();
      for (const f of s.files) if (f.created >= since) for (const t of f.tags) fresh.set(t, (fresh.get(t) || 0) + 1);
      items = s.tags.slice(0, 50).map(([tag, n]) => ({
        label: tag,
        value: n,
        valueText: fmtFull(n),
        note: fresh.get(tag) ? L(`本周 +${fresh.get(tag)}`, `+${fresh.get(tag)} this week`) : undefined,
        onClick: () => this.plugin.openSearch(`tag:${tag}`),
      }));
    } else {
      items = s.folders.slice(0, 50).map((f) => ({
        label: folderName(f.folder),
        value: f.notes,
        valueText: `${count(fmtFull(f.notes), "notes")} · ${fmtNum(f.words)} ${unit("words")}`,
        onClick: f.folder === ROOT_FOLDER ? undefined : () => this.plugin.revealFolder(f.folder),
      }));
    }
    this.barListCard(id, body, items, isTags ? L("还没有标签。给笔记加上 #标签，这里就会热闹起来", "No tags yet. Add #tags to your notes and they show up here.") : L("仓库里还没有文件夹", "No folders in the vault yet"), isTags ? "tag" : "folder");
  }

  /** 标签云：用得越多字越大；放不下的折成“还有 N 个” */
  private tagCloud(body: HTMLElement, id: string, s: VaultStats) {
    const tags = s.tags.slice(0, 80);
    if (tags.length === 0) {
      this.empty(body, "tag", L("还没有标签。给笔记加上 #标签，这里就会热闹起来", "No tags yet. Add #tags to your notes and they show up here."));
      return;
    }
    const hi = Math.sqrt(tags[0][1]);
    const lo = Math.sqrt(tags[tags.length - 1][1]);
    const cloud = body.createDiv({ cls: "vp-cloud", attr: { role: "list" } });
    const units: HTMLElement[] = [];
    for (const [tag, n] of tags) {
      const level = hi === lo ? 3 : Math.min(5, 1 + Math.floor(((Math.sqrt(n) - lo) / (hi - lo)) * 4.999));
      const chip = cloud.createEl("button", { cls: `vp-cloud-tag is-l${level}`, text: tag, attr: { type: "button", role: "listitem", title: L(`${n} 篇笔记`, `${count(n, "notes")}`) } });
      chip.addEventListener("click", () => this.plugin.openSearch(`tag:${tag}`));
      units.push(chip);
    }
    this.fitList(id, cloud, body.createDiv({ cls: "vp-card-foot" }), units);
  }

  /** 条形排行列表卡片：画出所有条，按卡片高度截断 */
  private barListCard(id: string, body: HTMLElement, items: BarItem[], emptyText: string, emptyIcon: string) {
    const host = body.createDiv();
    drawBarList(host, items, emptyText, (el) => setIcon(el.createDiv({ cls: "vp-empty-icon" }), emptyIcon));
    const foot = body.createDiv({ cls: "vp-card-foot" });
    this.fitList(id, host, foot, Array.from(host.querySelectorAll<HTMLElement>(".vp-barrow")));
  }

  /* ---------- 8. 库体检：6 张卡 ---------- */

  /** 库里一共有多少项可以整理（页首总结句用） */
  private tidyCount(s: VaultStats): number {
    const c = checkupModel(s);
    const dd = this.plugin.dedupe;
    const dupOn = this.plugin.settings.dedupeEnabled && this.plugin.settings.dedupeCard;
    const dup = dupOn && dd.analysis ? significantPairs(dd.analysis, dd.ignoredSet()).length : 0;
    return c.unresolvedCount + c.orphans.length + c.empty.length + c.big.length + c.sameName.length + c.unusedAttachments.length + dup;
  }

  /**
   * 体检卡的共同骨架：标题旁一个数量（有问题时用警示色），下面是列表，放不下的行折叠成“还有 N 个”。
   * 返回的 add 往列表里加一行，done 在加完之后调用。
   */
  private checkupCard(grid: HTMLElement, id: WidgetId, icon: string, help: string, total: number, warn: boolean, okText: string) {
    // 在合并卡“库体检”里：列表直接画进它的面板，不另外建卡片（列表折叠记在合并卡的名下）
    const hub = this.hubKit;
    let body: HTMLElement;
    if (hub) body = hub.body;
    else {
      const made = this.card(grid, "vp-checkup-card", widgetName(id), icon, help);
      made.head.createSpan({ cls: "vp-count" + (total && warn ? " is-warn" : ""), text: fmtFull(total) });
      body = made.body;
    }
    const fitId = hub ? hub.id : id;
    const host = body.createDiv();
    const list = host.createDiv({ cls: "vp-rows" });
    if (total === 0) list.createDiv({ cls: "vp-checkup-ok", text: okText });
    const foot = body.createDiv({ cls: "vp-card-foot" });
    const units: HTMLElement[] = [];
    const add = (name: string, label: string, onOpen: (() => void) | null, actText: string, act: () => void) => {
      const row = list.createDiv({ cls: "vp-row vp-checkup-row" });
      const n = row.createSpan({ cls: "vp-row-name", text: name, attr: { title: name } });
      if (onOpen) this.clickable(n, L(`打开 ${label}`, `Open ${label}`), () => onOpen());
      const b = row.createEl("button", { cls: "vp-act", text: actText, attr: { type: "button" } });
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        act();
      });
      units.push(row);
    };
    return { body, host, foot, add, done: () => this.fitList(fitId, host, foot, units) };
  }

  /** 合并卡“库体检”正在画的面板（普通的体检卡是 null） */
  private hubKit: { body: HTMLElement; id: string } | null = null;
  private checkupTab: "brokenLinks" | "orphans" | "sameName" | "emptyBig" | "unusedFiles" | "dupes" | null = null;

  /** 库体检合并卡：六个标签，标签上带数量（有问题的用警示色），下面是选中那一项的列表和操作 */
  private renderCheckupHub(grid: HTMLElement, s: VaultStats) {
    const id: WidgetId = "checkupHub";
    const c = checkupModel(s);
    const set = this.plugin.settings;
    const dd = this.plugin.dedupe;
    const dupOn = set.dedupeEnabled && set.dedupeCard;
    const dupN = dupOn && dd.analysis ? significantPairs(dd.analysis, dd.ignoredSet()).length : 0;
    type Tab = NonNullable<typeof this.checkupTab>;
    const counts: Record<Tab, number> = {
      brokenLinks: c.unresolvedCount,
      orphans: c.orphans.length,
      sameName: c.sameName.length,
      emptyBig: c.empty.length + c.big.length,
      unusedFiles: c.unusedAttachments.length,
      dupes: dupN,
    };
    const order: Tab[] = ["brokenLinks", "orphans", "sameName", "emptyBig", "unusedFiles", "dupes"];
    // 第一次打开：停在第一个有问题的标签上
    const tab: Tab = this.checkupTab ?? order.find((k) => counts[k] > 0) ?? "brokenLinks";
    const total = order.reduce((a, k) => a + counts[k], 0);
    const { ctrls, panel } = this.hubShell(
      grid,
      id,
      "heart-pulse",
      L(
        "随看板一起刷新。断链和孤立笔记来自 Obsidian 的链接索引；重复内容来自最近一次扫描。会改动笔记的操作都先确认，删除的笔记进回收站。",
        "Refreshes with the dashboard. Broken links and orphans come from Obsidian's link index; duplicates from the last scan. Anything that changes notes asks first, and deleted notes go to the trash."
      ),
      [
        { id: "brokenLinks" as const, label: L("断链", "Broken"), count: counts.brokenLinks, warn: true },
        { id: "orphans" as const, label: L("孤立", "Orphans"), count: counts.orphans },
        { id: "sameName" as const, label: L("同名", "Same name"), count: counts.sameName },
        { id: "emptyBig" as const, label: L("空与超大", "Empty/big"), count: counts.emptyBig },
        { id: "unusedFiles" as const, label: L("附件", "Files"), count: counts.unusedFiles },
        { id: "dupes" as const, label: L("重复", "Duplicates"), count: counts.dupes, warn: true },
      ],
      tab,
      (v) => {
        this.checkupTab = v;
        this.rerender(id);
      }
    );
    ctrls.createSpan({ cls: "vp-card-aside", text: total ? L(`共 ${fmtFull(total)} 项`, `${fmtFull(total)} to tidy`) : L("一切正常", "All good") });
    this.hubKit = { body: panel, id };
    try {
      if (tab === "brokenLinks") this.renderBrokenLinks(panel, s);
      else if (tab === "orphans") this.renderOrphans(panel, s);
      else if (tab === "sameName") this.renderSameName(panel, s);
      else if (tab === "emptyBig") this.renderEmptyBig(panel, s);
      else if (tab === "unusedFiles") this.renderUnused(panel, s);
      else this.renderDupes(panel);
    } finally {
      this.hubKit = null;
    }
  }

  /** 断链：能唯一确定指向哪篇的排在前面，一键改过去；其余照旧可以新建笔记（用 Obsidian 自己的规则） */
  private renderBrokenLinks(grid: HTMLElement, s: VaultStats) {
    const c = checkupModel(s);
    const k = this.checkupCard(
      grid,
      "brokenLinks",
      "unlink",
      L("指向不存在的笔记的链接。能唯一确定该指向哪篇时（笔记被移动过，或只差空格、大小写、分隔符），可以一键改过去，改完能撤销。", "Links to notes that don't exist. When exactly one note could be meant (it was moved, or differs only in spaces, case or separators), one click repoints the links, and you can undo it."),
      c.unresolvedCount,
      true,
      L("没有断开的链接", "No broken links")
    );
    for (const x of c.unresolved) {
      const shown = x.name.replace(/\\$/, "");
      const search = () => this.plugin.openSearch(`"[[${shown}"`);
      if (x.fix) {
        const fix = x.fix;
        const to = baseName(fix.target);
        k.add(`[[${shown}]] → ${to}`, shown, search, L("修复", "Fix"), () => this.confirmLinkFix(shown, x.name, fix.target, x.from, x.count));
      } else {
        k.add(L(`[[${shown}]] · ${x.count} 处`, `[[${shown}]] · ${x.count}×`), shown, search, L("创建笔记", "Create note"), () => {
          void this.app.workspace.openLinkText(shown, x.source ?? "", "tab");
        });
      }
    }
    k.done();
  }

  private renderOrphans(grid: HTMLElement, s: VaultStats) {
    const c = checkupModel(s);
    const k = this.checkupCard(
      grid,
      "orphans",
      "circle-dashed",
      L("没有任何链接进出的笔记，来自 Obsidian 的链接索引。采集文件夹和设置里忽略的文件夹不检查。", "Notes with no links in or out, from Obsidian's link index. Clipping folders and folders ignored in settings are not checked."),
      c.orphans.length,
      false,
      L("每篇笔记都连上了", "Every note is linked")
    );
    for (const f of c.orphans.slice(0, 50)) k.add(f.basename, f.basename, () => void this.plugin.openFile(f), L("打开", "Open"), () => void this.plugin.openFile(f));
    k.done();
  }

  private renderSameName(grid: HTMLElement, s: VaultStats) {
    const c = checkupModel(s);
    const k = this.checkupCard(
      grid,
      "sameName",
      "copy",
      L("名字相同的笔记。[[链接]] 只写名字时 Obsidian 会挑其中一篇，容易指错。", "Notes that share a name. A [[link]] with just the name makes Obsidian pick one of them, which is easy to get wrong."),
      c.sameName.length,
      false,
      L("没有同名笔记", "No notes share a name")
    );
    for (const g of c.sameName.slice(0, 50)) {
      const name = baseName(g[0]);
      const first = this.app.vault.getAbstractFileByPath(g[0]);
      k.add(L(`${name} · ${g.length} 篇`, `${name} · ${g.length}`), name, first instanceof TFile ? () => void this.plugin.openFile(first) : null, L("查看", "Show"), () => this.plugin.openSearch(`file:"${name}"`));
    }
    k.done();
  }

  private renderEmptyBig(grid: HTMLElement, s: VaultStats) {
    const c = checkupModel(s);
    const eb = c.empty.length + c.big.length;
    const k = this.checkupCard(
      grid,
      "emptyBig",
      "file-warning",
      L("没有任何内容和链接的空笔记，和字数超过上限、会让趋势失真的超大笔记。删除的笔记进回收站。", "Notes with no content or links, and oversized notes over the word limit that distort the trends. Deleted notes go to the trash."),
      eb,
      false,
      L("没有空笔记或超大笔记", "No empty or oversized notes")
    );
    for (const f of c.empty.slice(0, 50)) k.add(`${f.file.basename} · ${count(0, "words")}`, f.file.basename, () => void this.plugin.openFile(f.file), L("删除", "Delete"), () => this.trashNote(f.file));
    for (const f of c.big.slice(0, 50)) {
      const folder = f.folder === ROOT_FOLDER ? null : f.folder;
      k.add(
        `${f.file.basename} · ${fmtNum(f.words)} ${unit("words")}`,
        f.file.basename,
        () => void this.plugin.openFile(f.file),
        folder ? L("整夹不计入", "Don't count") : L("打开", "Open"),
        () => (folder ? void this.plugin.setClippingFolder(folder) : void this.plugin.openFile(f.file))
      );
    }
    k.done();
  }

  /** 未引用的附件：没有任何笔记链接或嵌入它 */
  private renderUnused(grid: HTMLElement, s: VaultStats) {
    const c = checkupModel(s);
    const k = this.checkupCard(
      grid,
      "unusedFiles",
      "paperclip",
      L("没有任何笔记链接或嵌入的附件，大的排在前面。删除前确认，进回收站。", "Attachments no note links to or embeds, largest first. Asks before deleting, and deleted files go to the trash."),
      c.unusedAttachments.length,
      false,
      L("附件都有笔记在用", "Every attachment is used")
    );
    for (const f of c.unusedAttachments.slice(0, 50)) k.add(`${f.name} · ${fmtSize(f.stat.size)}`, f.name, () => void this.plugin.openFile(f), L("删除", "Delete"), () => this.trashAttachment(f));
    k.done();
  }

  /**
   * 重复内容：列出“大面积重复”的笔记对（一篇笔记至少 70% 的内容在另一篇里也有）。
   * 零散的一两个句子、一两段话在别处出现过，不算重复内容，不在这里列；那些要逐段看，在“重复内容清理”页里。
   */
  private renderDupes(grid: HTMLElement) {
    const dd = this.plugin.dedupe;
    const set = this.plugin.settings;
    const dupOn = set.dedupeEnabled && set.dedupeCard;
    const pairs = dupOn && dd.analysis ? significantPairs(dd.analysis, dd.ignoredSet()) : [];
    const n = pairs.length;
    const k = this.checkupCard(
      grid,
      "dupes",
      "files",
      L(
        "内容大面积重复的笔记：一篇笔记至少 70% 的内容在另一篇里也有（比如同一篇文章剪藏了两次）。零散的一两句、一两段话重复不算。来自最近一次扫描，扫描只读，不会改动笔记。",
        "Notes that largely repeat each other: at least 70% of one note also appears in another (say, the same article clipped twice). A sentence or paragraph shared here and there doesn't count. From the last scan; scanning is read-only and changes nothing."
      ),
      n,
      true,
      dupOn ? (dd.scanning ? L("正在扫描…", "Scanning…") : dd.analysis ? L("没有内容大面积重复的笔记", "No notes largely repeat each other") : L("还没扫描过", "Not scanned yet")) : L("重复内容清理没有打开", "Duplicate cleanup is off")
    );
    if (!dupOn) {
      k.add(L("在设置里打开“重复内容清理”和它的看板卡片", "Turn on Duplicate cleanup and its dashboard card in settings"), "", null, L("打开设置", "Settings"), () => this.plugin.openSettings());
    } else if (!dd.analysis && !dd.scanning) {
      k.add(L("扫描只读，不会改动笔记", "Read-only, changes nothing"), "", null, L("开始扫描", "Scan"), () => void dd.openReport(true));
    }
    for (const p of pairs.slice(0, 50)) {
      const w = pairWording(p);
      const name = L(`${baseName(w.name)} 有 ${w.pct}% 和 ${baseName(w.other)} 重复`, `${w.pct}% of ${baseName(w.name)} is the same as ${baseName(w.other)}`);
      k.add(name, baseName(w.name), () => void dd.openNote(w.name), L("对比", "Compare"), () => void dd.openBoth(p.older, p.newer));
    }
    k.done();
    if (n > 0) this.moreLink(k.foot, L("查看和清理", "Review and clean up"), () => void dd.openReport(false));
    if (dupOn && dd.analysis && n === 0) {
      const scattered = dedupeOverview(dd.analysis, dd.ignoredSet()).groups.length;
      if (scattered > 0) k.body.createDiv({ cls: "vp-checkup-note is-quiet", text: L(`另有 ${fmtFull(scattered)} 处零散重复的段落，没有计入`, `${count(fmtFull(scattered), "passages")} shared here and there are not counted`) });
    }
    if (dupOn && dd.stale && dd.analysis) k.body.createDiv({ cls: "vp-checkup-note", text: L("笔记有改动，建议重新扫描", "Notes changed since the scan. Scan again.") });
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

  /* ---------- 10. 2.0 新卡片，以及合并卡共用的面板 ---------- */

  /** 合并卡的标签条占的高度：算内容密度时要扣掉 */
  /** 合并卡的标签条：每个标签可以带数量（有问题时用警示色） */
  private tabStrip<T extends string>(parent: HTMLElement, tabs: { id: T; label: string; count?: number; warn?: boolean }[], current: T, onChange: (v: T) => void, label: string): HTMLElement {
    const strip = parent.createDiv({ cls: "vp-tabs", attr: { role: "tablist", "aria-label": label } });
    for (const t of tabs) {
      const b = strip.createEl("button", {
        cls: "vp-tab" + (t.id === current ? " is-active" : ""),
        attr: { type: "button", role: "tab", "aria-selected": String(t.id === current), "data-fid": `${this.currentPart}:tab:${t.id}` },
      });
      b.createSpan({ text: t.label });
      if (t.count !== undefined) b.createSpan({ cls: "vp-count" + (t.count && t.warn ? " is-warn" : ""), text: fmtFull(t.count) });
      b.addEventListener("click", () => {
        if (t.id !== current) onChange(t.id);
      });
    }
    return strip;
  }

  /** 合并卡的外壳：卡片 + 标签条 + 装面板的容器。head 里可以再放这个标签页专属的样式切换 */
  private hubShell<T extends string>(grid: HTMLElement, id: WidgetId, icon: string, help: string, tabs: { id: T; label: string; count?: number; warn?: boolean }[], current: T, onChange: (v: T) => void) {
    const { head, body } = this.card(grid, `vp-hub-card vp-hub-${id}`, widgetName(id), icon, help);
    const ctrls = head.createDiv({ cls: "vp-ctrls" });
    this.tabStrip(body, tabs, current, (v) => {
      this.expanded.delete(id);
      onChange(v);
    }, widgetName(id));
    const panel = body.createDiv({ cls: "vp-hub-panel" });
    return { ctrls, panel };
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
    this.topLinkedPanel(body, "topLinked", s);
  }

  private topLinkedPanel(body: HTMLElement, id: string, s: VaultStats) {
    const items: BarItem[] = s.links.topLinked.slice(0, 30).map(({ file, count: n }) => ({
      label: file.basename,
      title: file.path,
      value: n,
      valueText: L(`${fmtFull(n)} 处链接`, `${fmtFull(n)} ${plural(n, "link")}`),
      onClick: (e) => void this.plugin.openFile(file, undefined, e),
    }));
    this.barListCard(id, body, items, L("还没有笔记被链接过", "No note is linked yet"), "network");
  }

  /** 写作节奏：近 12 周每个星期几平均写多少字；单一系列，只突出最常写的一天。柱状 / 折线 / 面积 */
  private renderRhythm(grid: HTMLElement, s: VaultStats) {
    const { head, body } = this.card(
      grid,
      "vp-rhythm-card",
      L("写作节奏", "Writing rhythm"),
      "bar-chart-3",
      L("近 12 周里，每个星期几平均写了多少字（只算开始记录之后的日子）。最常写的一天用实色标出。可以换成折线或面积。", "Average words written on each weekday over the last 12 weeks (only days since recording started). The busiest day is solid. You can switch to a line or area chart.")
    );
    this.rhythmStyleSwitch(head, "rhythm");
    this.rhythmPanel(body, "rhythm", s, this.box("rhythm"));
  }

  private rhythmStyleSwitch(parent: HTMLElement, cardId: string) {
    this.styleSeg<RhythmStyle>(parent, RHYTHM_STYLES.map((v) => [v, v === "bar" ? L("柱状", "Bar") : v === "line" ? L("折线", "Line") : L("面积", "Area")]), this.plugin.settings.chartStyles.rhythm, (v) => this.setChartStyle("rhythm", v, cardId), L("图的样式", "Chart style"));
  }

  private rhythmPanel(body: HTMLElement, id: string, s: VaultStats, box: Box) {
    const dn = rhythmDensity(box);
    const style = this.plugin.settings.chartStyles.rhythm;
    const r = weekdayRhythm(s, new Date(s.generatedAt), 12);
    const max = Math.max(...r.map((x) => x.average), 0);
    if (max === 0) {
      this.empty(body, "bar-chart-3", L("还没有写作记录", "No writing recorded yet"));
      return;
    }
    const best = r.reduce((a, b) => (b.average > a.average ? b : a));
    if (dn.top) {
      const top = body.createDiv({ cls: "vp-kpi-row" });
      bigNumber(top.createDiv({ cls: "vp-kpi-num" }), weekdayName(best.day), undefined);
      top.createSpan({ cls: "vp-kpi-caption", text: L(`平均 ${fmtFull(best.average)} 字`, `${fmtFull(best.average)} words avg`) });
    }
    if (style !== "bar") {
      const points: SeriesPoint[] = r.map((x) => ({
        label: weekdayShort(x.day),
        value: x.average,
        tipTitle: weekdayName(x.day),
        tipRows: [{ label: L("平均写", "Average"), value: count(fmtFull(x.average), "words"), dot: "is-accent" }],
      }));
      const chartWrap = body.createDiv({ cls: "vp-chart-wrap" });
      const tip = new Tooltip(chartWrap);
      const host = chartWrap.createDiv({ cls: "vp-chart-host" });
      host.setAttr("role", "img");
      srLabel(host, r.map((x) => `${weekdayName(x.day)} ${fmtFull(x.average)}`).join(L("，", ", ")), chartWrap);
      this.responsive(
        chartWrap,
        (w, h) => {
          host.empty();
          if (h < 60) return;
          drawTrendChart(host, points, { width: w, height: Math.max(64, h), kind: style === "line" ? "line" : "area", tooltip: tip, zeroBased: true });
        },
        { narrowH: 140 }
      );
      return;
    }
    const bars = body.createDiv({ cls: "vp-rhythm", attr: { role: "img" } });
    srLabel(bars, r.map((x) => `${weekdayName(x.day)} ${fmtFull(x.average)}`).join(L("，", ", ")));
    for (const x of r) {
      const c = bars.createDiv({ cls: "vp-rhythm-col" + (x === best ? " is-best" : ""), attr: { title: `${weekdayName(x.day)} · ${count(fmtFull(x.average), "words")}` } });
      if (dn.values) c.createDiv({ cls: "vp-rhythm-value", text: fmtNum(x.average) });
      const lane = c.createDiv({ cls: "vp-rhythm-lane" });
      lane.createDiv({ cls: "vp-rhythm-bar" }).setCssProps({ "--vp-rhythm-h": `${Math.max(4, (x.average / max) * 100)}%` });
      c.createDiv({ cls: "vp-rhythm-label", text: weekdayShort(x.day) });
    }
  }

  /** 笔记活跃度：近 30 天新建和修改，两个数字 + 一条分段条（两段的环读不准，不用） */
  private renderActivity(grid: HTMLElement, s: VaultStats) {
    const { body } = this.card(
      grid,
      "vp-activity-card",
      L("笔记活跃度", "Note activity"),
      "activity",
      L("近 30 天新建了多少篇、改了多少篇以前的笔记（新建的不重复算修改，不含采集文件夹）。看你是在写新的，还是在改旧的。", "Notes created and older notes edited in the last 30 days (new notes aren't counted again as edits; clipping folders left out): writing new or reworking old.")
    );
    this.activityPanel(body, s, this.box("activity"));
  }

  private activityPanel(body: HTMLElement, s: VaultStats, box: Box) {
    const dn = activityDensity(box);
    const a = noteActivity(s, new Date(s.generatedAt));
    const pair = body.createDiv({ cls: "vp-pair" });
    const one = (cls: string, label: string, n: number, key: string) => {
      const x = pair.createDiv({ cls: `vp-pair-item ${cls}` });
      x.createDiv({ cls: "vp-label", text: label });
      this.tweenNum(key, bigNumber(x, n, unit("notes", n), "vp-num vp-num-sm"), n, unit("notes", n));
    };
    one("is-a", L("新建", "New"), a.created, "act:new");
    one("is-b", L("改旧的", "Edited"), a.edited, "act:edit");
    if (dn.bar) {
      const total = a.created + a.edited;
      const bar = body.createDiv({ cls: "vp-split", attr: { role: "img" } });
      srLabel(bar, L(`新建 ${a.created} 篇，修改 ${a.edited} 篇`, `${a.created} new, ${a.edited} edited`));
      if (total === 0) bar.addClass("is-empty");
      bar.createDiv({ cls: "vp-split-a" }).setCssProps({ "--vp-split-w": `${total ? (a.created / total) * 100 : 0}%` });
      bar.createDiv({ cls: "vp-split-b" }).setCssProps({ "--vp-split-w": `${total ? (a.edited / total) * 100 : 0}%` });
    }
    if (dn.caption) body.createDiv({ cls: "vp-kpi-caption", text: L("近 30 天", "Last 30 days") });
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
    this.tasksPanel(body, "taskNotes", s, "notes");
  }

  /** 链接密度：一个数字的卡片（一个数就是图，不画仪表盘） */
  private renderDensity(grid: HTMLElement, s: VaultStats) {
    const { body } = this.card(
      grid,
      "vp-density-card",
      L("链接密度", "Link density"),
      "link",
      L("平均每篇笔记有几个链接，以及有多少笔记和别的笔记连着（孤立笔记的反面）。", "Average links per note, and how many notes are connected to another note (the opposite of orphans).")
    );
    this.densityPanel(body, s, this.box("density"));
  }

  private densityPanel(body: HTMLElement, s: VaultStats, box: Box) {
    const dn = densityDensity(box);
    const d = linkDensity(s);
    const row = body.createDiv({ cls: "vp-kpi-row" });
    // 一位小数：用字符串传，bigNumber 收到数字会取整；也不做数字滚动（滚动按整数走）
    bigNumber(row.createDiv({ cls: "vp-kpi-num" }), d.perNote.toFixed(1), L("个/篇", "per note"));
    if (!dn.caption) return;
    body.createDiv({ cls: "vp-kpi-caption", text: L(`${d.connected}% 的笔记连着别的笔记`, `${d.connected}% of notes are linked`) });
    if (dn.share) {
      this.meter(body, d.connected / 100, "");
      const orphans = s.links.orphans.length;
      body.createDiv({ cls: "vp-kpi-caption", text: L(`${fmtFull(orphans)} 篇孤立笔记`, `${count(fmtFull(orphans), "notes")} with no links`) });
    }
  }

  /** 文件夹构成：前 4 个文件夹各一色，其余并成“其他”；堆叠条 / 环形图 / 列表三种画法，都带名字和百分比 */
  private renderFolders(grid: HTMLElement, s: VaultStats) {
    const { head, body } = this.card(
      grid,
      "vp-folders-card",
      L("文件夹构成", "Folder mix"),
      "folder-tree",
      L("按笔记数看内容都在哪些顶层文件夹。前 4 个各一种颜色，其余合成“其他”。可以换成环形图或列表。", "Where your notes live, by top-level folder and note count. The top 4 get a color each, the rest is Other. You can switch to a donut or a list.")
    );
    this.mixStyleSwitch(head, "folders");
    this.mixPanel(body, s, this.box("folders"));
  }

  private mixStyleSwitch(parent: HTMLElement, cardId: string) {
    this.styleSeg<MixStyle>(parent, MIX_STYLES.map((v) => [v, v === "stack" ? L("堆叠条", "Stack") : v === "donut" ? L("环形图", "Donut") : L("列表", "List")]), this.plugin.settings.chartStyles.mix, (v) => this.setChartStyle("mix", v, cardId), L("图的样式", "Chart style"));
  }

  private mixPanel(body: HTMLElement, s: VaultStats, box: Box) {
    const style = this.plugin.settings.chartStyles.mix;
    const dn = foldersDensity(box);
    const parts = folderShares(s, style === "list" ? 6 : 4);
    if (parts.length === 0) {
      this.empty(body, "folder", L("仓库里还没有文件夹", "No folders in the vault yet"));
      return;
    }
    const name = (p: (typeof parts)[number]) => (p.other ? L("其他", "Other") : folderName(p.folder));
    const cat = (p: (typeof parts)[number], i: number) => (p.other ? "is-other" : `is-c${(i % 4) + 1}`);
    const reveal = (el: HTMLElement, p: (typeof parts)[number]) => {
      if (!p.other && p.folder !== ROOT_FOLDER) this.clickable(el, L(`在文件列表里定位 ${p.folder}`, `Reveal ${p.folder} in the file list`), () => this.plugin.revealFolder(p.folder));
    };
    const label = parts.map((p) => `${name(p)} ${Math.round(p.share * 100)}%`).join(L("，", ", "));
    if (style === "list") {
      const rows = body.createDiv({ cls: "vp-mixrows", attr: { role: "img", "aria-label": label } });
      parts.forEach((p, i) => {
        const row = rows.createDiv({ cls: "vp-mixrow" });
        row.createSpan({ cls: `vp-swatch ${cat(p, i)}`, attr: { "aria-hidden": "true" } });
        row.createSpan({ cls: "vp-legend-name", text: name(p), attr: { title: name(p) } });
        const track = row.createDiv({ cls: "vp-mixtrack" });
        track.createDiv({ cls: `vp-mixfill ${cat(p, i)}` }).setCssProps({ "--vp-stack-w": `${p.share * 100}%` });
        row.createSpan({ cls: "vp-legend-val", text: `${Math.round(p.share * 100)}% · ${count(fmtFull(p.notes), "notes")}` });
        reveal(row, p);
      });
      return;
    }
    if (style === "donut") {
      const size = Math.max(72, Math.min(170, Math.floor(bodyH(box) - 6), Math.floor(innerW(box) * 0.45)));
      const row = body.createDiv({ cls: "vp-donutrow" });
      const donut = drawDonut(row, parts.map((p, i) => ({ share: p.share, cls: cat(p, i), title: `${name(p)} · ${count(p.notes, "notes")}` })), size, Math.max(10, Math.round(size / 8)));
      donut.setAttr("role", "img");
      donut.setAttr("aria-label", label);
      const center = donut.querySelector<HTMLElement>(".vp-donut-center");
      if (center) {
        bigNumber(center, s.totalNotes, undefined, "vp-num vp-num-sm");
        center.createDiv({ cls: "vp-ring-caption", text: unit("notes") });
      }
      const legend = row.createDiv({ cls: "vp-legend is-list" });
      parts.forEach((p, i) => {
        const it = legend.createDiv({ cls: "vp-legend-item" });
        it.createSpan({ cls: `vp-swatch ${cat(p, i)}`, attr: { "aria-hidden": "true" } });
        it.createSpan({ cls: "vp-legend-name", text: name(p) });
        it.createSpan({ cls: "vp-legend-val", text: `${Math.round(p.share * 100)}%` });
        reveal(it, p);
      });
      return;
    }
    const bar = body.createDiv({ cls: "vp-stack", attr: { role: "img", "aria-label": label } });
    parts.forEach((p, i) => {
      const seg = bar.createDiv({ cls: `vp-stack-seg ${cat(p, i)}`, attr: { title: `${name(p)} · ${count(p.notes, "notes")}` } });
      seg.setCssProps({ "--vp-stack-w": `${p.share * 100}%` });
    });
    const legend = body.createDiv({ cls: "vp-legend" + (dn.list ? " is-list" : "") });
    parts.forEach((p, i) => {
      const it = legend.createDiv({ cls: "vp-legend-item" });
      it.createSpan({ cls: `vp-swatch ${cat(p, i)}`, attr: { "aria-hidden": "true" } });
      it.createSpan({ cls: "vp-legend-name", text: name(p) });
      it.createSpan({ cls: "vp-legend-val", text: `${Math.round(p.share * 100)}%${dn.list ? ` · ${count(fmtFull(p.notes), "notes")}` : ""}` });
      reveal(it, p);
    });
  }

  /* ---------- 合并卡：结构、写作习惯、任务（每张带标签页，样式切换放在标题行） ---------- */

  private structTab: "tags" | "folders" | "mix" | "linked" | "density" = "tags";
  private habitTab: "rhythm" | "activity" = "rhythm";
  private hubTaskTab: "due" | "folder" | "notes" = "due";

  private renderStructure(grid: HTMLElement, s: VaultStats) {
    const id: WidgetId = "structure";
    const tab = this.structTab;
    const { ctrls, panel } = this.hubShell(
      grid,
      id,
      "layout-grid",
      L("标签、文件夹和链接放在一张卡里：常用标签、文件夹排行、文件夹构成、最常被链接、链接密度。标签可以换成标签云，文件夹构成可以换成环形图或列表。", "Tags, folders and links in one card: top tags, folder ranking, folder mix, most linked and link density. Tags can be a cloud, the folder mix a donut or a list."),
      [
        { id: "tags" as const, label: L("标签", "Tags") },
        { id: "folders" as const, label: L("文件夹", "Folders") },
        { id: "mix" as const, label: L("构成", "Mix") },
        { id: "linked" as const, label: L("被链接", "Linked") },
        { id: "density" as const, label: L("密度", "Density") },
      ],
      tab,
      (v) => {
        this.structTab = v;
        this.rerender(id);
      }
    );
    const box = this.box(id, HUB_CHROME);
    if (tab === "tags") this.tagStyleSwitch(ctrls, id);
    if (tab === "mix") this.mixStyleSwitch(ctrls, id);
    if (tab === "tags" || tab === "folders") this.tagsPanel(panel, id, s, tab);
    else if (tab === "mix") this.mixPanel(panel, s, box);
    else if (tab === "linked") this.topLinkedPanel(panel, id, s);
    else this.densityPanel(panel, s, box);
  }

  private renderHabits(grid: HTMLElement, s: VaultStats) {
    const id: WidgetId = "habits";
    const tab = this.habitTab;
    const { ctrls, panel } = this.hubShell(
      grid,
      id,
      "activity",
      L("写作习惯：一般星期几写（可以换成折线或面积），以及近 30 天是在写新的还是在改旧的。", "Writing habits: which weekdays you write (switchable to a line or area chart), and whether the last 30 days were new notes or reworking old ones."),
      [{ id: "rhythm" as const, label: L("写作节奏", "Rhythm") }, { id: "activity" as const, label: L("笔记活跃度", "Activity") }],
      tab,
      (v) => {
        this.habitTab = v;
        this.rerender(id);
      }
    );
    const box = this.box(id, HUB_CHROME);
    if (tab === "rhythm") {
      this.rhythmStyleSwitch(ctrls, id);
      this.rhythmPanel(panel, id, s, box);
    } else this.activityPanel(panel, s, box);
  }

  private renderTasksHub(grid: HTMLElement, s: VaultStats) {
    const id: WidgetId = "tasksHub";
    const tab = this.hubTaskTab;
    const { panel } = this.hubShell(
      grid,
      id,
      "list-todo",
      L("笔记里的待办：按到期时间（逾期单独列出）、按文件夹、按笔记看。点任务直接跳到那一行。", "Open tasks in your notes: by due date (overdue first), by folder, or by note. Click a task to jump to its line."),
      [{ id: "due" as const, label: L("到期", "Due"), count: s.tasks.overdue.length, warn: true }, { id: "folder" as const, label: L("按文件夹", "By folder") }, { id: "notes" as const, label: L("按笔记", "By note") }],
      tab,
      (v) => {
        this.hubTaskTab = v;
        this.rerender(id);
      }
    );
    this.tasksPanel(panel, id, s, tab);
  }

  /* ---------- 新卡片：最近编辑、目标进度、本月对比上月、笔记长度分布 ---------- */

  /** 最近编辑的笔记：按修改时间，点一下打开 */
  private renderRecent(grid: HTMLElement, s: VaultStats) {
    const { body } = this.card(grid, "vp-recent-card", L("最近编辑", "Recently edited"), "history", L("最近改动过的笔记，最新的在前。点击打开。", "Notes you edited most recently, newest first. Click to open."));
    const host = body.createDiv();
    const list = host.createDiv({ cls: "vp-rows" });
    const units: HTMLElement[] = [];
    const now = Date.now();
    const notes = recentNotes(s, 50);
    if (notes.length === 0) this.empty(list, "files", L("还没有笔记", "No notes yet"));
    for (const f of notes) {
      const row = list.createDiv({ cls: "vp-row" });
      row.createSpan({ cls: "vp-row-name", text: f.file.basename, attr: { title: f.file.path } });
      row.createSpan({ cls: "vp-row-meta vp-tabular is-fit", text: relativeTime(f.mtime, now, L) });
      this.clickable(row, `${f.file.basename}${L("，", ", ")}${relativeTime(f.mtime, now, L)}`, (e) => void this.plugin.openFile(f.file, undefined, e));
      units.push(row);
    }
    this.fitList("recent", host, body.createDiv({ cls: "vp-card-foot" }), units);
  }

  /** 目标进度：今天、本周、本月三个环 */
  private renderGoals(grid: HTMLElement, s: VaultStats) {
    const set = this.plugin.settings;
    const { body } = this.card(
      grid,
      "vp-goals-card",
      L("目标进度", "Goals"),
      "target",
      L("今天和本周的字数各按你设的目标算；本月是已经过去的日子里有几天打卡。目标在设置里改。", "Today and this week count words against your goals; this month counts how many of the days so far were streak days. Change the goals in settings.")
    );
    const rings = goalRings(s, { dailyGoal: set.dailyWordGoal, weeklyGoal: set.weeklyWordGoal }, new Date(s.generatedAt));
    const size = goalRingSize(this.box("goals"));
    const row = body.createDiv({ cls: "vp-goalrow" });
    for (const g of rings) {
      const cell = row.createDiv({ cls: "vp-goalcell", attr: { role: "group" } });
      const title = g.key === "today" ? L("今天", "Today") : g.key === "week" ? L("本周", "This week") : L("本月", "This month");
      const center = drawRing(cell, g.ratio, size, size >= 100 ? 10 : 7, "vp-goal-ring" + (size < 90 ? " is-small" : size >= 130 ? " is-large" : ""));
      const wrap = center.parentElement as HTMLElement;
      this.tweenRing(`goal:${g.key}`, wrap, g.ratio);
      wrap.setAttr("role", "img");
      const valueText = g.unit === "days" ? L(`${g.value} / ${g.goal} 天`, `${g.value} / ${g.goal} days`) : g.goal > 0 ? `${fmtNum(g.value)} / ${fmtNum(g.goal)}` : `${fmtNum(g.value)}`;
      srLabel(wrap, `${title}${L("，", ", ")}${valueText}`);
      bigNumber(center, g.unit === "days" ? `${Math.round(g.ratio * 100)}` : fmtNum(g.value), g.unit === "days" ? "%" : undefined, "vp-num vp-ring-num");
      cell.createDiv({ cls: "vp-goal-title", text: title });
      cell.createDiv({ cls: "vp-kpi-caption", text: g.unit === "days" ? L(`打卡 ${g.value} / ${g.goal} 天`, `${g.value} of ${g.goal} days`) : g.goal > 0 ? L(`目标 ${fmtNum(g.goal)} 字`, `goal ${fmtNum(g.goal)}`) : L("没设目标", "no goal set") });
    }
  }

  /** 本月对比上月：到今天为止，和上个月同样天数的对比 */
  private renderMonthCompare(grid: HTMLElement, s: VaultStats) {
    const { body } = this.card(
      grid,
      "vp-compare-card",
      L("本月对比上月", "This month vs last"),
      "git-compare",
      L("本月到今天为止，和上个月同样天数的对比（上个月不够长就取整月）：写作字数、新建笔记、打卡天数。", "This month so far against the same number of days last month (the whole month if it was shorter): words written, new notes, streak days.")
    );
    const m = monthCompare(s, this.plugin.settings.dailyWordGoal, new Date(s.generatedAt));
    const label: Record<string, string> = { words: L("写作字数", "Words written"), notes: L("新建笔记", "New notes"), checkins: L("打卡天数", "Streak days") };
    const unitOf: Record<string, string> = { words: unit("words"), notes: unit("notes"), checkins: unit("days") };
    const rows = body.createDiv({ cls: "vp-compare" });
    for (const r of m.rows) {
      const row = rows.createDiv({ cls: "vp-compare-row", attr: { role: "group" } });
      const top = row.createDiv({ cls: "vp-compare-top" });
      top.createSpan({ cls: "vp-label", text: label[r.key] });
      if (r.changePct !== null && r.changePct !== 0) top.createSpan({ cls: `vp-delta ${r.changePct > 0 ? "is-up" : "is-down"}`, text: `${r.changePct > 0 ? "+" : ""}${r.changePct}%` });
      else if (r.changePct === 0) top.createSpan({ cls: "vp-date-chip", text: L("持平", "Same") });
      const peak = Math.max(r.cur, r.prev, 1);
      const bar = (cls: string, caption: string, v: number) => {
        const line = row.createDiv({ cls: "vp-compare-line" });
        line.createSpan({ cls: "vp-compare-cap", text: caption });
        const track = line.createDiv({ cls: "vp-compare-track" });
        track.createDiv({ cls: `vp-compare-fill ${cls}` }).setCssProps({ "--vp-bar-width": `${Math.max(v > 0 ? 3 : 0, (v / peak) * 100)}%` });
        line.createSpan({ cls: "vp-compare-val", text: `${fmtNum(v)} ${unitOf[r.key]}` });
      };
      bar("is-cur", L("本月", "This"), r.cur);
      bar("is-prev", L("上月", "Last"), r.prev);
      srLabel(row, `${label[r.key]}${L("，", ", ")}${L("本月", "this month")} ${fmtFull(r.cur)}${L("，", ", ")}${L("上月同期", "last month")} ${fmtFull(r.prev)}`);
    }
  }

  /** 笔记长度分布：你的笔记大多是几百字还是几千字 */
  private renderLengths(grid: HTMLElement, s: VaultStats) {
    const { head, body } = this.card(
      grid,
      "vp-lengths-card",
      L("笔记长度分布", "Note length"),
      "bar-chart-horizontal",
      L("按字数把笔记分成 6 档，看你的笔记大多多长（采集文件夹里的不算）。", "Your notes grouped into six length bands (clipping folders left out).")
    );
    const style = this.plugin.settings.chartStyles.lengths;
    this.styleSeg<LengthStyle>(head, LENGTH_STYLES.map((v) => [v, v === "bar" ? L("柱状", "Bar") : L("面积", "Area")]), style, (v) => this.setChartStyle("lengths", v, "lengths"), L("图的样式", "Chart style"));
    const names: Record<string, string> = { empty: L("空", "Empty"), tiny: "<100", short: "100+", medium: "500+", long: "2千+", huge: "1万+" };
    const en: Record<string, string> = { empty: "Empty", tiny: "<100", short: "100+", medium: "500+", long: "2K+", huge: "10K+" };
    const buckets = lengthBuckets(s);
    const total = buckets.reduce((a, b) => a + b.count, 0);
    if (total === 0) {
      this.empty(body, "bar-chart-horizontal", L("还没有笔记", "No notes yet"));
      return;
    }
    const points: SeriesPoint[] = buckets.map((b) => ({
      label: L(names[b.id], en[b.id]),
      value: b.count,
      tipTitle: L(`${names[b.id]} 字`, `${en[b.id]} words`),
      tipRows: [{ label: L("笔记", "Notes"), value: `${count(b.count, "notes")} · ${Math.round((b.count / total) * 100)}%`, dot: "is-accent" }],
    }));
    const chartWrap = body.createDiv({ cls: "vp-chart-wrap" });
    const tip = new Tooltip(chartWrap);
    const host = chartWrap.createDiv({ cls: "vp-chart-host" });
    host.setAttr("role", "img");
    srLabel(host, points.map((p) => `${p.label} ${p.value}`).join(L("，", ", ")), chartWrap);
    this.responsive(
      chartWrap,
      (w, h) => {
        host.empty();
        if (h < 60) return;
        drawTrendChart(host, points, { width: w, height: Math.max(64, h), kind: style === "bar" ? "bar" : "area", tooltip: tip, zeroBased: true });
      },
      { narrowH: 180 }
    );
  }

  /* ---------- 日历：选一天看日程、记日程 ---------- */

  /** 正在看的月份和选中的那天（只在这次打开期间记着） */
  private calYear = new Date().getFullYear();
  private calMonth = new Date().getMonth();
  private calSelected: string | null = null;

  private renderCalendar(grid: HTMLElement, s: VaultStats) {
    const box = this.box("calendar");
    const dn = calendarDensity(box);
    const todayKey = dayKey(Date.now());
    const sel = this.calSelected ?? todayKey;
    const agenda = this.plugin.settings.agenda;
    const { head, body } = this.card(
      grid,
      "vp-cal-card",
      yearMonth(this.calYear, this.calMonth),
      "calendar-days",
      L(
        "点一天看那天的日程，在下面的输入框里写下要做的事，回车保存；日程存在插件数据里，随库同步。有底色的日子写过东西，小圆点表示有日程（空心是都做完了）。",
        "Pick a day to see its agenda and type what you need to do below; press Enter to save. The agenda is stored in the plugin data and syncs with the vault. Tinted days have writing, a dot means there are items (hollow once all are done)."
      )
    );
    const go = (delta: number) => {
      const m = shiftMonth(this.calYear, this.calMonth, delta);
      this.calYear = m.year;
      this.calMonth = m.month;
      this.rerender("calendar", "resize");
    };
    const nav = head.createDiv({ cls: "vp-cal-nav" });
    const showToday = this.calSelected !== null && this.calSelected !== todayKey ? true : new Date().getFullYear() !== this.calYear || new Date().getMonth() !== this.calMonth;
    if (showToday) {
      const t = nav.createEl("button", { cls: "vp-link", text: L("今天", "Today"), attr: { type: "button", "data-fid": "cal:today" } });
      t.addEventListener("click", () => {
        const now = new Date();
        this.calYear = now.getFullYear();
        this.calMonth = now.getMonth();
        this.calSelected = null;
        this.rerender("calendar", "resize");
      });
    }
    for (const [icon, label, delta] of [["chevron-left", L("上个月", "Previous month"), -1], ["chevron-right", L("下个月", "Next month"), 1]] as const) {
      const b = nav.createEl("button", { cls: "vp-icon-btn is-small", attr: { type: "button", "aria-label": label, "data-fid": `cal:${delta}` } });
      setIcon(b, icon);
      b.addEventListener("click", () => go(delta));
    }

    const wrap = body.createDiv({ cls: `vp-cal is-${dn.mode}` });
    const month = wrap.createDiv({ cls: "vp-cal-month" });
    const narrowCells = innerW(box) < 300 || dn.mode === "below";
    const weekdays = month.createDiv({ cls: "vp-cal-weekdays", attr: { "aria-hidden": "true" } });
    for (const d of [1, 2, 3, 4, 5, 6, 0]) weekdays.createSpan({ text: narrowCells ? weekdayLetter(d) : weekdayShort(d) });
    const days = month.createDiv({ cls: "vp-cal-days", attr: { role: "group", "aria-label": yearMonth(this.calYear, this.calMonth) } });
    days.setCssProps({ "--vp-cal-cell": `${dn.cell}px` });
    for (const c of monthGrid(this.calYear, this.calMonth)) {
      const items = itemsOn(agenda, c.key);
      const open = items.filter((i) => !i.done).length;
      const [yy, mm, dd] = c.key.split("-").map(Number);
      const date = new Date(yy, mm - 1, dd);
      const words = s.dayWords[c.key] || 0;
      const b = days.createEl("button", {
        cls: "vp-cal-day" + (c.inMonth ? "" : " is-out") + (c.key === todayKey ? " is-today" : "") + (c.key === sel ? " is-selected" : "") + (words > 0 ? " has-words" : ""),
        attr: {
          type: "button",
          "aria-pressed": String(c.key === sel),
          "aria-label": `${fullDate(date)} ${weekdayName(date.getDay())}${items.length ? L(`，${items.length} 条日程`, `, ${items.length} ${plural(items.length, "item")}`) : ""}${words > 0 ? L(`，写了 ${fmtFull(words)} 字`, `, ${count(fmtFull(words), "words")}`) : ""}`,
          "data-fid": `cal:day:${c.key}`,
          title: items.length ? items.map((i) => `${i.done ? "✓ " : "· "}${i.text}`).join("\n") : "",
        },
      });
      if (c.key === todayKey) b.setAttr("aria-current", "date");
      b.createSpan({ cls: "vp-cal-num", text: String(c.day) });
      if (items.length) b.createSpan({ cls: "vp-cal-dot" + (open === 0 ? " is-done" : ""), attr: { "aria-hidden": "true" } });
      b.addEventListener("click", () => {
        this.calSelected = c.key;
        if (!c.inMonth) {
          this.calYear = yy;
          this.calMonth = mm - 1;
        }
        this.rerender("calendar", "resize");
      });
    }
    if (dn.mode === "none") return;

    // 选中那天的日程
    const [sy, sm, sd] = sel.split("-").map(Number);
    const selDate = new Date(sy, sm - 1, sd);
    const panel = wrap.createDiv({ cls: "vp-cal-agenda" });
    const ph = panel.createDiv({ cls: "vp-cal-agenda-head" });
    ph.createSpan({ cls: "vp-cal-agenda-title", text: `${monthDay(selDate)} ${weekdayName(selDate.getDay())}` });
    if (sel === todayKey) ph.createSpan({ cls: "vp-pill is-muted", text: L("今天", "Today") });
    const words = s.dayWords[sel] || 0;
    const diary = s.dailyNotes[sel];
    if (words > 0 || diary) {
      const meta = ph.createSpan({ cls: "vp-cal-agenda-meta" });
      if (words > 0) meta.createSpan({ text: L(`写了 ${fmtFull(words)} 字`, `${count(fmtFull(words), "words")}`) });
      if (diary) {
        const a = meta.createEl("button", { cls: "vp-link", text: L("打开日记", "Open daily note"), attr: { type: "button" } });
        a.addEventListener("click", (e) => void this.plugin.openFile(diary, undefined, e));
      }
    }
    const list = panel.createDiv({ cls: "vp-cal-items", attr: { role: "list" } });
    const items = itemsOn(agenda, sel);
    const save = (next: Agenda) => {
      this.plugin.settings.agenda = next;
      void this.plugin.saveViewSetting();
      this.rerender("calendar", "resize");
    };
    if (items.length === 0) list.createDiv({ cls: "vp-cal-empty", text: L("这一天还没有日程", "Nothing planned for this day") });
    for (const it of items) {
      const row = list.createDiv({ cls: "vp-cal-item" + (it.done ? " is-done" : ""), attr: { role: "listitem" } });
      const box = row.createEl("button", { cls: "vp-cal-check", attr: { type: "button", role: "checkbox", "aria-checked": String(it.done), "aria-label": it.text, "data-fid": `cal:check:${it.id}` } });
      if (it.done) setIcon(box, "check");
      box.addEventListener("click", () => save(toggleAgendaItem(this.plugin.settings.agenda, sel, it.id)));
      row.createSpan({ cls: "vp-cal-text", text: it.text, attr: { title: it.text } });
      const del = row.createEl("button", { cls: "vp-icon-btn is-small", attr: { type: "button", "aria-label": L("删除这条日程", "Delete this item"), "data-fid": `cal:del:${it.id}` } });
      setIcon(del, "x");
      del.addEventListener("click", () => save(removeAgendaItem(this.plugin.settings.agenda, sel, it.id)));
    }
    const input = panel.createEl("input", {
      cls: "vp-cal-input",
      attr: { type: "text", maxlength: String(MAX_ITEM_CHARS), placeholder: L("添加日程，回车保存", "Add an item, press Enter"), "aria-label": L("添加日程", "Add an agenda item"), "data-fid": "cal:input" },
    });
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.isComposing) return;
      e.preventDefault();
      const next = addAgendaItem(this.plugin.settings.agenda, sel, input.value, `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
      if (next !== this.plugin.settings.agenda) save(next);
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
