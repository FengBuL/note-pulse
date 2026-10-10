import { App, PluginSettingTab, Setting } from "obsidian";
import type NotePulsePlugin from "./main";

export type HeatmapMode = "auto" | "mtime" | "delta";
export type OutlierMode = "exclude" | "off";

/** 设置结构版本：用于一次性迁移旧设置 */
export const SETTINGS_VERSION = 2;

export interface DashboardSettings {
  settingsVersion: number;
  excludedFolders: string;
  /** 采集 / 剪藏文件夹：笔记仍计入总数，但不计入字数趋势、热力图和打卡 */
  clippingFolders: string;
  /** 是否把超大笔记排除出写作统计 */
  outlierMode: OutlierMode;
  /** 超过这个字数的笔记视为超大笔记（通常是自动采集或整段粘贴） */
  outlierWords: number;
  /** 已经点过“忽略”的提示 */
  dismissedHints: string[];
  onboarded: boolean;
  dailyNoteFolder: string;
  createdFields: string;
  dailyWordGoal: number;
  heatmapMode: HeatmapMode;
  autoRefresh: boolean;
  refreshDelaySec: number;
  openInNewTab: boolean;
}

export const DEFAULT_SETTINGS: DashboardSettings = {
  settingsVersion: SETTINGS_VERSION,
  excludedFolders: "",
  clippingFolders: "",
  outlierMode: "exclude",
  outlierWords: 20000,
  dismissedHints: [],
  onboarded: false,
  dailyNoteFolder: "",
  createdFields: "created, 创建时间, date",
  dailyWordGoal: 300,
  heatmapMode: "auto",
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
    const st = this.plugin.settings;

    const save = async () => {
      await this.plugin.saveSettings();
    };

    new Setting(containerEl).setName("范围").setHeading();

    new Setting(containerEl)
      .setName("排除的文件夹")
      .setDesc("这些文件夹（含子文件夹）中的笔记完全不参与统计。每行一个，或用逗号分隔，例如：Templates, Archive/Old")
      .addTextArea((t) => {
        t.setPlaceholder("Templates\nAttachments")
          .setValue(st.excludedFolders)
          .onChange(async (v) => {
            st.excludedFolders = v;
            await save();
          });
        t.inputEl.rows = 3;
      });

    new Setting(containerEl)
      .setName("采集 / 剪藏文件夹")
      .setDesc(
        "自动抓取、网页剪藏、每日转存之类的文件夹。里面的笔记仍计入笔记总数，但不计入字数趋势、写作热力图、打卡和“新建笔记”曲线。"
      )
      .addTextArea((t) => {
        t.setPlaceholder("x\nClippings")
          .setValue(st.clippingFolders)
          .onChange(async (v) => {
            st.clippingFolders = v;
            await save();
          });
        t.inputEl.rows = 2;
      });

    new Setting(containerEl)
      .setName("排除超大笔记")
      .setDesc("字数超过下面阈值的笔记不计入字数趋势、热力图和打卡（笔记数量仍计入）。看板上会注明排除了哪些。")
      .addToggle((t) =>
        t.setValue(st.outlierMode === "exclude").onChange(async (v) => {
          st.outlierMode = v ? "exclude" : "off";
          await save();
        })
      );

    new Setting(containerEl)
      .setName("超大笔记阈值（字）")
      .setDesc("默认 20000。汉字按字、英文按词计。")
      .addText((t) =>
        t.setPlaceholder("20000").setValue(String(st.outlierWords)).onChange(async (v) => {
          const n = parseInt(v, 10);
          st.outlierWords = isNaN(n) || n < 1000 ? 1000 : n;
          await save();
        })
      );

    new Setting(containerEl).setName("打卡与热力图").setHeading();

    new Setting(containerEl)
      .setName("日记文件夹")
      .setDesc("文件名为 YYYY-MM-DD 的笔记视为日记，用于“日记打卡”。留空则在整个仓库中识别。内容少于 10 字的空日记不算打卡。")
      .addText((t) =>
        t
          .setPlaceholder("例如：Daily")
          .setValue(st.dailyNoteFolder)
          .onChange(async (v) => {
            st.dailyNoteFolder = v;
            await save();
          })
      );

    new Setting(containerEl)
      .setName("每日字数目标")
      .setDesc("达到该字数的日子记为打卡成功（写了日记也算打卡）。设为 0 表示有任何写作即算打卡。")
      .addText((t) =>
        t
          .setPlaceholder("300")
          .setValue(String(st.dailyWordGoal))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            st.dailyWordGoal = isNaN(n) || n < 0 ? 0 : n;
            await save();
          })
      );

    new Setting(containerEl)
      .setName("写作量统计方式")
      .setDesc(
        "智能（推荐）：启用插件之后的日子按每日实际新增字数记录（看板关着也会记），之前的日子按“最后修改日”估算。" +
          "按修改日：每篇笔记的全部字数记在它最后修改的那天，较粗略。按每日新增：只用实测记录，从启用之日起累积。"
      )
      .addDropdown((d) =>
        d
          .addOption("auto", "智能：实测 + 估算")
          .addOption("mtime", "按修改日（全文字数）")
          .addOption("delta", "按每日新增字数（需累积）")
          .setValue(st.heatmapMode)
          .onChange(async (v) => {
            st.heatmapMode = v as HeatmapMode;
            await save();
          })
      );

    new Setting(containerEl)
      .setName("创建日期字段名")
      .setDesc(
        "如果 frontmatter 中有这些字段且为 YYYY-MM-DD 日期，则用它作为创建日期，否则使用文件创建时间。" +
          "iCloud、Dropbox、git 等同步后文件创建时间常常被重置，如果趋势图在某一天陡增，请给笔记加上这样的字段。"
      )
      .addText((t) =>
        t.setValue(st.createdFields).onChange(async (v) => {
          st.createdFields = v;
          await save();
        })
      );

    new Setting(containerEl).setName("刷新与行为").setHeading();

    new Setting(containerEl)
      .setName("自动刷新")
      .setDesc("仓库内容变化后自动刷新看板（带防抖，看板不可见时不会计算）。")
      .addToggle((t) =>
        t.setValue(st.autoRefresh).onChange(async (v) => {
          st.autoRefresh = v;
          await save();
        })
      );

    new Setting(containerEl).setName("自动刷新延迟（秒）").addText((t) =>
      t.setValue(String(st.refreshDelaySec)).onChange(async (v) => {
        const n = parseFloat(v);
        st.refreshDelaySec = isNaN(n) || n < 0.5 ? 0.5 : n;
        await save();
      })
    );

    new Setting(containerEl)
      .setName("在新标签页打开笔记")
      .setDesc("点击看板中的笔记时，在新标签页打开，保留看板。")
      .addToggle((t) =>
        t.setValue(st.openInNewTab).onChange(async (v) => {
          st.openInNewTab = v;
          await save();
        })
      );

    new Setting(containerEl).setName("数据").setHeading();

    new Setting(containerEl)
      .setName("重置每日新增字数记录")
      .setDesc("清除已累积的每日新增字数，并从今天重新开始记录。")
      .addButton((b) =>
        b
          .setButtonText("重置")
          .setWarning()
          .onClick(async () => {
            await this.plugin.resetLog();
          })
      );

    new Setting(containerEl)
      .setName("恢复所有提示")
      .setDesc("重新显示看板上被你“忽略”的建议和首次使用说明。")
      .addButton((b) =>
        b.setButtonText("恢复").onClick(async () => {
          st.dismissedHints = [];
          st.onboarded = false;
          await save();
        })
      );
  }
}
