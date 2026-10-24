import { ItemView, Platform, WorkspaceLeaf, setIcon } from "obsidian";
import type { DedupeService as ClipDedupePlugin } from "./service";
import type { DupGroup, OverlapPair } from "./core/group";
import { groupItem, pairsToItems } from "./core/plan";
import { noteDay, overview, pairReclaimChars, readablePreview, significantPairs } from "./core/summary";
import { StrKey, t } from "./i18n";
import type { ScanProgress } from "./scanner";
import { splitList } from "./settings";
import { HelpManager, baseName, fmtNum, iconButton } from "./ui";

export const VIEW_TYPE_CLIP_DEDUPE = "note-pulse-dedupe";

type Sort = "reclaim" | "count" | "newest";

const PAGE = 20;
const NOTES_SHOWN = 4;
let seq = 0;

export class ClipDedupeView extends ItemView {
  plugin: ClipDedupePlugin;
  private sort: Sort = "reclaim";
  private limit = PAGE;
  private pairLimit = 10;
  private keepChoice = new Map<string, number>();
  private expanded = new Set<string>();
  private allNotes = new Set<string>();
  private advOpen = new Set<string>();
  private globalAdvOpen = false;
  private scatterOpen = false;
  private scopeMode: "all" | "folder" | null = null;
  private renderedVersion = -1;
  private blockText = new Map<string, string | null>();
  private help = new HelpManager();
  private headerActions!: HTMLElement;
  private bodyEl!: HTMLElement;
  private progressEl: HTMLElement | null = null;
  private progressFill: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: ClipDedupePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_CLIP_DEDUPE;
  }
  getDisplayText(): string {
    return t("pluginName");
  }
  getIcon(): string {
    return "layers";
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("cd-root");
    if (Platform.isMobile) root.addClass("is-mobile");
    const shell = root.createDiv({ cls: "cd-shell" });

    const header = shell.createDiv({ cls: "cd-header" });
    const brand = header.createDiv({ cls: "cd-brand" });
    setIcon(brand.createDiv({ cls: "cd-brand-badge", attr: { "aria-hidden": "true" } }), "layers");
    const titleWrap = brand.createDiv({ cls: "cd-header-text" });
    titleWrap.createEl("h1", { cls: "cd-title", text: t("pluginName") });
    titleWrap.createDiv({ cls: "cd-subtitle", text: t("tagline") });
    this.headerActions = header.createDiv({ cls: "cd-header-actions" });
    this.bodyEl = shell.createDiv({ cls: "cd-body" });

    this.registerDomEvent(root, "scroll", () => this.help.hide(), { capture: true });
    this.registerDomEvent(root.ownerDocument, "pointerdown", (e: Event) => {
      if (!(e.target as HTMLElement | null)?.closest?.(".cd-help")) this.help.hide();
    });
    this.refresh();
  }

  async onClose() {
    this.help.destroy();
    this.contentEl.empty();
  }

  /* ================= state changes pushed by the plugin ================= */

  refresh() {
    if (!this.bodyEl) return;
    this.renderHeader();
    const p = this.plugin;
    if (p.analysis && this.renderedVersion !== p.analysisVersion) {
      this.renderedVersion = p.analysisVersion;
      this.keepChoice.clear();
      this.expanded.clear();
      this.allNotes.clear();
      this.advOpen.clear();
      this.blockText.clear();
      this.limit = PAGE;
    }
    if (!(p.analysis && p.scanning)) this.renderBody();
    this.contentEl.toggleClass("is-scanning", p.scanning);
  }

  setProgress(pr: ScanProgress) {
    const label = pr.phase === "read" ? t("scanningProgress", pr.done, pr.total) : t("grouping");
    const status = this.headerActions?.querySelector(".cd-status");
    if (status) status.textContent = label;
    if (this.progressEl) {
      const text = this.progressEl.querySelector(".cd-loading-text");
      if (text) text.textContent = label;
    }
    this.progressFill?.setCssProps({ "--cd-progress": `${Math.round((pr.done / Math.max(1, pr.total)) * 100)}%` });
  }

  /* ================= header ================= */

  private renderHeader() {
    const p = this.plugin;
    const a = this.headerActions;
    a.empty();
    const status = a.createSpan({ cls: "cd-status", attr: { role: "status" } });
    if (p.scanning) status.setText(t("scanning"));
    else if (p.stale && p.analysis) {
      status.addClass("is-stale");
      status.setText(t("stale"));
    }
    const what = a.createEl("button", { cls: "cd-btn is-quiet cd-what", attr: { type: "button" } });
    setIcon(what.createSpan({ cls: "cd-btn-icon", attr: { "aria-hidden": "true" } }), "circle-help");
    what.createSpan({ cls: "cd-btn-label", text: t("whatIsThis") });
    what.addEventListener("click", () => p.openHelp());
    if (p.latestBackup && !p.scanning) {
      const undo = a.createEl("button", { cls: "cd-btn cd-undo", attr: { type: "button" } });
      setIcon(undo.createSpan({ cls: "cd-btn-icon", attr: { "aria-hidden": "true" } }), "undo-2");
      undo.createSpan({ cls: "cd-btn-label", text: t("undoLast") });
      undo.addEventListener("click", () => void p.undoLast());
    }
    if (p.scanning) {
      const c = a.createEl("button", { cls: "cd-btn", text: t("cancel"), attr: { type: "button" } });
      c.addEventListener("click", () => p.cancelScan());
    } else if (p.analysis) {
      const s = a.createEl("button", { cls: "cd-btn", attr: { type: "button" } });
      setIcon(s.createSpan({ cls: "cd-btn-icon", attr: { "aria-hidden": "true" } }), "refresh-cw");
      s.createSpan({ cls: "cd-btn-label", text: t("rescan") });
      s.addEventListener("click", () => void p.scan());
    }
    iconButton(a, "settings", t("settings"), () => p.openSettings());
  }

  /* ================= body ================= */

  private renderBody() {
    const body = this.bodyEl;
    this.help.hide();
    body.empty();
    this.progressEl = null;
    this.progressFill = null;
    const p = this.plugin;
    if (!p.analysis) {
      if (p.scanning) this.renderLoading(body);
      else this.renderWelcome(body);
      return;
    }
    const ov = overview(p.analysis, p.ignoredSet());
    if (ov.groups.length === 0) {
      this.renderNone(body, ov.ignored);
      return;
    }
    this.renderResults(body);
  }

  private renderLoading(parent: HTMLElement) {
    const card = parent.createDiv({ cls: "cd-card cd-loading", attr: { role: "status" } });
    card.createDiv({ cls: "cd-spinner" });
    card.createDiv({ cls: "cd-loading-text", text: t("scanning") });
    const bar = card.createDiv({ cls: "cd-progress" });
    this.progressFill = bar.createDiv({ cls: "cd-progress-fill" });
    card.createDiv({ cls: "cd-loading-hint", text: t("scanningHint") });
    this.progressEl = card;
  }

  /* ---------- welcome ---------- */

  private renderWelcome(parent: HTMLElement) {
    const p = this.plugin;
    const card = parent.createDiv({ cls: "cd-card cd-welcome" });
    card.createEl("h2", { cls: "cd-welcome-title", text: t("welcomeTitle") });
    card.createEl("p", { cls: "cd-welcome-text", text: t("welcomeText") });

    const steps = card.createEl("ol", { cls: "cd-steps" });
    const step = (n: number, icon: string, title: StrKey, text: StrKey) => {
      const li = steps.createEl("li", { cls: "cd-step" });
      const art = li.createDiv({ cls: "cd-step-art", attr: { "aria-hidden": "true" } });
      setIcon(art, icon);
      art.createSpan({ cls: "cd-step-num", text: String(n) });
      const tx = li.createDiv({ cls: "cd-step-body" });
      tx.createDiv({ cls: "cd-step-title", text: t(title) });
      tx.createDiv({ cls: "cd-step-text", text: t(text) });
    };
    step(1, "search", "step1", "step1Text");
    step(2, "copy", "step2", "step2Text");
    step(3, "list-checks", "step3", "step3Text");

    // scope: whole vault or one folder
    const include = splitList(p.settings.includeFolders);
    const mode = this.scopeMode ?? (include.length ? "folder" : "all");
    const scope = card.createDiv({ cls: "cd-scope", attr: { role: "radiogroup" } });
    const labelId = `cd-scope-${++seq}`;
    scope.createDiv({ cls: "cd-scope-label", text: t("scopeLabel"), attr: { id: labelId } });
    scope.setAttr("aria-labelledby", labelId);
    const opts = scope.createDiv({ cls: "cd-scope-opts" });
    const opt = (value: "all" | "folder", label: StrKey, icon: string) => {
      const b = opts.createEl("button", {
        cls: "cd-scope-opt" + (mode === value ? " is-active" : ""),
        attr: { type: "button", role: "radio", "aria-checked": String(mode === value) },
      });
      setIcon(b.createSpan({ cls: "cd-btn-icon", attr: { "aria-hidden": "true" } }), icon);
      b.createSpan({ text: t(label) });
      b.addEventListener("click", () => {
        this.scopeMode = value;
        if (value === "all" && include.length) void p.setScope("").then(() => this.renderBody());
        else this.renderBody();
      });
    };
    opt("all", "scopeAll", "book-open");
    opt("folder", "scopeFolder", "folder");
    if (mode === "folder") {
      const folders = p.folderList();
      const sel = opts.createEl("select", { cls: "dropdown cd-select cd-scope-select" });
      const selId = `cd-folder-${++seq}`;
      sel.id = selId;
      sel.setAttr("aria-labelledby", labelId);
      sel.createEl("option", { text: t("scopePick"), value: "" });
      if (include.length > 1) sel.createEl("option", { text: t("scopeCustom", include.join(", ")), value: p.settings.includeFolders });
      for (const f of folders) sel.createEl("option", { text: f, value: f });
      sel.value = include.length > 1 ? p.settings.includeFolders : include[0] ?? "";
      sel.addEventListener("change", () => void p.setScope(sel.value).then(() => this.renderBody()));
    }

    const go = card.createDiv({ cls: "cd-welcome-go" });
    const b = go.createEl("button", { cls: "cd-btn is-primary is-big", attr: { type: "button" } });
    setIcon(b.createSpan({ cls: "cd-btn-icon", attr: { "aria-hidden": "true" } }), "search");
    b.createSpan({ cls: "cd-btn-label", text: t("startScan") });
    b.disabled = mode === "folder" && include.length === 0;
    b.addEventListener("click", () => void p.scan());
    const safe = go.createDiv({ cls: "cd-reassure" });
    setIcon(safe.createSpan({ cls: "cd-reassure-icon", attr: { "aria-hidden": "true" } }), "shield-check");
    safe.createSpan({ text: t("readOnly") });
  }

  /* ---------- nothing found ---------- */

  private renderNone(parent: HTMLElement, ignored: number) {
    const a = this.plugin.analysis;
    const card = parent.createDiv({ cls: "cd-card cd-fullempty" });
    const e = card.createDiv({ cls: "cd-empty" });
    setIcon(e.createDiv({ cls: "cd-empty-icon is-good", attr: { "aria-hidden": "true" } }), "check-circle");
    e.createDiv({ cls: "cd-empty-title", text: t("noneTitle") });
    e.createDiv({ cls: "cd-empty-text", text: t("noneText", a?.files.length ?? 0) + (ignored ? " " + t("noneIgnored", ignored) : "") });
    e.createDiv({ cls: "cd-empty-tip", text: t("noneTip") });
    const row = card.createDiv({ cls: "cd-empty-actions" });
    const again = row.createEl("button", { cls: "cd-btn is-primary", text: t("rescan"), attr: { type: "button" } });
    again.addEventListener("click", () => void this.plugin.scan());
    const st = row.createEl("button", { cls: "cd-btn", text: t("openSettings"), attr: { type: "button" } });
    st.addEventListener("click", () => this.plugin.openSettings());
    if (ignored) {
      const r = row.createEl("button", { cls: "cd-btn is-quiet", text: t("advRestore"), attr: { type: "button" } });
      r.addEventListener("click", () => void this.plugin.restoreIgnored());
    }
  }

  /* ---------- results ---------- */

  private sorted(groups: DupGroup[]): DupGroup[] {
    const a = this.plugin.analysis;
    if (!a) return groups;
    if (this.sort === "count") return groups.slice().sort((x, y) => y.occs.length - x.occs.length || y.reclaimChars - x.reclaimChars);
    if (this.sort === "newest") {
      const last = (g: DupGroup) => g.occs.reduce((m, o) => Math.max(m, a.files[o.f].mtime), 0);
      return groups.slice().sort((x, y) => last(y) - last(x));
    }
    return groups;
  }

  private renderResults(parent: HTMLElement) {
    const p = this.plugin;
    const a = p.analysis;
    if (!a) return;
    const ignoredSet = p.ignoredSet();
    const ov = overview(a, ignoredSet);
    // 主角是“大面积重复的笔记”：一篇笔记至少 70% 的内容在另一篇里也有。零散的句子、段落重复放到下面折起来的一栏
    const pairs = significantPairs(a, ignoredSet);

    const sum = parent.createDiv({ cls: "cd-card cd-summary-card" });
    const txt = sum.createDiv({ cls: "cd-summary-text" });
    if (pairs.length > 0) {
      txt.createEl("h2", { cls: "cd-summary-lead", text: t("pairsLead", pairs.length) });
      txt.createDiv({ cls: "cd-summary-save", text: t("resultSave", fmtNum(pairReclaimChars(pairs))) });
      txt.createDiv({ cls: "cd-summary-how", text: t("pairsHow") });
      const all = sum.createEl("button", { cls: "cd-btn is-primary is-big cd-fix-all", attr: { type: "button" } });
      setIcon(all.createSpan({ cls: "cd-btn-icon", attr: { "aria-hidden": "true" } }), "sparkles");
      all.createSpan({ cls: "cd-btn-label", text: t("fixAll") });
      all.addEventListener("click", () => p.startCleanup(pairsToItems(a, pairs), "mark"));
    } else {
      txt.createEl("h2", { cls: "cd-summary-lead", text: t("pairsNoneLead") });
      txt.createDiv({ cls: "cd-summary-how", text: t("pairsNoneText") });
    }

    if (pairs.length > 0) {
      const head = parent.createDiv({ cls: "cd-list-head" });
      head.createEl("h3", { cls: "cd-list-title", text: t("pairsListTitle") });
      head.createSpan({ cls: "cd-list-sub", text: t("pairsListSub") });
      const list = parent.createDiv({ cls: "cd-list" });
      for (const pr of pairs.slice(0, this.pairLimit)) this.renderPairCard(list, pr);
      if (pairs.length > this.pairLimit) {
        const more = parent.createEl("button", { cls: "cd-btn cd-more", text: t("showMore", Math.min(PAGE, pairs.length - this.pairLimit)), attr: { type: "button" } });
        more.addEventListener("click", () => {
          this.pairLimit += PAGE;
          this.renderBody();
        });
      }
    }

    this.renderScattered(parent, ov);
    this.renderGlobalAdvanced(parent, ov.ignored);
  }

  /** 零散重复的段落：折起来，打开才画（可能有上千段），里面还是原来逐段处理的样子 */
  private renderScattered(parent: HTMLElement, ov: ReturnType<typeof overview>) {
    if (ov.groups.length === 0) return;
    const det = parent.createEl("details", { cls: "cd-card cd-scatter" });
    if (this.scatterOpen) det.setAttr("open", "");
    const sum = det.createEl("summary", { cls: "cd-adv-summary" });
    sum.createSpan({ cls: "cd-scatter-title", text: t("scatterTitle", ov.groups.length) });
    det.createDiv({ cls: "cd-adv-text cd-scatter-hint", text: t("scatterHint") });
    det.addEventListener("toggle", () => {
      if (det.open === this.scatterOpen) return;
      this.scatterOpen = det.open;
      if (det.open) this.renderBody();
    });
    if (!this.scatterOpen) return;

    const sortRow = det.createDiv({ cls: "cd-field" });
    const sortId = `cd-sort-${++seq}`;
    sortRow.createEl("label", { cls: "cd-adv-title", text: t("advSort"), attr: { for: sortId } });
    const sel = sortRow.createEl("select", { cls: "dropdown cd-select" });
    sel.id = sortId;
    for (const [v, label] of [["reclaim", "sortReclaim"], ["count", "sortCount"], ["newest", "sortNewest"]] as [Sort, StrKey][]) {
      const o = sel.createEl("option", { text: t(label), value: v });
      if (v === this.sort) o.selected = true;
    }
    sel.addEventListener("change", () => {
      this.sort = sel.value as Sort;
      this.limit = PAGE;
      this.renderBody();
    });
    const groups = this.sorted(ov.groups);
    const list = det.createDiv({ cls: "cd-list" });
    for (const g of groups.slice(0, this.limit)) this.renderItem(list, g);
    if (groups.length > this.limit) {
      const more = det.createEl("button", { cls: "cd-btn cd-more", text: t("showMore", Math.min(PAGE, groups.length - this.limit)), attr: { type: "button" } });
      more.addEventListener("click", () => {
        this.limit += PAGE;
        this.renderBody();
      });
    }
  }

  /** 一对大面积重复的笔记：重复了多少、共同的一段摘录、较早和较晚的两篇，以及一个主要动作（保留较早的，清理这一篇） */
  private renderPairCard(parent: HTMLElement, pr: OverlapPair) {
    const p = this.plugin;
    const a = p.analysis;
    if (!a) return;
    const pct = Math.round(Math.max(pr.newerRatio, pr.olderRatio) * 100);
    const card = parent.createDiv({ cls: "cd-card cd-item cd-pair-card" });
    const head = card.createDiv({ cls: "cd-item-head" });
    head.createDiv({ cls: "cd-item-title", text: t("pairLead", baseName(pr.newer), baseName(pr.older), pct) });
    head.createSpan({ cls: "cd-item-save", text: t("pairShared", pr.sharedBlocks, fmtNum(Math.round(pr.sharedChars))) });

    // 共同部分里最长的一段，让人一眼认出“是同一篇”
    const biggest = pr.groupIds.map((id) => a.groups.find((g) => g.id === id)).filter((g): g is DupGroup => !!g).sort((x, y) => (y.occs[0]?.block.w ?? 0) - (x.occs[0]?.block.w ?? 0))[0];
    if (biggest) {
      const quote = card.createDiv({ cls: "cd-quote" });
      const textEl = quote.createDiv({ cls: "cd-quote-text", text: t("loadingText") });
      void (async () => {
        const raw = await this.loadText(biggest, 0);
        if (!card.isConnected) return;
        textEl.setText(raw === null ? t("textUnavailable") : readablePreview(raw, 400));
      })();
    }

    const ul = card.createDiv({ cls: "cd-where" }).createEl("ul", { cls: "cd-notes" });
    const row = (path: string, keep: boolean) => {
      const f = a.files.find((x) => x.path === path);
      const li = ul.createEl("li", { cls: "cd-note" + (keep ? " is-keep" : "") });
      li.createSpan({ cls: "cd-note-tag", text: keep ? t("tagKeep") : t("tagDup") });
      if (f) li.createSpan({ cls: "cd-note-date", text: noteDay(f) });
      const link = li.createEl("button", { cls: "cd-note-link", text: baseName(path), attr: { type: "button", title: path } });
      link.addEventListener("click", (e) => void p.openNote(path, undefined, e));
    };
    row(pr.older, true);
    row(pr.newer, false);

    const acts = card.createDiv({ cls: "cd-item-actions" });
    const main = acts.createEl("button", { cls: "cd-btn is-primary", attr: { type: "button" } });
    setIcon(main.createSpan({ cls: "cd-btn-icon", attr: { "aria-hidden": "true" } }), "check");
    main.createSpan({ cls: "cd-btn-label", text: t("pairKeepOlder") });
    main.addEventListener("click", () => p.startCleanup(p.pairItems(pr.groupIds, pr.older, pr.newer), "mark"));
    const both = acts.createEl("button", { cls: "cd-btn", text: t("pairOpenBoth"), attr: { type: "button" } });
    both.addEventListener("click", () => void p.openBoth(pr.older, pr.newer));
    const ign = acts.createEl("button", { cls: "cd-btn is-quiet", text: t("ignore"), attr: { type: "button" } });
    ign.addEventListener("click", () => void p.ignorePair(pr));
  }

  private async loadText(g: DupGroup, idx: number): Promise<string | null> {
    const o = g.occs[idx];
    const key = `${o.path}:${o.block.s}:${o.block.e}`;
    if (this.blockText.has(key)) return this.blockText.get(key) ?? null;
    const text = await this.plugin.readBlock(o);
    this.blockText.set(key, text);
    return text;
  }

  private renderItem(parent: HTMLElement, g: DupGroup) {
    const p = this.plugin;
    const a = p.analysis;
    if (!a) return;
    const keepIdx = this.keepChoice.get(g.id) ?? 0;
    const notes = new Set(g.occs.map((o) => o.f)).size;
    const card = parent.createDiv({ cls: "cd-card cd-item" });

    const head = card.createDiv({ cls: "cd-item-head" });
    head.createDiv({ cls: "cd-item-title", text: t("itemTitle", notes) });
    head.createSpan({ cls: "cd-item-save", text: t("itemSave", fmtNum(g.reclaimWords)) });

    // the passage itself, as readable text
    const quote = card.createDiv({ cls: "cd-quote" });
    const textEl = quote.createDiv({ cls: "cd-quote-text" + (this.expanded.has(g.id) ? " is-expanded" : ""), text: t("loadingText") });
    const toggle = quote.createEl("button", { cls: "cd-expand", attr: { type: "button" } });
    toggle.hide();
    const setToggle = () => {
      const open = this.expanded.has(g.id);
      toggle.empty();
      toggle.createSpan({ text: open ? t("collapse") : t("expand") });
      toggle.setAttr("aria-expanded", String(open));
    };
    toggle.addEventListener("click", () => {
      if (this.expanded.has(g.id)) this.expanded.delete(g.id);
      else this.expanded.add(g.id);
      textEl.toggleClass("is-expanded", this.expanded.has(g.id));
      setToggle();
    });
    void (async () => {
      const raw = await this.loadText(g, keepIdx);
      if (!card.isConnected) return;
      if (raw === null) {
        textEl.setText(t("textUnavailable"));
        return;
      }
      const shown = readablePreview(raw, 3000);
      textEl.setText(shown);
      if (shown.length > 120 || shown.split("\n").length > 3) {
        setToggle();
        toggle.show();
      }
    })();
    if (g.kind === "post" && !g.exact) card.createDiv({ cls: "cd-item-warn", text: t("itemPostWarn") });

    // which notes it is in
    const where = card.createDiv({ cls: "cd-where" });
    where.createDiv({ cls: "cd-where-label", text: t("inNotes") });
    const ul = where.createEl("ul", { cls: "cd-notes" });
    const seen = new Set<number>();
    const rows = g.occs.map((o, i) => ({ o, i })).filter(({ o }) => (seen.has(o.f) ? false : (seen.add(o.f), true)));
    const showAll = this.allNotes.has(g.id) || rows.length <= NOTES_SHOWN + 1;
    rows.forEach(({ o, i }, n) => {
      if (!showAll && n >= NOTES_SHOWN && i !== keepIdx) return;
      const file = a.files[o.f];
      const isKeep = i === keepIdx;
      const li = ul.createEl("li", { cls: "cd-note" + (isKeep ? " is-keep" : "") });
      li.createSpan({ cls: "cd-note-tag", text: isKeep ? t("tagKeep") : t("tagDup") });
      li.createSpan({ cls: "cd-note-date", text: noteDay(file) });
      const link = li.createEl("button", { cls: "cd-note-link", text: baseName(o.path), attr: { type: "button", title: o.path } });
      link.addEventListener("click", (e) => void p.openNote(o.path, o.block.s, e));
      if (i === 0) li.createSpan({ cls: "cd-note-earliest", text: t("tagEarliest") });
    });
    if (!showAll) {
      const more = where.createEl("button", { cls: "cd-expand", text: t("showAllNotes", rows.length), attr: { type: "button" } });
      more.addEventListener("click", () => {
        this.allNotes.add(g.id);
        this.renderBody();
      });
    }

    // one obvious action, one way out
    const acts = card.createDiv({ cls: "cd-item-actions" });
    const main = acts.createEl("button", { cls: "cd-btn is-primary", attr: { type: "button" } });
    setIcon(main.createSpan({ cls: "cd-btn-icon", attr: { "aria-hidden": "true" } }), "check");
    main.createSpan({ cls: "cd-btn-label", text: keepIdx === 0 ? t("keepEarliest") : t("keepChosen") });
    main.addEventListener("click", () => p.startCleanup([groupItem(g, keepIdx)], "mark"));
    const ign = acts.createEl("button", { cls: "cd-btn is-quiet", text: t("ignore"), attr: { type: "button" } });
    ign.addEventListener("click", () => void p.ignoreGroup(g));

    // everything else, folded away
    const adv = card.createEl("details", { cls: "cd-adv" });
    if (this.advOpen.has(g.id)) adv.setAttr("open", "");
    adv.addEventListener("toggle", () => {
      if (adv.open) this.advOpen.add(g.id);
      else this.advOpen.delete(g.id);
    });
    adv.createEl("summary", { cls: "cd-adv-summary", text: t("advanced") });
    const ab = adv.createDiv({ cls: "cd-adv-body" });
    ab.createDiv({ cls: "cd-adv-title", text: t("advKeepTitle") });
    ab.createDiv({ cls: "cd-adv-text", text: t("advKeepText") });
    const picks = ab.createDiv({ cls: "cd-keep-picks", attr: { role: "radiogroup" } });
    rows.forEach(({ o, i }) => {
      const b = picks.createEl("button", {
        cls: "cd-keep-pick" + (i === keepIdx ? " is-active" : ""),
        attr: { type: "button", role: "radio", "aria-checked": String(i === keepIdx) },
      });
      b.createSpan({ cls: "cd-radio-dot", attr: { "aria-hidden": "true" } });
      b.createSpan({ text: `${noteDay(a.files[o.f])} · ${baseName(o.path)}` });
      b.addEventListener("click", () => {
        this.keepChoice.set(g.id, i);
        this.advOpen.add(g.id);
        this.renderBody();
      });
    });
    ab.createDiv({ cls: "cd-adv-title", text: t("advOtherWays") });
    ab.createDiv({ cls: "cd-adv-text", text: t("advOtherWaysText") });
    const other = ab.createEl("button", { cls: "cd-btn is-compact", text: t("advChoose"), attr: { type: "button" } });
    other.addEventListener("click", () => p.startCleanup([groupItem(g, keepIdx)]));
  }

  /* ---------- page-level advanced options ---------- */

  private renderGlobalAdvanced(parent: HTMLElement, ignored: number) {
    if (ignored <= 0) return;
    const det = parent.createEl("details", { cls: "cd-card cd-global-adv" });
    if (this.globalAdvOpen) det.setAttr("open", "");
    det.addEventListener("toggle", () => (this.globalAdvOpen = det.open));
    const sum = det.createEl("summary", { cls: "cd-adv-summary" });
    setIcon(sum.createSpan({ cls: "cd-btn-icon", attr: { "aria-hidden": "true" } }), "sliders-horizontal");
    sum.createSpan({ text: t("globalAdv") });
    const body = det.createDiv({ cls: "cd-adv-body" });
    const r = body.createDiv({ cls: "cd-field" });
    r.createSpan({ cls: "cd-adv-title", text: t("advIgnored", ignored) });
    const b = r.createEl("button", { cls: "cd-btn is-compact", text: t("advRestore"), attr: { type: "button" } });
    b.addEventListener("click", () => void this.plugin.restoreIgnored());
  }
}
