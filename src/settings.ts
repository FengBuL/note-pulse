import { App, PluginSettingTab, Setting, SettingDefinitionItem } from "obsidian";
import type NotePulsePlugin from "./main";
import { sanitizeProperty } from "./wordprops-logic";
import { ClipDedupeSettings, DEFAULT_SETTINGS as DEDUPE_DEFAULTS, dedupeSections } from "./dedupe/settings";

export type HeatmapMode = "auto" | "mtime" | "delta";
export type OutlierMode = "exclude" | "off";

/** 设置结构版本：用于一次性迁移旧设置 */
export const SETTINGS_VERSION = 3;

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
  weeklyWordGoal: number;
  reportFolder: string;
  heatmapMode: HeatmapMode;
  autoRefresh: boolean;
  refreshDelaySec: number;
  openInNewTab: boolean;
  /* 字数属性：把字数写进笔记属性（默认关闭） */
  wordPropEnabled: boolean;
  wordPropName: string;
  wordPropReading: boolean;
  wordPropReadingName: string;
  wordPropCjkPerMin: number;
  wordPropLatinPerMin: number;
  wordPropMinChange: number;
  wordPropIdleSec: number;
  wordPropSkipOutliers: boolean;
  wordPropIncludeFolders: string;
  wordPropExcludeFolders: string;
  /* 重复内容清理（1.4.0 起由 Clip Dedupe 并入） */
  dedupeEnabled: boolean;
  /** 看板底部的入口卡片 */
  dedupeCard: boolean;
  dedupe: ClipDedupeSettings;
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
  weeklyWordGoal: 1500,
  reportFolder: "Note Pulse",
  heatmapMode: "auto",
  autoRefresh: true,
  refreshDelaySec: 3,
  openInNewTab: true,
  wordPropEnabled: false,
  wordPropName: "words",
  wordPropReading: false,
  wordPropReadingName: "reading_time",
  wordPropCjkPerMin: 400,
  wordPropLatinPerMin: 220,
  wordPropMinChange: 1,
  wordPropIdleSec: 5,
  wordPropSkipOutliers: true,
  wordPropIncludeFolders: "",
  wordPropExcludeFolders: "",
  dedupeEnabled: true,
  dedupeCard: true,
  dedupe: { ...DEDUPE_DEFAULTS, ignored: [] },
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

/** 一行设置：名称、说明，以及往这一行里添加控件的函数 */
interface SettingRow {
  name: string;
  desc?: string;
  /** 返回值被忽略（Setting 自带 then 方法，会被 lint 误认成 Promise，所以这里不声明为 void） */
  render: (setting: Setting) => unknown;
}
interface SettingSection {
  heading: string;
  rows: SettingRow[];
}

export class DashboardSettingTab extends PluginSettingTab {
  plugin: NotePulsePlugin;

  constructor(app: App, plugin: NotePulsePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /** 设置内容只在这里定义一次；新版 Obsidian（1.13+）走 getSettingDefinitions，旧版走 display，两边完全一致 */
  private buildSections(): SettingSection[] {
    const st = this.plugin.settings;
    const save = async () => {
      await this.plugin.saveSettings();
    };

    return [
      {
        heading: "范围",
        rows: [
          {
            name: "排除的文件夹",
            desc: "这些文件夹（含子文件夹）中的笔记完全不参与统计。每行一个，或用逗号分隔，例如：Templates, Archive/Old",
            render: (setting) =>
              setting.addTextArea((t) => {
                t.setPlaceholder("Templates\nAttachments")
                  .setValue(st.excludedFolders)
                  .onChange(async (v) => {
                    st.excludedFolders = v;
                    await save();
                  });
                t.inputEl.rows = 3;
              }),
          },
          {
            name: "采集 / 剪藏文件夹",
            desc: "自动抓取、网页剪藏、每日转存之类的文件夹。里面的笔记仍计入笔记总数，但不计入字数趋势、写作热力图、打卡和“新建笔记”曲线。",
            render: (setting) =>
              setting.addTextArea((t) => {
                t.setPlaceholder("x\nClippings")
                  .setValue(st.clippingFolders)
                  .onChange(async (v) => {
                    st.clippingFolders = v;
                    await save();
                  });
                t.inputEl.rows = 2;
              }),
          },
          {
            name: "排除超大笔记",
            desc: "字数超过下面阈值的笔记不计入字数趋势、热力图和打卡（笔记数量仍计入）。看板上会注明排除了哪些。",
            render: (setting) =>
              setting.addToggle((t) =>
                t.setValue(st.outlierMode === "exclude").onChange(async (v) => {
                  st.outlierMode = v ? "exclude" : "off";
                  await save();
                })
              ),
          },
          {
            name: "超大笔记阈值（字）",
            desc: "默认 20000。汉字按字、英文按词计。",
            render: (setting) =>
              setting.addText((t) =>
                t.setPlaceholder("20000").setValue(String(st.outlierWords)).onChange(async (v) => {
                  const n = parseInt(v, 10);
                  st.outlierWords = isNaN(n) || n < 1000 ? 1000 : n;
                  await save();
                })
              ),
          },
        ],
      },
      {
        heading: "打卡与热力图",
        rows: [
          {
            name: "日记文件夹",
            desc: "文件名为 YYYY-MM-DD 的笔记视为日记，用于“日记打卡”。留空则在整个仓库中识别。内容少于 10 字的空日记不算打卡。",
            render: (setting) =>
              setting.addText((t) =>
                t
                  .setPlaceholder("例如：Daily")
                  .setValue(st.dailyNoteFolder)
                  .onChange(async (v) => {
                    st.dailyNoteFolder = v;
                    await save();
                  })
              ),
          },
          {
            name: "每日字数目标",
            desc: "达到该字数的日子记为打卡成功（写了日记也算打卡）。设为 0 表示有任何写作即算打卡。",
            render: (setting) =>
              setting.addText((t) =>
                t
                  .setPlaceholder("300")
                  .setValue(String(st.dailyWordGoal))
                  .onChange(async (v) => {
                    const n = parseInt(v, 10);
                    st.dailyWordGoal = isNaN(n) || n < 0 ? 0 : n;
                    await save();
                  })
              ),
          },
          {
            name: "每周字数目标",
            desc: "周一到周日累计，默认 1500 字。设为 0 关闭每周目标。",
            render: (setting) => setting.addText((t) =>
              t.setPlaceholder("1500").setValue(String(st.weeklyWordGoal)).onChange(async (v) => {
                const n = Number(v);
                st.weeklyWordGoal = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 1500;
                await save();
              })
            ),
          },
          {
            name: "写作报告保存位置",
            desc: "周报和月报保存在这个文件夹，默认 Note Pulse。留空保存在笔记库最外层。",
            render: (setting) => setting.addText((t) =>
              t.setPlaceholder(DEFAULT_SETTINGS.reportFolder).setValue(st.reportFolder).onChange(async (v) => {
                st.reportFolder = v.trim();
                await save();
              })
            ),
          },
          {
            name: "写作量统计方式",
            desc:
              "智能（推荐）：启用插件之后的日子按每日实际新增字数记录（看板关着也会记），之前的日子按“最后修改日”估算。" +
              "按修改日：每篇笔记的全部字数记在它最后修改的那天，较粗略。按每日新增：只用实测记录，从启用之日起累积。",
            render: (setting) =>
              setting.addDropdown((d) =>
                d
                  .addOption("auto", "智能：实测 + 估算")
                  .addOption("mtime", "按修改日（全文字数）")
                  .addOption("delta", "按每日新增字数（需累积）")
                  .setValue(st.heatmapMode)
                  .onChange(async (v) => {
                    st.heatmapMode = v as HeatmapMode;
                    await save();
                  })
              ),
          },
          {
            name: "创建日期字段名",
            desc:
              "如果 frontmatter 中有这些字段且为 YYYY-MM-DD 日期，则用它作为创建日期，否则使用文件创建时间。" +
              "iCloud、Dropbox、git 等同步后文件创建时间常常被重置，如果趋势图在某一天陡增，请给笔记加上这样的字段。",
            render: (setting) =>
              setting.addText((t) =>
                t.setValue(st.createdFields).onChange(async (v) => {
                  st.createdFields = v;
                  await save();
                })
              ),
          },
        ],
      },
      {
        heading: "刷新与行为",
        rows: [
          {
            name: "自动刷新",
            desc: "仓库内容变化后自动刷新看板（带防抖，看板不可见时不会计算）。",
            render: (setting) =>
              setting.addToggle((t) =>
                t.setValue(st.autoRefresh).onChange(async (v) => {
                  st.autoRefresh = v;
                  await save();
                })
              ),
          },
          {
            name: "自动刷新延迟（秒）",
            render: (setting) =>
              setting.addText((t) =>
                t.setValue(String(st.refreshDelaySec)).onChange(async (v) => {
                  const n = parseFloat(v);
                  st.refreshDelaySec = isNaN(n) || n < 0.5 ? 0.5 : n;
                  await save();
                })
              ),
          },
          {
            name: "在新标签页打开笔记",
            desc: "点击看板中的笔记时，在新标签页打开，保留看板。",
            render: (setting) =>
              setting.addToggle((t) =>
                t.setValue(st.openInNewTab).onChange(async (v) => {
                  st.openInNewTab = v;
                  await save();
                })
              ),
          },
        ],
      },
      {
        heading: "字数属性",
        rows: [
          {
            name: "把字数写入笔记属性",
            desc:
              "开启后，编辑完一篇笔记并停手几秒，会把它的字数写进 frontmatter（属性是数字类型），这样 Bases 可以直接按字数排序、筛选和做公式。" +
              "这会修改你的笔记文件，所以默认关闭。写入时 Obsidian 会重新整理该笔记的 YAML 属性区（注释可能丢失）。下面的两个命令在关闭时也能手动使用。",
            render: (setting) =>
              setting.addToggle((t) =>
                t.setValue(st.wordPropEnabled).onChange(async (v) => {
                  st.wordPropEnabled = v;
                  await save();
                })
              ),
          },
          {
            name: "字数属性名",
            desc: "默认 words。在 Bases 里就用这个名字，例如 words > 1000。",
            render: (setting) =>
              setting.addText((t) =>
                t.setPlaceholder(DEFAULT_SETTINGS.wordPropName).setValue(st.wordPropName).onChange(async (v) => {
                  st.wordPropName = sanitizeProperty(v, DEFAULT_SETTINGS.wordPropName);
                  await save();
                })
              ),
          },
          {
            name: "同时写入阅读时长",
            desc: "按下面的阅读速度估算，单位是分钟（向上取整，最少 1 分钟）。",
            render: (setting) =>
              setting.addToggle((t) =>
                t.setValue(st.wordPropReading).onChange(async (v) => {
                  st.wordPropReading = v;
                  await save();
                })
              ),
          },
          {
            name: "阅读时长属性名",
            desc: "默认 reading_time。",
            render: (setting) =>
              setting.addText((t) =>
                t.setPlaceholder(DEFAULT_SETTINGS.wordPropReadingName).setValue(st.wordPropReadingName).onChange(async (v) => {
                  st.wordPropReadingName = sanitizeProperty(v, DEFAULT_SETTINGS.wordPropReadingName);
                  await save();
                })
              ),
          },
          {
            name: "中日文阅读速度（字/分钟）",
            desc: "默认 400。",
            render: (setting) =>
              setting.addText((t) =>
                t.setPlaceholder("400").setValue(String(st.wordPropCjkPerMin)).onChange(async (v) => {
                  const n = parseInt(v, 10);
                  st.wordPropCjkPerMin = isNaN(n) || n < 50 ? 50 : n;
                  await save();
                })
              ),
          },
          {
            name: "其他文字阅读速度（词/分钟）",
            desc: "英文等按词计的文字，默认 220。",
            render: (setting) =>
              setting.addText((t) =>
                t.setPlaceholder("220").setValue(String(st.wordPropLatinPerMin)).onChange(async (v) => {
                  const n = parseInt(v, 10);
                  st.wordPropLatinPerMin = isNaN(n) || n < 50 ? 50 : n;
                  await save();
                })
              ),
          },
          {
            name: "最小变化字数",
            desc: "新旧字数相差达到这个数才写入，默认 1（只要有变化就写）。调大可以减少文件改动和同步次数，但属性值会略微滞后。",
            render: (setting) =>
              setting.addText((t) =>
                t.setPlaceholder("1").setValue(String(st.wordPropMinChange)).onChange(async (v) => {
                  const n = parseInt(v, 10);
                  st.wordPropMinChange = isNaN(n) || n < 1 ? 1 : n;
                  await save();
                })
              ),
          },
          {
            name: "停手多久后写入（秒）",
            desc: "只处理你正在编辑的那篇笔记，停止输入这么久之后才写，默认 5，最小 3。",
            render: (setting) =>
              setting.addText((t) =>
                t.setPlaceholder("5").setValue(String(st.wordPropIdleSec)).onChange(async (v) => {
                  const n = parseFloat(v);
                  st.wordPropIdleSec = isNaN(n) || n < 3 ? 3 : n;
                  await save();
                })
              ),
          },
          {
            name: "不写入超大笔记",
            desc: "字数超过上面“超大笔记阈值”的笔记不写入（多为自动采集的文件，改写它们既慢又没意义）。",
            render: (setting) =>
              setting.addToggle((t) =>
                t.setValue(st.wordPropSkipOutliers).onChange(async (v) => {
                  st.wordPropSkipOutliers = v;
                  await save();
                })
              ),
          },
          {
            name: "只写入这些文件夹",
            desc: "留空表示整个仓库。每行一个，或用逗号分隔，含子文件夹。",
            render: (setting) =>
              setting.addTextArea((t) => {
                t.setValue(st.wordPropIncludeFolders)
                  .onChange(async (v) => {
                    st.wordPropIncludeFolders = v;
                    await save();
                  });
                t.inputEl.rows = 2;
              }),
          },
          {
            name: "不写入这些文件夹",
            desc: "含子文件夹。上面“范围”里设置的排除文件夹也不会写入。只处理 .md 文件。",
            render: (setting) =>
              setting.addTextArea((t) => {
                t.setValue(st.wordPropExcludeFolders)
                  .onChange(async (v) => {
                    st.wordPropExcludeFolders = v;
                    await save();
                  });
                t.inputEl.rows = 2;
              }),
          },
          {
            name: "批量更新所有笔记",
            desc: "先统计会改动多少篇并让你确认，再分批写入。没有变化的笔记不会被碰。",
            render: (setting) =>
              setting.addButton((b) =>
                b.setButtonText("批量更新").onClick(() => {
                  void this.plugin.wordProps.batchUpdate();
                })
              ),
          },
          {
            name: "移除所有字数属性",
            desc: "从所有笔记里删掉上面设置的属性名（字数，以及开启时的阅读时长）。如果你自己也用了同名属性，也会被删掉，确认前会显示数量。",
            render: (setting) =>
              setting.addButton((b) => {
                b.buttonEl.addClass("mod-warning");
                b.setButtonText("移除").onClick(() => {
                  void this.plugin.wordProps.removeAll();
                });
              }),
          },
        ],
      },
      {
        heading: "重复内容清理",
        rows: [
          {
            name: "启用重复内容清理",
            desc: "找出在多篇笔记里重复出现的段落（比如反复剪藏的文章、每天自动生成的报告），先预览再处理，随时可撤销。关闭后隐藏侧边栏图标、命令和看板入口。",
            render: (setting) =>
              setting.addToggle((tg) =>
                tg.setValue(st.dedupeEnabled).onChange(async (v) => {
                  st.dedupeEnabled = v;
                  await this.plugin.saveDedupeSettings();
                  this.plugin.dedupe.applyEnabled();
                  this.plugin.refreshViewsOnly();
                })
              ),
          },
          {
            name: "在看板上显示入口",
            desc: "看板底部的“重复内容清理”小卡片。",
            render: (setting) =>
              setting.addToggle((tg) =>
                tg.setValue(st.dedupeCard).onChange(async (v) => {
                  st.dedupeCard = v;
                  await this.plugin.saveDedupeSettings();
                  this.plugin.refreshViewsOnly();
                })
              ),
          },
        ],
      },
      ...dedupeSections(this.plugin.dedupe),
      {
        heading: "数据",
        rows: [
          {
            name: "重置每日新增字数记录",
            desc: "清除已累积的每日新增字数，并从今天重新开始记录。",
            render: (setting) =>
              setting.addButton((b) => {
                // 与旧版 setWarning() 效果相同（它只是加上 mod-warning 样式类）；setDestructive 要求 Obsidian 1.13+
                b.buttonEl.addClass("mod-warning");
                b.setButtonText("重置").onClick(async () => {
                  await this.plugin.resetLog();
                });
              }),
          },
          {
            name: "恢复所有提示",
            desc: "重新显示看板上被你“忽略”的建议和首次使用说明。",
            render: (setting) =>
              setting.addButton((b) =>
                b.setButtonText("恢复").onClick(async () => {
                  st.dismissedHints = [];
                  st.onboarded = false;
                  await save();
                })
              ),
          },
        ],
      },
    ];
  }

  /** Obsidian 1.13+：声明式设置（让设置项出现在设置搜索里） */
  getSettingDefinitions(): SettingDefinitionItem[] {
    return this.buildSections().map((sec) => ({
      type: "group" as const,
      heading: sec.heading,
      items: sec.rows.map((row) => ({
        name: row.name,
        desc: row.desc,
        render: (setting: Setting) => {
          setting.setName(row.name);
          if (row.desc) setting.setDesc(row.desc);
          row.render(setting);
        },
      })),
    }));
  }

  /** 1.13 以前的 Obsidian 用这个方法渲染；1.13+ 在 getSettingDefinitions 非空时不会调用它 */
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    for (const sec of this.buildSections()) {
      new Setting(containerEl).setName(sec.heading).setHeading();
      for (const row of sec.rows) {
        const setting = new Setting(containerEl).setName(row.name);
        if (row.desc) setting.setDesc(row.desc);
        row.render(setting);
      }
    }
  }
}

/** 保留用户明确设置的 0；旧设置缺少新字段时补齐默认值。 */
export function migrateWritingSettings(settings: DashboardSettings): void {
  if (!Number.isFinite(settings.weeklyWordGoal) || settings.weeklyWordGoal < 0) {
    settings.weeklyWordGoal = DEFAULT_SETTINGS.weeklyWordGoal;
  }
  settings.weeklyWordGoal = Math.floor(settings.weeklyWordGoal);
  if (typeof settings.reportFolder !== "string") settings.reportFolder = DEFAULT_SETTINGS.reportFolder;
}
