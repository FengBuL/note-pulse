import { ItemView, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type NotePulsePlugin from "./main";
import { GroupStat, TaskInfo, VaultStats, addDays, dayKey, pad2, startOfDay } from "./stats";
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
  private metric: Metric = "words";
  private taskTab: TaskTab = "due";
  private tagTab: TagTab = "tags";
  private linkTab: LinkTab = "top";
  private selectedDay: string | null = null;
  private bodyEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private subtitleEl!: HTMLElement;
  private refreshBtn!: HTMLElement;
  private observers: ResizeObserver[] = [];

  constructor(leaf: WorkspaceLeaf, plugin: NotePulsePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_PULSE;
  }
  getDisplayText(): string {
    return "仓库看板";
  }
  getIcon(): string {
    return "layout-dashboard";
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("vp-root");
    const shell = root.createDiv({ cls: "vp-shell" });

    const header = shell.createDiv({ cls: "vp-header" });
    const titleWrap = header.createDiv({ cls: "vp-header-text" });
    titleWrap.createEl("h1", { cls: "vp-title", text: "仓库看板" });
    this.subtitleEl = titleWrap.createDiv({ cls: "vp-subtitle" });
    this.updateSubtitle();

    const actions = header.createDiv({ cls: "vp-header-actions" });
    this.statusEl = actions.createSpan({ cls: "vp-status" });
    this.refreshBtn = this.iconButton(actions, "refresh-cw", "刷新数据", () => this.plugin.requestRefresh(true));
    this.iconButton(actions, "settings", "看板设置", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const setting = (this.app as any).setting;
      if (setting) {
        setting.open();
        setting.openTabById(this.plugin.manifest.id);
      }
    });

    this.bodyEl = shell.createDiv({ cls: "vp-body" });

    if (this.plugin.lastStats) this.render(this.plugin.lastStats);
    else this.showLoading("正在统计…");
    this.plugin.requestRefresh(false);
  }

  async onClose() {
    this.disconnectObservers();
    this.contentEl.empty();
  }

  private disconnectObservers() {
    for (const o of this.observers) o.disconnect();
    this.observers = [];
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
      const l = this.bodyEl.createDiv({ cls: "vp-loading" });
      l.createDiv({ cls: "vp-spinner" });
      l.createDiv({ text: msg });
    }
    this.statusEl.setText(msg);
  }

  setProgress(done: number, total: number) {
    const msg = `正在读取笔记 ${done}/${total}`;
    this.statusEl.setText(msg);
    if (!this.plugin.lastStats) {
      const t = this.bodyEl.querySelector(".vp-loading div:last-child");
      if (t) t.textContent = msg;
    }
  }

  /* ================= 渲染 ================= */

  render(stats: VaultStats) {
    const scrollTop = this.contentEl.scrollTop;
    this.disconnectObservers();
    this.refreshBtn?.removeClass("is-spinning");
    const d = new Date(stats.generatedAt);
    this.statusEl.setText(`更新于 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`);
    this.statusEl.setAttr("title", `统计耗时 ${stats.durationMs} ms`);
    this.updateSubtitle();

    const body = this.bodyEl;
    body.empty();
    const grid = body.createDiv({ cls: "vp-grid" });
    const ck = this.computeCheckin(stats);

    this.renderHero(grid, stats, ck);
    this.renderKpis(grid, stats);
    this.renderHeatmap(grid, stats, ck);
    this.renderTrend(grid, stats);
    this.renderTasks(grid, stats);
    this.renderTags(grid, stats);
    this.renderLinks(grid, stats);

    this.contentEl.scrollTop = scrollTop;
  }

  /* ---------- 通用组件 ---------- */

  private card(parent: HTMLElement, cls: string, title: string, icon: string): { el: HTMLElement; head: HTMLElement; body: HTMLElement } {
    const el = parent.createDiv({ cls: `vp-card ${cls}` });
    const head = el.createDiv({ cls: "vp-card-head" });
    const h = head.createDiv({ cls: "vp-card-title" });
    setIcon(h.createSpan({ cls: "vp-card-icon" }), icon);
    h.createSpan({ text: title });
    const body = el.createDiv({ cls: "vp-card-body" });
    return { el, head, body };
  }

  private segmented<T extends string | number>(parent: HTMLElement, options: [T, string][], current: T, onChange: (v: T) => void) {
    const seg = parent.createDiv({ cls: "vp-seg", attr: { role: "tablist" } });
    for (const [v, label] of options) {
      const b = seg.createEl("button", { cls: "vp-seg-btn" + (v === current ? " is-active" : ""), text: label });
      b.addEventListener("click", () => {
        if (v !== current) onChange(v);
      });
    }
    return seg;
  }

  private empty(parent: HTMLElement, icon: string, text: string) {
    const e = parent.createDiv({ cls: "vp-empty" });
    setIcon(e.createDiv({ cls: "vp-empty-icon" }), icon);
    e.createDiv({ cls: "vp-empty-text", text });
  }

  private noteRow(parent: HTMLElement, file: TFile, meta?: string, line?: number): HTMLElement {
    const row = parent.createDiv({ cls: "vp-row is-clickable" });
    row.createSpan({ cls: "vp-row-name", text: file.basename, attr: { title: file.path } });
    if (meta) row.createSpan({ cls: "vp-row-meta", text: meta });
    row.addEventListener("click", (e) => this.plugin.openFile(file, line, e));
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
      this.observers.push(ro);
    }
  }

  /* ---------- 打卡计算 ---------- */

  private computeCheckin(s: VaultStats): Checkin {
    const goal = this.plugin.settings.dailyWordGoal;
    const today = startOfDay(Date.now());
    const todayKey = dayKey(today);
    const isActive = (k: string) => {
      const w = s.dayWords[k] || 0;
      return (goal > 0 ? w >= goal : w > 0) || !!s.dailyNotes[k];
    };
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

  /* ---------- 1. 焦点：今日写作 ---------- */

  private renderHero(grid: HTMLElement, s: VaultStats, ck: Checkin) {
    const goal = this.plugin.settings.dailyWordGoal;
    const hero = grid.createDiv({ cls: "vp-card vp-hero" });
    const todayDone = ck.isActive(ck.todayKey);

    const head = hero.createDiv({ cls: "vp-hero-head" });
    const ht = head.createDiv({ cls: "vp-card-title" });
    setIcon(ht.createSpan({ cls: "vp-card-icon" }), "pencil");
    ht.createSpan({ text: "今日写作" });
    const pill = head.createDiv({ cls: "vp-pill " + (todayDone ? "is-success" : "is-muted") });
    setIcon(pill.createSpan({ cls: "vp-pill-icon" }), todayDone ? "check" : "clock");
    pill.createSpan({ text: todayDone ? "今日已打卡" : "今天还没打卡" });

    const main = hero.createDiv({ cls: "vp-hero-main" });

    // 左：今日字数 / 目标 圆环
    const ratio = goal > 0 ? ck.todayWords / goal : ck.todayWords > 0 ? 1 : 0;
    const center = drawRing(main, ratio, 132, 12, "vp-hero-ring" + (ratio >= 1 ? " is-complete" : ""));
    bigNumber(center, ck.todayWords, undefined, "vp-num vp-ring-num");
    center.createDiv({ cls: "vp-ring-caption", text: goal > 0 ? `目标 ${fmtNum(goal)} 字` : "今日字数" });

    // 右：连续打卡
    const streak = main.createDiv({ cls: "vp-hero-streak" });
    streak.createDiv({ cls: "vp-label", text: "连续打卡" });
    bigNumber(streak, String(ck.current), "天", "vp-num vp-num-hero");
    const note = streak.createDiv({ cls: "vp-hero-note" });
    if (goal > 0 && ck.todayWords < goal) note.setText(`距离今日目标还差 ${fmtFull(goal - ck.todayWords)} 字`);
    else if (goal > 0) note.setText(`已完成今日目标的 ${Math.round(ratio * 100)}%`);
    else note.setText(ck.todayWords > 0 ? "今天已经动笔了" : "写点什么吧");

    const week = streak.createDiv({ cls: "vp-week" });
    for (const day of ck.last7) {
      const c = week.createDiv({ cls: "vp-week-day" + (day.active ? " is-active" : "") + (day.isToday ? " is-today" : "") });
      const dot = c.createDiv({ cls: "vp-week-dot", attr: { "aria-label": `${day.key}${day.active ? " 已打卡" : " 未打卡"}` } });
      if (day.active) setIcon(dot, "check");
      c.createDiv({ cls: "vp-week-label", text: day.isToday ? "今" : day.label });
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
    stat("最长连续", String(ck.longest), "天");
    stat("近一年打卡", String(ck.activeDays), "天");
    const diary = stat("本月日记", String(ck.diaryMonth), "篇");
    const todayDiary = s.dailyNotes[ck.todayKey];
    if (todayDiary) {
      diary.addClass("is-clickable");
      diary.setAttr("aria-label", "打开今天的日记");
      diary.addEventListener("click", (e) => this.plugin.openFile(todayDiary, undefined, e));
    }
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
      if (f.created >= d30) {
        n30++;
        w30 += f.words;
      } else if (f.created >= d60) {
        nPrev++;
        wPrev += f.words;
      }
    }

    // 近 12 周的累计曲线
    const weeks = 12;
    const weekStarts: number[] = [];
    for (let i = weeks - 1; i >= 0; i--) weekStarts.push(addDays(today, -7 * i + 1).getTime());
    const sorted = [...s.files].sort((a, b) => a.created - b.created);
    const cumNotes: number[] = [],
      cumWords: number[] = [];
    let p = 0,
      cn = 0,
      cw = 0;
    for (const end of weekStarts) {
      while (p < sorted.length && sorted[p].created < end) {
        cn++;
        cw += sorted[p].words;
        p++;
      }
      cumNotes.push(cn);
      cumWords.push(cw);
    }

    const kpi = (icon: string, label: string) => {
      const c = wrap.createDiv({ cls: "vp-card vp-kpi" });
      const top = c.createDiv({ cls: "vp-kpi-top" });
      setIcon(top.createSpan({ cls: "vp-kpi-icon" }), icon);
      top.createSpan({ cls: "vp-label", text: label });
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
    const a = kpi("files", "笔记");
    bigNumber(a, s.totalNotes, "篇");
    delta(a, n30, nPrev, `近 30 天新建 ${fmtFull(n30)} 篇`);
    drawSparkline(a.createDiv({ cls: "vp-kpi-viz" }), cumNotes);

    // 字数
    const b = kpi("type", "总字数");
    bigNumber(b, s.totalWords, "字");
    delta(b, w30, wPrev, `近 30 天新增 ${fmtNum(w30)} 字`);
    drawSparkline(b.createDiv({ cls: "vp-kpi-viz" }), cumWords);

    // 任务
    const t = s.tasks;
    const rate = t.total ? Math.round((t.done / t.total) * 100) : 0;
    const c = kpi("list-checks", "任务完成率");
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
    const dd = kpi("link", "链接");
    bigNumber(dd, s.totalLinks, "条");
    const ld = dd.createDiv({ cls: "vp-kpi-delta" });
    const lp = ld.createSpan({ cls: "vp-delta is-flat" });
    setIcon(lp.createSpan({ cls: "vp-delta-icon" }), "unlink");
    lp.createSpan({ text: `孤立 ${fmtFull(s.links.orphans.length)}` });
    ld.createSpan({
      cls: "vp-kpi-caption",
      text: `平均每篇 ${(s.totalLinks / Math.max(1, s.totalNotes)).toFixed(1)} 条`,
    });
    this.meter(dd.createDiv({ cls: "vp-kpi-viz" }), conn, "", `连通率 ${Math.round(conn * 100)}%`);
  }

  private meter(parent: HTMLElement, ratio: number, cls: string, label?: string) {
    const m = parent.createDiv({ cls: "vp-meter-wrap" });
    if (label) m.createDiv({ cls: "vp-meter-label", text: label });
    const track = m.createDiv({ cls: `vp-meter ${cls}` });
    track.createDiv({ cls: "vp-meter-fill" }).style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
  }

  /* ---------- 3. 热力图 ---------- */

  private renderHeatmap(grid: HTMLElement, s: VaultStats, ck: Checkin) {
    const { el, head, body } = this.card(grid, "vp-heat-card", "写作热力图", "calendar-days");
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
    const goal = this.plugin.settings.dailyWordGoal;
    const mode = this.plugin.settings.heatmapMode === "delta" ? "按每日新增字数" : "按笔记修改日";
    foot.createDiv({ cls: "vp-heat-mode", text: `${mode}${goal > 0 ? ` · 目标 ${fmtNum(goal)} 字/天` : ""}` }).setAttr(
      "aria-label",
      this.plugin.settings.heatmapMode === "delta"
        ? "每日新增字数：从启用插件那天开始累积。写了日记的日子也算打卡。"
        : "笔记全文字数计入其最后修改日，可在设置中切换为“每日新增字数”。写了日记的日子也算打卡。"
    );

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
        this.render(s);
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
    const q = (p: number) => (values.length ? values[Math.min(values.length - 1, Math.floor(values.length * p))] : 1);
    const levelOf = (w: number, k: string): number => {
      if (w <= 0) return s.dailyNotes[k] ? 1 : 0;
      if (goal > 0) {
        if (w < goal / 2) return 1;
        if (w < goal) return 2;
        if (w < goal * 3) return 3;
        return 4;
      }
      if (w <= q(0.25)) return 1;
      if (w <= q(0.5)) return 2;
      if (w <= q(0.75)) return 3;
      return 4;
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
        rect.addEventListener("mouseenter", () => {
          const rows = [
            { label: "写作", value: `${fmtFull(words)} 字` },
            { label: "修改笔记", value: `${s.dayModified[k]?.length || 0} 篇` },
            { label: "新建笔记", value: `${s.dayCreated[k] || 0} 篇` },
          ];
          if (s.dailyNotes[k]) rows.push({ label: "日记", value: "有" });
          const [yy, mm, dd] = k.split("-").map(Number);
          const rr = rect.getBoundingClientRect();
          tip.showAtClient(rr.left + rr.width / 2, rr.top, `${yy}年${mm}月${dd}日 周${WEEKDAYS[day.getDay()]}${ck.isActive(k) ? " · 已打卡" : ""}`, rows);
        });
        rect.addEventListener("mouseleave", () => tip.hide());
        rect.addEventListener("click", () => {
          this.selectedDay = this.selectedDay === k ? null : k;
          this.render(s);
        });
      }
    }
    return weeks;
  }

  /* ---------- 4. 趋势 ---------- */

  private renderTrend(grid: HTMLElement, s: VaultStats) {
    const { head, body } = this.card(grid, "vp-trend-card", "增长趋势", "trending-up");
    const ctrls = head.createDiv({ cls: "vp-ctrls" });
    this.segmented<Metric>(ctrls, [["words", "字数"], ["notes", "笔记"]], this.metric, (v) => {
      this.metric = v;
      this.render(s);
    });
    this.segmented<Range>(ctrls, [[30, "30天"], [90, "90天"], [365, "1年"]], this.range, (v) => {
      this.range = v;
      this.render(s);
    });

    const isWords = this.metric === "words";
    const gran: Gran = isWords ? (this.range === 365 ? "week" : "day") : this.range === 30 ? "day" : this.range === 90 ? "week" : "month";
    const { points, added } = this.buildTrend(s, gran);

    const summary = body.createDiv({ cls: "vp-trend-summary" });
    const main = summary.createDiv({ cls: "vp-trend-main" });
    main.createDiv({ cls: "vp-label", text: isWords ? `近 ${this.rangeText()}新增字数` : `近 ${this.rangeText()}新建笔记` });
    bigNumber(main, added, isWords ? "字" : "篇", "vp-num vp-num-lg");
    const side = summary.createDiv({ cls: "vp-trend-side" });
    side.createDiv({ cls: "vp-label", text: isWords ? "累计字数" : "平均每" + (gran === "day" ? "天" : gran === "week" ? "周" : "月") });
    if (isWords) bigNumber(side, s.totalWords, "字", "vp-num vp-num-sm");
    else bigNumber(side, String(Math.round((added / Math.max(1, points.length)) * 10) / 10), "篇", "vp-num vp-num-sm");

    if (points.every((p) => p.value === 0)) {
      this.empty(body.createDiv({ cls: "vp-chart-empty" }), "line-chart", isWords ? "还没有笔记字数，开始写第一篇吧" : "这段时间还没有新建笔记");
      return;
    }
    const chartWrap = body.createDiv({ cls: "vp-chart-wrap" });
    const tip = new Tooltip(chartWrap);
    const host = chartWrap.createDiv({ cls: "vp-chart-host" });
    this.responsive(chartWrap, (w) => {
      host.empty();
      drawTrendChart(host, points, { width: w, height: 236, kind: isWords ? "area" : "bar", tooltip: tip });
    });
    body.createDiv({
      cls: "vp-foot-note",
      text: isWords ? "曲线为按笔记创建日期累计的当前字数" : `每${gran === "day" ? "天" : gran === "week" ? "周" : "月"}新建的笔记数`,
    });
  }

  private rangeText(): string {
    return this.range === 365 ? "1 年" : `${this.range} 天`;
  }

  private buildTrend(s: VaultStats, gran: Gran): { points: SeriesPoint[]; added: number } {
    const today = startOfDay(Date.now());
    const start = addDays(today, -(this.range - 1));
    const sorted = s.files.map((f) => [f.created, f.words] as [number, number]).sort((a, b) => a[0] - b[0]);
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
              { label: "累计字数", value: fmtFull(c), dot: "is-accent" },
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
    const { head, body } = this.card(grid, "vp-tasks-card", "任务", "list-todo");
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
      this.render(s);
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
        const row = list.createDiv({ cls: "vp-row is-clickable" });
        const overdue = (it.due || "") < todayKey;
        const due = it.due ? it.due.slice(5).replace("-", "/") : "";
        row.createSpan({ cls: "vp-due" + (overdue ? " is-overdue" : ""), text: due });
        const text = cleanTaskText(it.text);
        row.createSpan({ cls: "vp-row-name", text: text || "（空任务）", attr: { title: `${text}\n${it.file.path}` } });
        row.createSpan({ cls: "vp-row-meta", text: it.file.basename });
        row.addEventListener("click", (e) => this.plugin.openFile(it.file, it.line, e));
      }
      if (items.length > LIST_LIMIT) list.createDiv({ cls: "vp-more", text: `还有 ${items.length - LIST_LIMIT} 项` });
    } else {
      const groups: GroupStat[] = (this.taskTab === "folder" ? t.byFolder : t.byNote).filter((g) => g.pending > 0);
      if (groups.length === 0) {
        this.empty(list, "party-popper", "所有任务都完成了");
        return;
      }
      for (const g of groups.slice(0, LIST_LIMIT)) {
        const row = list.createDiv({ cls: "vp-row vp-group-row is-clickable" });
        row.createSpan({ cls: "vp-row-name", text: g.key, attr: { title: g.file ? g.file.path : g.key } });
        const m = row.createDiv({ cls: "vp-meter is-success is-inline" });
        m.createDiv({ cls: "vp-meter-fill" }).style.width = `${(g.done / Math.max(1, g.total)) * 100}%`;
        row.createSpan({ cls: "vp-row-meta vp-tabular", text: `待办 ${g.pending}` });
        if (g.file) {
          const f = g.file;
          row.addEventListener("click", (e) => this.plugin.openFile(f, undefined, e));
        } else if (g.key !== "(根目录)") row.addEventListener("click", () => this.plugin.revealFolder(g.key));
      }
    }
  }

  /* ---------- 6. 标签 / 文件夹 ---------- */

  private renderTags(grid: HTMLElement, s: VaultStats) {
    const { head, body } = this.card(grid, "vp-tags-card", this.tagTab === "tags" ? "标签" : "文件夹", this.tagTab === "tags" ? "tag" : "folder");
    head.createDiv({
      cls: "vp-card-aside",
      text: this.tagTab === "tags" ? `${fmtFull(s.uniqueTags)} 个 · 使用 ${fmtFull(s.tagOccurrences)} 次` : `${s.folders.length} 个顶层文件夹`,
    });
    const bar = body.createDiv({ cls: "vp-subhead" });
    this.segmented<TagTab>(bar, [["tags", "标签"], ["folders", "文件夹"]], this.tagTab, (v) => {
      this.tagTab = v;
      this.render(s);
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
    if (total > limit) body.createDiv({ cls: "vp-more", text: this.tagTab === "tags" ? `还有 ${total - limit} 个标签 · 点击标签可搜索` : `还有 ${total - limit} 个文件夹` });
  }

  /* ---------- 7. 链接 ---------- */

  private renderLinks(grid: HTMLElement, s: VaultStats) {
    const { head, body } = this.card(grid, "vp-links-card", "链接", "network");
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
      this.render(s);
    });
    const list = body.createDiv({ cls: "vp-rows" });
    if (this.linkTab === "top") {
      if (L.topLinked.length === 0) return this.empty(list, "link", "还没有双向链接，试试用 [[ ]] 连接笔记");
      for (const x of L.topLinked.slice(0, LIST_LIMIT)) this.noteRow(list, x.file, `${x.count} 次引用`);
    } else if (this.linkTab === "orphans") {
      if (L.orphans.length === 0) return this.empty(list, "sparkles", "没有孤立笔记，每篇都连上了");
      const sorted = [...L.orphans].sort((a, b) => b.stat.mtime - a.stat.mtime);
      for (const f of sorted.slice(0, LIST_LIMIT)) this.noteRow(list, f, f.parent && f.parent.path !== "/" ? f.parent.path : "根目录");
      if (sorted.length > LIST_LIMIT) list.createDiv({ cls: "vp-more", text: `还有 ${sorted.length - LIST_LIMIT} 篇（按最近修改排序）` });
    } else {
      if (L.topUnresolved.length === 0) return this.empty(list, "sparkles", "没有断开的链接");
      for (const [name, n] of L.topUnresolved.slice(0, LIST_LIMIT)) {
        const row = list.createDiv({ cls: "vp-row is-clickable" });
        row.createSpan({ cls: "vp-row-name is-unresolved", text: name });
        row.createSpan({ cls: "vp-row-meta", text: `${n} 处` });
        row.addEventListener("click", () => this.plugin.openSearch(`"[[${name}]]"`));
      }
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
  new Notice("仓库看板统计出错，详情见开发者控制台");
}
