import { Notice, TAbstractFile, TFile, TFolder, WorkspaceLeaf, debounce, normalizePath } from "obsidian";
import type NotePulsePlugin from "../main";
import { Analysis, DupGroup, Occurrence, OverlapPair } from "./core/group";
import { ApplyIO, ApplyResult, BackupRecord, UndoResult, executePlan, undoBackup } from "./core/engine";
import { CleanMode, Plan, PlanItem, buildPlan } from "./core/plan";
import { StrKey, initLanguage, t } from "./i18n";
import { groupKey } from "./core/summary";
import { ConfirmModal, HelpModal, PreviewModal } from "./modals";
import { ScanControl, ScanProgress, cacheKey, runScan } from "./scanner";
import { ClipDedupeSettings, DEFAULT_SETTINGS } from "./settings";
import { BackupStore, ScanCache } from "./store";
import { ClipDedupeView, VIEW_TYPE_CLIP_DEDUPE } from "./view";
import { L } from "../i18n";

export interface BackupInfo {
  id: string;
  createdAt: number;
  files: number;
}

const nextTick = () => new Promise<void>((resolve) => window.setTimeout(resolve, 0));

/** Normalises stored dedupe settings (from Note Pulse data or an old Clip Dedupe data.json). */
export function normalizeDedupeSettings(raw: unknown): ClipDedupeSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<ClipDedupeSettings>;
  const out: ClipDedupeSettings = Object.assign({}, DEFAULT_SETTINGS, r);
  out.ignored = Array.isArray(r.ignored) ? r.ignored.filter((x): x is string => typeof x === "string") : [];
  return out;
}

/**
 * 重复内容清理（原 Clip Dedupe 插件，1.4.0 起并入 Note Pulse）。
 * 不是独立插件：由 NotePulsePlugin 持有，设置存放在 Note Pulse 的 data.json 的 settings.dedupe 里。
 */
export class DedupeService {
  analysis: Analysis | null = null;
  scannedAt = 0;
  scanning = false;
  progress: ScanProgress | null = null;
  stale = false;
  latestBackup: BackupInfo | null = null;
  /** Bumps whenever a new analysis replaces the old one, so views can drop selections that no longer apply. */
  analysisVersion = 0;
  private ctl: ScanControl = { cancelled: false };
  private cache!: ScanCache;
  private backups!: BackupStore;
  private working = false;
  private groupIndex = new Map<string, DupGroup>();
  private markStale = debounce(() => this.setStale(), 1500, true);
  private ribbonEl: HTMLElement | null = null;

  constructor(private host: NotePulsePlugin) {}

  get app() {
    return this.host.app;
  }

  get settings(): ClipDedupeSettings {
    return this.host.settings.dedupe;
  }

  get enabled(): boolean {
    return this.host.settings.dedupeEnabled;
  }

  async load() {
    initLanguage();
    const p = this.host;
    const dir = p.manifest.dir ?? `${p.app.vault.configDir}/plugins/${p.manifest.id}`;
    this.cache = new ScanCache(p.app.vault.adapter, normalizePath(`${dir}/dedupe-cache.json`));
    this.backups = new BackupStore(p.app.vault.adapter, normalizePath(`${dir}/dedupe-backups`));
    await this.cache.load(cacheKey(this.settings));
    await this.refreshBackupInfo();

    p.registerView(VIEW_TYPE_CLIP_DEDUPE, (leaf) => new ClipDedupeView(leaf, this));
    // Opening shows the welcome screen first, so nobody starts a scan without knowing what it does
    this.ribbonEl = p.addRibbonIcon("layers", t("pluginName"), () => void this.openReport(false));
    this.applyEnabled();
    const when = (fn: () => void) => (checking: boolean) => {
      if (!this.enabled) return false;
      if (!checking) fn();
      return true;
    };
    p.addCommand({ id: "dedupe-open", name: L("打开重复内容清理", "Open duplicate cleanup"), checkCallback: when(() => void this.openReport(false)) });
    p.addCommand({ id: "dedupe-scan", name: L("扫描重复内容", "Scan for duplicate content"), checkCallback: when(() => void this.openReport(true)) });
    p.addCommand({ id: "dedupe-undo-last", name: L("撤销上一次重复内容清理", "Undo the last duplicate cleanup"), checkCallback: when(() => void this.undoLast()) });
    p.addCommand({ id: "dedupe-help", name: L("重复内容清理：使用说明", "Duplicate cleanup: how it works"), checkCallback: when(() => this.openHelp()) });

    p.app.workspace.onLayoutReady(() => {
      const changed = (f: TAbstractFile) => {
        if (f instanceof TFile && f.extension === "md" && this.analysis && !this.working) this.markStale();
      };
      p.registerEvent(p.app.vault.on("modify", changed));
      p.registerEvent(p.app.vault.on("create", changed));
      p.registerEvent(p.app.vault.on("delete", changed));
      p.registerEvent(p.app.vault.on("rename", changed));
    });
  }

  dispose() {
    this.ctl.cancelled = true;
  }

  /** Shows or hides the ribbon icon and closes the view when the feature is switched off. */
  applyEnabled() {
    this.ribbonEl?.toggleClass("vp-hidden", !this.enabled);
    if (!this.enabled) {
      this.cancelScan();
      this.app.workspace.detachLeavesOfType(VIEW_TYPE_CLIP_DEDUPE);
    }
  }

  /* ---------------- views ---------------- */

  getViews(): ClipDedupeView[] {
    return this.app.workspace
      .getLeavesOfType(VIEW_TYPE_CLIP_DEDUPE)
      .map((l) => l.view)
      .filter((v): v is ClipDedupeView => v instanceof ClipDedupeView);
  }

  notifyViews() {
    for (const v of this.getViews()) v.refresh();
    // 看板上的“库体检”也显示重复内容，一起更新
    this.host.refreshViewsOnly();
  }

  async openReport(scanNow: boolean) {
    if (!this.enabled) {
      new Notice(L("重复内容清理已在设置中关闭", "Duplicate cleanup is turned off in settings"));
      return;
    }
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_CLIP_DEDUPE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE_CLIP_DEDUPE, active: true });
    }
    await workspace.revealLeaf(leaf);
    if (scanNow && !this.scanning) void this.scan();
  }

  openSettings() {
    this.host.openSettings();
  }

  openHelp() {
    new HelpModal(this.app).open();
  }

  /** Folders a beginner can pick from on the welcome screen (top two levels). */
  folderList(): string[] {
    return this.app.vault
      .getAllLoadedFiles()
      .filter((f): f is TFolder => f instanceof TFolder && !f.isRoot() && !f.path.startsWith(".") && f.path.split("/").length <= 2)
      .map((f) => f.path)
      .sort((a, b) => a.localeCompare(b));
  }

  async setScope(folder: string) {
    this.settings.includeFolders = folder;
    await this.saveSettings();
  }

  /* ---------------- ignoring ---------------- */

  ignoredSet(): Set<string> {
    return new Set(this.settings.ignored);
  }

  async ignoreGroup(g: DupGroup) {
    const key = groupKey(g);
    if (!this.settings.ignored.includes(key)) this.settings.ignored.push(key);
    await this.host.saveDedupeSettings();
    this.notifyViews();
  }

  /** 忽略一对笔记：它们共同的段落都标为忽略，这一对不再显示（恢复忽略后会回来） */
  async ignorePair(p: OverlapPair) {
    for (const id of p.groupIds) {
      const g = this.groupIndex.get(id);
      if (!g) continue;
      const key = groupKey(g);
      if (!this.settings.ignored.includes(key)) this.settings.ignored.push(key);
    }
    await this.host.saveDedupeSettings();
    this.notifyViews();
  }

  /** 两篇几乎一样时，把较新的那篇移到回收站（先确认；回收站里可以找回） */
  trashNote(path: string, keepPath: string) {
    const file = this.app.vault.getFileByPath(path);
    if (!file) return;
    new ConfirmModal(this.app, t("pairTrashTitle"), t("pairTrashText", file.basename, keepPath.split("/").pop()?.replace(/\.md$/i, "") ?? keepPath), t("pairTrashConfirm"), async () => {
      await this.app.fileManager.trashFile(file);
    }).open();
  }

  async restoreIgnored() {
    this.settings.ignored = [];
    await this.host.saveDedupeSettings();
    this.notifyViews();
  }

  /* ---------------- scanning ---------------- */

  private setStale() {
    if (this.stale) return;
    this.stale = true;
    this.notifyViews();
  }

  async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    this.ctl = { cancelled: false };
    this.progress = null;
    this.notifyViews();
    try {
      const result = await runScan(this.app, this.settings, this.cache, this.ctl, (p) => {
        this.progress = p;
        for (const v of this.getViews()) v.setProgress(p);
      });
      if (result === null) {
        new Notice(t("scanCancelled"));
      } else {
        this.analysis = result;
        this.analysisVersion++;
        this.groupIndex = new Map(result.groups.map((g) => [g.id, g]));
        this.scannedAt = Date.now();
        this.stale = false;
      }
    } catch (e) {
      console.error("[note-pulse dedupe]", e);
      new Notice(t("scanFailed"));
    } finally {
      this.scanning = false;
      this.progress = null;
      this.notifyViews();
    }
  }

  cancelScan() {
    this.ctl.cancelled = true;
  }

  async clearCache() {
    await this.cache.clear();
    new Notice(t("cacheCleared"));
  }

  groupById(id: string): DupGroup | undefined {
    return this.groupIndex.get(id);
  }

  /* ---------------- reading and opening ---------------- */

  /** Raw text of a block as it is in the note right now. */
  async readBlock(occ: Occurrence): Promise<string | null> {
    const file = this.app.vault.getFileByPath(occ.path);
    if (!file) return null;
    const lines = (await this.app.vault.cachedRead(file)).split("\n");
    if (occ.block.e >= lines.length) return null;
    return lines
      .slice(occ.block.s, occ.block.e + 1)
      .join("\n")
      .replace(/\r/g, "");
  }

  async openNote(path: string, line?: number, evt?: MouseEvent | KeyboardEvent, split = false) {
    const file = this.app.vault.getFileByPath(path);
    if (!file) return;
    const newTab = this.settings.openInNewTab || (evt && (evt.ctrlKey || evt.metaKey));
    const leaf = split ? this.app.workspace.getLeaf("split", "vertical") : this.app.workspace.getLeaf(newTab ? "tab" : false);
    await leaf.openFile(file, line !== undefined ? { eState: { line } } : undefined);
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  /** Opens two notes next to each other. */
  async openBoth(older: string, newer: string) {
    await this.openNote(older);
    await this.openNote(newer, undefined, undefined, true);
  }

  /* ---------------- cleanup ---------------- */

  linkText(path: string, from?: string): string {
    const file = this.app.vault.getFileByPath(path);
    return file ? this.app.metadataCache.fileToLinktext(file, from ?? "", true) : path.replace(/\.md$/, "");
  }

  makePlan(items: PlanItem[], texts: Map<string, string>, mode: CleanMode): Plan {
    return buildPlan(items, texts, {
      mode,
      embed: this.settings.linkStyle === "embed",
      linkText: (p) => this.linkText(p),
      linkLabel: (p) => this.linkText(p),
    });
  }

  async readTexts(paths: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const p of paths) {
      const f = this.app.vault.getFileByPath(p);
      if (f) out.set(p, await this.app.vault.read(f));
    }
    return out;
  }

  startCleanup(items: PlanItem[], mode?: CleanMode) {
    if (items.length === 0) return;
    new PreviewModal(this.app, this, items, mode).open();
  }

  /** Itemises one group, optionally cleaning only some of its notes (used by the overlapping-notes view). */
  pairItems(groupIds: string[], older: string, newer: string): PlanItem[] {
    const items: PlanItem[] = [];
    for (const id of groupIds) {
      const g = this.groupIndex.get(id);
      const keep = g?.occs.find((o) => o.path === older);
      const rm = g?.occs.find((o) => o.path === newer);
      if (g && keep && rm) items.push({ group: g, keep, remove: [rm] });
    }
    return items;
  }

  private io(): ApplyIO {
    const fileOf = (p: string) => this.app.vault.getFileByPath(p);
    return {
      now: () => Date.now(),
      mtime: (p) => fileOf(p)?.stat.mtime ?? null,
      read: async (p) => {
        const f = fileOf(p);
        return f ? await this.app.vault.read(f) : null;
      },
      process: async (p, fn) => {
        const f = fileOf(p);
        if (!f) throw new Error(`Missing note: ${p}`);
        return await this.app.vault.process(f, fn);
      },
      processFrontMatter: async (p, fn) => {
        const f = fileOf(p);
        if (!f) throw new Error(`Missing note: ${p}`);
        await this.app.fileManager.processFrontMatter(f, (fm: Record<string, unknown>) => fn(fm));
      },
      saveBackup: (rec) => this.backups.save(rec),
      deleteBackup: (id) => this.backups.remove(id),
      yieldToUi: nextTick,
    };
  }

  async applyPlan(plan: Plan, onProgress: (done: number, total: number) => void, ctl: { cancelled: boolean }): Promise<ApplyResult> {
    this.working = true;
    const notice = new Notice(t("applying", 0, plan.files.length * 2), 0);
    try {
      return await executePlan(plan, this.io(), this.settings.propertyName, {
        progress: (d, tot) => {
          onProgress(d, tot);
          notice.setMessage(t("applying", d, tot));
        },
        cancelled: () => ctl.cancelled,
      });
    } finally {
      notice.hide();
      await this.backups.prune(this.settings.backupsToKeep);
      await this.refreshBackupInfo();
      this.working = false;
      this.setStale();
      this.rescanSoon();
    }
  }

  /** A short message after a cleanup, with an undo button right in it. */
  showDoneToast(res: ApplyResult) {
    const frag = createFragment();
    const box = frag.createDiv({ cls: "cd-toast" });
    let msg = res.changed.length ? t("doneToast", res.changed.length) : t("doneNone");
    if (res.skipped.length) msg += t("doneSkipped", res.skipped.length);
    box.createSpan({ cls: "cd-toast-text", text: msg });
    let notice: Notice | null = null;
    if (res.backupId && res.changed.length) {
      const b = box.createEl("button", { cls: "cd-toast-btn", text: t("undo"), attr: { type: "button" } });
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        notice?.hide();
        void this.undoLast();
      });
    }
    notice = new Notice(frag, 12000);
  }

  /** Re-reads the notes a moment after a cleanup or undo so the report matches what is on disk. */
  private rescanSoon() {
    window.setTimeout(() => void this.scan(), 800);
  }

  async refreshBackupInfo() {
    const rec = await this.backups.latest();
    this.latestBackup = rec ? { id: rec.id, createdAt: rec.createdAt, files: rec.files.length } : null;
    this.notifyViews();
  }

  async runUndo(rec: BackupRecord): Promise<UndoResult> {
    this.working = true;
    const notice = new Notice(t("undoProgress"), 0);
    try {
      return await undoBackup(rec, this.io());
    } finally {
      notice.hide();
      this.working = false;
      await this.refreshBackupInfo();
      this.setStale();
      this.rescanSoon();
    }
  }

  async undoLast(): Promise<void> {
    const rec = await this.backups.latest();
    if (!rec) {
      new Notice(t("undoNone"));
      return;
    }
    new ConfirmModal(
      this.app,
      t("undoTitle"),
      t("undoBody", rec.files.length, new Date(rec.createdAt).toLocaleString()),
      t("undoConfirm"),
      async () => {
        const res = await this.runUndo(rec);
        new Notice(res.skipped.length ? t("undoDoneSkipped", res.restored.length, res.skipped.length) : t("undoDone", res.restored.length));
      }
    ).open();
  }

  skipText(reason: string): string {
    return t(`skip_${reason}` as StrKey);
  }

  /* ---------------- settings ---------------- */

  async saveSettings() {
    await this.host.saveDedupeSettings();
    this.cache.useKey(cacheKey(this.settings));
    if (this.analysis) this.setStale();
  }
}
