import type { Setting } from "obsidian";
import type { DedupeService as ClipDedupePlugin } from "./service";
import type { KeepRule } from "./core/group";
import type { CleanMode } from "./core/plan";
import { StrKey, t } from "./i18n";

export type LinkStyle = "embed" | "link";

export interface ClipDedupeSettings {
  includeFolders: string;
  excludeFolders: string;
  minLength: number;
  ignoreFrontmatter: boolean;
  ignoreCode: boolean;
  ignoreHeadings: boolean;
  ignoreLinkOnly: boolean;
  detectStatusIds: boolean;
  keepRule: KeepRule;
  overlapPercent: number;
  cleanMode: CleanMode;
  linkStyle: LinkStyle;
  propertyName: string;
  backupsToKeep: number;
  openInNewTab: boolean;
  /** Keys (see groupKey) of repeated passages the user chose to ignore. */
  ignored: string[];
}

export const DEFAULT_SETTINGS: ClipDedupeSettings = {
  includeFolders: "",
  excludeFolders: "",
  minLength: 80,
  ignoreFrontmatter: true,
  ignoreCode: true,
  ignoreHeadings: true,
  ignoreLinkOnly: true,
  detectStatusIds: true,
  keepRule: "auto",
  overlapPercent: 70,
  cleanMode: "mark",
  linkStyle: "embed",
  propertyName: "duplicate_of",
  backupsToKeep: 10,
  openInNewTab: true,
  ignored: [],
};

export function splitList(s: string): string[] {
  return s
    .split(/[\n,，;；]/)
    .map((x) => x.trim().replace(/^\/+/, "").replace(/\/+$/, ""))
    .filter((x) => x.length > 0);
}

/** One row of the settings screen; `render` adds the controls. */
export interface SettingRow {
  name: string;
  desc?: string;
  /** Return value is ignored (Setting has a `then` method, which linters mistake for a Promise). */
  render: (setting: Setting) => unknown;
}
export interface SettingSection {
  heading: string;
  rows: SettingRow[];
}

function clampInt(v: string, min: number, max: number, fallback: number): number {
  const n = parseInt(v, 10);
  if (isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 设置页里“重复内容清理”分组的内容；由 Note Pulse 的设置页统一渲染。 */
export function dedupeSections(plugin: ClipDedupePlugin): SettingSection[] {
  const st = plugin.settings;
  const save = async () => {
    await plugin.saveSettings();
  };
  const dd = (setting: Setting, options: [string, StrKey][], get: () => string, set: (v: string) => void) =>
    setting.addDropdown((d) => {
      for (const [value, label] of options) d.addOption(value, t(label));
      d.setValue(get()).onChange(async (v) => {
        set(v);
        await save();
      });
    });
  const toggle = (setting: Setting, get: () => boolean, set: (v: boolean) => void) =>
    setting.addToggle((tg) =>
      tg.setValue(get()).onChange(async (v) => {
        set(v);
        await save();
      })
    );

  return [
    {
      heading: t("setBasic"),
      rows: [
        {
          name: t("setIncludeName"),
          desc: t("setIncludeDesc"),
          render: (setting) =>
            setting.addTextArea((ta) => {
              ta.setValue(st.includeFolders)
                .onChange(async (v) => {
                  st.includeFolders = v;
                  await save();
                });
              ta.inputEl.rows = 2;
            }),
        },
        {
          name: t("setExcludeName"),
          desc: t("setExcludeDesc"),
          render: (setting) =>
            setting.addTextArea((ta) => {
              ta.setValue(st.excludeFolders)
                .onChange(async (v) => {
                  st.excludeFolders = v;
                  await save();
                });
              ta.inputEl.rows = 2;
            }),
        },
        {
          name: t("setMinName", st.minLength, Math.round(st.minLength / 2)),
          desc: t("setMinDesc"),
          render: (setting) =>
            setting.addText((tx) =>
              tx.setPlaceholder("80").setValue(String(st.minLength)).onChange(async (v) => {
                st.minLength = clampInt(v, 10, 2000, DEFAULT_SETTINGS.minLength);
                await save();
              })
            ),
        },
      ],
    },
    {
      heading: t("setAdvanced"),
      rows: [
        { name: t("setFrontmatterName"), desc: t("setFrontmatterDesc"), render: (s) => toggle(s, () => st.ignoreFrontmatter, (v) => (st.ignoreFrontmatter = v)) },
        { name: t("setCodeName"), desc: t("setCodeDesc"), render: (s) => toggle(s, () => st.ignoreCode, (v) => (st.ignoreCode = v)) },
        { name: t("setHeadingsName"), desc: t("setHeadingsDesc"), render: (s) => toggle(s, () => st.ignoreHeadings, (v) => (st.ignoreHeadings = v)) },
        { name: t("setLinksName"), desc: t("setLinksDesc"), render: (s) => toggle(s, () => st.ignoreLinkOnly, (v) => (st.ignoreLinkOnly = v)) },
        { name: t("setStatusName"), desc: t("setStatusDesc"), render: (s) => toggle(s, () => st.detectStatusIds, (v) => (st.detectStatusIds = v)) },
        {
          name: t("setKeepName"),
          desc: t("setKeepDesc"),
          render: (s) =>
            dd(
              s,
              [
                ["auto", "keepAuto"],
                ["created", "keepCreated"],
                ["modified", "keepModified"],
                ["name", "keepName"],
              ],
              () => st.keepRule,
              (v) => (st.keepRule = v as KeepRule)
            ),
        },
        {
          name: t("setOverlapName"),
          desc: t("setOverlapDesc"),
          render: (setting) =>
            setting.addText((tx) =>
              tx.setPlaceholder("70").setValue(String(st.overlapPercent)).onChange(async (v) => {
                st.overlapPercent = clampInt(v, 30, 100, DEFAULT_SETTINGS.overlapPercent);
                await save();
              })
            ),
        },
        {
          name: t("setModeName"),
          desc: t("setModeDesc"),
          render: (s) =>
            dd(
              s,
              [
                ["mark", "modeMark"],
                ["link", "modeLink"],
                ["remove", "modeRemove"],
              ],
              () => st.cleanMode,
              (v) => (st.cleanMode = v as CleanMode)
            ),
        },
        {
          name: t("setLinkStyleName"),
          desc: t("setLinkStyleDesc"),
          render: (s) =>
            dd(
              s,
              [
                ["embed", "styleEmbed"],
                ["link", "styleLink"],
              ],
              () => st.linkStyle,
              (v) => (st.linkStyle = v as LinkStyle)
            ),
        },
        {
          name: t("setPropName"),
          desc: t("setPropDesc"),
          render: (setting) =>
            setting.addText((tx) =>
              tx.setValue(st.propertyName).onChange(async (v) => {
                const name = v.trim().replace(/[^\w\u4e00-\u9fff-]/g, "");
                st.propertyName = name || DEFAULT_SETTINGS.propertyName;
                await save();
              })
            ),
        },
        {
          name: t("setBackupsName"),
          desc: t("setBackupsDesc"),
          render: (setting) =>
            setting.addText((tx) =>
              tx.setPlaceholder("10").setValue(String(st.backupsToKeep)).onChange(async (v) => {
                st.backupsToKeep = clampInt(v, 1, 100, DEFAULT_SETTINGS.backupsToKeep);
                await save();
              })
            ),
        },
        { name: t("setNewTabName"), desc: t("setNewTabDesc"), render: (s) => toggle(s, () => st.openInNewTab, (v) => (st.openInNewTab = v)) },
        {
          name: t("setIgnoredName"),
          desc: t("setIgnoredDesc", st.ignored.length),
          render: (setting) =>
            setting.addButton((b) => {
              b.setButtonText(t("restore")).onClick(async () => {
                st.ignored = [];
                await save();
                plugin.notifyViews();
              });
            }),
        },
        {
          name: t("setClearCacheName"),
          desc: t("setClearCacheDesc"),
          render: (setting) =>
            setting.addButton((b) => {
              b.buttonEl.addClass("mod-warning");
              b.setButtonText(t("clear")).onClick(async () => {
                await plugin.clearCache();
              });
            }),
        },
      ],
    },
  ];
}
