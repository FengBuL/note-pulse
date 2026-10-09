import { App, PluginSettingTab, Setting } from "obsidian";
import type NotePulsePlugin from "./main";

export type HeatmapMode = "mtime" | "delta";

export interface DashboardSettings {
  excludedFolders: string;
  dailyNoteFolder: string;
  createdFields: string;
  dailyWordGoal: number;
  heatmapMode: HeatmapMode;
  autoRefresh: boolean;
  refreshDelaySec: number;
  openInNewTab: boolean;
}

export const DEFAULT_SETTINGS: DashboardSettings = {
  excludedFolders: "",
  dailyNoteFolder: "",
  createdFields: "created, 创建时间, date",
  dailyWordGoal: 300,
  heatmapMode: "mtime",
  autoRefresh: true,
  refreshDelaySec: 3,
  openInNewTab: true,
};

export function splitList(s: string): string[] {
  return s
    .split(/[\n,，;；]/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

export function normalizeFolder(f: string): string {
  return f.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

export class DashboardSettingTab extends PluginSettingTab {
  plugin: NotePulsePlugin;

  constructor(app: App, plugin: NotePulsePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const save = async () => {
      await this.plugin.saveSettings();
    };

    new Setting(containerEl)
      .setName("排除的文件夹")
      .setDesc("这些文件夹（含子文件夹）中的笔记不参与统计。每行一个，或用逗号分隔，例如：Templates, Archive/Old")
      .addTextArea((t) => {
        t.setPlaceholder("Templates\nAttachments")
          .setValue(this.plugin.settings.excludedFolders)
          .onChange(async (v) => {
            this.plugin.settings.excludedFolders = v;
            await save();
          });
        t.inputEl.rows = 4;
      });

    new Setting(containerEl)
      .setName("日记文件夹")
      .setDesc("文件名为 YYYY-MM-DD 的笔记视为日记，用于“日记打卡”。留空则在整个仓库中识别。")
      .addText((t) =>
        t
          .setPlaceholder("例如：Daily")
          .setValue(this.plugin.settings.dailyNoteFolder)
          .onChange(async (v) => {
            this.plugin.settings.dailyNoteFolder = v;
            await save();
          })
      );

    new Setting(containerEl)
      .setName("每日字数目标")
      .setDesc("热力图中达到该字数的日子记为打卡成功（写了日记也算打卡）。设为 0 表示有任何写作即算打卡。")
      .addText((t) =>
        t
          .setPlaceholder("300")
          .setValue(String(this.plugin.settings.dailyWordGoal))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            this.plugin.settings.dailyWordGoal = isNaN(n) || n < 0 ? 0 : n;
            await save();
          })
      );

    new Setting(containerEl)
      .setName("写作热力图统计方式")
      .setDesc(
        "按修改日：把每篇笔记的全部字数计入其最后修改日（立即可用，但较粗略）。按每日新增：插件每次统计时记录字数增量（从启用之日起累积，更准确）。"
      )
      .addDropdown((d) =>
        d
          .addOption("mtime", "按修改日（全文字数）")
          .addOption("delta", "按每日新增字数（需累积）")
          .setValue(this.plugin.settings.heatmapMode)
          .onChange(async (v) => {
            this.plugin.settings.heatmapMode = v as HeatmapMode;
            await save();
          })
      );

    new Setting(containerEl)
      .setName("创建日期字段名")
      .setDesc("如果 frontmatter 中有这些字段且为 YYYY-MM-DD 日期，则用它作为创建日期（否则使用文件创建时间）。适合同步后文件时间不准的情况。")
      .addText((t) =>
        t.setValue(this.plugin.settings.createdFields).onChange(async (v) => {
          this.plugin.settings.createdFields = v;
          await save();
        })
      );

    new Setting(containerEl)
      .setName("自动刷新")
      .setDesc("仓库内容变化后自动刷新看板（带防抖）。")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoRefresh).onChange(async (v) => {
          this.plugin.settings.autoRefresh = v;
          await save();
        })
      );

    new Setting(containerEl)
      .setName("自动刷新延迟（秒）")
      .addText((t) =>
        t.setValue(String(this.plugin.settings.refreshDelaySec)).onChange(async (v) => {
          const n = parseFloat(v);
          this.plugin.settings.refreshDelaySec = isNaN(n) || n < 0.5 ? 0.5 : n;
          await save();
        })
      );

    new Setting(containerEl)
      .setName("在新标签页打开笔记")
      .setDesc("点击看板中的笔记时，在新标签页打开，保留看板。")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.openInNewTab).onChange(async (v) => {
          this.plugin.settings.openInNewTab = v;
          await save();
        })
      );

    new Setting(containerEl)
      .setName("清空每日新增字数记录")
      .setDesc("清除“按每日新增字数”模式下累积的历史记录。")
      .addButton((b) =>
        b
          .setButtonText("清空")
          .setWarning()
          .onClick(async () => {
            this.plugin.data.wordLog = {};
            this.plugin.data.fileWords = {};
            await this.plugin.persist();
            this.plugin.requestRefresh(true);
          })
      );
  }
}
