import { App, ButtonComponent, Modal, Notice, Setting, TFile, TAbstractFile, getFrontMatterInfo, parseYaml } from "obsidian";
import type NotePulsePlugin from "./main";
import { normalizeFolder, splitList } from "./settings";
import { L, plural } from "./i18n";
import {
  Computed,
  RECENT_MS,
  SkipReason,
  WordPropOptions,
  WriteDecision,
  compute,
  decideWrite,
  isRecentlyModified,
  pathSkipReason,
} from "./wordprops-logic";

type Frontmatter = Record<string, unknown>;

/** 读出笔记现有的 frontmatter。没有属性区返回 null；YAML 无法解析返回 undefined。 */
function readFrontmatter(text: string): Frontmatter | null | undefined {
  const info = getFrontMatterInfo(text);
  if (!info.exists) return null;
  try {
    const v: unknown = parseYaml(info.frontmatter);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Frontmatter;
    return v === null || v === undefined ? {} : undefined;
  } catch {
    return undefined;
  }
}

const prefix = () => L("Note Pulse：", "Note Pulse: ");
function notify(text: string, ms?: number): Notice {
  return new Notice(prefix() + text, ms);
}
const n_ = (n: number) => plural(n, "note");

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

/** 带“确认 / 取消”按钮的对话框；内容在统计完成后再填 */
class ActionModal extends Modal {
  closed = false;
  private bodyEl!: HTMLElement;
  private okButton!: ButtonComponent;

  constructor(
    app: App,
    private heading: string,
    private okText: string,
    private onOk: () => void,
    private danger = false
  ) {
    super(app);
  }

  onOpen() {
    this.setTitle(this.heading);
    this.bodyEl = this.contentEl.createDiv();
    new Setting(this.contentEl)
      .addButton((b) => {
        this.okButton = b;
        if (this.danger) b.buttonEl.addClass("mod-warning");
        else b.setCta();
        b.setButtonText(this.okText)
          .setDisabled(true)
          .onClick(() => {
            this.close();
            this.onOk();
          });
      })
      .addButton((b) => b.setButtonText(L("取消", "Cancel")).onClick(() => this.close()));
  }

  onClose() {
    this.closed = true;
    this.contentEl.empty();
  }

  setLines(lines: string[]) {
    this.bodyEl.empty();
    for (const l of lines) this.bodyEl.createEl("p", { text: l });
  }

  setReady(ok: boolean) {
    this.okButton.setDisabled(!ok);
  }
}

export type UpdateKind = "written" | "unchanged" | "skipped" | "outlier" | "recent" | "empty" | "error";
export interface UpdateOutcome {
  kind: UpdateKind;
  words?: number;
  minutes?: number | null;
}

interface PlanItem {
  file: TFile;
  mtime: number;
  words: number;
  minutes: number | null;
}
interface Plan {
  items: PlanItem[];
  scanned: number;
  unchanged: number;
  outlier: number;
  recent: number;
  outOfScope: number;
  empty: number;
  error: number;
}

const BATCH = 20;

/** 把字数写进笔记属性。所有写入都经过 decideWrite：值没变就绝不写。 */
export class WordPropsService {
  private pending = new Set<string>();
  /** 正在由本插件写入的文件：这期间的 modify / editor-change 事件一律忽略 */
  private inflight = new Set<string>();
  /** 本插件上一次写完后文件的 mtime：对应的 modify 事件是自己触发的 */
  private ownMtime = new Map<string, number>();
  private timer: number | null = null;
  private busy = false;
  private disposed = false;

  constructor(private plugin: NotePulsePlugin) {}

  private get app(): App {
    return this.plugin.app;
  }

  options(): WordPropOptions {
    const s = this.plugin.settings;
    return {
      property: s.wordPropName,
      readingEnabled: s.wordPropReading,
      readingProperty: s.wordPropReadingName,
      cjkPerMin: s.wordPropCjkPerMin,
      wordsPerMin: s.wordPropLatinPerMin,
      minChange: s.wordPropMinChange,
      skipOutliers: s.wordPropSkipOutliers,
      outlierWords: s.outlierWords,
      includeFolders: splitList(s.wordPropIncludeFolders).map(normalizeFolder),
      excludeFolders: [...splitList(s.wordPropExcludeFolders), ...splitList(s.excludedFolders)].map(normalizeFolder),
    };
  }

  /* ---------------- 自动：只跟随正在编辑的笔记 ---------------- */

  register() {
    const { workspace, vault } = this.app;
    this.plugin.registerEvent(
      workspace.on("editor-change", (_editor, info) => {
        if (info.file) this.onEdited(info.file);
      })
    );
    this.plugin.registerEvent(
      vault.on("modify", (f: TAbstractFile) => {
        // 只关心当前打开的那篇；其他文件被同步改动不是“编辑”，不去碰
        if (f instanceof TFile && f.path === workspace.getActiveFile()?.path) this.onEdited(f);
      })
    );
  }

  private onEdited(file: TFile) {
    if (!this.plugin.settings.wordPropEnabled || this.disposed) return;
    if (this.inflight.has(file.path)) return;
    if (this.ownMtime.get(file.path) === file.stat.mtime) return; // 自己刚写的，不要形成循环
    if (pathSkipReason(file.path, file.extension, this.options())) return;
    this.pending.add(file.path);
    this.schedule();
  }

  private schedule() {
    if (this.timer !== null) window.clearTimeout(this.timer);
    const ms = Math.max(3, this.plugin.settings.wordPropIdleSec) * 1000;
    // 写入一定发生在定时器里，绝不在事件处理函数的同一个调用栈内
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, ms);
  }

  private async flush() {
    if (this.disposed) return;
    if (this.busy) {
      // 批量任务在跑：稍后再来
      this.schedule();
      return;
    }
    const paths = Array.from(this.pending);
    this.pending.clear();
    let again = false;
    for (const p of paths) {
      if (!this.plugin.settings.wordPropEnabled) break;
      const f = this.app.vault.getAbstractFileByPath(p);
      if (!(f instanceof TFile)) continue;
      const r = await this.updateFile(f, this.options());
      if (r.kind === "recent") {
        this.pending.add(p);
        again = true;
      }
    }
    if (again) this.schedule();
  }

  dispose() {
    this.disposed = true;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.pending.clear();
  }

  /* ---------------- 单篇 ---------------- */

  private evaluate(text: string, o: WordPropOptions): { d: WriteDecision; c: Computed } | "bad-yaml" {
    const fm = readFrontmatter(text);
    if (fm === undefined) return "bad-yaml";
    const c = compute(text, o);
    return { d: decideWrite(fm, c, o), c };
  }

  /** 读取、统计、判断，需要时写入。写入前会再确认文件在此期间没有被改动。 */
  async updateFile(file: TFile, o: WordPropOptions): Promise<UpdateOutcome> {
    if (pathSkipReason(file.path, file.extension, o)) return { kind: "skipped" };
    if (isRecentlyModified(file.stat.mtime, Date.now())) return { kind: "recent" };
    const mtime = file.stat.mtime;
    let text: string;
    try {
      text = await this.app.vault.read(file);
    } catch (e) {
      console.warn("[note-pulse] 读取失败", file.path, e);
      return { kind: "error" };
    }
    const ev = this.evaluate(text, o);
    if (ev === "bad-yaml") return { kind: "error" };
    if (!ev.d.write) return { kind: ev.d.reason, words: ev.c.words, minutes: ev.c.minutes };
    return this.write(file, { file, mtime, words: ev.d.words, minutes: ev.d.minutes }, o);
  }

  private async write(file: TFile, item: PlanItem, o: WordPropOptions): Promise<UpdateOutcome> {
    // 文件在读取之后又被改了（可能正在别处编辑 / 同步中）：这次不写
    if (file.stat.mtime !== item.mtime || isRecentlyModified(file.stat.mtime, Date.now())) return { kind: "recent" };
    this.inflight.add(file.path);
    try {
      await this.app.fileManager.processFrontMatter(file, (fm: Frontmatter) => {
        fm[o.property] = item.words;
        if (item.minutes !== null) fm[o.readingProperty] = item.minutes;
      });
      this.ownMtime.set(file.path, file.stat.mtime);
      return { kind: "written", words: item.words, minutes: item.minutes };
    } catch (e) {
      console.warn("[note-pulse] 写入字数属性失败", file.path, e);
      return { kind: "error" };
    } finally {
      window.setTimeout(() => this.inflight.delete(file.path), 1000);
    }
  }

  async updateCurrent() {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") {
      notify(L("请先打开一篇 Markdown 笔记", "Open a Markdown note first"));
      return;
    }
    const o = this.options();
    const r = await this.updateFile(file, o);
    switch (r.kind) {
      case "written": {
        const reading = r.minutes != null ? `${L("，", ", ")}${o.readingProperty} = ${r.minutes}` : "";
        notify(L(`已写入 ${o.property} = ${r.words}${reading}`, `Wrote ${o.property} = ${r.words}${reading}`));
        break;
      }
      case "unchanged":
        notify(L(`「${o.property}」已经是最新（${r.words}），没有改动文件`, `${o.property} is already up to date (${r.words}); the file was not changed`));
        break;
      case "empty":
        notify(L("笔记还没有内容，没有写入", "The note is empty; nothing was written"));
        break;
      case "outlier":
        notify(L(`这篇笔记超过超大笔记阈值（${o.outlierWords} 字），按设置不写入`, `This note is over the oversized note threshold (${o.outlierWords} words), so it is skipped`));
        break;
      case "skipped":
        notify(L("这篇笔记在不写入的文件夹里（或不在“只写入”的文件夹里）", "This note is in a skipped folder (or outside the \"only these folders\" list)"));
        break;
      case "recent":
        notify(L("这篇笔记刚刚被修改过，过几秒再试", "This note was just changed. Try again in a few seconds"));
        break;
      default:
        notify(L("写入失败，可能是属性区的 YAML 有错误", "Could not write. The note's YAML properties may contain an error"));
    }
  }

  /* ---------------- 批量 ---------------- */

  private async buildPlan(o: WordPropOptions, onProgress: (done: number, total: number) => void, cancelled: () => boolean): Promise<Plan | null> {
    const files = this.app.vault.getMarkdownFiles();
    const plan: Plan = { items: [], scanned: files.length, unchanged: 0, outlier: 0, recent: 0, outOfScope: 0, empty: 0, error: 0 };
    let n = 0;
    for (const f of files) {
      if (cancelled() || this.disposed) return null;
      if (++n % 25 === 0) {
        onProgress(n, files.length);
        await sleep(0);
      }
      const skip: SkipReason | null = pathSkipReason(f.path, f.extension, o);
      if (skip) {
        plan.outOfScope++;
        continue;
      }
      if (isRecentlyModified(f.stat.mtime, Date.now())) {
        plan.recent++;
        continue;
      }
      let text: string;
      try {
        text = await this.app.vault.cachedRead(f);
      } catch {
        plan.error++;
        continue;
      }
      const ev = this.evaluate(text, o);
      if (ev === "bad-yaml") plan.error++;
      else if (ev.d.write) plan.items.push({ file: f, mtime: f.stat.mtime, words: ev.d.words, minutes: ev.d.minutes });
      else if (ev.d.reason === "outlier") plan.outlier++;
      else if (ev.d.reason === "empty") plan.empty++;
      else plan.unchanged++;
    }
    return plan;
  }

  async batchUpdate() {
    if (this.busy) {
      notify(L("已有批量任务在进行", "A batch update is already running"));
      return;
    }
    const o = this.options();
    let plan: Plan | null = null;
    const modal = new ActionModal(this.app, L("批量更新字数属性", "Update word count property"), L("开始更新", "Update"), () => {
      if (plan) void this.applyPlan(plan, o);
    });
    modal.open();
    const counting = L("正在统计，不会修改任何文件…", "Counting. No files are changed yet…");
    modal.setLines([counting]);
    plan = await this.buildPlan(o, (d, t) => modal.setLines([`${counting} ${d} / ${t}`]), () => modal.closed);
    if (!plan || modal.closed) return;

    const names = o.readingEnabled
      ? L(`「${o.property}」和「${o.readingProperty}」`, `${o.property} and ${o.readingProperty}`)
      : L(`「${o.property}」`, o.property);
    const p = plan;
    const lines = [
      p.items.length > 0
        ? L(`共检查 ${p.scanned} 篇笔记，将更新 ${p.items.length} 篇的${names}属性。`, `Checked ${p.scanned} ${n_(p.scanned)}. ${names} will be updated in ${p.items.length} ${n_(p.items.length)}.`)
        : L(`共检查 ${p.scanned} 篇笔记，没有需要更新的。`, `Checked ${p.scanned} ${n_(p.scanned)}. Nothing needs updating.`),
      L(`已经是最新、不会被改动：${p.unchanged} 篇。`, `Already up to date and left alone: ${p.unchanged}.`),
    ];
    const skipped: string[] = [];
    if (p.outOfScope) skipped.push(L(`不在写入范围内 ${p.outOfScope} 篇`, `${p.outOfScope} outside the folders to write`));
    if (p.outlier) skipped.push(L(`超大笔记 ${p.outlier} 篇`, `${p.outlier} oversized`));
    if (p.recent) skipped.push(L(`刚被修改过 ${p.recent} 篇`, `${p.recent} just changed`));
    if (p.empty) skipped.push(L(`空笔记 ${p.empty} 篇`, `${p.empty} empty`));
    if (p.error) skipped.push(L(`属性区无法解析 ${p.error} 篇`, `${p.error} with unreadable properties`));
    if (skipped.length) lines.push(L(`跳过：${skipped.join("，")}。`, `Skipped: ${skipped.join(", ")}.`));
    if (p.items.length > 0) {
      lines.push(
        L(
          "写入时 Obsidian 会重新整理这些笔记的属性区：没有属性区的笔记会新增一个，YAML 里的注释可能丢失。如果你的仓库在 iCloud 等同步盘里，改动的文件会被同步。建议先备份。",
          "Obsidian reformats the properties of these notes when writing: notes without properties get them, and YAML comments may be lost. If your vault is in iCloud or another synced folder, the changed files will sync. Back up first."
        )
      );
    }
    modal.setLines(lines);
    modal.setReady(plan.items.length > 0);
  }

  private async applyPlan(plan: Plan, o: WordPropOptions) {
    if (this.busy) return;
    this.busy = true;
    const total = plan.items.length;
    const progress = (i: number) => L(`正在更新字数属性 ${i} / ${total}`, `Updating word count property ${i} / ${total}`);
    const notice = notify(progress(0), 0);
    const res = { written: 0, unchanged: 0, recent: 0, error: 0 };
    try {
      for (let i = 0; i < total; i++) {
        if (this.disposed) break;
        const item = plan.items[i];
        // 统计之后文件被改过：重新判断一次，而不是写入过期的值
        const r = item.file.stat.mtime === item.mtime ? await this.write(item.file, item, o) : await this.updateFile(item.file, o);
        if (r.kind === "written") res.written++;
        else if (r.kind === "recent") res.recent++;
        else if (r.kind === "error") res.error++;
        else res.unchanged++;
        if ((i + 1) % BATCH === 0 || i === total - 1) {
          notice.setMessage(prefix() + progress(i + 1));
          await sleep(50); // 分批写，给同步盘和界面留出喘息
        }
      }
    } finally {
      notice.hide();
      this.busy = false;
    }
    const extra = [
      res.unchanged ? L(`${res.unchanged} 篇已是最新`, `${res.unchanged} already up to date`) : "",
      res.recent ? L(`${res.recent} 篇刚被修改，已跳过`, `${res.recent} just changed, skipped`) : "",
      res.error ? L(`${res.error} 篇失败`, `${res.error} failed`) : "",
    ].filter(Boolean);
    notify(
      L(
        `已更新 ${res.written} 篇${extra.length ? "（" + extra.join("，") + "）" : ""}`,
        `Updated ${res.written} ${n_(res.written)}${extra.length ? " (" + extra.join(", ") + ")" : ""}`
      ),
      8000
    );
    void this.plugin.requestRefresh(false);
  }

  /* ---------------- 移除 ---------------- */

  async removeAll() {
    if (this.busy) {
      notify(L("已有批量任务在进行", "A batch update is already running"));
      return;
    }
    const o = this.options();
    const names = o.readingEnabled ? [o.property, o.readingProperty] : [o.property];
    const items: TFile[] = [];
    for (const f of this.app.vault.getMarkdownFiles()) {
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
      if (fm && names.some((n) => Object.prototype.hasOwnProperty.call(fm, n))) items.push(f);
    }
    const label = L(names.map((n) => `「${n}」`).join("和"), names.join(" and "));
    const modal = new ActionModal(
      this.app,
      L("移除字数属性", "Remove word count properties"),
      L("移除", "Remove"),
      () => void this.applyRemove(items, names),
      true
    );
    modal.open();
    modal.setLines(
      items.length > 0
        ? [
            L(`将从 ${items.length} 篇笔记中删除属性 ${label}。`, `${label} will be deleted from ${items.length} ${n_(items.length)}.`),
            L("按属性名删除：如果你自己也用了同名属性，它也会被删掉。", "Properties are deleted by name: a property of yours with the same name is deleted too."),
            L(
              "写入时 Obsidian 会重新整理这些笔记的属性区，YAML 里的注释可能丢失。此操作无法撤销，建议先备份。",
              "Obsidian reformats the properties of these notes when writing, and YAML comments may be lost. This cannot be undone. Back up first."
            ),
          ]
        : [L(`没有笔记含有属性 ${label}，无需移除。`, `No note has ${label}. Nothing to remove.`)]
    );
    modal.setReady(items.length > 0);
  }

  private async applyRemove(files: TFile[], names: string[]) {
    if (this.busy) return;
    this.busy = true;
    const progress = (i: number) => L(`正在移除字数属性 ${i} / ${files.length}`, `Removing word count properties ${i} / ${files.length}`);
    const notice = notify(progress(0), 0);
    let removed = 0;
    let skipped = 0;
    let failed = 0;
    try {
      for (let i = 0; i < files.length; i++) {
        if (this.disposed) break;
        const f = files[i];
        if (isRecentlyModified(f.stat.mtime, Date.now(), RECENT_MS)) {
          skipped++;
          continue;
        }
        this.inflight.add(f.path);
        try {
          await this.app.fileManager.processFrontMatter(f, (fm: Frontmatter) => {
            for (const n of names) delete fm[n];
          });
          this.ownMtime.set(f.path, f.stat.mtime);
          removed++;
        } catch (e) {
          console.warn("[note-pulse] 移除失败", f.path, e);
          failed++;
        } finally {
          window.setTimeout(() => this.inflight.delete(f.path), 1000);
        }
        if ((i + 1) % BATCH === 0 || i === files.length - 1) {
          notice.setMessage(prefix() + progress(i + 1));
          await sleep(50);
        }
      }
    } finally {
      notice.hide();
      this.busy = false;
    }
    notify(
      L(
        `已从 ${removed} 篇笔记移除字数属性${skipped ? `，${skipped} 篇刚被修改已跳过` : ""}${failed ? `，${failed} 篇失败` : ""}`,
        `Removed word count properties from ${removed} ${n_(removed)}${skipped ? `, ${skipped} just changed and skipped` : ""}${failed ? `, ${failed} failed` : ""}`
      ),
      8000
    );
  }
}
