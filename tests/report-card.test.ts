import { test } from "node:test";
import assert from "node:assert/strict";
import { DashboardView } from "../src/view";
import { DEFAULT_SETTINGS } from "../src/settings";
import { writingReportOverview } from "../src/report-logic";
import { reportFixture } from "./helpers/report-fixture";
import { TFile } from "obsidian";

type ElementOptions = { cls?: string; text?: string; attr?: Record<string, string> };
class CardElement {
  children: CardElement[] = [];
  classes = new Set<string>();
  attributes: Record<string, string> = {};
  props: Record<string, string> = {};
  text: string;
  hidden = false;
  tag: string;
  events = new Map<string, ((event: Event) => void)[]>();
  constructor(options: ElementOptions = {}, tag = "div") {
    this.tag = tag;
    this.text = options.text ?? "";
    for (const cls of options.cls?.split(" ") ?? []) this.classes.add(cls);
    this.attributes = { ...options.attr };
  }
  createDiv(options?: ElementOptions) {
    const element = new CardElement(options);
    this.children.push(element);
    return element;
  }
  createSpan(options?: ElementOptions) { return this.createEl("span", options); }
  createEl(tag: string, options?: ElementOptions) {
    const element = new CardElement(options, tag);
    this.children.push(element);
    return element;
  }
  get id() { return this.attributes.id; }
  setText(text: string) { this.text = text; }
  addClass(cls: string) { this.classes.add(cls); }
  setAttr(name: string, value: string) { this.attributes[name] = value; }
  setCssProps(props: Record<string, string>) { Object.assign(this.props, props); }
  addEventListener(type: string, handler: (event: Event) => void) {
    this.events.set(type, [...this.events.get(type) ?? [], handler]);
  }
  find(cls: string): CardElement[] {
    return [...this.classes.has(cls) ? [this] : [], ...this.children.flatMap((child) => child.find(cls))];
  }
  texts(): string[] { return [this.text, ...this.children.flatMap((child) => child.texts())]; }
  fire(type: string, key = "") {
    const event = { key, preventDefault() {} } as unknown as Event;
    for (const handler of this.events.get(type) ?? []) handler(event);
    // 原生 button 的 Enter / Space 激活由浏览器提供。
    if (type === "keydown" && this.tag === "button" && (key === "Enter" || key === " ")) this.fire("click");
  }
}

// 直接执行真实渲染和键盘处理，仅替换宿主卡片及 Obsidian DOM 扩展。
function renderCard(goal = 1500, expanded = false, generatedAt?: Date) {
  const root = new CardElement();
  const stats = reportFixture();
  if (generatedAt) stats.generatedAt = generatedAt.getTime();
  const settings = { ...DEFAULT_SETTINGS, weeklyWordGoal: goal, reportWeekExpanded: expanded };
  const saved: typeof settings[] = [];
  const opened: string[] = [];
  const latest = Object.assign(new TFile(), { path: "Note Pulse/写作周报 2026-10-12 至 2026-10-18.md" });
  const prototype = DashboardView.prototype as unknown as {
    renderReports(this: object, grid: CardElement): void;
    clickable: unknown;
  };
  const context = {
    stats,
    plugin: { settings, saveSettings: () => { saved.push({ ...settings }); return Promise.resolve(); }, openWritingReport: (kind: string) => opened.push(kind), openFile: () => opened.push("latest") },
    app: { vault: { getMarkdownFiles: () => [latest] }, metadataCache: { getFileCache: () => null } },
    card: () => ({ head: root.createDiv({ cls: "vp-card-head" }), body: root.createDiv({ cls: "vp-card-body" }) }),
    clickable: prototype.clickable,
  };
  prototype.renderReports.call(context, root);
  return { root, stats, settings, opened, saved };
}

test("双面板复用共享概览，卡片头部共享切换，明细默认隐藏", () => {
  const { root, stats, settings } = renderCard();
  const rows = root.find("vp-report-row");
  assert.equal(rows.length, 2);
  for (const [index, kind] of ["week", "month"].entries()) {
    const row = rows[index];
    const overview = writingReportOverview(stats, settings, kind as "week" | "month");
    const bar = row.find("vp-report-summary")[0];
    const header = row.find("vp-report-bar")[0];
    assert.equal(header.find("vp-report-summary").length, 0);
    assert.equal(header.find("vp-report-heading").length, 1);
    assert.equal(header.find("vp-report-row-actions").length, 1);
    assert.deepEqual(row.children.map((el) => [...el.classes][0]), ["vp-report-bar", "vp-report-summary", "vp-report-details"]);
    assert.equal(bar.find("vp-report-total")[0].find("vp-report-metric-label")[0].text, overview.metrics[0].label);
    assert.ok(bar.texts().includes(overview.metrics[0].value));
    assert.ok(bar.texts().includes(overview.metrics[0].detail));
    assert.deepEqual(bar.find("vp-report-checkins")[0].texts().filter(Boolean), ["打卡", overview.metrics[1].value, "天"]);
    const details = row.find("vp-report-details")[0];
    assert.equal(details.hidden, true);
    assert.equal(details.find("vp-report-stat").length, 3);
    for (const metric of overview.metrics.slice(2)) {
      for (const text of [metric.label, metric.value, metric.detail]) assert.ok(details.texts().includes(text), text);
      assert.ok(!bar.texts().includes(metric.label));
    }
    assert.equal(row.find("vp-report-toggle").length, 0);
    assert.equal(row.attributes.role, undefined);
    assert.equal(row.find("vp-report-generate")[0].attributes["aria-label"], `生成${index === 0 ? "周报" : "月报"}`);
  }
  const meters = root.find("vp-report-meter");
  assert.equal(meters.length, 2);
  const toggle = root.find("vp-report-toggle")[0];
  assert.equal(root.find("vp-report-toggle").length, 1);
  assert.equal(root.find("vp-card-head")[0].find("vp-report-toggle")[0], toggle);
  assert.equal(toggle.tag, "button");
  assert.equal(toggle.attributes["aria-expanded"], "false");
  assert.equal(toggle.attributes["aria-controls"], root.find("vp-report-details").map((el) => el.attributes.id).join(" "));
  assert.ok(toggle.texts().includes("展开"));
  assert.equal(meters[0].attributes["aria-valuenow"], "1500");
  assert.match(meters[0].attributes["aria-valuetext"], /3,820/);
  assert.equal(root.find("vp-report-fill")[0].props["--vp-report-progress"], "100%");
  assert.equal(root.find("vp-report-goal")[0].find("vp-report-metric-label")[0].text, "目标 100%");
  assert.equal(rows[1].find("vp-report-goal").length, 1);
  const month = rows[1].find("vp-report-month-progress")[0];
  assert.equal(month.find("vp-report-metric-label")[0].text, "本月进度 68%");
  assert.equal(month.find("vp-report-progress-detail")[0].text, "第 21 / 31 天");
  assert.equal(meters[1].attributes["aria-valuenow"], "21");
  assert.equal(meters[1].attributes["aria-valuemax"], "31");
  assert.equal(month.find("vp-report-fill")[0].props["--vp-report-progress"], `${21 / 31 * 100}%`);
  assert.equal(root.find("vp-report-recent-link")[0].attributes.href, "Note Pulse/写作周报 2026-10-12 至 2026-10-18.md");
});

test("原生按钮支持键盘和点击，生成、展开及最近报告互不干扰", () => {
  const { root, opened, settings, saved } = renderCard(0);
  assert.equal(root.find("vp-report-row")[0].find("vp-report-goal").length, 0);
  assert.equal(root.find("vp-report-meter").length, 1);
  assert.equal(root.find("vp-report-month-progress").length, 1);
  const buttons = root.find("vp-report-generate");
  buttons[0].fire("keydown", "Enter");
  buttons[1].fire("keydown", " ");
  buttons[1].fire("keydown", "Escape");
  buttons[0].fire("click");
  const toggles = root.find("vp-report-toggle");
  toggles[0].fire("keydown", "Enter");
  assert.equal(settings.reportWeekExpanded, true);
  assert.deepEqual(root.find("vp-report-details").map((el) => el.hidden), [false, false]);
  assert.equal(toggles[0].attributes["aria-expanded"], "true");
  assert.ok(toggles[0].texts().includes("收起"));
  toggles[0].fire("keydown", " ");
  assert.deepEqual(root.find("vp-report-details").map((el) => el.hidden), [true, true]);
  assert.equal(toggles[0].attributes["aria-expanded"], "false");
  assert.ok(toggles[0].texts().includes("展开"));
  toggles[0].fire("click");
  assert.deepEqual(saved.map((s) => s.reportWeekExpanded), [true, false, true]);
  root.find("vp-report-recent-link")[0].fire("click");
  assert.deepEqual(opened, ["week", "month", "week", "latest"]);
});

test("重新渲染恢复共享展开状态，周目标未完成时显示真实进度", () => {
  const { root, saved } = renderCard(5000, true);
  assert.deepEqual(root.find("vp-report-details").map((el) => el.hidden), [false, false]);
  assert.deepEqual(root.find("vp-report-toggle").map((el) => el.attributes["aria-expanded"]), ["true"]);
  assert.equal(saved.length, 0);
  assert.equal(root.find("vp-report-goal")[0].find("vp-report-metric-label")[0].text, "目标 76%");
  assert.equal(root.find("vp-report-fill")[0].props["--vp-report-progress"], "76.4%");
  assert.equal(root.find("vp-report-meter")[0].attributes["aria-valuenow"], "3820");
});

for (const [year, month, day, days] of [[2024, 2, 1, 29], [2024, 2, 29, 29], [2026, 2, 28, 28], [2026, 4, 30, 30], [2026, 12, 31, 31]]) {
  test(`本月进度遵循本地日历：${year}-${month}-${day}`, () => {
    const { root } = renderCard(0, false, new Date(year, month - 1, day, 12));
    const progress = root.find("vp-report-month-progress")[0];
    assert.equal(progress.find("vp-report-metric-label")[0].text, `本月进度 ${Math.round(day / days * 100)}%`);
    assert.equal(progress.find("vp-report-progress-detail")[0].text, `第 ${day} / ${days} 天`);
    const meter = progress.find("vp-report-meter")[0];
    assert.equal(meter.attributes["aria-valuenow"], String(day));
    assert.equal(meter.attributes["aria-valuemax"], String(days));
  });
}
