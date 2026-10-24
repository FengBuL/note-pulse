import { App, PluginSettingTab, Setting, SettingDefinitionItem } from "obsidian";
import type NotePulsePlugin from "./main";
import { sanitizeProperty } from "./wordprops-logic";
import { ClipDedupeSettings, DEFAULT_SETTINGS as DEDUPE_DEFAULTS, dedupeSections } from "./dedupe/settings";
import { L, LanguagePref, setLanguage } from "./i18n";
import { Agenda, sanitizeAgenda } from "./agenda";
import { WidgetLayout, defaultLayout, normalizeLayout } from "./widgets";

export type HeatmapMode = "auto" | "mtime" | "delta";
export type OutlierMode = "exclude" | "off";
export type WeekStyle = "dots" | "bars";

/** 设置结构版本：用于一次性迁移旧设置 */
export const SETTINGS_VERSION = 6;

export interface DashboardSettings {
  settingsVersion: number;
  /** 界面语言：auto 跟随 Obsidian（所有用户的默认值） */
  language: LanguagePref;
  excludedFolders: string;
  /** 采集 / 剪藏文件夹：笔记仍计入总数，但不计入字数趋势、热力图和打卡 */
  clippingFolders: string;
  /** 是否把超大笔记排除出写作统计 */
  outlierMode: OutlierMode;
  /** 超过这个字数的笔记视为超大笔记（通常是自动采集或整段粘贴） */
  outlierWords: number;
  /** 库体检里不检查孤立笔记的文件夹（含子文件夹）；采集文件夹也自动不检查 */
  orphanIgnoreFolders: string;
  /** 已经点过“忽略”的提示 */
  dismissedHints: string[];
  onboarded: boolean;
  dailyNoteFolder: string;
  createdFields: string;
  dailyWordGoal: number;
  weeklyWordGoal: number;
  reportFolder: string;
  /** 写作回顾卡片共享的展开状态，沿用旧周报字段。 */
  reportWeekExpanded: boolean;
  /** 仅用于迁移旧版独立展开状态。 */
  reportMonthExpanded?: boolean;
  heatmapMode: HeatmapMode;
  /** 今日写作卡里“本周”的显示方式 */
  weekStyle: WeekStyle;
  /** 看板动效（系统开了“减弱动态效果”时始终不播放） */
  motion: boolean;
  /** 2.0：看板上有哪些卡片、什么尺寸、什么顺序。存在 data.json 里，随库同步 */
  layout: WidgetLayout;
  /** 日历卡片里用户记的日程：日期 → 当天的条目。存在 data.json 里，随库同步 */
  agenda: Agenda;
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
  /** 看板“库体检”里的重复内容一栏 */
  dedupeCard: boolean;
  dedupe: ClipDedupeSettings;
}

export const DEFAULT_SETTINGS: DashboardSettings = {
  settingsVersion: SETTINGS_VERSION,
  language: "auto",
  excludedFolders: "",
  clippingFolders: "",
  outlierMode: "exclude",
  outlierWords: 20000,
  orphanIgnoreFolders: "",
  dismissedHints: [],
  onboarded: false,
  dailyNoteFolder: "",
  createdFields: "created, 创建时间, date",
  dailyWordGoal: 300,
  weeklyWordGoal: 1500,
  reportFolder: "Note Pulse",
  reportWeekExpanded: false,
  heatmapMode: "auto",
  weekStyle: "dots",
  motion: true,
  layout: defaultLayout(),
  agenda: {},
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
        heading: L("范围", "Scope"),
        rows: [
          {
            name: L("排除的文件夹", "Excluded folders"),
            desc: L("这些文件夹（含子文件夹）中的笔记完全不参与统计。每行一个，或用逗号分隔，例如：Templates, Archive/Old", "Notes in these folders (and their subfolders) are left out of every statistic. One per line or comma-separated, for example: Templates, Archive/Old"),
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
            name: L("采集 / 剪藏文件夹", "Clipping folders"),
            desc: L("自动抓取、网页剪藏、每日转存之类的文件夹。里面的笔记仍计入笔记总数，但不计入字数趋势、写作热力图、打卡和“新建笔记”曲线。", "Folders filled automatically, such as web clippings, feeds or daily exports. Their notes still count toward the note total but not toward word trends, the writing heatmap, streaks or the new-notes chart."),
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
            name: L("孤立笔记不检查的文件夹", "Folders skipped for orphans"),
            desc: L(
              "库体检不把这些文件夹里没有链接的笔记算作孤立笔记，比如日记、对话记录。采集文件夹自动不检查。每行一个，或用逗号分隔。",
              "Vault checkup doesn't count unlinked notes in these folders as orphans, for example daily notes or chat logs. Clipping folders are skipped automatically. One per line or comma-separated."
            ),
            render: (setting) =>
              setting.addTextArea((t) => {
                t.setValue(st.orphanIgnoreFolders).onChange(async (v) => {
                  st.orphanIgnoreFolders = v;
                  await save();
                });
                t.inputEl.rows = 2;
              }),
          },
          {
            name: L("排除超大笔记", "Exclude oversized notes"),
            desc: L("字数超过下面阈值的笔记不计入字数趋势、热力图和打卡（笔记数量仍计入）。看板上会注明排除了哪些。", "Notes longer than the threshold below are left out of word trends, the heatmap and streaks (they still count as notes). The dashboard shows which ones were excluded."),
            render: (setting) =>
              setting.addToggle((t) =>
                t.setValue(st.outlierMode === "exclude").onChange(async (v) => {
                  st.outlierMode = v ? "exclude" : "off";
                  await save();
                })
              ),
          },
          {
            name: L("超大笔记阈值（字）", "Oversized note threshold (words)"),
            desc: L("默认 20000。汉字按字、英文按词计。", "Default 20000. Each CJK character counts as one word; other languages count by words."),
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
        heading: L("打卡与热力图", "Streaks and heatmap"),
        rows: [
          {
            name: L("日记文件夹", "Daily notes folder"),
            desc: L("文件名为 YYYY-MM-DD 的笔记视为日记，用于“日记打卡”。留空则在整个仓库中识别。内容少于 10 字的空日记不算打卡。", "Notes named YYYY-MM-DD count as daily notes, and a daily note keeps the streak. Leave empty to look across the whole vault. Daily notes with fewer than 10 words do not count."),
            render: (setting) =>
              setting.addText((t) =>
                t
                  .setPlaceholder(L("例如：Daily", "For example: Daily"))
                  .setValue(st.dailyNoteFolder)
                  .onChange(async (v) => {
                    st.dailyNoteFolder = v;
                    await save();
                  })
              ),
          },
          {
            name: L("每日字数目标", "Daily word goal"),
            desc: L("达到该字数的日子记为打卡成功（写了日记也算打卡）。设为 0 表示有任何写作即算打卡。", "A day that reaches this many words counts toward the streak (so does a day with a daily note). Set to 0 to count any writing."),
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
            name: L("每周字数目标", "Weekly word goal"),
            desc: L("周一到周日累计，默认 1500 字。设为 0 关闭每周目标。", "Counted Monday to Sunday, default 1500 words. Set to 0 to turn the weekly goal off."),
            render: (setting) => setting.addText((t) =>
              t.setPlaceholder("1500").setValue(String(st.weeklyWordGoal)).onChange(async (v) => {
                const n = Number(v);
                st.weeklyWordGoal = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 1500;
                await save();
              })
            ),
          },
          {
            name: L("写作报告保存位置", "Writing report folder"),
            desc: L("周报和月报保存在这个文件夹，默认 Note Pulse。留空保存在笔记库最外层。", "Weekly and monthly reports are saved here, default Note Pulse. Leave empty to save at the top of the vault."),
            render: (setting) => setting.addText((t) =>
              t.setPlaceholder(DEFAULT_SETTINGS.reportFolder).setValue(st.reportFolder).onChange(async (v) => {
                st.reportFolder = v.trim();
                await save();
              })
            ),
          },
          {
            name: L("写作量统计方式", "How writing is counted"),
            desc:
              L("智能（推荐）：启用插件之后的日子按每日实际新增字数记录（看板关着也会记），之前的日子按“最后修改日”估算。", "Smart (recommended): from the day the plugin was enabled, the words actually added each day are recorded (even while the dashboard is closed); earlier days are estimated from each note's last-modified date. ") +
              L("按修改日：每篇笔记的全部字数记在它最后修改的那天，较粗略。按每日新增：只用实测记录，从启用之日起累积。", "By modified date: a note's full word count goes to the day it was last modified, which is rough. By daily additions: only recorded additions, building up from the day you enabled the plugin."),
            render: (setting) =>
              setting.addDropdown((d) =>
                d
                  .addOption("auto", L("智能：实测 + 估算", "Smart: recorded + estimated"))
                  .addOption("mtime", L("按修改日（全文字数）", "By modified date (full word count)"))
                  .addOption("delta", L("按每日新增字数（需累积）", "By daily additions (builds up over time)"))
                  .setValue(st.heatmapMode)
                  .onChange(async (v) => {
                    st.heatmapMode = v as HeatmapMode;
                    await save();
                  })
              ),
          },
          {
            name: L("本周的显示方式", "This week display"),
            desc: L("今日写作卡里本周七天的样子。圆点：达标打勾，没达标显示完成百分比。柱状：柱高是当天字数，虚线是每日目标。也可以直接在看板上切换。", "How the seven days of this week look on the Today card. Dots: a check for days that met the goal, otherwise the percentage done. Bars: bar height is that day's words, the dashed line is the daily goal. You can also switch on the dashboard."),
            render: (setting) =>
              setting.addDropdown((d) =>
                d
                  .addOption("dots", L("圆点", "Dots"))
                  .addOption("bars", L("柱状", "Bars"))
                  .setValue(st.weekStyle)
                  .onChange(async (v) => {
                    st.weekStyle = v as WeekStyle;
                    await this.plugin.saveViewSetting();
                    this.plugin.refreshViewsOnly();
                  })
              ),
          },
          {
            name: L("创建日期字段名", "Created date properties"),
            desc:
              L("如果 frontmatter 中有这些字段且为 YYYY-MM-DD 日期，则用它作为创建日期，否则使用文件创建时间。", "If a note has one of these properties with a YYYY-MM-DD date, it is used as the created date; otherwise the file's creation time is used. ") +
              L("iCloud、Dropbox、git 等同步后文件创建时间常常被重置，如果趋势图在某一天陡增，请给笔记加上这样的字段。", "Syncing with iCloud, Dropbox, git and similar often resets file creation times. If the trend chart jumps on a single day, add one of these properties to your notes."),
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
        heading: L("刷新与行为", "Refresh and behavior"),
        rows: [
          {
            name: L("界面语言", "Language"),
            desc: L(
              "跟随 Obsidian：Obsidian 是中文界面时显示中文，否则显示英文。侧边栏图标的提示和命令名称要重启 Obsidian 后才会换。",
              "Follow Obsidian shows Chinese when Obsidian's own language is Chinese and English otherwise. Ribbon tooltips and command names change after restarting Obsidian."
            ),
            render: (setting) =>
              setting.addDropdown((d) =>
                d
                  .addOption("auto", L("跟随 Obsidian", "Follow Obsidian"))
                  .addOption("zh", "中文") // i18n-skip
                  .addOption("en", "English")
                  .setValue(st.language)
                  .onChange(async (v) => {
                    st.language = v as LanguagePref;
                    setLanguage(st.language);
                    await this.plugin.saveViewSetting();
                    this.plugin.refreshViewsOnly();
                    this.redraw();
                  })
              ),
          },
          {
            name: L("自动刷新", "Auto refresh"),
            desc: L("仓库内容变化后自动刷新看板（带防抖，看板不可见时不会计算）。", "Refresh the dashboard after the vault changes (debounced; nothing is computed while the dashboard is hidden)."),
            render: (setting) =>
              setting.addToggle((t) =>
                t.setValue(st.autoRefresh).onChange(async (v) => {
                  st.autoRefresh = v;
                  await save();
                })
              ),
          },
          {
            name: L("自动刷新延迟（秒）", "Auto refresh delay (seconds)"),
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
            name: L("看板布局", "Dashboard layout"),
            desc: L(
              "点看板右上角的铅笔编辑：拖动卡片换位置，拖右下角调宽和高，移除或添加卡片。布局随库同步，几台设备看到的看板一样；手机和窄面板里卡片排成一列，只看不改。",
              "Use the pencil at the top right of the dashboard to drag cards around, drag a corner to resize, and remove or add cards. The layout syncs with the vault, so every device shows the same dashboard; phones and narrow panes stack the cards in one column and are view-only."
            ),
            render: (setting) =>
              setting.addButton((b) =>
                b.setButtonText(L("恢复默认布局", "Restore default layout")).onClick(async () => {
                  st.layout = defaultLayout();
                  await this.plugin.saveViewSetting();
                  this.plugin.refreshViewsOnly();
                })
              ),
          },
          {
            name: L("动效", "Motion"),
            desc: L("打开看板时卡片依次出现、数字滚动到当前值，切换和展开时平滑过渡；自动刷新只让变化了的数字动。系统开了“减弱动态效果”时始终关闭。", "Cards appear one after another and numbers count up when the dashboard opens; switching and expanding animate smoothly; auto refresh only animates numbers that changed. Always off when your system asks for reduced motion."),
            render: (setting) =>
              setting.addToggle((t) =>
                t.setValue(st.motion).onChange(async (v) => {
                  st.motion = v;
                  await save();
                })
              ),
          },
          {
            name: L("在新标签页打开笔记", "Open notes in a new tab"),
            desc: L("点击看板中的笔记时，在新标签页打开，保留看板。", "Notes clicked on the dashboard open in a new tab so the dashboard stays open."),
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
        heading: L("字数属性", "Word count property"),
        rows: [
          {
            name: L("把字数写入笔记属性", "Write word count to note properties"),
            desc:
              L("开启后，编辑完一篇笔记并停手几秒，会把它的字数写进 frontmatter（属性是数字类型），这样 Bases 可以直接按字数排序、筛选和做公式。", "When on, a few seconds after you stop editing a note its word count is written to the frontmatter as a number, so Bases can sort, filter and calculate with it. ") +
              L("这会修改你的笔记文件，所以默认关闭。写入时 Obsidian 会重新整理该笔记的 YAML 属性区（注释可能丢失）。下面的两个命令在关闭时也能手动使用。", "This changes your note files, so it is off by default. When writing, Obsidian reformats the note's YAML properties (comments may be lost). The two commands below work even while this is off."),
            render: (setting) =>
              setting.addToggle((t) =>
                t.setValue(st.wordPropEnabled).onChange(async (v) => {
                  st.wordPropEnabled = v;
                  await save();
                })
              ),
          },
          {
            name: L("字数属性名", "Word count property name"),
            desc: L("默认 words。在 Bases 里就用这个名字，例如 words > 1000。", "Default words. Use this name in Bases, for example words > 1000."),
            render: (setting) =>
              setting.addText((t) =>
                t.setPlaceholder(DEFAULT_SETTINGS.wordPropName).setValue(st.wordPropName).onChange(async (v) => {
                  st.wordPropName = sanitizeProperty(v, DEFAULT_SETTINGS.wordPropName);
                  await save();
                })
              ),
          },
          {
            name: L("同时写入阅读时长", "Also write reading time"),
            desc: L("按下面的阅读速度估算，单位是分钟（向上取整，最少 1 分钟）。", "Estimated from the reading speeds below, in minutes (rounded up, at least 1)."),
            render: (setting) =>
              setting.addToggle((t) =>
                t.setValue(st.wordPropReading).onChange(async (v) => {
                  st.wordPropReading = v;
                  await save();
                })
              ),
          },
          {
            name: L("阅读时长属性名", "Reading time property name"),
            desc: L("默认 reading_time。", "Default reading_time."),
            render: (setting) =>
              setting.addText((t) =>
                t.setPlaceholder(DEFAULT_SETTINGS.wordPropReadingName).setValue(st.wordPropReadingName).onChange(async (v) => {
                  st.wordPropReadingName = sanitizeProperty(v, DEFAULT_SETTINGS.wordPropReadingName);
                  await save();
                })
              ),
          },
          {
            name: L("中日文阅读速度（字/分钟）", "CJK reading speed (characters per minute)"),
            desc: L("默认 400。", "Default 400."),
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
            name: L("其他文字阅读速度（词/分钟）", "Other reading speed (words per minute)"),
            desc: L("英文等按词计的文字，默认 220。", "For English and other languages counted by words. Default 220."),
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
            name: L("最小变化字数", "Minimum change"),
            desc: L("新旧字数相差达到这个数才写入，默认 1（只要有变化就写）。调大可以减少文件改动和同步次数，但属性值会略微滞后。", "Only write when the count changes by at least this much. Default 1 (write on any change). A larger value means fewer file changes and syncs, but the property lags a little."),
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
            name: L("停手多久后写入（秒）", "Write after idle (seconds)"),
            desc: L("只处理你正在编辑的那篇笔记，停止输入这么久之后才写，默认 5，最小 3。", "Only the note you are editing is updated, this long after you stop typing. Default 5, minimum 3."),
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
            name: L("不写入超大笔记", "Skip oversized notes"),
            desc: L("字数超过上面“超大笔记阈值”的笔记不写入（多为自动采集的文件，改写它们既慢又没意义）。", "Notes over the oversized note threshold above are not written (they are usually collected files, and rewriting them is slow and pointless)."),
            render: (setting) =>
              setting.addToggle((t) =>
                t.setValue(st.wordPropSkipOutliers).onChange(async (v) => {
                  st.wordPropSkipOutliers = v;
                  await save();
                })
              ),
          },
          {
            name: L("只写入这些文件夹", "Only these folders"),
            desc: L("留空表示整个仓库。每行一个，或用逗号分隔，含子文件夹。", "Leave empty for the whole vault. One per line or comma-separated, subfolders included."),
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
            name: L("不写入这些文件夹", "Skip these folders"),
            desc: L("含子文件夹。上面“范围”里设置的排除文件夹也不会写入。只处理 .md 文件。", "Subfolders included. Folders excluded under Scope are skipped too. Only .md files are written."),
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
            name: L("批量更新所有笔记", "Update all notes"),
            desc: L("先统计会改动多少篇并让你确认，再分批写入。没有变化的笔记不会被碰。", "First counts how many notes would change and asks you to confirm, then writes in batches. Notes that are already up to date are not touched."),
            render: (setting) =>
              setting.addButton((b) =>
                b.setButtonText(L("批量更新", "Update all")).onClick(() => {
                  void this.plugin.wordProps.batchUpdate();
                })
              ),
          },
          {
            name: L("移除所有字数属性", "Remove all word count properties"),
            desc: L("从所有笔记里删掉上面设置的属性名（字数，以及开启时的阅读时长）。如果你自己也用了同名属性，也会被删掉，确认前会显示数量。", "Deletes the properties named above (word count, and reading time if on) from every note. A property of yours with the same name is deleted too; you see the count before confirming."),
            render: (setting) =>
              setting.addButton((b) => {
                b.buttonEl.addClass("mod-warning");
                b.setButtonText(L("移除", "Remove")).onClick(() => {
                  void this.plugin.wordProps.removeAll();
                });
              }),
          },
        ],
      },
      {
        heading: L("重复内容清理", "Duplicate cleanup"),
        rows: [
          {
            name: L("启用重复内容清理", "Enable duplicate cleanup"),
            desc: L("找出在多篇笔记里重复出现的段落（比如反复剪藏的文章、每天自动生成的报告），先预览再处理，随时可撤销。关闭后隐藏侧边栏图标、命令和看板入口。", "Finds passages repeated across several notes (such as an article clipped many times or reports generated every day). You preview before anything changes and can undo any time. Turning it off hides the ribbon icon, commands and the dashboard entry."),
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
            name: L("在库体检里显示重复内容", "Show duplicates in vault checkup"),
            desc: L("看板“库体检”卡里的“重复内容”一栏。", "The Duplicates column on the dashboard's Vault checkup card."),
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
        heading: L("数据", "Data"),
        rows: [
          {
            name: L("这台设备的名字", "This device's name"),
            desc: L(
              "连着同一个库的设备会自动合并，不用设置：每台设备只记在自己的 Obsidian 编辑器里打的字，看板把所有设备相加，手机和电脑都写也不会重复计数。同步进来的改动、别的程序（比如 AI 助手、脚本）直接写进笔记的内容不算写作。",
              "Devices connected to the same vault are merged automatically, with nothing to set up. Each device only records words typed in its own Obsidian editor, and the dashboard adds all devices together, so writing on both phone and computer is not double counted. Changes that arrive by sync, or that other programs (such as AI assistants or scripts) write into notes, do not count as writing."
            ),
            render: (setting) =>
              setting.addText((t) =>
                t.setValue(this.plugin.device.name).onChange(async (v) => {
                  await this.plugin.renameDevice(v);
                })
              ),
          },
          {
            name: L("参与合并的设备", "Devices"),
            desc: this.deviceSummary(),
            render: () => undefined,
          },
          {
            name: L("重置每日新增字数记录", "Reset daily word log"),
            desc: L("清除所有设备已累积的每日新增字数，并从今天重新开始记录。", "Clears the recorded daily additions from all devices and starts recording again from today."),
            render: (setting) =>
              setting.addButton((b) => {
                // 与旧版 setWarning() 效果相同（它只是加上 mod-warning 样式类）；setDestructive 要求 Obsidian 1.13+
                b.buttonEl.addClass("mod-warning");
                b.setButtonText(L("重置", "Reset")).onClick(async () => {
                  await this.plugin.resetLog();
                });
              }),
          },
          {
            name: L("恢复所有提示", "Restore all tips"),
            desc: L("重新显示看板上被你“忽略”的建议和首次使用说明。", "Shows the dashboard suggestions you dismissed and the getting-started tip again."),
            render: (setting) =>
              setting.addButton((b) =>
                b.setButtonText(L("恢复", "Restore")).onClick(async () => {
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

  /** 设置页里列出的设备：本机在前，其余按最后更新时间 */
  private deviceSummary(): string {
    const p = this.plugin;
    const fmt = (t: number) => (t ? new Date(t).toLocaleDateString() : L("还没有记录", "nothing recorded yet"));
    const rows = [`${p.device.name}${L("（本机）", " (this device)")} · ${fmt(p.device.updated)}`];
    const others = [...p.otherDevices.values()].sort((a, b) => b.updated - a.updated);
    for (const d of others) rows.push(`${d.name} · ${fmt(d.updated)}`);
    return rows.join(L("；", "; "));
  }

  /** 换语言后重画设置页：1.13+ 先让 Obsidian 重新读取设置定义（也用于设置搜索），再重画 */
  private redraw() {
    const tab = this as unknown as { update?: () => void };
    if (typeof tab.update === "function") tab.update();
    this.display();
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
  settings.reportWeekExpanded = settings.reportWeekExpanded === true || settings.reportMonthExpanded === true;
  delete settings.reportMonthExpanded;
  if (settings.weekStyle !== "dots" && settings.weekStyle !== "bars") settings.weekStyle = DEFAULT_SETTINGS.weekStyle;
  // 2.0 之前没有布局：生成默认布局（1.8 的看板 + 6 张新卡片）
  settings.layout = normalizeLayout(settings.layout);
  settings.agenda = sanitizeAgenda(settings.agenda);
}

/**
 * 1.6.0 加入英文界面，所有用户默认跟随 Obsidian 的界面语言。
 * 开发期间有一版（设置版本 4）把老用户迁移成了“中文”，这里把它改回跟随；版本 5 之后用户自己的选择保留。
 */
export function migrateLanguage(settings: DashboardSettings, _hadSettings: boolean, savedVersion: number): void {
  if (savedVersion < 5) settings.language = "auto";
  if (settings.language !== "auto" && settings.language !== "zh" && settings.language !== "en") settings.language = "auto";
  setLanguage(settings.language);
}
