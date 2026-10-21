import { ItemView, Notice, Platform, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type NotePulsePlugin from "./main";
import { reportPeriod, summarizeWritingDays } from "./report-logic";
import { groupKey as groupKeyOf } from "./dedupe/core/summary";
import { GroupStat, Hint, TaskInfo, VaultStats, addDays, dayKey, isCheckinDay, pad2, startOfDay } from "./stats";
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
  srLabel,
  svgEl,
} from "./charts";

export const VIEW_TYPE_PULSE = "note-pulse-view";

type Range = 30 | 90 | 365;
type Metric = "words" | "notes";
type Gran = "day" | "week" | "month";
type TaskTab = "due" | "folder" | "note";
type TagTab = "tags" | "folders";
type LinkTab = "top" | "orphans" | "unresolved";

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
const LIST_LIMIT = 6;

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
  private range: Range = 90;
  private metric: Metric = "notes";
  private taskTab: TaskTab = "due";
  private tagTab: TagTab = "tags";
  private linkTab: LinkTab = "top";
  private selectedDay: string | null = null;
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
  /** 分页卡片（任务 / 标签 / 链接）见过的最大高度：切换标签页时只增不减，避免整页高度塌缩导致滚动跳动 */
  private cardMinH = new Map<string, number>();
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
    this.keepScroll(() => this.renderNow(stats));
    this.cardMinH.clear();
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
    const grid = body.createDiv({ cls: "vp-grid" });
    this.define("hero", grid, (h) => this.renderHero(h, stats, ck));
    this.define("kpis", grid, (h) => this.renderKpis(h, stats));
    this.define("heat", grid, (h) => this.renderHeatmap(h, stats, ck));
    this.define("trend", grid, (h) => this.renderTrend(h, stats));
    this.define("tasks", grid, (h) => this.renderTasks(h, stats));
    this.define("tags", grid, (h) => this.renderTags(h, stats));
    this.define("links", grid, (h) => this.renderLinks(h, stats));
    this.define("reports", grid, (h) => this.renderReports(h));
    if (this.plugin.settings.dedupeEnabled && this.plugin.settings.dedupeCard) this.define("dedupe", grid, (h) => this.renderDedupe(h));
  }

  /** 登记并渲染一个区块；每个渲染函数必须恰好生成一个根元素 */
  private define(key: string, parent: HTMLElement, fn: (host: HTMLElement) => void) {
    this.renderers.set(key, fn);
    this.mount(key, parent, fn);
  }

  private mount(key: string, parent: HTMLElement, fn: (host: HTMLElement) => void) {
    const prev = this.currentPart;
    this.currentPart = key;
    try {
      fn(parent);
    } finally {
      this.currentPart = prev;
    }
    const el = parent.lastElementChild as HTMLElement | null;
    if (el) this.parts.set(key, el);
  }

  /**
   * 只重绘一个区块（点击标签页、切换范围时），不打断其它区块，并保持键盘焦点和滚动位置。
   * 任务 / 标签 / 链接这类分页卡片：高度只增不减，切到较短的标签页时卡片不会收缩，
   * 否则页面总高度变小，处在底部时浏览器会把滚动位置夹回去，看起来就是整页“弹”了一下。
   */
  private rerender(key: string) {
    const old = this.parts.get(key);
    const fn = this.renderers.get(key);
    if (!old || !fn || !this.stats) return;
    const focusId = (this.contentEl.ownerDocument.activeElement as HTMLElement | null)?.getAttribute("data-fid") || null;
    const sticky = key === "tasks" || key === "tags" || key === "links";
    const prevH = Math.max(this.cardMinH.get(key) ?? 0, sticky ? old.getBoundingClientRect().height : 0);
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
      if (sticky && prevH > 0) {
        fresh.addClass("vp-held-height");
        fresh.setCssProps({ "--vp-held-height": `${Math.ceil(prevH)}px` });
        this.cardMinH.set(key, Math.max(prevH, fresh.getBoundingClientRect().height));
      }
      // preventScroll：聚焦时不要让浏览器把元素滚进视野（手机上会拖着整页跳）
      if (focusId) fresh.querySelector<HTMLElement>(`[data-fid="${focusId}"]`)?.focus({ preventScroll: true });
    });
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

  /* ---------- 1. 焦点：今日写作 ---------- */

  private renderHero(grid: HTMLElement, s: VaultStats, ck: Checkin) {
    const goal = this.plugin.settings.dailyWordGoal;
    const hero = grid.createDiv({ cls: "vp-card vp-hero" });
    const todayDone = ck.isActive(ck.todayKey);

    const head = hero.createDiv({ cls: "vp-hero-head" });
    const ht = head.createDiv({ cls: "vp-card-title" });
    setIcon(ht.createSpan({ cls: "vp-card-icon" }), "pencil");
    ht.createSpan({ text: "今日写作" });
    this.help(
      ht,
      `${goal > 0 ? `当天新增字数达到每日目标（${fmtFull(goal)} 字，可在设置里改）` : "当天写了任何字"}就算打卡，写了当天的日记也算。\n连续打卡从今天往前数；今天还没写不会中断，到明天才断。`
    );
    const pill = head.createDiv({ cls: "vp-pill " + (todayDone ? "is-success" : "is-muted") });
    setIcon(pill.createSpan({ cls: "vp-pill-icon" }), todayDone ? "check" : "clock");
    pill.createSpan({ text: todayDone ? "今日已打卡" : "今天还没打卡" });

    const main = hero.createDiv({ cls: "vp-hero-main" });

    // 左：今日字数 / 目标 圆环
    const ratio = goal > 0 ? ck.todayWords / goal : ck.todayWords > 0 ? 1 : 0;
    const center = drawRing(main, ratio, 132, 12, "vp-hero-ring" + (ratio >= 1 ? " is-complete" : ""));
    const ringWrap = center.parentElement as HTMLElement;
    ringWrap.setAttr("role", "img");
    srLabel(ringWrap, goal > 0 ? `今日 ${fmtFull(ck.todayWords)} 字，目标 ${fmtFull(goal)} 字` : `今日 ${fmtFull(ck.todayWords)} 字`);
    bigNumber(center, ck.todayWords, undefined, "vp-num vp-ring-num");
    center.createDiv({ cls: "vp-ring-caption", text: goal > 0 ? `目标 ${fmtNum(goal)} 字` : "今日字数" });

    // 右：连续打卡
    const streak = main.createDiv({ cls: "vp-hero-streak" });
    streak.createDiv({ cls: "vp-label", text: "连续打卡" });
    bigNumber(streak, String(ck.current), "天", "vp-num vp-num-hero");
    const note = streak.createDiv({ cls: "vp-hero-note" });
    if (goal > 0 && ck.todayWords < goal) note.setText(`距离今日目标还差 ${fmtFull(goal - ck.todayWords)} 字`);
    else if (goal > 0) note.setText(ratio >= 2 ? `已达成今日目标，超额 ${Math.round((ratio - 1) * 100)}%` : ratio > 1 ? "已超额完成今日目标" : "今日目标已达成");
    else note.setText(ck.todayWords > 0 ? "今天已经动笔了" : "写点什么吧");

    const week = streak.createDiv({ cls: "vp-week" });
    for (const day of ck.last7) {
      const c = week.createDiv({ cls: "vp-week-day" + (day.active ? " is-active" : "") + (day.isToday ? " is-today" : "") });
      const dot = c.createDiv({ cls: "vp-week-dot", attr: { role: "img", "aria-label": `${day.key}${day.active ? " 已打卡" : " 未打卡"}` } }); // 小圆点没有别的气泡，保留 Obsidian 自带提示
      if (day.active) setIcon(dot, "check");
      c.createDiv({ cls: "vp-week-label", text: day.isToday ? "今" : day.label });
    }

    const weeklyGoal = this.plugin.settings.weeklyWordGoal;
    const weekly = summarizeWritingDays(s, this.plugin.settings, reportPeriod("week", new Date(s.generatedAt)));
    const weeklyBox = hero.createDiv({ cls: "vp-weekly-goal" });
    weeklyBox.createDiv({ cls: "vp-label", text: `本周打卡 ${weekly.checkins}/7 天 · 周一到周日` });
    if (weeklyGoal > 0) {
      weeklyBox.createDiv({ text: `本周 ${fmtFull(weekly.words)} / ${fmtFull(weeklyGoal)} 字` });
      const meter = weeklyBox.createDiv({ cls: "vp-meter", attr: {
        role: "progressbar", "aria-label": "每周字数目标", "aria-valuemin": "0",
        "aria-valuemax": String(weeklyGoal), "aria-valuenow": String(Math.min(weekly.words, weeklyGoal)),
        "aria-valuetext": `已写 ${weekly.words} 字，目标 ${weeklyGoal} 字`,
      } });
      meter.createDiv({ cls: "vp-meter-fill vp-weekly-fill" }).setCssProps({ "--vp-weekly-progress": `${Math.min(100, weekly.words / weeklyGoal * 100)}%` });
    }

    // 底部统计
    const foot = hero.createDiv({ cls: "vp-hero-foot" });
    const stat = (label: string, value: string, unit: string) => {
      const x = foot.createDiv({ cls: "vp-hero-stat" });
      x.createDiv({ cls: "vp-label", text: label });
      const v = x.createDiv({ cls: "vp-hero-stat-value" });
      v.createSpan({ text: value });
      v.createSpan({ cls: "vp-num-unit", text: unit });
      return x;
    };
    stat("近一年最长连续", String(ck.longest), "天");
    stat("近一年打卡", String(ck.activeDays), "天");
    const diary = stat("本月日记", String(ck.diaryMonth), "篇");
    const todayDiary = s.dailyNotes[ck.todayKey];
    if (todayDiary) this.clickable(diary, "打开今天的日记", (e) => void this.plugin.openFile(todayDiary, undefined, e));
  }

  /* ---------- 2. KPI ---------- */

  private renderKpis(grid: HTMLElement, s: VaultStats) {
    const wrap = grid.createDiv({ cls: "vp-kpis" });
    const today = startOfDay(Date.now());
    const d30 = addDays(today, -29).getTime();
    const d60 = addDays(today, -59).getTime();
    let n30 = 0,
      nPrev = 0,
      w30 = 0,
      wPrev = 0;
    for (const f of s.files) {
      if (f.collected) continue;
      if (f.created >= d30) {
        n30++;
        w30 += f.writeWords;
      } else if (f.created >= d60) {
        nPrev++;
        wPrev += f.writeWords;
      }
    }

    // 近 12 周的累计曲线
    const weeks = 12;
    const weekStarts: number[] = [];
    for (let i = weeks - 1; i >= 0; i--) weekStarts.push(addDays(today, -7 * i + 1).getTime());
    const sorted = s.files.filter((f) => !f.collected).sort((a, b) => a.created - b.created);
    const cumNotes: number[] = [],
      cumWords: number[] = [];
    let p = 0,
      cn = 0,
      cw = 0;
    for (const end of weekStarts) {
      while (p < sorted.length && sorted[p].created < end) {
        cn++;
        cw += sorted[p].writeWords;
        p++;
      }
      cumNotes.push(cn);
      cumWords.push(cw);
    }

    const kpi = (icon: string, label: string, help: string) => {
      const c = wrap.createDiv({ cls: "vp-card vp-kpi", attr: { role: "group" } });
      srLabel(c, label);
      const top = c.createDiv({ cls: "vp-kpi-top" });
      setIcon(top.createSpan({ cls: "vp-kpi-icon" }), icon);
      top.createSpan({ cls: "vp-label", text: label });
      this.help(top, help);
      return c;
    };
    const delta = (parent: HTMLElement, cur: number, prev: number, caption: string) => {
      const row = parent.createDiv({ cls: "vp-kpi-delta" });
      if (prev > 0 || cur > 0) {
        const pct = prev > 0 ? Math.round(((cur - prev) / prev) * 100) : 100;
        const up = cur >= prev;
        const pill = row.createSpan({ cls: "vp-delta " + (cur === prev ? "is-flat" : up ? "is-up" : "is-down") });
        setIcon(pill.createSpan({ cls: "vp-delta-icon" }), cur === prev ? "minus" : up ? "trending-up" : "trending-down");
        pill.createSpan({ text: prev > 0 ? `${Math.abs(pct)}%` : "新增" });
        pill.setAttr("aria-label", `与前 30 天相比（${fmtFull(prev)} → ${fmtFull(cur)}）`);
      }
      row.createSpan({ cls: "vp-kpi-caption", text: caption });
    };

    // 笔记
    const a = kpi("files", "笔记", "统计所有未被排除的 Markdown 笔记。曲线是近 12 周的累计新建数（不含采集文件夹）；百分比是近 30 天与前 30 天相比的变化。");
    bigNumber(a, s.totalNotes, "篇");
    delta(a, n30, nPrev, `近 30 天新建 ${fmtFull(n30)} 篇`);
    drawSparkline(a.createDiv({ cls: "vp-kpi-viz" }), cumNotes);

    // 字数
    const skipped = s.totalWords - s.writeWordsTotal;
    const b = kpi(
      "type",
      "总字数",
      `所有笔记的字数合计。曲线是近 12 周累计的写作字数；百分比是近 30 天与前 30 天相比的变化。${
        skipped > 0 ? `\n其中 ${fmtNum(skipped)} 字来自采集文件夹或超大笔记，不计入趋势图、热力图和“新增字数”，可在设置里调整。` : ""
      }`
    );
    bigNumber(b, s.totalWords, "字");
    delta(b, w30, wPrev, `近 30 天新增 ${fmtNum(w30)} 字`);
    drawSparkline(b.createDiv({ cls: "vp-kpi-viz" }), cumWords);

    // 任务
    const t = s.tasks;
    const rate = t.total ? Math.round((t.done / t.total) * 100) : 0;
    const c = kpi("list-checks", "任务完成率", "已完成任务占全部任务的比例，已取消的任务不计。逾期指截止日期（📅 或 [due::]）早于今天、还没完成的任务。");
    bigNumber(c, t.total ? String(rate) : "—", t.total ? "%" : "");
    const cd = c.createDiv({ cls: "vp-kpi-delta" });
    const op = cd.createSpan({ cls: "vp-delta " + (t.overdue.length ? "is-down" : "is-up") });
    setIcon(op.createSpan({ cls: "vp-delta-icon" }), t.overdue.length ? "alarm-clock" : "check");
    op.createSpan({ text: t.overdue.length ? `逾期 ${t.overdue.length}` : "无逾期" });
    cd.createSpan({ cls: "vp-kpi-caption", text: `${fmtFull(t.done)} / ${fmtFull(t.total)} 已完成` });
    this.meter(c.createDiv({ cls: "vp-kpi-viz" }), t.total ? t.done / t.total : 0, "is-success");

    // 链接
    const linked = s.totalNotes - s.links.orphans.length;
    const conn = s.totalNotes ? linked / s.totalNotes : 0;
    const dd = kpi(
      "link",
      "链接",
      `笔记之间的链接总数。孤立指没有任何链接指向它、它也没有链到别处的笔记。\n底部进度条是连通率：有链接的笔记占全部笔记的比例，现在是 ${Math.round(conn * 100)}%。`
    );
    bigNumber(dd, s.totalLinks, "条");
    const ld = dd.createDiv({ cls: "vp-kpi-delta" });
    const lp = ld.createSpan({ cls: "vp-delta is-flat" });
    setIcon(lp.createSpan({ cls: "vp-delta-icon" }), "unlink");
    lp.createSpan({ text: `孤立 ${fmtFull(s.links.orphans.length)}` });
    ld.createSpan({
      cls: "vp-kpi-caption",
      text: `平均每篇 ${(s.totalLinks / Math.max(1, s.totalNotes)).toFixed(1)} 条`,
    });
    this.meter(dd.createDiv({ cls: "vp-kpi-viz" }), conn, "");
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
    const rangeLabel = head.createDiv({ cls: "vp-card-aside" });
    const summary = body.createDiv({ cls: "vp-trend-summary" });
    const wrap = body.createDiv({ cls: "vp-heatmap-wrap" });
    const tip = new Tooltip(wrap);
    const svgHost = wrap.createDiv({ cls: "vp-heatmap-host" });
    this.responsive(wrap, (w) => {
      svgHost.empty();
      const weeks = this.drawHeatmap(svgHost, s, ck, w, tip);
      rangeLabel.setText(`近 ${weeks} 周`);
      // 与右侧趋势卡对齐的摘要行
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
      const m = summary.createDiv({ cls: "vp-trend-main" });
      m.createDiv({ cls: "vp-label", text: "期间写作" });
      bigNumber(m, total, "字", "vp-num vp-num-lg");
      const a = summary.createDiv({ cls: "vp-trend-side" });
      a.createDiv({ cls: "vp-label", text: "打卡天数" });
      bigNumber(a, String(active), `/ ${days} 天`, "vp-num vp-num-sm");
      const b = summary.createDiv({ cls: "vp-trend-side" });
      b.createDiv({ cls: "vp-label", text: "日均" });
      bigNumber(b, Math.round(total / Math.max(1, days)), "字", "vp-num vp-num-sm");
    });

    const foot = body.createDiv({ cls: "vp-heat-foot" });
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
        this.rerender("heat");
      });
      const list = det.createDiv({ cls: "vp-rows" });
      if (s.dailyNotes[k]) this.noteRow(list, s.dailyNotes[k], "日记");
      const mods = (s.dayModified[k] || []).filter((f) => f !== s.dailyNotes[k]);
      for (const f of mods.slice(0, 8)) this.noteRow(list, f, "当天修改");
      if (mods.length > 8) list.createDiv({ cls: "vp-more", text: `还有 ${mods.length - 8} 篇` });
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
    const targetCell = 15;
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
          this.rerender("heat");
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
        this.rerender("heat");
      } else if (e.key === "Escape") {
        tip.hide();
      }
    });
    return weeks;
  }

  /* ---------- 4. 趋势 ---------- */

  private renderTrend(grid: HTMLElement, s: VaultStats) {
    const gran0: Gran = this.range === 365 ? "week" : "day";
    const trendHelp =
      this.metric === "words"
        ? "按笔记的创建日期累计，用的是笔记“当前”的字数：之后修改旧笔记会改变历史曲线。"
        : `每${gran0 === "day" ? "天" : "周"}新建的笔记数（不含采集文件夹）。`;
    const { head, body } = this.card(grid, "vp-trend-card", "增长趋势", "trending-up", trendHelp);
    const ctrls = head.createDiv({ cls: "vp-ctrls" });
    this.segmented<Metric>(
      ctrls,
      [["notes", "新建笔记"], ["words", "累计字数"]],
      this.metric,
      (v) => {
        this.metric = v;
        this.rerender("trend");
      },
      "指标"
    );
    this.segmented<Range>(
      ctrls,
      [[30, "30天"], [90, "90天"], [365, "1年"]],
      this.range,
      (v) => {
        this.range = v;
        this.rerender("trend");
      },
      "时间范围"
    );

    const isWords = this.metric === "words";
    const gran: Gran = this.range === 365 ? "week" : "day";
    const unitText = gran === "day" ? "天" : "周";
    const { points, added } = this.buildTrend(s, gran);

    const summary = body.createDiv({ cls: "vp-trend-summary" });
    const main = summary.createDiv({ cls: "vp-trend-main" });
    main.createDiv({ cls: "vp-label", text: isWords ? `近 ${this.rangeText()}新增字数` : `近 ${this.rangeText()}新建笔记` });
    bigNumber(main, added, isWords ? "字" : "篇", "vp-num vp-num-lg");
    const side = summary.createDiv({ cls: "vp-trend-side" });
    side.createDiv({ cls: "vp-label", text: isWords ? "累计字数（写作口径）" : `平均每${unitText}` });
    if (isWords) bigNumber(side, s.writeWordsTotal, "字", "vp-num vp-num-sm");
    else bigNumber(side, String(Math.round((added / Math.max(1, points.length)) * 10) / 10), "篇", "vp-num vp-num-sm");

    if (points.every((p) => p.value === 0)) {
      this.empty(body.createDiv({ cls: "vp-chart-empty" }), "line-chart", isWords ? "还没有笔记字数，开始写第一篇吧" : "这段时间还没有新建笔记");
    } else {
      const chartWrap = body.createDiv({ cls: "vp-chart-wrap" });
      const tip = new Tooltip(chartWrap);
      const host = chartWrap.createDiv({ cls: "vp-chart-host" });
      const last = points[points.length - 1];
      host.setAttr("role", "img");
      srLabel(
        host,
        isWords
          ? `累计字数曲线，近 ${this.rangeText()}新增 ${fmtFull(added)} 字，当前累计 ${fmtFull(last.value)} 字`
          : `新建笔记柱状图，近 ${this.rangeText()}共新建 ${fmtFull(added)} 篇`,
        chartWrap
      );
      this.responsive(chartWrap, (w) => {
        host.empty();
        drawTrendChart(host, points, { width: w, height: 236, kind: isWords ? "area" : "bar", tooltip: tip });
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

  private rangeText(): string {
    return this.range === 365 ? "1 年" : `${this.range} 天`;
  }

  private buildTrend(s: VaultStats, gran: Gran): { points: SeriesPoint[]; added: number } {
    const today = startOfDay(Date.now());
    const start = addDays(today, -(this.range - 1));
    const sorted = s.files.filter((f) => !f.collected).map((f) => [f.created, f.writeWords] as [number, number]).sort((a, b) => a[0] - b[0]);
    let ptr = 0,
      cum = 0;
    const cumUntil = (endExclusive: number) => {
      while (ptr < sorted.length && sorted[ptr][0] < endExclusive) {
        cum += sorted[ptr][1];
        ptr++;
      }
      return cum;
    };
    const base = cumUntil(start.getTime());

    type Bucket = { key: string; label: string; start: Date; end: Date; count: number };
    const buckets: Bucket[] = [];
    let cur: Bucket | null = null;
    for (let d = new Date(start); d.getTime() <= today.getTime(); d = addDays(d, 1)) {
      let key: string, label: string, bs: Date;
      if (gran === "day") {
        key = dayKey(d);
        bs = d;
        label = `${d.getMonth() + 1}/${d.getDate()}`;
      } else if (gran === "week") {
        bs = addDays(d, -((d.getDay() + 6) % 7));
        key = dayKey(bs);
        label = `${bs.getMonth() + 1}/${bs.getDate()}`;
      } else {
        bs = new Date(d.getFullYear(), d.getMonth(), 1);
        key = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
        label = `${d.getMonth() + 1}月`;
      }
      if (!cur || cur.key !== key) {
        cur = { key, label, start: new Date(d), end: new Date(d), count: 0 };
        buckets.push(cur);
      }
      cur.end = new Date(d);
      cur.count += s.dayCreated[dayKey(d)] || 0;
    }
    const fmtDay = (d: Date) => `${d.getMonth() + 1}月${d.getDate()}日`;
    const isWords = this.metric === "words";
    let added = 0;
    const points = buckets.map((b) => {
      const c = cumUntil(addDays(b.end, 1).getTime());
      added += b.count;
      const title =
        gran === "day"
          ? fmtDay(b.start)
          : gran === "month"
          ? `${b.start.getFullYear()}年${b.start.getMonth() + 1}月`
          : `${fmtDay(b.start)} – ${fmtDay(b.end)}`;
      return {
        label: b.label,
        value: isWords ? c : b.count,
        tipTitle: title,
        tipRows: isWords
          ? [
              { label: "累计字数（当前字数口径）", value: fmtFull(c), dot: "is-accent" },
              { label: "新建笔记", value: `${b.count} 篇` },
            ]
          : [
              { label: "新建笔记", value: `${b.count} 篇`, dot: "is-accent" },
              { label: "累计字数", value: fmtNum(c) },
            ],
      };
    });
    return { points, added: isWords ? cum - base : added };
  }

  /* ---------- 5. 任务 ---------- */

  private renderTasks(grid: HTMLElement, s: VaultStats) {
    const { head, body } = this.card(
      grid,
      "vp-tasks-card",
      "任务",
      "list-todo",
      "统计笔记里的待办（- [ ] / - [x]）。完成率不含已取消的任务。逾期指截止日期（📅 或 [due::]）早于今天；7 天内到期指截止日期在今天起 7 天内。"
    );
    const t = s.tasks;
    if (t.total === 0 && t.cancelled === 0) {
      head.createDiv({ cls: "vp-card-aside", text: "0 项" });
      this.empty(body, "list-checks", "还没有任务。在笔记里写 - [ ] 就会出现在这里");
      return;
    }
    head.createDiv({ cls: "vp-card-aside", text: `共 ${fmtFull(t.total)} 项` });

    const top = body.createDiv({ cls: "vp-task-top" });
    const ratio = t.total ? t.done / t.total : 0;
    const center = drawRing(top, ratio, 96, 10, "vp-task-ring");
    bigNumber(center, String(Math.round(ratio * 100)), "%", "vp-num vp-ring-num-sm");
    const legend = top.createDiv({ cls: "vp-stat-list" });
    const stat = (cls: string, label: string, value: number) => {
      const r = legend.createDiv({ cls: "vp-stat" });
      r.createSpan({ cls: `vp-dot ${cls}` });
      r.createSpan({ cls: "vp-stat-label", text: label });
      r.createSpan({ cls: "vp-stat-value", text: fmtFull(value) });
    };
    stat("is-success", "已完成", t.done);
    stat("is-accent", "未完成", t.pending);
    stat("is-danger", "已逾期", t.overdue.length);
    stat("is-warning", "7 天内到期", t.dueSoon.length);

    const bar = body.createDiv({ cls: "vp-subhead" });
    this.segmented<TaskTab>(bar, [["due", "到期"], ["folder", "按文件夹"], ["note", "按笔记"]], this.taskTab, (v) => {
      this.taskTab = v;
      this.rerender("tasks");
    });
    const list = body.createDiv({ cls: "vp-rows" });
    const todayKey = dayKey(Date.now());

    if (this.taskTab === "due") {
      const items: TaskInfo[] = [...t.overdue, ...t.dueSoon];
      if (items.length === 0) {
        this.empty(list, "party-popper", "没有逾期或即将到期的任务");
        return;
      }
      for (const it of items.slice(0, LIST_LIMIT)) {
        const row = list.createDiv({ cls: "vp-row" });
        const overdue = (it.due || "") < todayKey;
        const due = it.due ? it.due.slice(5).replace("-", "/") : "";
        row.createSpan({ cls: "vp-due" + (overdue ? " is-overdue" : ""), text: due });
        const text = cleanTaskText(it.text);
        row.createSpan({ cls: "vp-row-name", text: text || "（空任务）", attr: { title: `${text}\n${it.file.path}` } });
        row.createSpan({ cls: "vp-row-meta", text: it.file.basename });
        this.clickable(row, `${text || "空任务"}，${it.file.basename}${overdue ? "，已逾期" : ""}`, (e) => void this.plugin.openFile(it.file, it.line, e));
      }
      if (items.length > LIST_LIMIT) list.createDiv({ cls: "vp-more", text: `还有 ${items.length - LIST_LIMIT} 项` });
    } else {
      const groups: GroupStat[] = (this.taskTab === "folder" ? t.byFolder : t.byNote).filter((g) => g.pending > 0);
      if (groups.length === 0) {
        this.empty(list, "party-popper", "所有任务都完成了");
        return;
      }
      for (const g of groups.slice(0, LIST_LIMIT)) {
        const row = list.createDiv({ cls: "vp-row vp-group-row" });
        row.createSpan({ cls: "vp-row-name", text: g.key, attr: { title: g.file ? g.file.path : g.key } });
        const m = row.createDiv({ cls: "vp-meter is-success is-inline" });
        m.createDiv({ cls: "vp-meter-fill" }).setCssProps({ "--vp-meter-width": `${(g.done / Math.max(1, g.total)) * 100}%` });
        row.createSpan({ cls: "vp-row-meta vp-tabular", text: `待办 ${g.pending}` });
        if (g.file) {
          const f = g.file;
          this.clickable(row, `${g.key}，待办 ${g.pending}`, (e) => void this.plugin.openFile(f, undefined, e));
        } else if (g.key !== "(根目录)") this.clickable(row, `${g.key}，待办 ${g.pending}`, () => this.plugin.revealFolder(g.key));
      }
    }
  }

  /* ---------- 6. 标签 / 文件夹 ---------- */

  private renderTags(grid: HTMLElement, s: VaultStats) {
    const { head, body } = this.card(
      grid,
      "vp-tags-card",
      this.tagTab === "tags" ? "标签" : "文件夹",
      this.tagTab === "tags" ? "tag" : "folder",
      this.tagTab === "tags" ? "统计笔记里的 #标签，点击标签可在搜索里查看对应的笔记。" : "按顶层文件夹统计笔记数和字数，点击可在文件列表里定位。"
    );
    head.createDiv({
      cls: "vp-card-aside",
      text: this.tagTab === "tags" ? `${fmtFull(s.uniqueTags)} 个 · 使用 ${fmtFull(s.tagOccurrences)} 次` : `${s.folders.length} 个顶层文件夹`,
    });
    const bar = body.createDiv({ cls: "vp-subhead" });
    this.segmented<TagTab>(bar, [["tags", "标签"], ["folders", "文件夹"]], this.tagTab, (v) => {
      this.tagTab = v;
      this.rerender("tags");
    });
    const limit = 7;
    let items: BarItem[];
    if (this.tagTab === "tags") {
      items = s.tags.slice(0, limit).map(([tag, n]) => ({
        label: tag,
        value: n,
        valueText: `${fmtFull(n)} 篇`,
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
      body,
      items,
      this.tagTab === "tags" ? "还没有标签。给笔记加上 #标签，这里就会热闹起来" : "仓库里还没有文件夹",
      (el) => setIcon(el.createDiv({ cls: "vp-empty-icon" }), this.tagTab === "tags" ? "tag" : "folder")
    );
    const total = this.tagTab === "tags" ? s.tags.length : s.folders.length;
    if (total > limit) body.createDiv({ cls: "vp-more", text: this.tagTab === "tags" ? `还有 ${total - limit} 个标签` : `还有 ${total - limit} 个文件夹` });
  }

  /* ---------- 7. 链接 ---------- */

  private renderLinks(grid: HTMLElement, s: VaultStats) {
    const { head, body } = this.card(
      grid,
      "vp-links-card",
      "链接",
      "network",
      "孤立笔记：没有任何链接指向它、它也没有链到别处。未解析：指向尚不存在的笔记的链接（断链）。孤立列表按最近修改排序。"
    );
    head.createDiv({ cls: "vp-card-aside", text: `${fmtFull(s.totalLinks)} 条` });
    const L = s.links;
    const orphanPct = s.totalNotes ? Math.round((L.orphans.length / s.totalNotes) * 100) : 0;

    const stats = body.createDiv({ cls: "vp-mini-stats" });
    const mini = (label: string, value: string, sub: string, cls = "") => {
      const m = stats.createDiv({ cls: `vp-mini ${cls}` });
      m.createDiv({ cls: "vp-label", text: label });
      m.createDiv({ cls: "vp-mini-value", text: value });
      m.createDiv({ cls: "vp-mini-sub", text: sub });
    };
    mini("已连接", fmtFull(s.totalNotes - L.orphans.length), "篇有链接");
    mini("孤立笔记", fmtFull(L.orphans.length), `占 ${orphanPct}%`, orphanPct > 30 ? "is-warning" : "");
    mini("未解析", fmtFull(L.unresolvedCount), "条断链", L.unresolvedCount > 0 ? "is-warning" : "");

    const bar = body.createDiv({ cls: "vp-subhead" });
    this.segmented<LinkTab>(bar, [["top", "最常被链"], ["orphans", "孤立"], ["unresolved", "未解析"]], this.linkTab, (v) => {
      this.linkTab = v;
      this.rerender("links");
    });
    const list = body.createDiv({ cls: "vp-rows" });
    if (this.linkTab === "top") {
      if (L.topLinked.length === 0) return this.empty(list, "link", "还没有双向链接，试试用 [[ ]] 连接笔记");
      for (const x of L.topLinked.slice(0, LIST_LIMIT)) this.noteRow(list, x.file, `${x.count} 次引用`);
    } else if (this.linkTab === "orphans") {
      if (L.orphans.length === 0) return this.empty(list, "sparkles", "没有孤立笔记，每篇都连上了");
      const sorted = [...L.orphans].sort((a, b) => b.stat.mtime - a.stat.mtime);
      for (const f of sorted.slice(0, LIST_LIMIT)) this.noteRow(list, f, f.parent && f.parent.path !== "/" ? f.parent.path : "根目录");
      if (sorted.length > LIST_LIMIT) list.createDiv({ cls: "vp-more", text: `还有 ${sorted.length - LIST_LIMIT} 篇` });
    } else {
      if (L.topUnresolved.length === 0) return this.empty(list, "sparkles", "没有断开的链接");
      for (const [name, n] of L.topUnresolved.slice(0, LIST_LIMIT)) {
        const row = list.createDiv({ cls: "vp-row" });
        row.createSpan({ cls: "vp-row-name is-unresolved", text: name });
        row.createSpan({ cls: "vp-row-meta", text: `${n} 处` });
        this.clickable(row, `未解析的链接 ${name}，${n} 处，点击搜索`, () => this.plugin.openSearch(`"[[${name}]]"`));
      }
    }
  }

  /* ---------- 8. 重复内容清理入口（轻量，详细功能在独立标签页） ---------- */

  private renderReports(grid: HTMLElement) {
    const { body } = this.card(grid, "vp-report-card", "写作回顾", "notebook-pen");
    body.createDiv({ cls: "vp-label", text: "把这段时间的写作整理成笔记，先预览再保存。" });
    const actions = body.createDiv({ cls: "vp-report-actions" });
    for (const kind of ["week", "month"] as const) {
      const button = actions.createEl("button", { text: kind === "week" ? "生成写作周报" : "生成写作月报" });
      button.addEventListener("click", () => void this.plugin.openWritingReport(kind));
    }
  }

  private renderDedupe(grid: HTMLElement) {
    const dd = this.plugin.dedupe;
    const el = grid.createDiv({ cls: "vp-card vp-dedupe-card" });
    setIcon(el.createSpan({ cls: "vp-dedupe-icon", attr: { "aria-hidden": "true" } }), "layers");
    const main = el.createDiv({ cls: "vp-dedupe-main" });
    const title = main.createDiv({ cls: "vp-dedupe-title" });
    title.createSpan({ text: "重复内容清理" });
    this.help(
      title,
      "同一段文字出现在好几篇笔记里（反复剪藏的文章、每天自动生成的报告、复制粘贴的模板），会让笔记库越来越乱。\n扫描只读，不会改动任何笔记；处理前会先给你看改动前后的对比，处理后随时可以撤销。"
    );
    let line = "找出在多篇笔记里重复出现的段落，先预览、再处理，可撤销。";
    if (dd.scanning) line = "正在扫描…";
    else if (dd.analysis) {
      const ignored = dd.ignoredSet();
      const n = dd.analysis.groups.filter((g) => !ignored.has(groupKeyOf(g))).length;
      line = n > 0 ? `上次扫描发现 ${fmtFull(n)} 段内容在多篇笔记里重复出现。` : "上次扫描没有发现重复内容。";
    }
    main.createDiv({ cls: "vp-dedupe-text", text: line });
    const b = el.createEl("button", { cls: "vp-btn is-compact is-primary vp-dedupe-btn", text: dd.analysis ? "查看" : "开始" });
    b.addEventListener("click", () => void dd.openReport(false));
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
