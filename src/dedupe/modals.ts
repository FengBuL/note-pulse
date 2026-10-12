import { App, Modal, Notice, setIcon } from "obsidian";
import type { DedupeService as ClipDedupePlugin } from "./service";
import type { ApplyResult } from "./core/engine";
import { CleanMode, Edit, Plan, PlanFile, PlanItem, ReplaceEdit } from "./core/plan";
import { readablePreview } from "./core/summary";
import { StrKey, t } from "./i18n";
import { HelpManager, baseName, truncate } from "./ui";

/** A plain confirmation dialog. */
export class ConfirmModal extends Modal {
  constructor(app: App, private title: string, private body: string, private confirmText: string, private onConfirm: () => Promise<void>) {
    super(app);
  }

  onOpen() {
    this.modalEl.addClass("cd-modal", "is-small");
    this.setTitle(this.title);
    this.contentEl.createEl("p", { cls: "cd-modal-text", text: this.body });
    const bar = this.contentEl.createDiv({ cls: "cd-modal-actions" });
    bar.createEl("button", { cls: "cd-modal-btn", text: t("cancel") }).addEventListener("click", () => this.close());
    const ok = bar.createEl("button", { cls: "mod-cta cd-modal-btn", text: this.confirmText });
    ok.addEventListener("click", () => {
      this.close();
      void this.onConfirm();
    });
    ok.focus();
  }

  onClose() {
    this.contentEl.empty();
  }
}

/** The three ways to handle a duplicate, in the order shown (safest first). */
export const MODES: [CleanMode, StrKey, StrKey, string][] = [
  ["mark", "modeMark", "modeMarkDesc", "tag"],
  ["link", "modeLink", "modeLinkDesc", "link"],
  ["remove", "modeRemove", "modeRemoveDesc", "eraser"],
];

/** "What does this do?" with a small before/after picture made of plain elements. */
export class HelpModal extends Modal {
  onOpen() {
    this.modalEl.addClass("cd-modal", "cd-help-modal");
    this.setTitle(t("helpTitle"));
    const root = this.contentEl;
    root.createEl("p", { cls: "cd-modal-text", text: t("helpIntro") });

    const ex = root.createDiv({ cls: "cd-example" });
    const col = (title: string, after: boolean) => {
      const c = ex.createDiv({ cls: "cd-example-col" + (after ? " is-after" : "") });
      c.createDiv({ cls: "cd-example-title", text: title });
      (["helpNoteA", "helpNoteB", "helpNoteC"] as StrKey[]).forEach((k, i) => {
        const n = c.createDiv({ cls: "cd-mini-note" + (after && i > 0 ? " is-marked" : "") });
        const h = n.createDiv({ cls: "cd-mini-head" });
        setIcon(h.createSpan({ cls: "cd-mini-icon", attr: { "aria-hidden": "true" } }), "file-text");
        h.createSpan({ text: t(k) });
        if (after && i > 0) n.createDiv({ cls: "cd-mini-prop", text: t("helpMarked") });
        n.createDiv({ cls: "cd-mini-text", text: t("helpSample") });
        if (after && i === 0) n.createDiv({ cls: "cd-mini-tag", text: t("helpKept") });
      });
    };
    col(t("helpBefore"), false);
    const arrow = ex.createDiv({ cls: "cd-example-arrow", attr: { "aria-hidden": "true" } });
    setIcon(arrow, "arrow-right");
    col(t("helpAfter"), true);

    root.createEl("h3", { cls: "cd-help-h", text: t("helpWaysTitle") });
    const ways = root.createDiv({ cls: "cd-ways" });
    for (const [, label, desc, icon] of MODES) {
      const w = ways.createDiv({ cls: "cd-way" });
      setIcon(w.createSpan({ cls: "cd-way-icon", attr: { "aria-hidden": "true" } }), icon);
      const tx = w.createDiv();
      tx.createDiv({ cls: "cd-way-name", text: t(label) });
      tx.createDiv({ cls: "cd-way-desc", text: t(desc) });
    }

    root.createEl("h3", { cls: "cd-help-h", text: t("helpSafeTitle") });
    const ul = root.createEl("ul", { cls: "cd-safe-list" });
    for (const k of ["helpSafe1", "helpSafe2", "helpSafe3"] as StrKey[]) {
      const li = ul.createEl("li");
      setIcon(li.createSpan({ cls: "cd-safe-icon", attr: { "aria-hidden": "true" } }), "shield-check");
      li.createSpan({ text: t(k) });
    }
    const bar = root.createDiv({ cls: "cd-modal-actions" });
    const ok = bar.createEl("button", { cls: "mod-cta cd-modal-btn", text: t("gotIt") });
    ok.addEventListener("click", () => this.close());
  }

  onClose() {
    this.contentEl.empty();
  }
}

const MAX_FILES = 40;
const MAX_EDITS_PER_FILE = 12;

/** Shows what a cleanup would change in each note, in plain words, and applies it on confirm. */
export class PreviewModal extends Modal {
  private mode: CleanMode;
  private texts = new Map<string, string>();
  private plan: Plan | null = null;
  private confirmed = false;
  private ctl = { cancelled: false };
  private help = new HelpManager();
  private leadEl!: HTMLElement;
  private listEl!: HTMLElement;
  private confirmEl!: HTMLElement;
  private applyBtn!: HTMLButtonElement;
  private mainEl!: HTMLElement;
  private running = false;

  constructor(app: App, private plugin: ClipDedupePlugin, private items: PlanItem[], mode?: CleanMode) {
    super(app);
    this.mode = mode ?? plugin.settings.cleanMode;
  }

  async onOpen() {
    this.modalEl.addClass("cd-modal", "cd-preview-modal");
    this.setTitle(t("previewTitle"));
    const root = this.contentEl;
    root.addClass("cd-preview");
    this.mainEl = root.createDiv({ cls: "cd-preview-main" });
    this.mainEl.createDiv({ cls: "cd-loading-line", text: t("loadingPlan") });
    const paths = new Set<string>();
    for (const it of this.items) {
      paths.add(it.keep.path);
      for (const r of it.remove) paths.add(r.path);
    }
    this.texts = await this.plugin.readTexts(Array.from(paths));
    this.buildUi();
    this.refreshPlan();
  }

  onClose() {
    this.help.destroy();
    this.contentEl.empty();
  }

  private buildUi() {
    const main = this.mainEl;
    main.empty();
    this.leadEl = main.createDiv({ cls: "cd-preview-lead", attr: { role: "status" } });

    main.createDiv({ cls: "cd-section-label", text: t("modeLabel") });
    const modes = main.createDiv({ cls: "cd-modes", attr: { role: "radiogroup" } });
    for (const [m, label, desc, icon] of MODES) {
      const card = modes.createEl("label", { cls: "cd-mode" + (m === this.mode ? " is-selected" : "") });
      const input = card.createEl("input", { attr: { type: "radio", name: "cd-mode", value: m } });
      input.checked = m === this.mode;
      setIcon(card.createSpan({ cls: "cd-mode-icon", attr: { "aria-hidden": "true" } }), icon);
      const text = card.createDiv({ cls: "cd-mode-text" });
      const head = text.createDiv({ cls: "cd-mode-head" });
      head.createSpan({ cls: "cd-mode-name", text: t(label) });
      if (m === "mark") head.createSpan({ cls: "cd-badge is-good", text: t("recommended") });
      else head.createSpan({ cls: "cd-badge is-warn", text: t("changesText") });
      text.createDiv({ cls: "cd-mode-desc", text: t(desc) });
      input.addEventListener("change", () => {
        this.mode = m;
        this.confirmed = false;
        modes.querySelectorAll(".cd-mode").forEach((el) => el.removeClass("is-selected"));
        card.addClass("is-selected");
        this.refreshPlan();
      });
    }

    main.createDiv({ cls: "cd-section-label", text: t("changesTitle") });
    this.listEl = main.createDiv({ cls: "cd-diff-list" });
    this.confirmEl = main.createDiv({ cls: "cd-confirm" });

    const bar = this.contentEl.createDiv({ cls: "cd-modal-actions is-big" });
    bar.createEl("button", { cls: "cd-modal-btn", text: t("cancel") }).addEventListener("click", () => this.close());
    this.applyBtn = bar.createEl("button", { cls: "mod-cta cd-modal-btn", text: t("confirm") });
    this.applyBtn.addEventListener("click", () => void this.apply());
  }

  private refreshPlan() {
    this.plan = this.plugin.makePlan(this.items, this.texts, this.mode);
    this.renderPlan();
  }

  private renderPlan() {
    const plan = this.plan;
    if (!plan) return;
    this.leadEl.empty();
    this.listEl.empty();
    this.confirmEl.empty();
    const touched = plan.files.filter((f) => f.edits.some((e) => e.type !== "blockid")).length;
    if (plan.blocks === 0) {
      this.leadEl.createDiv({ cls: "cd-preview-lead-main", text: t("nothingToDo") });
    } else {
      this.leadEl.createDiv({ cls: "cd-preview-lead-main", text: t("previewLead", touched, new Set(this.items.map((i) => i.group.id)).size) });
      this.leadEl.createDiv({ cls: "cd-preview-lead-sub", text: t("previewKeep") });
    }
    if (plan.keptNotes > 0) this.leadEl.createDiv({ cls: "cd-preview-lead-sub", text: t("keptNotesNote", plan.keptNotes) });
    if (plan.skipped.length > 0) {
      const sk = this.leadEl.createDiv({ cls: "cd-preview-lead-sub is-warn", text: t("skippedNote", plan.skipped.length) });
      this.help.attach(sk, this.skipSummary(plan.skipped.map((s) => s.reason)));
    }

    plan.files.slice(0, MAX_FILES).forEach((f, i) => this.renderFile(f, i < 2));
    if (plan.files.length > MAX_FILES) this.listEl.createDiv({ cls: "cd-diff-more", text: t("diffMoreFiles", plan.files.length - MAX_FILES) });

    const destructive = this.mode !== "mark";
    if (destructive && plan.blocks > 0) {
      const row = this.confirmEl.createEl("label", { cls: "cd-confirm-row" });
      const cb = row.createEl("input", { attr: { type: "checkbox" } });
      cb.checked = this.confirmed;
      row.createSpan({ text: t("confirmCheck", touched) });
      cb.addEventListener("change", () => {
        this.confirmed = cb.checked;
        this.updateApply();
      });
    }
    this.updateApply();
  }

  private updateApply() {
    const plan = this.plan;
    const destructive = this.mode !== "mark";
    this.applyBtn.disabled = !plan || plan.blocks === 0 || this.running || (destructive && !this.confirmed);
    this.applyBtn.toggleClass("mod-warning", destructive);
    this.applyBtn.toggleClass("mod-cta", !destructive);
  }

  private skipSummary(reasons: string[]): string {
    const counts = new Map<string, number>();
    for (const r of reasons) counts.set(r, (counts.get(r) ?? 0) + 1);
    return Array.from(counts.entries())
      .map(([r, n]) => `${n} × ${this.plugin.skipText(r)}`)
      .join("\n");
  }

  private renderFile(file: PlanFile, open: boolean) {
    const det = this.listEl.createEl("details", { cls: "cd-file" });
    if (open) det.setAttr("open", "");
    const sum = det.createEl("summary", { cls: "cd-file-head" });
    setIcon(sum.createSpan({ cls: "cd-file-icon", attr: { "aria-hidden": "true" } }), "file-text");
    sum.createSpan({ cls: "cd-file-name", text: baseName(file.path) });
    const onlyMarker = file.edits.every((e) => e.type === "blockid");
    const n = file.edits.filter((e) => e.type !== "blockid").length;
    sum.createSpan({ cls: "cd-file-count" + (onlyMarker ? " is-muted" : ""), text: onlyMarker ? t("keptOriginal") : t("changeCount", n) });
    const body = det.createDiv({ cls: "cd-file-body" });
    file.edits.slice(0, MAX_EDITS_PER_FILE).forEach((e) => this.renderEdit(body, e));
    if (file.edits.length > MAX_EDITS_PER_FILE) body.createDiv({ cls: "cd-diff-more", text: t("diffMoreEdits", file.edits.length - MAX_EDITS_PER_FILE) });
  }

  private renderEdit(parent: HTMLElement, e: Edit) {
    const box = parent.createDiv({ cls: "cd-edit" });
    const side = (label: StrKey, cls: string) => {
      const s = box.createDiv({ cls: `cd-edit-side ${cls}` });
      s.createDiv({ cls: "cd-edit-label", text: t(label) });
      return s.createDiv({ cls: "cd-edit-text" });
    };
    if (e.type === "prop") {
      const after = side("afterLabel", "is-after");
      after.createSpan({ cls: "cd-edit-note", text: t("afterProp") });
      after.createSpan({ cls: "cd-prop-chip", text: `${t("propLabel")}：${e.values.map((v) => v.replace(/^\[\[|\]\]$/g, "")).join("、")}` });
      return;
    }
    if (e.type === "blockid") {
      const after = side("afterLabel", "is-after is-quiet");
      after.setText(`${t("afterMarker")} ^${e.id}`);
      return;
    }
    const r: ReplaceEdit = e;
    side("beforeLabel", "is-before").setText(truncate(readablePreview(r.before.join("\n"), 400) || " ", 400));
    const after = side("afterLabel", "is-after");
    if (r.lines.length === 0) after.createSpan({ cls: "cd-edit-note", text: t("afterRemoved") });
    else after.setText(r.lines.join("\n").replace(/\r/g, ""));
  }

  private async apply() {
    const plan = this.plan;
    if (!plan || this.running) return;
    this.running = true;
    this.updateApply();
    const root = this.contentEl;
    root.empty();
    const run = root.createDiv({ cls: "cd-run" });
    const label = run.createDiv({ cls: "cd-run-label", text: t("applying", 0, plan.files.length * 2), attr: { role: "status" } });
    const bar = run.createDiv({ cls: "cd-progress" });
    const fill = bar.createDiv({ cls: "cd-progress-fill" });
    const actions = root.createDiv({ cls: "cd-modal-actions" });
    const cancel = actions.createEl("button", { cls: "cd-modal-btn", text: t("cancel") });
    cancel.addEventListener("click", () => {
      this.ctl.cancelled = true;
      cancel.disabled = true;
    });
    let result: ApplyResult | null = null;
    try {
      result = await this.plugin.applyPlan(
        plan,
        (d, total) => {
          label.setText(t("applying", d, total));
          fill.setCssProps({ "--cd-progress": `${Math.round((d / Math.max(1, total)) * 100)}%` });
        },
        this.ctl
      );
    } catch (e) {
      console.error("[note-pulse dedupe]", e);
      new Notice(String(e instanceof Error ? e.message : e));
    }
    this.running = false;
    if (result) this.plugin.showDoneToast(result);
    if (result && result.skipped.length > 0) this.showSkipped(result);
    else this.close();
  }

  /** Only shown when something could not be handled; otherwise the toast says it all. */
  private showSkipped(res: ApplyResult) {
    const root = this.contentEl;
    root.empty();
    this.setTitle(t("resultTitle"));
    const box = root.createDiv({ cls: "cd-result" });
    box.createDiv({ cls: "cd-result-line", text: t("resultSkipped", res.skipped.length) });
    const counts = new Map<string, number>();
    for (const s of res.skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);
    const ul = box.createEl("ul", { cls: "cd-result-list" });
    for (const [r, n] of counts) ul.createEl("li", { text: `${n} × ${this.plugin.skipText(r)}` });
    const actions = root.createDiv({ cls: "cd-modal-actions" });
    const close = actions.createEl("button", { cls: "mod-cta cd-modal-btn", text: t("close") });
    close.addEventListener("click", () => this.close());
    close.focus();
  }
}
