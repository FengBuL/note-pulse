/*
 * 新版本引导的界面：整屏半透明遮罩，挖一个洞高亮当前要讲的界面元素，旁边一张提示卡（第几步、标题、说明、上一步 / 下一步 / 跳过）。
 * 步骤内容和提示卡的定位在 tour-logic.ts。引导期间看板不响应点击（遮罩盖住了），由“下一步”带着走：
 * 需要编辑模式的步骤会自动进入编辑模式，需要“添加卡片”面板的步骤会自动展开面板。
 * 遮罩层放在 document.body 上而不是看板容器里：看板容器是 container-type 元素，里面的 fixed 定位会相对容器而不是窗口。
 */
import { setIcon } from "obsidian";
import { svgEl } from "./charts";
import { L } from "./i18n";
import { Rect, TourState, TourStep, TourTarget, placeCard, visibleRect } from "./tour-logic";

export interface TourHost {
  /** 引导层挂在这个文档的 body 上（弹出窗口里的看板用它自己的 document） */
  doc: Document;
  /** 把看板调到这一步要的状态 */
  apply(state: TourState): void;
  /** 找这一步要高亮的元素 */
  find(target: TourTarget): HTMLElement | null;
  /** 看板所在的面板（窗口坐标）：没有目标的步骤，提示卡在它中间 */
  bounds(): Rect | null;
  /** 引导结束：completed 为 true 是看完了，false 是中途跳过；看板据此恢复进入引导前的状态、记下已看过 */
  end(completed: boolean): void;
}

const PAD = 6;

export class Tour {
  private layer: HTMLElement | null = null;
  private card: HTMLElement | null = null;
  private cursor: HTMLElement | null = null;
  private ghost: HTMLElement | null = null;
  private index = -1;
  private step: TourStep | null = null;
  private skipped = new Set<string>();
  /** 上一次摆好的位置：没变就不再写样式，免得白白触发重绘 */
  private lastPlace = "";
  private settle: number[] = [];
  private raf = 0;
  private dirs: { next: HTMLButtonElement; prev: HTMLButtonElement } | null = null;
  private counter!: HTMLElement;
  private title!: HTMLElement;
  private bodyEl!: HTMLElement;
  private dots!: HTMLElement;

  constructor(private host: TourHost, private steps: TourStep[]) {}

  get active(): boolean {
    return this.layer !== null;
  }

  start() {
    if (this.layer) return;
    const doc = this.host.doc;
    const win = doc.defaultView as Window;
    // 带上 vp-root 是为了拿到设计令牌（颜色、圆角、阴影）
    const layer = doc.body.createDiv({ cls: "vp-tour vp-root", attr: { role: "dialog", "aria-modal": "true", "aria-label": L("新版本引导", "What is new") } });
    this.layer = layer;
    const spot = layer.createDiv({ cls: "vp-tour-spot", attr: { "aria-hidden": "true" } });
    spot.createDiv({ cls: "vp-tour-ring" });
    // 演示时跟着光标动的虚线框（代表被拖动、被拉大的卡片）：真实的卡片不动，高亮框和提示卡的位置才稳定
    this.ghost = layer.createDiv({ cls: "vp-tour-ghost", attr: { "aria-hidden": "true" } });
    this.cursor = layer.createDiv({ cls: "vp-tour-cursor", attr: { "aria-hidden": "true" } });
    const arrow = svgEl("svg", { viewBox: "0 0 24 24", width: 26, height: 26 }, this.cursor);
    svgEl("path", { d: "M5 3l14 8-6 2-3 6z", class: "vp-tour-cursor-shape" }, arrow);

    const card = layer.createDiv({ cls: "vp-tour-card" });
    this.card = card;
    const top = card.createDiv({ cls: "vp-tour-top" });
    this.counter = top.createSpan({ cls: "vp-tour-count" });
    const skip = top.createEl("button", { cls: "vp-tour-skip", attr: { type: "button", "aria-label": L("跳过引导", "Skip the guide") } });
    setIcon(skip.createSpan({ attr: { "aria-hidden": "true" } }), "x");
    skip.createSpan({ text: L("跳过", "Skip") });
    skip.addEventListener("click", () => this.finish(false));
    this.title = card.createDiv({ cls: "vp-tour-title" });
    this.bodyEl = card.createDiv({ cls: "vp-tour-body" });
    const foot = card.createDiv({ cls: "vp-tour-foot" });
    this.dots = foot.createDiv({ cls: "vp-tour-dots", attr: { "aria-hidden": "true" } });
    const btns = foot.createDiv({ cls: "vp-tour-btns" });
    const prev = btns.createEl("button", { cls: "vp-tour-btn", text: L("上一步", "Back"), attr: { type: "button" } });
    const next = btns.createEl("button", { cls: "vp-tour-btn is-primary", attr: { type: "button" } });
    prev.addEventListener("click", () => this.go(-1));
    next.addEventListener("click", () => this.go(1));
    this.dirs = { next, prev };

    doc.addEventListener("keydown", this.onKey, true);
    win.addEventListener("resize", this.schedulePlace);
    win.addEventListener("scroll", this.schedulePlace, true);
    this.show(0, 1);
  }

  destroy() {
    const doc = this.host.doc;
    const win = doc.defaultView;
    doc.removeEventListener("keydown", this.onKey, true);
    win?.removeEventListener("resize", this.schedulePlace);
    win?.removeEventListener("scroll", this.schedulePlace, true);
    if (win) {
      this.settle.forEach((t) => win.clearTimeout(t));
      win.cancelAnimationFrame(this.raf);
    }
    this.settle = [];
    this.layer?.remove();
    this.layer = this.card = this.cursor = this.ghost = null;
  }

  private finish(completed: boolean) {
    this.destroy();
    this.host.end(completed);
  }

  private go(dir: 1 | -1) {
    if (!this.layer) return;
    const to = this.index + dir;
    if (to >= this.steps.length) {
      this.finish(true);
      return;
    }
    if (to < 0) return;
    this.show(to, dir);
  }

  /** 显示第 i 步；目标找不到的可选步骤顺着方向跳过 */
  private show(i: number, dir: 1 | -1) {
    while (i >= 0 && i < this.steps.length) {
      const s = this.steps[i];
      this.host.apply(s.state);
      const el = s.target ? this.host.find(s.target) : null;
      if (s.target && !el && s.optional) {
        this.skipped.add(s.id);
        i += dir;
        continue;
      }
      this.index = i;
      this.setStep(s, el);
      return;
    }
    if (i >= this.steps.length) this.finish(true);
    else this.show(0, 1);
  }

  private visibleSteps(): TourStep[] {
    return this.steps.filter((s) => !this.skipped.has(s.id));
  }

  private setStep(s: TourStep, el: HTMLElement | null) {
    this.step = s;
    const vis = this.visibleSteps();
    const n = vis.indexOf(s) + 1;
    this.counter.setText(L(`第 ${n} 步，共 ${vis.length} 步`, `Step ${n} of ${vis.length}`));
    this.title.setText(s.title);
    this.bodyEl.setText(s.body);
    this.dots.empty();
    vis.forEach((v) => this.dots.createSpan({ cls: "vp-tour-dot" + (v === s ? " is-on" : "") }));
    const first = this.index === 0;
    const last = this.index === this.steps.length - 1;
    if (this.dirs) {
      this.dirs.prev.toggleClass("vp-hide", first);
      this.dirs.next.setText(first ? L("开始看看", "Show me") : last ? L("开始使用", "Get started") : L("下一步", "Next"));
    }
    this.card?.toggleClass("is-centered", !el);
    // 目标不在可见范围里：滚到中间
    if (el) {
      const r = el.getBoundingClientRect();
      const vh = this.host.doc.defaultView?.innerHeight ?? 800;
      if (r.top < 70 || r.bottom > vh - 70) el.scrollIntoView({ block: r.height > vh * 0.7 ? "start" : "center", inline: "nearest" });
    }
    this.startDemo(s, el);
    // 先同步摆好一次（提示卡的内容已经换好，量出来的大小是对的），之后看板可能还在重画、卡片还在滑动，
    // 隔几段时间再校正几次；校正完就不再自己动，不然提示卡会在用户要点的时候跑掉
    this.place(true);
    const win = this.host.doc.defaultView;
    if (win) {
      this.settle.forEach((t) => win.clearTimeout(t));
      this.settle = [60, 200, 450, 900].map((ms) => win.setTimeout(() => this.place(false), ms));
    }
    // 提示卡淡入（只动透明度和位移，不触发布局）
    const card = this.card;
    if (card) {
      card.removeClass("is-in");
      void card.offsetWidth;
      card.addClass("is-in");
    }
    this.dirs?.next.focus({ preventScroll: true });
  }

  /** 当前步骤的演示动画：光标在目标上做一遍操作；拖动、调大小的步骤里，一个虚线框代表被拖动、被拉大的卡片跟着光标走（真实的卡片不动） */
  private startDemo(s: TourStep, el: HTMLElement | null) {
    this.ghost?.removeClass("is-drag");
    this.ghost?.removeClass("is-grow");
    if (!s.demo || !el || !this.cursor) {
      this.cursor?.removeClass("is-on");
      return;
    }
    const r = el.getBoundingClientRect();
    const vw = this.host.doc.defaultView?.innerWidth ?? 1200;
    let sx = r.left + r.width / 2;
    let sy = r.top + r.height / 2;
    let dx = 0;
    let dy = 0;
    if (s.demo === "drag") {
      sx = r.left + Math.min(60, r.width / 3);
      sy = r.top + 22;
      dx = Math.max(24, Math.min(110, vw - sx - 40));
      dy = 18;
      this.ghost?.addClass("is-drag");
    } else if (s.demo === "resize") {
      dx = 34;
      dy = 26;
      this.ghost?.addClass("is-grow");
    } else {
      sx -= 46;
      sy += 30;
      dx = 46;
      dy = -30;
    }
    const props = { "--vp-tour-x": `${sx}px`, "--vp-tour-y": `${sy}px`, "--vp-tour-dx": `${dx}px`, "--vp-tour-dy": `${dy}px` };
    this.cursor.setCssProps(props);
    this.ghost?.setCssProps(props);
    this.cursor.addClass("is-on");
  }

  private schedulePlace = () => {
    const win = this.host.doc.defaultView;
    if (!win || this.raf) return;
    this.raf = win.requestAnimationFrame(() => {
      this.raf = 0;
      this.place(false);
    });
  };

  /**
   * 高亮框和提示卡摆到目标上。只在这些时候调用：换步骤时、窗口缩放或滚动时、换步骤后的几次校正；
   * 位置没变就什么都不写；鼠标正悬在提示卡上（用户正要点按钮）时不动它，除非是换步骤。
   */
  private place = (force: boolean | Event = false) => {
    const layer = this.layer;
    const card = this.card;
    const s = this.step;
    const win = this.host.doc.defaultView;
    if (!layer || !card || !s || !win) return;
    const forced = force === true;
    if (!forced && card.matches(":hover")) return;
    const vp = { w: win.innerWidth, h: win.innerHeight };
    const el = s.target ? this.host.find(s.target) : null;
    const b = el?.getBoundingClientRect();
    let spot: Rect | null = null;
    if (b && b.width > 0 && b.height > 0) {
      const v = visibleRect({ x: b.left - PAD, y: b.top - PAD, w: b.width + PAD * 2, h: b.height + PAD * 2 }, vp);
      if (v.w > 0 && v.h > 0) spot = v;
    }
    const hole = spot ?? { x: vp.w / 2, y: vp.h / 2, w: 1, h: 1 };
    const pos = placeCard(spot, { w: card.offsetWidth || 340, h: card.offsetHeight || 200 }, vp, 14, this.host.bounds() ?? undefined);
    const key = [hole.x, hole.y, hole.w, hole.h, pos.x, pos.y].map((n) => Math.round(n)).join(",");
    if (key === this.lastPlace && !forced) return;
    this.lastPlace = key;
    layer.setCssProps({ "--vp-sx": `${Math.round(hole.x)}px`, "--vp-sy": `${Math.round(hole.y)}px`, "--vp-sw": `${Math.round(hole.w)}px`, "--vp-sh": `${Math.round(hole.h)}px` });
    layer.toggleClass("has-spot", !!spot);
    card.setCssProps({ "--vp-cx": `${Math.round(pos.x)}px`, "--vp-cy": `${Math.round(pos.y)}px` });
  };

  private onKey = (e: KeyboardEvent) => {
    if (!this.layer) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.finish(false);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      e.stopPropagation();
      this.go(1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      e.stopPropagation();
      this.go(-1);
    }
  };
}
