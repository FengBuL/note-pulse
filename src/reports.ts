import { App, Component, getFrontMatterInfo, MarkdownRenderer, Modal, Notice, Setting, TFile } from "obsidian";
import type { DashboardSettings } from "./settings";
import type { VaultStats } from "./stats";
import { buildWritingReport, ReportKind } from "./report-logic";
import { createReport, overwriteReport, reportPath, ReportStorageError } from "./report-storage";
import { L } from "./i18n";

export class ReportPreviewModal extends Modal {
  private offset = 0;
  private includeNotes = false;
  private busy = false;
  private preview!: HTMLElement;
  private actions!: HTMLElement;
  private periodHeading!: HTMLElement;
  private message!: HTMLElement;
  private rendering: Component | null = null;
  private report: ReturnType<typeof buildWritingReport>;

  constructor(app: App, private stats: VaultStats, private settings: DashboardSettings, private kind: ReportKind) {
    super(app);
    this.report = buildWritingReport(stats, settings, kind, 0, false);
  }

  onOpen(): void {
    this.setTitle(this.kind === "week" ? L("写作周报预览", "Weekly writing report preview") : L("写作月报预览", "Monthly writing report preview"));
    this.modalEl.addClass("vp-report-dialog");
    this.contentEl.addClass("vp-report-modal");
    this.periodHeading = this.contentEl.createDiv({ cls: "vp-report-period" });
    const controls = this.contentEl.createDiv({ cls: "vp-report-controls" });
    new Setting(controls).setName(L("时间范围", "Period")).addDropdown((dropdown) => {
      dropdown.addOption("0", this.kind === "week" ? L("本周", "This week") : L("本月", "This month"))
        .addOption("-1", this.kind === "week" ? L("上一周", "Last week") : L("上个月", "Last month"))
        .setValue("0").onChange((value) => {
          if (!this.busy) {
            this.offset = Number(value);
            void this.renderPreview();
          }
          dropdown.setValue(String(this.offset));
        });
    });
    new Setting(controls).setName(L("列出修改过的笔记", "List modified notes")).setDesc(L("在报告末尾添加可点击的笔记链接。", "Adds clickable links to the notes at the end of the report."))
      .addToggle((toggle) => toggle.setValue(false).onChange((value) => {
        if (!this.busy) {
          this.includeNotes = value;
          void this.renderPreview();
        }
        toggle.setValue(this.includeNotes);
      }));
    this.preview = this.contentEl.createDiv({ cls: "vp-report-preview markdown-rendered", attr: { tabindex: "0", role: "region", "aria-label": L("报告正文", "Report") } });
    const footer = this.contentEl.createDiv({ cls: "vp-report-footer" });
    this.message = footer.createDiv({ cls: "vp-report-message", attr: { role: "status", "aria-live": "polite" } });
    this.actions = footer.createDiv({ cls: "vp-report-actions" });
    void this.renderPreview();
  }

  private async renderPreview(): Promise<void> {
    this.rendering?.unload();
    const component = new Component();
    component.load();
    this.rendering = component;
    this.report = buildWritingReport(this.stats, this.settings, this.kind, this.offset, this.includeNotes);
    this.periodHeading.setText(`${this.report.periodLabel} · ${this.report.dateRange}`);
    this.preview.empty();
    this.preview.scrollTop = 0;
    this.message.empty();
    this.defaultActions();
    try {
      const path = reportPath(this.settings.reportFolder, this.report.title);
      this.message.setText(L(`保存位置：${path}`, `Saves to: ${path}`));
      // 原生笔记在属性区展示 frontmatter，预览正文也从标题开始。
      const body = this.report.markdown.slice(getFrontMatterInfo(this.report.markdown).contentStart);
      const rendered = createDiv({ cls: "vp-report-document" });
      await MarkdownRenderer.render(this.app, body, rendered, path, component);
      if (this.rendering === component) this.preview.replaceChildren(rendered);
    } catch (error) {
      if (this.rendering === component) this.showError(error);
    }
  }

  private defaultActions(): void {
    this.actions.empty();
    this.button(L("取消", "Cancel"), () => this.close());
    this.button(L("写入笔记", "Save as note"), () => void this.save(), true);
  }

  private button(text: string, action: () => void, primary = false): void {
    const button = this.actions.createEl("button", { text });
    if (primary) button.addClass("mod-cta");
    button.addEventListener("click", () => { if (!this.busy) action(); });
  }

  private async save(): Promise<void> {
    this.busy = true;
    try {
      const path = reportPath(this.settings.reportFolder, this.report.title);
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing) {
        this.actions.empty();
        this.message.setText(L(`已存在同名文件：${path}。请选择覆盖或另存为新文件。`, `${path} already exists. Replace it or save as a new file.`));
        this.button(L("取消", "Cancel"), () => this.close());
        if (existing instanceof TFile) {
          const original = await this.app.vault.read(existing);
          this.button(L("覆盖现有笔记", "Replace existing note"), () => void this.write(() => overwriteReport(this.app, existing, original, this.report.markdown)));
        }
        this.button(L("另存为新文件", "Save as new file"), () => void this.write(() => createReport(this.app, path, this.report.markdown, true)), true);
      } else {
        await this.finish(await createReport(this.app, path, this.report.markdown, false));
      }
    } catch (error) {
      this.showError(error);
    } finally {
      this.busy = false;
    }
  }

  private async write(action: () => Promise<TFile>): Promise<void> {
    this.busy = true;
    try {
      await this.finish(await action());
    } catch (error) {
      this.showError(error);
    } finally {
      this.busy = false;
    }
  }

  private async finish(file: TFile): Promise<void> {
    new Notice(L(`写作报告已保存：${file.path}`, `Writing report saved: ${file.path}`));
    this.close();
    await this.app.workspace.getLeaf("tab").openFile(file);
  }

  private showError(error: unknown): void {
    console.error("[note-pulse] 报告保存失败", error);
    this.message.setText(
      error instanceof ReportStorageError
        ? L(`未能保存：${error.message}`, `Could not save: ${error.message}`)
        : L("未能保存，请检查保存位置后重试。", "Could not save. Check the report folder and try again.")
    );
    this.defaultActions();
  }

  onClose(): void {
    this.rendering?.unload();
    this.rendering = null;
    this.contentEl.empty();
  }
}
