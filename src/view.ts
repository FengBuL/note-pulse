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
  fmtParts,
  srLabel,
  svgEl,
} from "./charts";

let reportDetailsId = 0;

export const VIEW_TYPE_PULSE = "note-pulse-view";

type TaskTab = "due" | "folder";
type TagTab = "tags" | "folders";
type LinkTab = "top" | "orphans" | "unresolved";

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

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
    this.refreshBtn = this.iconButton(actions, "refresh-cw", "刷新数据", () => void this.plugin.requestRefresh(true));
    this.iconButton(actions, "settings", "看板设置", () => this.plugin.openSettings());

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
    else this.showLoading("正在统计…");
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
    this.subtitleEl.setText(`${vault} · ${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 星期${WEEKDAYS[d.getDay()]}`);
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
    const msg = `正在读取笔记 ${done}/${total}`;
    this.statusEl.setText(msg);
    if (!this.plugin.lastStats) {
      const t = this.bodyEl.querySelector(".vp-loading-text");
      if (t) t.textContent = msg;
    }
  }

  showError() {
    this.refreshBtn?.removeClass("is-spinning");
    this.statusEl.setText("统计失败");
    if (this.plugin.lastStats) return;
    this.bodyEl.empty();
    const e = this.bodyEl.createDiv({ cls: "vp-card vp-fullempty", attr: { role: "alert" } });
    this.empty(e, "alert-triangle", "统计时出错了，详情见开发者控制台");
    const b = e.createEl("button", { cls: "vp-btn", text: "重试" });
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
    this.statusEl.setText(`更新于 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`);
    this.statusEl.setAttr("aria-label", `统计耗时 ${stats.durationMs} ms`);
    this.updateSubtitle();

    const body = this.bodyEl;
    body.empty();

    if (stats.totalNotes === 0) {
      const e = body.createDiv({ cls: "vp-card vp-fullempty" });
      this.empty(e, "files", "没有可统计的笔记。先写一篇笔记，或检查设置里的“排除的文件夹”。");
      const b = e.createEl("button", { cls: "vp-btn", text: "打开设置" });
      b.addEventListener("click", () => this.plugin.openSettings());
      this.renderReports(body);
      return;
    }

    const ck = this.computeCheckin(stats);
    this.bodyHost = body;
    this.define("hints", body, (h) => this.renderHints(h, stats));
    this.define("headline", body, (h) => this.renderHeadline(h, stats, ck));
    const grid = body.createDiv({ cls: "vp-grid" });
    this.define("hero", grid, (h) => this.renderHero(h, stats, ck));
    this.define("tasks", grid, (h) => this.renderTasks(h, stats));
    this.define("kpis", grid, (h) => this.renderKpis(h, stats));
    this.define("heat", grid, (h) => this.renderHeatmap(h, stats, ck));
    this.define("trend", grid, (h) => this.renderTrend(h, stats));
    this.define("tags", grid, (h) => this.renderTags(h, stats));
    this.define("checkup", grid, (h) => this.renderCheckup(h, stats));
    this.define("reports", grid, (h) => this.renderReports(h));
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
    if (intro) {
      markStagger(el);
      drawLines(el, this.enterDelay);
    }
    if (intro) {
      const targets = el.hasClass("vp-kpis") ? Array.from(el.children) as HTMLElement[] : [el];
      for (const t of targets) {
        t.addClass("vp-enter");
        t.setCssProps({ "--vp-enter": String(Math.min(0.6, this.enterOrder++ / 14)) });
      }
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
    srLabel(b, "说明");
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
      last7.push({ key: k, label: WEEKDAYS[x.getDay()], active: isActive(k), isToday: i === 0 });
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
          `欢迎使用 Note Pulse：每天写 ${goal > 0 ? fmtFull(goal) : "任意"} 字算打卡。`,
          `超过 ${thr} 字的超大笔记不计入写作统计。自动采集、网页剪藏之类的文件夹，建议在设置里标记为“采集文件夹”。`
        );
        m.btn("打开设置", "调整每日目标、采集文件夹、超大笔记阈值等", () => this.plugin.openSettings(), true);
        m.close("知道了，不再显示");
      } else if (h.kind === "folder" && h.target) {
        const f = h.target;
        const m = make(
          h,
          "lightbulb",
          `“${f}/” 里${h.count === h.total ? `${h.total} 篇笔记都` : ` ${h.total} 篇有 ${h.count} 篇`}超过 ${thr} 字，像是自动采集的内容。`,
          "这类笔记会让字数趋势和热力图失真。“不计入写作统计”后，笔记仍计入总数；“完全排除”则整个文件夹不参与任何统计。"
        );
        m.btn("不计入写作统计", "笔记仍计入总数，但不计入字数趋势、热力图和打卡", () => void this.plugin.setClippingFolder(f), true);
        m.btn("完全排除", "整个文件夹不参与任何统计", () => void this.plugin.excludeFolder(f));
        m.close("忽略，不再提示这个文件夹");
      } else if (h.kind === "spike" && h.target) {
        const [, mm, dd] = h.target.split("-").map(Number);
        const m = make(
          h,
          "calendar-clock",
          `${h.count} 篇笔记的创建日期都是 ${mm} 月 ${dd} 日（占 ${Math.round(((h.count || 0) / Math.max(1, h.total || 1)) * 100)}%），趋势图会在这天陡升。`,
          "可能是同步或导入重置了文件创建时间。给笔记加上 created 字段，再在设置里指定它作为创建日期，就能修正。"
        );
        m.btn("设置创建日期字段", "在设置里指定用哪个 frontmatter 字段作为创建日期", () => this.plugin.openSettings(), true);
        m.close("忽略，不再提示这一天");
      }
    }
  }

  /* ---------- 1. 页首一句话 ---------- */

  private renderHeadline(parent: HTMLElement, s: VaultStats, ck: Checkin) {
    const goal = this.plugin.settings.dailyWordGoal;
    const h = headline(s, goal, new Date(s.generatedAt));
    const el = parent.createDiv({ cls: "vp-headline" });
    const lead = el.createDiv({ cls: "vp-headline-lead" });
    lead.createSpan({ text: "本周已写 " });
    lead.createSpan({ cls: "vp-grad-text", text: fmtFull(h.weekWords) });
    lead.createSpan({ text: " 字" });
    if (h.changePct !== null && h.changePct !== 0) lead.createSpan({ text: `，比上周同期${h.changePct > 0 ? "多" : "少"} ${Math.abs(h.changePct)}%` });
    else if (h.changePct === 0) lead.createSpan({ text: "，和上周同期持平" });
    lead.createSpan({ text: "。" });
    const bits: string[] = [];
    if (ck.current > 0) bits.push(`连续写作第 ${ck.current} 天`);
    bits.push(h.todayDone ? "今天已达成目标" : goal > 0 ? `今天还差 ${fmtFull(Math.max(0, goal - h.todayWords))} 字` : "今天还没动笔");
    if (h.dueToday > 0) bits.push(`${h.dueToday} 项任务今天到期`);
    if (h.overdue > 0) bits.push(`${h.overdue} 项已逾期`);
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
    ht.createSpan({ text: "今日写作" });
    this.help(
      ht,
      `${goal > 0 ? `当天新增字数达到每日目标（${fmtFull(goal)} 字，可在设置里改）` : "当天写了任何字"}就算打卡，写了当天的日记也算。\n连续打卡从今天往前数；今天还没写不会中断，到明天才断。`
    );
    const pill = head.createDiv({ cls: "vp-pill " + (todayDone ? "is-success" : "is-muted") });
    setIcon(pill.createSpan({ cls: "vp-pill-icon" }), todayDone ? "check" : "clock");
    pill.createSpan({ text: todayDone ? "已打卡" : "还没打卡" });

    const main = hero.createDiv({ cls: "vp-hero-main" });

    // 今日字数 / 目标 圆环
    const ratio = goal > 0 ? ck.todayWords / goal : ck.todayWords > 0 ? 1 : 0;
    const center = drawRing(main, ratio, 132, 10, "vp-hero-ring");
    const ringWrap = center.parentElement as HTMLElement;
    this.tweenRing("hero:ring", ringWrap, ratio);
    ringWrap.setAttr("role", "img");
    srLabel(ringWrap, goal > 0 ? `今日 ${fmtFull(ck.todayWords)} 字，目标 ${fmtFull(goal)} 字` : `今日 ${fmtFull(ck.todayWords)} 字`);
    this.tweenNum("hero:today", bigNumber(center, ck.todayWords, undefined, "vp-num vp-ring-num"), ck.todayWords);
    center.createDiv({ cls: "vp-ring-caption", text: goal > 0 ? `目标 ${fmtNum(goal)} 字` : "今日字数" });

    // 连续打卡
    const streak = main.createDiv({ cls: "vp-hero-streak" });
    streak.createDiv({ cls: "vp-label", text: "连续打卡" });
    this.tweenNum("hero:streak", bigNumber(streak, String(ck.current), "天", "vp-num vp-num-hero"), ck.current, "天");
    streak.createDiv({ cls: "vp-hero-note", text: `最长 ${ck.longest} 天 · 近一年 ${ck.activeDays} 天` });
    const diary = streak.createDiv({ cls: "vp-hero-note", text: `本月日记 ${ck.diaryMonth} 篇` });
    const todayDiary = s.dailyNotes[ck.todayKey];
    if (todayDiary) this.clickable(diary, "打开今天的日记", (e) => void this.plugin.openFile(todayDiary, undefined, e));

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
    stat("hero:created", "今日新建", todayCreated, "篇");
    stat("hero:modified", "今日改动", todayFiles.length, "篇");
    const recent = foot.createDiv({ cls: "vp-hero-recent" });
    recent.createDiv({ cls: "vp-label", text: "今天写过" });
    const chips = recent.createDiv({ cls: "vp-chips" });
    if (todayFiles.length === 0) chips.createSpan({ cls: "vp-chip-empty", text: "今天还没有改动的笔记" });
    for (const f of [...todayFiles].sort((a, b) => b.stat.mtime - a.stat.mtime).slice(0, 3)) {
      const c = chips.createSpan({ cls: "vp-chip", text: f.basename, attr: { title: f.path } });
      this.clickable(c, `打开 ${f.basename}`, (e) => void this.plugin.openFile(f, undefined, e));
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
    sum.createSpan({ cls: "vp-label", text: "本周 " });
    sum.createSpan({ cls: "vp-week-total", text: fmtFull(weekWords) });
    if (settings.weeklyWordGoal > 0) sum.createSpan({ cls: "vp-week-goal", text: ` / ${fmtFull(settings.weeklyWordGoal)}` });
    this.segmented<"dots" | "bars">(
      top,
      [["dots", "圆点"], ["bars", "柱状"]],
      style,
      (v) => {
        settings.weekStyle = v;
        void this.plugin.saveViewSetting();
        this.rerender("hero");
      },
      "本周显示方式"
    );

    const row = box.createDiv({ cls: "vp-week" });
    const max = Math.max(goal, ...days.map((d) => d.words), 1);
    for (const d of days) {
      const c = row.createDiv({ cls: "vp-week-day" + (d.done ? " is-active" : "") + (d.isToday ? " is-today" : "") + (d.future ? " is-future" : "") });
      const desc = d.future ? "还没到" : d.done ? `已打卡，${fmtFull(d.words)} 字` : d.words > 0 ? `${fmtFull(d.words)} 字，未达标` : "没有写";
      if (style === "dots") {
        const dot = c.createDiv({ cls: "vp-week-dot", attr: { role: "img", "aria-label": `周${d.label} ${desc}` } });
        if (d.done) setIcon(dot, "check");
        else if (d.pct !== null) dot.createSpan({ cls: "vp-week-pct", text: `${d.pct}%` });
      } else {
        const lane = c.createDiv({ cls: "vp-week-lane", attr: { role: "img", "aria-label": `周${d.label} ${desc}` } });
        const bar = lane.createDiv({ cls: "vp-week-bar" });
        bar.setCssProps({ "--vp-week-h": `${d.future ? 0 : Math.max(4, (d.words / max) * 100)}%` });
      }
      c.createDiv({ cls: "vp-week-label", text: d.isToday ? "今" : d.label });
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
          "aria-label": "每周字数目标",
          "aria-valuemin": "0",
          "aria-valuemax": String(settings.weeklyWordGoal),
          "aria-valuenow": String(Math.min(weekWords, settings.weeklyWordGoal)),
          "aria-valuetext": `已写 ${weekWords} 字，目标 ${settings.weeklyWordGoal} 字`,
        },
      });
      meter.createDiv({ cls: "vp-meter-fill" }).setCssProps({ "--vp-meter-width": `${pct}%` });
    }
    const legend = box.createDiv({ cls: "vp-week-legend" });
    if (style === "dots") legend.setText("✓ 达标 · 百分比为未达标的进度 · 虚线为还没到的日子");
    else legend.setText(goal > 0 ? `实色为达标 · 虚线为每日目标 ${fmtFull(goal)} 字` : "柱高为当天字数");
    return box;
  }

  /* ---------- 3. 数据卡 ---------- */

  private renderKpis(grid: HTMLElement, s: VaultStats) {
    const wrap = grid.createDiv({ cls: "vp-kpis" });
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

    // 笔记
    const notes = weeklyNotes(s, 12, now);
    const a = kpi("files", "笔记", "统计所有未被排除的 Markdown 笔记。曲线是近 12 周每周结束时的累计数（不含采集文件夹），按创建日期计。");
    const aOn = readout(
      a,
      () => {
        this.tweenNum("kpi:notes", bigNumber(a.num, s.totalNotes, "篇"), s.totalNotes, "篇");
        a.side.createSpan({ cls: "vp-kpi-caption", text: "近 30 天" });
        a.side.createSpan({ cls: "vp-delta is-up", text: `+${fmtFull(n30)}` });
      },
      (i) => ({ value: fmtFull(notes[i].value), unit: "篇", date: range(notes[i].start, notes[i].end), note: `当周 +${fmtFull(notes[i].extra)}`, up: true })
    );
    drawSparkline(a.c.createDiv({ cls: "vp-kpi-viz" }), notes.map((p) => p.value), {
      onPoint: aOn,
      label: (i) => `${range(notes[i].start, notes[i].end)}，累计 ${notes[i].value} 篇，当周新增 ${notes[i].extra} 篇`,
    });

    // 字数
    const words = weeklyWords(s, 12, now);
    const skipped = s.totalWords - s.writeWordsTotal;
    const b = kpi(
      "type",
      "总字数",
      `所有笔记的字数合计。曲线是近 12 周累计的写作字数（按笔记创建日期、用笔记当前字数计）。${
        skipped > 0 ? `\n其中 ${fmtNum(skipped)} 字来自采集文件夹或超大笔记，不计入曲线、热力图和“新增字数”。` : ""
      }`
    );
    const bOn = readout(
      b,
      () => {
        this.tweenNum("kpi:words", bigNumber(b.num, s.totalWords, "字"), s.totalWords, "字");
        b.side.createSpan({ cls: "vp-kpi-caption", text: "近 30 天" });
        b.side.createSpan({ cls: "vp-delta is-up", text: `+${fmtNum(w30)}` });
      },
      (i) => {
        const p = fmtParts(words[i].value);
        return { value: p.num, unit: `${p.unit}字`, date: range(words[i].start, words[i].end), note: `当周 +${fmtNum(words[i].extra)}`, up: true };
      }
    );
    drawSparkline(b.c.createDiv({ cls: "vp-kpi-viz" }), words.map((p) => p.value), {
      onPoint: bOn,
      label: (i) => `${range(words[i].start, words[i].end)}，累计 ${words[i].value} 字，当周新增 ${words[i].extra} 字`,
    });

    // 任务（没有每周历史，不画走势，只画完成进度）
    const t = s.tasks;
    const rate = t.total ? Math.round((t.done / t.total) * 100) : 0;
    const c = kpi("list-checks", "任务完成率", "已完成任务占全部任务的比例，已取消的任务不计。");
    const rateEl = bigNumber(c.num, t.total ? String(rate) : "—", t.total ? "%" : "");
    if (t.total) this.tweenNum("kpi:rate", rateEl, rate, "%");
    c.side.createSpan({ cls: "vp-kpi-caption", text: `${fmtFull(t.done)} / ${fmtFull(t.total)}` });
    this.meter(c.c.createDiv({ cls: "vp-kpi-viz" }), t.total ? t.done / t.total : 0, "");

    // 本月写作
    const month = monthWriting(s, goal, now);
    const weeks = weeklyCheckins(s, goal, 12, now);
    const d = kpi("flame", "本月写作", `本月打卡的天数，和本月每天平均写的字数。曲线是近 12 周每周打卡的天数。`);
    const dOn = readout(
      d,
      () => {
        this.tweenNum("kpi:month", bigNumber(d.num, String(month.days), "天"), month.days, "天");
        d.side.createSpan({ cls: "vp-kpi-caption", text: `日均 ${fmtFull(month.average)} 字` });
      },
      (i) => ({ value: String(weeks[i].value), unit: "天", date: i === weeks.length - 1 ? "本周" : range(weeks[i].start, weeks[i].end), note: `${fmtFull(weeks[i].extra)} 字` })
    );
    drawSparkline(d.c.createDiv({ cls: "vp-kpi-viz" }), weeks.map((p) => p.value), {
      onPoint: dOn,
      label: (i) => `${range(weeks[i].start, weeks[i].end)}，打卡 ${weeks[i].value} 天，写了 ${weeks[i].extra} 字`,
    });
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
      const st = s.logStartDay ? s.logStartDay.slice(5).replace("-", "/") : "今天";
      modeTip = `${st} 起是实测值：从启用插件那天起，按每天实际新增的字数记录（看板关着也会记）。更早的日子按笔记最后修改日估算，悬停格子会标注“估算”。`;
    } else if (hm === "delta") {
      modeTip = "按每日新增字数：从启用插件那天开始累积。";
    } else {
      modeTip = "按笔记修改日：笔记全文字数计入其最后修改日，较粗略，可在设置中切换为“智能”或“每日新增字数”。";
    }
    const skippedN = s.outliers.count;
    const heatHelp = [
      modeTip,
      `颜色越深写得越多${goal > 0 ? `，目标 ${fmtNum(goal)} 字/天` : ""}。写了日记的日子也算打卡。`,
      skippedN > 0 ? `已排除 ${skippedN} 篇超大或采集笔记。` : "",
    ]
      .filter(Boolean)
      .join("\n");
    const { el, head, body } = this.card(grid, "vp-heat-card", "写作热力图", "calendar-days", heatHelp);
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
      const item = (label: string, value: string, unit = "") => {
        const x = summary.createSpan({ cls: "vp-heat-sum" });
        x.createSpan({ text: label + " " });
        x.createEl("b", { text: value });
        if (unit) x.createSpan({ text: " " + unit });
      };
      const p = fmtParts(total);
      item(weeks >= 52 ? "近一年" : `近 ${weeks} 周`, p.num, `${p.unit}字`);
      item("打卡", String(active), "天");
      item("日均", fmtFull(Math.round(total / Math.max(1, days))), "字");
      const busy = busiestWeekday(s, from, today);
      if (busy) item("最活跃", busy);
    });

    const foot = body.createDiv({ cls: "vp-heat-foot" });
    const note: string[] = [];
    if (s.estimatedBefore) {
      const [, em, ed] = s.estimatedBefore.split("-").map(Number);
      note.push(`${em}月${ed}日之前为估算`);
    }
    note.push("点击某天查看当天改动的笔记");
    foot.createSpan({ text: note.join(" · ") });
    const legend = foot.createDiv({ cls: "vp-heat-legend" });
    legend.createSpan({ text: "少" });
    for (let i = 0; i <= 4; i++) legend.createSpan({ cls: `vp-heat-swatch vp-l${i}` });
    legend.createSpan({ text: "多" });
    if (this.selectedDay) {
      const k = this.selectedDay;
      const det = el.createDiv({ cls: "vp-day-detail" });
      const dh = det.createDiv({ cls: "vp-day-detail-head" });
      const [y, m, d] = k.split("-").map(Number);
      dh.createSpan({ cls: "vp-day-detail-title", text: `${m}月${d}日` });
      dh.createSpan({
        cls: "vp-day-detail-meta",
        text: `${fmtFull(s.dayWords[k] || 0)} 字${s.dailyNotes[k] ? " · 有日记" : ""}${y !== new Date().getFullYear() ? ` · ${y}` : ""}`,
      });
      const close = dh.createEl("button", { cls: "vp-icon-btn is-small", attr: { "aria-label": "关闭" } });
      setIcon(close, "x");
      close.addEventListener("click", () => {
        this.selectedDay = null;
        this.dayExpanded = false;
        this.rerender("heat", "resize");
      });
      const list = det.createDiv({ cls: "vp-rows" });
      if (s.dailyNotes[k]) this.noteRow(list, s.dailyNotes[k], "日记");
      const mods = (s.dayModified[k] || []).filter((f) => f !== s.dailyNotes[k]);
      const shown = this.dayExpanded ? mods : mods.slice(0, 8);
      const area = this.dayExpanded && mods.length > 8 ? list.createDiv({ cls: "vp-rows vp-scroll", attr: { tabindex: "0", role: "region", "aria-label": "当天修改的笔记" } }) : list;
      for (const f of shown) this.noteRow(area, f, "当天修改");
      if (mods.length > 8) {
        this.moreLink(det.createDiv({ cls: "vp-card-foot" }), this.dayExpanded ? "收起" : `展开另外 ${mods.length - 8} 篇`, () => {
          this.dayExpanded = !this.dayExpanded;
          this.rerender("heat", "resize");
        });
      }
      if (mods.length === 0 && !s.dailyNotes[k]) this.empty(list, "coffee", "这一天没有留下笔记，休息也很重要");
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
        { label: "写作", value: `${fmtFull(words)} 字` },
        { label: "修改笔记", value: `${s.dayModified[k]?.length || 0} 篇` },
        { label: "新建笔记", value: `${s.dayCreated[k] || 0} 篇` },
      ];
      if (s.dailyNotes[k]) rows.push({ label: "日记", value: "有" });
      if (s.estimatedBefore && k < s.estimatedBefore) rows.push({ label: "来源", value: "按修改日估算" });
      else if (s.estimatedBefore) rows.push({ label: "来源", value: "实测" });
      const [yy, mm, dd] = k.split("-").map(Number);
      const rr = c.rect.getBoundingClientRect();
      tip.showAtClient(rr.left + rr.width / 2, rr.top, `${yy}年${mm}月${dd}日 周${WEEKDAYS[c.day.getDay()]}${ck.isActive(k) ? " · 已打卡" : ""}`, rows);
    };

    [
      ["一", 0],
      ["三", 2],
      ["五", 4],
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
          mt.textContent = `${m + 1}月`;
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
    srLabel(svg, "写作热力图。用左右方向键切换周，上下方向键切换日，回车查看当天的笔记。", host);
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
      live.setText(`${yy}年${mm}月${dd}日，${fmtFull(s.dayWords[k] || 0)} 字${ck.isActive(k) ? "，已打卡" : ""}`);
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
    const per = m.gran === "day" ? "天" : "周";
    const trendHelp = isWords
      ? `每${per}写作的字数，与热力图同一来源（排除超大和采集笔记）。最右边一根是本${per === "天" ? "日" : "周"}，用实色标出。`
      : `每${per}新建的笔记数（不含采集文件夹）。`;
    const { head, body } = this.card(grid, "vp-trend-card", isWords ? `每${per}写作` : `每${per}新建笔记`, "trending-up", trendHelp);
    const ctrls = head.createDiv({ cls: "vp-ctrls" });
    this.segmented<TrendMetric>(
      ctrls,
      [["words", "字数"], ["notes", "新建笔记"]],
      this.metric,
      (v) => {
        this.metric = v;
        this.rerender("trend");
      },
      "指标"
    );
    this.segmented<TrendRange>(
      ctrls,
      [[30, "30 天"], [182, "半年"], [365, "一年"]],
      this.range,
      (v) => {
        this.range = v;
        this.rerender("trend");
      },
      "时间范围"
    );

    const unit = isWords ? "字" : "篇";
    const rangeName = this.range === 30 ? "30 天" : this.range === 182 ? "半年" : "一年";
    const summary = body.createDiv({ cls: "vp-trend-summary" });
    const stat = (key: string, label: string, value: number) => {
      const x = summary.createDiv({ cls: "vp-trend-side" });
      this.tweenNum(`trend:${this.metric}:${key}`, bigNumber(x, value, unit, "vp-num vp-num-sm"), value, unit);
      x.createDiv({ cls: "vp-label", text: label });
    };
    stat("total", `${rangeName}合计`, m.total);
    stat("avg", `${per}均`, m.average);
    if (m.best) stat("best", `最高一${per}`, m.best.value);

    const fmtDay = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;
    const points: SeriesPoint[] = m.buckets.map((bk) => {
      const title = m.gran === "day" ? `${bk.start.getMonth() + 1}月${bk.start.getDate()}日` : `${fmtDay(bk.start)} – ${fmtDay(bk.end)}`;
      const rows = [{ label: isWords ? "写作" : "新建笔记", value: `${fmtFull(bk.value)} ${unit}`, dot: "is-accent" }];
      if (m.gran === "week") rows.push({ label: "打卡", value: `${bk.checkins} 天`, dot: "" });
      return { label: fmtDay(bk.start), value: bk.value, tipTitle: title, tipRows: rows };
    });
    if (points.every((p) => p.value === 0)) {
      this.empty(body.createDiv({ cls: "vp-chart-empty" }), "line-chart", isWords ? "这段时间还没有写作记录" : "这段时间还没有新建笔记");
    } else {
      const chartWrap = body.createDiv({ cls: "vp-chart-wrap" });
      const tip = new Tooltip(chartWrap);
      const host = chartWrap.createDiv({ cls: "vp-chart-host" });
      host.setAttr("role", "img");
      srLabel(host, `${rangeName}${isWords ? "写作字数" : "新建笔记"}柱状图，合计 ${fmtFull(m.total)} ${unit}`, chartWrap);
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
    sw.createSpan({ cls: "vp-switch-label", text: `排除超大笔记（> ${fmtNum(s.outliers.threshold)} 字）` });
    sw.addEventListener("click", () => void this.plugin.setOutlierExclusion(!on));

    const w = big.reduce((a, f) => a + f.words, 0);
    const top = [...big, ...collected].sort((a, b) => b.words - a.words).slice(0, 3);
    const lines = [
      `字数超过 ${fmtNum(s.outliers.threshold)} 字的笔记（多为自动采集或整段粘贴）会让趋势和热力图失真。`,
      on ? `已排除 ${big.length} 篇 · ${fmtNum(w)} 字。` : `目前含 ${big.length} 篇超大笔记 · ${fmtNum(w)} 字。`,
    ];
    if (collected.length > 0) lines.push(`另有 ${collected.length} 篇在采集文件夹里，始终不计入。`);
    lines.push(`字数最多：\n${top.map((f) => `${f.file.path}（${fmtNum(f.words)} 字）`).join("\n")}`);
    this.help(row, lines.join("\n"));
  }

  /* ---------- 6. 接下来：任务 ---------- */

  private taskExpanded = false;

  private renderTasks(grid: HTMLElement, s: VaultStats) {
    const { el, head, body } = this.card(
      grid,
      "vp-tasks-card",
      "接下来",
      "list-todo",
      "笔记里带截止日期（📅 或 [due::]）的待办：已逾期的单独列出，下面是今天起 7 天内到期的。点任务直接跳到那一行。"
    );
    const t = s.tasks;
    this.segmented<TaskTab>(head, [["due", "到期"], ["folder", "按文件夹"]], this.taskTab, (v) => {
      this.taskTab = v;
      this.taskExpanded = false;
      this.rerender("tasks");
    });
    if (t.total === 0) {
      this.empty(body, "list-checks", "还没有任务。在笔记里写 - [ ] 就会出现在这里");
      return;
    }
    const todayKey = dayKey(Date.now());
    const limit = this.taskExpanded ? 50 : 4;

    if (this.taskTab === "due") {
      const area = this.listArea(el, body, this.taskExpanded);
      if (t.overdue.length) {
        const od = area.createDiv({ cls: "vp-overdue" });
        od.createDiv({ cls: "vp-overdue-title", text: `已逾期 ${t.overdue.length}` });
        const list = od.createDiv({ cls: "vp-rows" });
        for (const it of t.overdue.slice(0, this.taskExpanded ? 50 : 2)) this.taskRow(list, it, true);
      }
      const list = area.createDiv({ cls: "vp-rows" });
      if (t.dueSoon.length === 0 && !t.overdue.length) this.empty(list, "party-popper", "7 天内没有到期的任务");
      for (const it of t.dueSoon.slice(0, limit)) this.taskRow(list, it, false, it.due === todayKey);
      const hidden = Math.max(0, t.dueSoon.length - limit) + Math.max(0, t.overdue.length - (this.taskExpanded ? 50 : 2));
      const more = body.createDiv({ cls: "vp-card-foot" });
      if (hidden > 0 || this.taskExpanded) {
        this.moreLink(more, this.taskExpanded ? "收起" : `展开另外 ${hidden} 项`, () => {
          this.taskExpanded = !this.taskExpanded;
          this.rerender("tasks", "resize");
        });
      }
      this.moreLink(more, `全部 ${fmtFull(t.pending)} 项待办`, () => this.plugin.openSearch("task-todo:\"\""));
    } else {
      const groups: GroupStat[] = t.byFolder.filter((g) => g.pending > 0);
      const list = this.listArea(el, body, this.taskExpanded).createDiv({ cls: "vp-rows" });
      if (groups.length === 0) {
        this.empty(list, "party-popper", "所有任务都完成了");
        return;
      }
      for (const g of groups.slice(0, this.taskExpanded ? 50 : 6)) {
        const row = list.createDiv({ cls: "vp-row vp-group-row" });
        row.createSpan({ cls: "vp-row-name", text: g.key });
        const m = row.createDiv({ cls: "vp-meter is-inline" });
        m.createDiv({ cls: "vp-meter-fill" }).setCssProps({ "--vp-meter-width": `${(g.done / Math.max(1, g.total)) * 100}%` });
        row.createSpan({ cls: "vp-row-meta vp-tabular", text: `待办 ${g.pending}` });
        if (g.key !== "(根目录)") this.clickable(row, `${g.key}，待办 ${g.pending}`, () => this.plugin.revealFolder(g.key));
      }
      if (groups.length > 6) {
        this.moreLink(body.createDiv({ cls: "vp-card-foot" }), this.taskExpanded ? "收起" : `展开另外 ${groups.length - 6} 个文件夹`, () => {
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
    row.createSpan({ cls: "vp-due", text: today ? "今天" : due });
    const text = cleanTaskText(it.text);
    row.createSpan({ cls: "vp-row-name", text: text || "（空任务）", attr: { title: `${text}\n${it.file.path}` } });
    row.createSpan({ cls: "vp-row-meta", text: it.file.basename });
    this.clickable(row, `${text || "空任务"}，${it.file.basename}${overdue ? "，已逾期" : ""}`, (e) => void this.plugin.openFile(it.file, it.line, e));
  }

  /**
   * 展开后的列表放进限高的滚动区：卡片最多长到大约 8 行，整页不会被拉长，
   * “收起”就在滚动区下面，不用滚过整张列表去找。
   */
  private listArea(card: HTMLElement, body: HTMLElement, expanded: boolean): HTMLElement {
    if (!expanded) return body;
    card.addClass("is-expanded");
    return body.createDiv({ cls: "vp-scroll", attr: { tabindex: "0", role: "region", "aria-label": "展开的列表" } });
  }

  /** 卡片底部的文字链接（展开 / 查看全部） */
  private moreLink(parent: HTMLElement, text: string, onClick: () => void) {
    const b = parent.createEl("button", { cls: "vp-link", attr: { type: "button" } });
    b.createSpan({ text });
    setIcon(b.createSpan({ cls: "vp-link-icon", attr: { "aria-hidden": "true" } }), text === "收起" ? "chevron-up" : "chevron-right");
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
      isTags ? "常用标签" : "文件夹",
      isTags ? "tag" : "folder",
      isTags ? "按使用的笔记数排列。“本周 +n”是本周新建的笔记里用到这个标签的篇数。点击标签在搜索里查看。" : "按顶层文件夹统计笔记数和字数，点击可在文件列表里定位。"
    );
    this.segmented<TagTab>(head, [["tags", "标签"], ["folders", "文件夹"]], this.tagTab, (v) => {
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
        note: fresh.get(tag) ? `本周 +${fresh.get(tag)}` : undefined,
        onClick: () => this.plugin.openSearch(`tag:${tag}`),
      }));
    } else {
      items = s.folders.slice(0, limit).map((f) => ({
        label: f.folder,
        value: f.notes,
        valueText: `${fmtFull(f.notes)} 篇 · ${fmtNum(f.words)} 字`,
        onClick: f.folder === "(根目录)" ? undefined : () => this.plugin.revealFolder(f.folder),
      }));
    }
    drawBarList(
      this.listArea(el, body, this.tagsExpanded),
      items,
      isTags ? "还没有标签。给笔记加上 #标签，这里就会热闹起来" : "仓库里还没有文件夹",
      (el) => setIcon(el.createDiv({ cls: "vp-empty-icon" }), isTags ? "tag" : "folder")
    );
    const total = isTags ? s.tags.length : s.folders.length;
    if (total > 6) {
      this.moreLink(body.createDiv({ cls: "vp-card-foot" }), this.tagsExpanded ? "收起" : `全部 ${total} 个${isTags ? "标签" : "文件夹"}`, () => {
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
      "库体检",
      "heart-pulse",
      "随看板一起刷新。断链和孤立笔记来自 Obsidian 的链接索引；重复内容来自最近一次扫描。会改动笔记的操作都先确认，删除的笔记进回收站。"
    );
    const live = head.createDiv({ cls: "vp-live" });
    live.createSpan({ cls: "vp-live-dot", attr: { "aria-hidden": "true" } });
    const at = new Date(s.generatedAt);
    live.createSpan({ text: `实时 · ${pad2(at.getHours())}:${pad2(at.getMinutes())} 更新` });
    const total = c.unresolved.length + c.orphans.length + c.empty.length + c.big.length + (dup ? dup.groups.length : 0);
    head.createDiv({ cls: "vp-card-aside", text: total ? `共 ${fmtFull(c.unresolvedCount + c.orphans.length + c.empty.length + c.big.length + (dup ? dup.groups.length : 0))} 项可整理` : "一切正常" });

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
        list.setAttr("aria-label", `${title}，展开的列表`);
      }
      if (count === 0) list.createDiv({ cls: "vp-checkup-ok", text: empty });
      return { el, list, limit: open ? 50 : 3, open };
    };
    const item = (list: HTMLElement, name: string, label: string, onOpen: (() => void) | null, actText: string, act: () => void) => {
      const row = list.createDiv({ cls: "vp-row vp-checkup-row" });
      const n = row.createSpan({ cls: "vp-row-name", text: name, attr: { title: name } });
      if (onOpen) this.clickable(n, `打开 ${label}`, () => onOpen());
      const b = row.createEl("button", { cls: "vp-act", text: actText, attr: { type: "button" } });
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        act();
      });
    };
    /** shown：列表里实际有多少条可以展开（断链只保留出现最多的 10 个名字，比总处数少） */
    const foot = (k: { el: HTMLElement; open: boolean }, key: string, shown: number, unit: string) => {
      if (shown <= 3) return;
      this.moreLink(k.el.createDiv({ cls: "vp-card-foot" }), k.open ? "收起" : `展开 ${fmtFull(shown)} ${unit}`, () => {
        this.checkupOpen = k.open ? null : key;
        this.rerender("checkup", "resize");
      });
    };

    // 断链：按出现次数排；新建笔记用 Obsidian 自己的规则（和点断链时一样）
    const u = col("unresolved", "断链", c.unresolvedCount, "warn", "没有断开的链接");
    for (const x of c.unresolved.slice(0, u.limit)) {
      item(u.list, `[[${x.name}]] · ${x.count} 处`, x.name, () => this.plugin.openSearch(`"[[${x.name}]]"`), "创建笔记", () => {
        void this.app.workspace.openLinkText(x.name, x.source ?? "", "tab");
      });
    }
    foot(u, "unresolved", c.unresolved.length, "个");

    // 孤立笔记
    const o = col("orphans", "孤立笔记", c.orphans.length, "", "每篇笔记都连上了");
    for (const f of c.orphans.slice(0, o.limit)) {
      item(o.list, f.basename, f.basename, () => void this.plugin.openFile(f), "打开", () => void this.plugin.openFile(f));
    }
    foot(o, "orphans", c.orphans.length, "篇");

    // 重复内容
    if (dupOn) {
      const n = dup ? dup.groups.length : 0;
      const d = col("dupes", "重复内容", n, "warn", dd.scanning ? "正在扫描…" : dd.analysis ? "没有重复内容" : "还没扫描过");
      if (!dd.analysis && !dd.scanning) {
        item(d.list, "扫描只读，不会改动笔记", "", null, "开始扫描", () => void dd.openReport(true));
      }
      if (dup) {
        for (const g of dup.groups.slice(0, d.limit)) {
          const first = g.occs[0];
          const name = first ? `${first.path.split("/").pop()?.replace(/\.md$/, "")} 等 ${g.occs.length} 篇` : `${g.occs.length} 篇`;
          item(d.list, name, name, () => void dd.openReport(false), "保留最早", () => dd.startCleanup([groupItem(g, 0)], "mark"));
        }
      }
      if (n > 3) this.moreLink(d.el.createDiv({ cls: "vp-card-foot" }), `全部 ${fmtFull(n)} 段`, () => void dd.openReport(false));
      if (dd.stale && dd.analysis) d.el.createDiv({ cls: "vp-checkup-note", text: "笔记有改动，建议重新扫描" });
    }

    // 空笔记与超大笔记
    const eb = c.empty.length + c.big.length;
    const e = col("emptybig", "空笔记与超大笔记", eb, "", "没有空笔记或超大笔记");
    let shown = 0;
    for (const f of c.empty) {
      if (shown++ >= e.limit) break;
      item(e.list, `${f.file.basename} · 0 字`, f.file.basename, () => void this.plugin.openFile(f.file), "删除", () => this.trashNote(f.file));
    }
    for (const f of c.big) {
      if (shown++ >= e.limit) break;
      const folder = f.folder === "(根目录)" ? null : f.folder;
      item(
        e.list,
        `${f.file.basename} · ${fmtNum(f.words)} 字`,
        f.file.basename,
        () => void this.plugin.openFile(f.file),
        folder ? "整夹不计入" : "打开",
        () => (folder ? void this.plugin.setClippingFolder(folder) : void this.plugin.openFile(f.file))
      );
    }
    foot(e, "emptybig", eb, "篇");
  }

  /** 删除前确认；进系统 / Obsidian 回收站（按用户的“删除文件”设置），可以找回 */
  private trashNote(file: TFile) {
    new ConfirmModal(this.app, "删除空笔记", `“${file.basename}” 没有任何内容。删除后会进回收站，可以从回收站找回。`, "删除", async () => {
      await this.app.fileManager.trashFile(file);
    }).open();
  }

  /* ---------- 9. 写作回顾 ---------- */

  private renderReports(grid: HTMLElement) {
    if (!this.stats) return;
    const { head, body } = this.card(grid, "vp-report-card", "写作回顾", "notebook-pen");
    const aside = head.createDiv({ cls: "vp-card-aside vp-report-head-actions" });
    aside.createSpan({ cls: "vp-report-hint", text: "先预览，再保存为笔记" });
    const toggle = aside.createEl("button", { cls: "vp-report-toggle", attr: { type: "button" } });
    const chevron = toggle.createSpan({ cls: "vp-report-chevron", attr: { "aria-hidden": "true" } });
    const label = toggle.createSpan();
    const detailPanels: HTMLElement[] = [];
    const rows = body.createDiv({ cls: "vp-report-rows" });
    const settings = this.plugin.settings;
    const shortDate = (date: Date) => `${date.getMonth() + 1}月${date.getDate()}日`;
    for (const kind of ["week", "month"] as const) {
      const weekly = kind === "week";
      const title = weekly ? "周报" : "月报";
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
      const generate = actions.createEl("button", { cls: "vp-btn is-compact is-primary vp-report-generate", text: "生成", attr: {
        type: "button", "aria-label": `生成${title}`,
      } });
      generate.addEventListener("click", () => void this.plugin.openWritingReport(kind));
      const data = row.createDiv({ cls: "vp-report-summary" });
      const totalBlock = data.createDiv({ cls: "vp-report-total" });
      totalBlock.createDiv({ cls: "vp-report-metric-label", text: total.label });
      const totalValue = totalBlock.createDiv({ cls: "vp-report-metric-value" });
      const words = totalValue.createSpan({ cls: "vp-report-words" });
      words.createSpan({ cls: "vp-report-number", text: total.value });
      words.createSpan({ cls: "vp-report-unit", text: "字" });
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
        goalBlock.createDiv({ cls: "vp-report-metric-label", text: `目标 ${Math.round(progress)}%` });
        const goalValue = goalBlock.createDiv({ cls: "vp-report-metric-value" });
        const meter = goalValue.createDiv({ cls: "vp-report-meter", attr: {
          role: "progressbar", "aria-label": "每周字数目标", "aria-valuemin": "0", "aria-valuemax": String(goal),
          "aria-valuenow": String(Math.min(summary.words, goal)), "aria-valuetext": `已写 ${fmtFull(summary.words)} 字，目标 ${fmtFull(goal)} 字`,
        } });
        meter.createDiv({ cls: "vp-report-fill" }).setCssProps({ "--vp-report-progress": `${progress}%` });
      }
      if (!weekly) {
        const days = addDays(period.end, -1).getDate();
        const elapsed = summary.elapsedDays;
        const progress = elapsed / days * 100;
        const monthBlock = data.createDiv({ cls: "vp-report-goal vp-report-month-progress" });
        monthBlock.createDiv({ cls: "vp-report-metric-label", text: `本月进度 ${Math.round(progress)}%` });
        const monthValue = monthBlock.createDiv({ cls: "vp-report-metric-value" });
        const meter = monthValue.createDiv({ cls: "vp-report-meter", attr: {
          role: "progressbar", "aria-label": "本月进度", "aria-valuemin": "0", "aria-valuemax": String(days),
          "aria-valuenow": String(elapsed), "aria-valuetext": `第 ${elapsed} / ${days} 天`,
        } });
        meter.createDiv({ cls: "vp-report-fill" }).setCssProps({ "--vp-report-progress": `${progress}%` });
        monthBlock.createDiv({ cls: "vp-report-progress-detail", text: `第 ${elapsed} / ${days} 天` });
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
      label.setText(settings.reportWeekExpanded ? "收起" : "展开");
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
      recent.createSpan({ cls: "vp-report-recent-label", text: "上次生成：" });
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
  new Notice("Note Pulse：统计出错，详情见开发者控制台");
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
