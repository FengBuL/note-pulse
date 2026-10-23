import { Notice, Platform, Plugin, TAbstractFile, TFile, TFolder, WorkspaceLeaf, debounce, Debouncer, normalizePath } from "obsidian";
import { DashboardSettings, DEFAULT_SETTINGS, DashboardSettingTab, SETTINGS_VERSION, migrateLanguage, migrateWritingSettings, normalizeFolder, splitList } from "./settings";
import { ContentInfo, PersistentData, VaultStats, computeStats, includedFiles, syncContent, dayKey } from "./stats";
import { DashboardView, VIEW_TYPE_PULSE, noticeError } from "./view";
import { ReportPreviewModal } from "./reports";
import { ReportKind } from "./report-logic";
import { WordPropsService } from "./wordprops";
import { DedupeService, normalizeDedupeSettings } from "./dedupe/service";
import { L } from "./i18n";
import { linkText, rewriteLinks } from "./checkup-logic";
import { DeviceLog, emptyDeviceLog, isDeviceId, mergeDeviceLog, newDeviceId, normalizeDeviceLog } from "./devices";

interface SavedData {
  settings: DashboardSettings;
  /** 1.7.0 之前的每日新增（所有设备混在一起）；1.7.0 起只读，新增写进 devices/<设备 ID>.json */
  wordLog: Record<string, number>;
  wordLogBig?: Record<string, number>;
  /** 有这个字段说明已经换成按设备记录，wordLog 不再增长 */
  devicesSince?: string;
  /**
   * 各设备记录的副本（设备 ID -> 记录）。主记录在 devices/ 下各自的文件里；
   * 有的同步服务不一定同步插件目录里的额外文件，但一定同步 data.json，所以这里也存一份。
   */
  devices?: Record<string, unknown>;
  logInitialized: boolean;
  logStartDay?: string;
  /** ≤1.0.0 的遗留字段 */
  fileWords?: Record<string, number>;
}

/** Obsidian 没有公开的 API，只能通过这几个内部入口完成“打开搜索 / 设置 / 在文件管理器中定位”；每一处都会先检查是否存在。 */
interface InternalPluginHandle<T> {
  instance?: T;
}
interface AppInternals {
  internalPlugins?: {
    getPluginById?: (id: string) => InternalPluginHandle<unknown> | undefined;
  };
  setting?: {
    open?: () => void;
    openTabById?: (id: string) => void;
  };
}
interface GlobalSearchInstance {
  openGlobalSearch?: (query: string) => void;
}
interface FileExplorerInstance {
  revealInFolder?: (folder: TFolder) => void;
}
type CacheEntry = [number, number, number, number | null, Record<number, string>];
interface CacheFile {
  v?: number;
  files?: Record<string, CacheEntry>;
}

const CACHE_FILE = "cache.json";
const DEVICES_DIR = "devices";
/** 设备 ID 存在本机 localStorage：不随库同步，所以每台设备各有一个 */
const DEVICE_KEY = "note-pulse-device-id";
const CACHE_VERSION = 1;

export default class NotePulsePlugin extends Plugin {
  settings: DashboardSettings = { ...DEFAULT_SETTINGS };
  data: PersistentData = { wordLog: {}, wordLogBig: {}, logInitialized: false, logStartDay: "" };
  lastStats: VaultStats | null = null;
  wordProps: WordPropsService = new WordPropsService(this);
  dedupe: DedupeService = new DedupeService(this);
  private contentCache = new Map<string, ContentInfo>();
  deviceId = "";
  /** 本机设备文件里的名字和更新时间（字数在 this.data.wordLog 里） */
  device: DeviceLog = emptyDeviceLog("");
  /** 其它设备，按设备 ID；设置页列出来 */
  otherDevices = new Map<string, DeviceLog>();
  private deviceDirty = false;
  private running = false;
  private rerun = false;
  /** 所有写入内容缓存 / 每日记录的任务串行执行，避免并发重复计数 */
  private queue: Promise<unknown> = Promise.resolve();
  private stale = false;
  private dirtyPaths = new Set<string>();
  private autoRefresh!: Debouncer<[], void>;
  private trackDebounced = debounce(() => this.trackDirty(), 8000, true);
  private persistDebounced = debounce(() => this.persist(), 30000, true);

  async onload() {
    await this.loadAll();

    this.registerView(VIEW_TYPE_PULSE, (leaf) => new DashboardView(leaf, this));

    this.addRibbonIcon("layout-dashboard", L("打开看板", "Open dashboard"), () => this.activateView());

    this.addCommand({
      id: "open-dashboard",
      name: L("打开看板", "Open dashboard"),
      callback: () => this.activateView(),
    });
    this.addCommand({
      id: "refresh-dashboard",
      name: L("刷新看板数据", "Refresh dashboard data"),
      callback: () => this.requestRefresh(true),
    });

    this.addCommand({
      id: "update-word-property",
      name: L("更新当前笔记字数属性", "Update word count property of current note"),
      callback: () => void this.wordProps.updateCurrent(),
    });
    this.addCommand({
      id: "update-all-word-properties",
      name: L("批量更新所有笔记字数属性", "Update word count property of all notes"),
      callback: () => void this.wordProps.batchUpdate(),
    });
    this.addCommand({
      id: "remove-word-properties",
      name: L("移除所有字数属性", "Remove all word count properties"),
      callback: () => void this.wordProps.removeAll(),
    });

    this.addCommand({
      id: "generate-writing-weekly-report",
      name: L("生成写作周报", "Create weekly writing report"),
      callback: () => void this.openWritingReport("week"),
    });
    this.addCommand({
      id: "generate-writing-monthly-report",
      name: L("生成写作月报", "Create monthly writing report"),
      callback: () => void this.openWritingReport("month"),
    });

    await this.dedupe.load();

    this.addSettingTab(new DashboardSettingTab(this.app, this));

    this.buildDebouncer();

    // 布局就绪后再监听，避免启动时大量 create 事件
    this.app.workspace.onLayoutReady(() => {
      const trigger = () => this.onVaultChanged();
      this.wordProps.register();
      this.registerEvent(this.app.metadataCache.on("changed", trigger));
      // 本机编辑器里打的字才算本机的写作；同步进来的、外部程序写的只更新基线
      this.registerEvent(
        this.app.workspace.on("editor-change", (_editor, info) => {
          const f = info.file;
          if (f && f.extension === "md") this.data.localEdits?.set(f.path, Date.now());
        })
      );
      this.registerEvent(this.app.vault.on("create", (f: TAbstractFile) => f instanceof TFile && trigger()));
      this.registerEvent(
        this.app.vault.on("modify", (f: TAbstractFile) => {
          if (f instanceof TFile && f.extension === "md") {
            this.dirtyPaths.add(f.path);
            this.trackDebounced();
          }
        })
      );
      this.registerEvent(
        this.app.vault.on("delete", (f: TAbstractFile) => {
          if (f instanceof TFile && this.contentCache.delete(f.path)) this.data.cacheDirty = true;
          trigger();
        })
      );
      this.registerEvent(
        this.app.vault.on("rename", (f: TAbstractFile, oldPath: string) => {
          const c = this.contentCache.get(oldPath);
          if (c && f instanceof TFile) {
            this.contentCache.delete(oldPath);
            this.contentCache.set(f.path, c);
            this.data.cacheDirty = true;
          }
          const edited = this.data.localEdits?.get(oldPath);
          if (edited !== undefined && f instanceof TFile) {
            this.data.localEdits?.delete(oldPath);
            this.data.localEdits?.set(f.path, edited);
          }
          trigger();
        })
      );
      // 切回看板标签页时，补上它不可见期间错过的刷新
      this.registerEvent(
        this.app.workspace.on("active-leaf-change", (leaf) => {
          if (this.stale && leaf && leaf.view instanceof DashboardView) void this.requestRefresh(false);
        })
      );
      // 其它设备的记录同步进来后自动更新看板：iCloud 等不会通知插件，每分钟看一眼 devices/ 有没有变
      this.registerInterval(window.setInterval(() => void this.checkDevices(), 60_000));
      // 启动后在后台补记一次（只会读取上次之后改动过的文件），这样看板没打开时写的字数也不会丢
      window.setTimeout(() => {
        if (this.getViews().length === 0) void this.enqueue(() => this.silentSync());
      }, 4000);
    });
  }

  /** Obsidian Sync 等同步了 data.json：设备副本可能有新记录 */
  async onExternalSettingsChange() {
    const raw = (await this.loadData()) as Partial<SavedData> | null;
    if (raw?.devices && typeof raw.devices === "object") this.savedDevices = { ...this.savedDevices, ...raw.devices };
    if (this.getViews().some((v) => v.isVisible())) void this.requestRefresh(false);
    else this.stale = true;
  }

  /** devices/ 下各文件的名字和修改时间；变了说明有设备同步来新记录 */
  private deviceSignature = "";
  private deviceChecked = false;

  private async checkDevices() {
    if (this.getViews().length === 0) return;
    let sig = "";
    try {
      const adapter = this.app.vault.adapter;
      if (await adapter.exists(this.devicesDir)) {
        const files = (await adapter.list(this.devicesDir)).files.filter((p) => !p.endsWith(`/${this.deviceId}.json`)).sort();
        for (const p of files) sig += `${p}:${(await adapter.stat(p))?.mtime ?? 0};`;
      }
    } catch {
      return;
    }
    if (sig === this.deviceSignature) return;
    const first = !this.deviceSignature && !this.deviceChecked;
    this.deviceSignature = sig;
    this.deviceChecked = true;
    if (first) return;
    // 看板被别的标签页盖住时，等切回来再算
    if (this.getViews().some((v) => v.isVisible())) void this.requestRefresh(false);
    else this.stale = true;
  }

  onunload() {
    this.wordProps.dispose();
    this.dedupe.dispose();
    // 视图会被 Obsidian 自动卸载；把还没落盘的记录写出去
    void this.persist();
  }

  private buildDebouncer() {
    const ms = Math.max(500, (this.settings.refreshDelaySec || 3) * 1000);
    this.autoRefresh = debounce(() => this.requestRefresh(false), ms, true);
  }

  private onVaultChanged() {
    if (!this.settings.autoRefresh) return;
    const views = this.getViews();
    if (views.length === 0) return; // 看板未打开：下次打开再统计
    if (!views.some((v) => v.isVisible())) {
      this.stale = true; // 看板开着但被别的标签页盖住：不做无谓计算
      return;
    }
    this.autoRefresh();
  }

  getViews(): DashboardView[] {
    return this.app.workspace
      .getLeavesOfType(VIEW_TYPE_PULSE)
      .map((l) => l.view)
      .filter((v): v is DashboardView => v instanceof DashboardView);
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_PULSE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE_PULSE, active: true });
    }
    await workspace.revealLeaf(leaf);
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => undefined);
    return p;
  }

  /** 看板没打开时：只同步改动过的文件并记录字数增量 */
  private async silentSync() {
    try {
      const files = includedFiles(this.app, this.settings);
      await syncContent(this.app, files, this.settings, this.contentCache, this.data);
      if (this.data.legacyFileWords || this.data.seedOnly) {
        this.data.legacyFileWords = undefined; // 所有文件都已建立基线，迁移完成
        this.data.seedOnly = false;
        this.data.dirty = true;
      }
      this.schedulePersist();
    } catch (e) {
      console.error("[note-pulse] 后台记录失败", e);
    }
  }

  /** 编辑笔记时在后台记录字数增量（不依赖看板是否打开） */
  private async trackDirty() {
    // 首次完整统计 / 迁移还没做完时先不要只记一部分文件
    if (!this.data.logInitialized || this.data.seedOnly || this.data.legacyFileWords) return;
    const paths = Array.from(this.dirtyPaths);
    this.dirtyPaths.clear();
    if (paths.length === 0) return;
    await this.enqueue(async () => {
      try {
        const all = includedFiles(this.app, this.settings);
        const set = new Set(paths);
        await syncContent(this.app, all.filter((f) => set.has(f.path)), this.settings, this.contentCache, this.data);
        this.schedulePersist();
      } catch (e) {
        console.error("[note-pulse] 后台记录失败", e);
      }
    });
  }

  /** 重新统计并刷新所有打开的看板。force=true 时会提示完成。 */
  async requestRefresh(force: boolean) {
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.rerun = false;
        this.stale = false;
        for (const v of this.getViews()) v.showLoading(L("正在统计…", "Counting…"));
        // 先把其它设备同步过来的记录读进来
        await this.loadDevices();
        const stats = await this.enqueue(() =>
          computeStats(this.app, this.settings, this.contentCache, this.data, (d, t) => {
            for (const v of this.getViews()) v.setProgress(d, t);
          })
        );
        this.lastStats = stats;
        this.schedulePersist();
        for (const v of this.getViews()) v.render(stats);
      } while (this.rerun);
      if (force) new Notice(L("Note Pulse：看板已刷新", "Note Pulse: dashboard refreshed"));
    } catch (e) {
      noticeError(e);
      for (const v of this.getViews()) v.showError();
    } finally {
      this.running = false;
    }
  }

  async openWritingReport(kind: ReportKind): Promise<void> {
    try {
      // 与后台采集串行，命令在看板关闭时也能拿到最新统计。
      const stats = await this.enqueue(() => computeStats(this.app, this.settings, this.contentCache, this.data));
      this.lastStats = stats;
      this.schedulePersist();
      new ReportPreviewModal(this.app, stats, { ...this.settings }, kind).open();
    } catch (e) {
      noticeError(e);
    }
  }

  async openFile(file: TFile, line?: number, evt?: MouseEvent | KeyboardEvent) {
    const newTab = this.settings.openInNewTab || (evt && (evt.ctrlKey || evt.metaKey));
    const leaf = this.app.workspace.getLeaf(newTab ? "tab" : false);
    await leaf.openFile(file, line !== undefined ? { eState: { line } } : undefined);
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  openSearch(query: string) {
    const internals = this.app as unknown as AppInternals;
    const search = internals.internalPlugins?.getPluginById?.("global-search")?.instance as GlobalSearchInstance | undefined;
    if (search && typeof search.openGlobalSearch === "function") {
      search.openGlobalSearch(query);
    } else {
      new Notice(L(`请启用核心插件“搜索”。查询：${query}`, `Turn on the core Search plugin. Query: ${query}`));
    }
  }

  openSettings() {
    const setting = (this.app as unknown as AppInternals).setting;
    if (setting) {
      setting.open?.();
      setting.openTabById?.(this.manifest.id);
    }
  }

  revealFolder(path: string) {
    const folder = this.app.vault.getAbstractFileByPath(path);
    if (!(folder instanceof TFolder)) return;
    const explorer = (this.app as unknown as AppInternals).internalPlugins?.getPluginById?.("file-explorer")?.instance as
      | FileExplorerInstance
      | undefined;
    if (explorer && typeof explorer.revealInFolder === "function") {
      explorer.revealInFolder(folder);
    } else {
      this.openSearch(`path:"${path}"`);
    }
  }

  /* ---------------- 看板上的一键操作 ---------------- */

  private addToList(key: "excludedFolders" | "clippingFolders", folder: string) {
    const list = splitList(this.settings[key]).map(normalizeFolder);
    if (!list.includes(folder)) list.push(folder);
    this.settings[key] = list.join("\n");
  }

  async setClippingFolder(folder: string) {
    this.addToList("clippingFolders", folder);
    await this.saveSettings();
  }

  /**
   * 把指向 from 的断链改成指向 target，只改出现它的那些笔记。返回改了几篇、几处。
   * 改之前记下每篇的原文和改后的文本，撤销时只恢复之后没再被改过的笔记。
   */
  async fixLink(from: string, target: string, sources: string[]): Promise<{ notes: number; links: number; to: string }> {
    const paths = this.app.vault.getMarkdownFiles().map((f) => f.path);
    const to = linkText(target, paths);
    const changed: { path: string; before: string; after: string }[] = [];
    let links = 0;
    for (const p of new Set(sources)) {
      const f = this.app.vault.getAbstractFileByPath(p);
      if (!(f instanceof TFile)) continue;
      await this.app.vault.process(f, (text) => {
        const r = rewriteLinks(text, from, to);
        if (r.count > 0) {
          links += r.count;
          changed.push({ path: p, before: text, after: r.text });
        }
        return r.text;
      });
    }
    this.lastLinkFix = changed.length ? changed : null;
    return { notes: changed.length, links, to };
  }

  /** 最近一次断链修复改过的笔记（只在这次运行期间可撤销） */
  lastLinkFix: { path: string; before: string; after: string }[] | null = null;

  /** 撤销最近一次断链修复：返回恢复了几篇、跳过了几篇（之后又被改过的不动） */
  async undoLinkFix(): Promise<{ restored: number; skipped: number }> {
    const fix = this.lastLinkFix;
    this.lastLinkFix = null;
    let restored = 0;
    let skipped = 0;
    for (const c of fix ?? []) {
      const f = this.app.vault.getAbstractFileByPath(c.path);
      if (!(f instanceof TFile)) {
        skipped++;
        continue;
      }
      let ok = false;
      await this.app.vault.process(f, (text) => {
        ok = text === c.after;
        return ok ? c.before : text;
      });
      if (ok) restored++;
      else skipped++;
    }
    return { restored, skipped };
  }

  async excludeFolder(folder: string) {
    this.addToList("excludedFolders", folder);
    await this.saveSettings();
  }

  async dismissHint(key: string) {
    if (key === "onboarding") this.settings.onboarded = true;
    else if (!this.settings.dismissedHints.includes(key)) this.settings.dismissedHints.push(key);
    await this.saveSettings();
  }

  async setOutlierExclusion(on: boolean) {
    this.settings.outlierMode = on ? "exclude" : "off";
    await this.saveSettings();
  }

  /** 清空每日新增字数记录，并从今天重新开始 */
  async resetLog() {
    this.data.wordLog = {};
    this.data.wordLogBig = {};
    this.data.legacyLog = {};
    this.data.legacyLogBig = {};
    this.data.otherLogs = [];
    // 所有设备的记录都清掉，否则别的设备的旧记录还会被加回来
    try {
      const adapter = this.app.vault.adapter;
      if (await adapter.exists(this.devicesDir)) {
        for (const path of (await adapter.list(this.devicesDir)).files) if (path.endsWith(".json")) await adapter.remove(path);
      }
    } catch (e) {
      console.warn("[note-pulse] 清除设备记录失败", e);
    }
    this.otherDevices.clear();
    this.deviceDirty = true;
    this.data.logInitialized = false;
    this.data.logStartDay = "";
    this.data.legacyFileWords = undefined;
    for (const c of this.contentCache.values()) c.logged = undefined;
    this.data.dirty = this.data.cacheDirty = true;
    await this.persist();
    await this.requestRefresh(true);
  }

  /* ---------------- 持久化 ---------------- */

  private get cachePath(): string {
    return normalizePath(`${this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`}/${CACHE_FILE}`);
  }

  async loadAll() {
    const raw = ((await this.loadData()) || {}) as Partial<SavedData>;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, raw.settings || {});
    if (!Array.isArray(this.settings.dismissedHints)) this.settings.dismissedHints = [];
    // 0.2.0 起移除了“类型/主题”统计，清理旧版本遗留的设置项
    const legacy = this.settings as unknown as Record<string, unknown>;
    delete legacy.typeFields;
    delete legacy.themeFields;
    // 1.1.0 迁移：旧默认值“按修改日”会让改动旧笔记的那天被严重夸大，改为智能模式
    if ((raw.settings?.settingsVersion ?? 1) < 2) {
      if (this.settings.heatmapMode === "mtime") this.settings.heatmapMode = "auto";
      if (raw.settings) this.settings.onboarded = true; // 老用户不需要欢迎提示
    }
    // 1.4.0：重复内容清理并入。旧设置原样保留；第一次加载时，如果装过独立的 Clip Dedupe，就沿用它的设置
    let migrated = false;
    if (!raw.settings?.dedupe) {
      this.settings.dedupe = normalizeDedupeSettings(await this.readLegacyDedupe());
      migrated = !!raw.settings;
    } else {
      this.settings.dedupe = normalizeDedupeSettings(raw.settings.dedupe);
    }
    migrateWritingSettings(this.settings);
    migrateLanguage(this.settings, !!raw.settings, raw.settings?.settingsVersion ?? 1);
    this.settings.settingsVersion = SETTINGS_VERSION;

    // 1.7.0：data.json 里的旧记录冻结为“1.7.0 之前”，本机的新增写自己的设备文件
    const legacyLog = raw.wordLog || {};
    const logDays = Object.keys(legacyLog).sort();
    this.devicesSince = raw.devicesSince || dayKey(Date.now());
    this.data = {
      wordLog: {},
      wordLogBig: {},
      legacyLog,
      legacyLogBig: raw.wordLogBig || {},
      otherLogs: [],
      localEdits: new Map(),
      logInitialized: !!raw.logInitialized,
      logStartDay: raw.logStartDay || (raw.logInitialized ? logDays[0] || dayKey(Date.now()) : ""),
      legacyFileWords: raw.fileWords && Object.keys(raw.fileWords).length ? raw.fileWords : undefined,
      dirty: !!raw.fileWords || (raw.settings?.settingsVersion ?? 1) < SETTINGS_VERSION || migrated || !raw.devicesSince,
    };
    this.savedDevices = raw.devices && typeof raw.devices === "object" ? raw.devices : {};
    await this.loadDevices();

    // 内容缓存：[mtime, size, words, logged, taskLines]
    let cacheOk = false;
    try {
      const adapter = this.app.vault.adapter;
      if (await adapter.exists(this.cachePath)) {
        const c = JSON.parse(await adapter.read(this.cachePath)) as CacheFile | null;
        if (c && c.v === CACHE_VERSION && c.files) {
          for (const [p, e] of Object.entries(c.files)) {
            this.contentCache.set(p, { mtime: e[0], size: e[1], words: e[2], logged: e[3] ?? undefined, taskLines: e[4] || {} });
          }
          cacheOk = true;
        }
      }
    } catch (e) {
      console.warn("[note-pulse] 读取缓存失败，将重新统计", e);
    }
    if (!cacheOk && this.data.logInitialized && !this.data.legacyFileWords) this.data.seedOnly = true;
  }

  private devicesSince = "";
  /** data.json 里最近一次读到 / 写入的设备副本 */
  private savedDevices: Record<string, unknown> = {};

  private get devicesDir(): string {
    return normalizePath(`${this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`}/${DEVICES_DIR}`);
  }

  private devicePath(id: string): string {
    return normalizePath(`${this.devicesDir}/${id}.json`);
  }

  /** 本机设备 ID：第一次运行时生成，存在 localStorage */
  private ensureDeviceId(): string {
    let id: string | null = null;
    try {
      id = window.localStorage.getItem(DEVICE_KEY);
    } catch {
      id = null;
    }
    if (!isDeviceId(id)) {
      id = newDeviceId();
      try {
        window.localStorage.setItem(DEVICE_KEY, id);
      } catch {
        // localStorage 不可用时本次会话仍用这个 ID；下次启动会再生成一个新设备，记录不会丢，只是多一个设备
      }
    }
    return id;
  }

  private defaultDeviceName(): string {
    if (Platform.isIosApp) return Platform.isTablet ? "iPad" : "iPhone";
    if (Platform.isAndroidApp) return Platform.isTablet ? L("安卓平板", "Android tablet") : L("安卓手机", "Android phone");
    if (Platform.isMacOS) return "Mac";
    if (Platform.isWin) return "Windows";
    if (Platform.isLinux) return "Linux";
    return L("这台设备", "This device");
  }

  /**
   * 读取所有设备的记录：devices/ 下的文件和 data.json 里的副本，按设备合并。
   * 只要几台设备连的是同一个库（iCloud、Obsidian Sync、git……），同步过来就自动参与相加，不用设置。
   */
  async loadDevices() {
    this.deviceId = this.ensureDeviceId();
    const adapter = this.app.vault.adapter;
    const found = new Map<string, DeviceLog>();
    const add = (id: string, log: DeviceLog | null) => {
      const merged = mergeDeviceLog(found.get(id), log);
      if (merged) found.set(id, merged);
    };
    for (const [id, raw] of Object.entries(this.savedDevices)) if (isDeviceId(id)) add(id, normalizeDeviceLog(raw, id));
    try {
      if (await adapter.exists(this.devicesDir)) {
        const listed = await adapter.list(this.devicesDir);
        for (const path of listed.files) {
          const name = path.split("/").pop() || "";
          const id = name.replace(/\.json$/, "");
          if (!name.endsWith(".json") || !isDeviceId(id)) continue;
          try {
            add(id, normalizeDeviceLog(JSON.parse(await adapter.read(path)) as unknown, id));
          } catch (e) {
            console.warn("[note-pulse] 读取设备记录失败", path, e);
          }
        }
      }
    } catch (e) {
      console.warn("[note-pulse] 读取设备记录失败", e);
    }
    // 本机：磁盘上的记录和内存里还没保存的新增合并
    const disk = found.get(this.deviceId) ?? null;
    found.delete(this.deviceId);
    const memory: DeviceLog | null = this.device.name ? { ...this.device, wordLog: this.data.wordLog, wordLogBig: this.data.wordLogBig } : null;
    if (!disk) this.deviceDirty = true;
    this.device = mergeDeviceLog(disk, memory) ?? emptyDeviceLog(this.defaultDeviceName());
    this.data.wordLog = { ...this.device.wordLog };
    this.data.wordLogBig = { ...this.device.wordLogBig };
    const others = found;
    // 别的设备有了 data.json 副本里没有的新记录：下次保存时补齐副本
    for (const [id, log] of others) {
      const saved = normalizeDeviceLog(this.savedDevices[id], id);
      if (!saved || saved.updated < log.updated) this.data.dirty = true;
    }
    this.otherDevices = others;
    this.data.otherLogs = [...others.values()].map((d) => ({ wordLog: d.wordLog, wordLogBig: d.wordLogBig }));
  }

  /** 把磁盘上 data.json 里的设备副本合并进内存（只合并其它设备；本机以内存为准） */
  private async absorbSavedDevices() {
    try {
      const raw = (await this.loadData()) as Partial<SavedData> | null;
      if (!raw?.devices || typeof raw.devices !== "object") return;
      for (const [id, v] of Object.entries(raw.devices)) {
        if (!isDeviceId(id) || id === this.deviceId) continue;
        const log = normalizeDeviceLog(v, id);
        const merged = mergeDeviceLog(this.otherDevices.get(id), log);
        if (merged) this.otherDevices.set(id, merged);
      }
      this.data.otherLogs = [...this.otherDevices.values()].map((d) => ({ wordLog: d.wordLog, wordLogBig: d.wordLogBig }));
    } catch {
      // 读不到就按内存里的写
    }
  }

  /** 写进 data.json 的设备副本：已有副本 + 读到的其它设备 + 本机 */
  private deviceCopies(): Record<string, DeviceLog> {
    const out: Record<string, DeviceLog> = {};
    for (const [id, raw] of Object.entries(this.savedDevices)) {
      const log = isDeviceId(id) ? normalizeDeviceLog(raw, id) : null;
      if (log) out[id] = log;
    }
    for (const [id, log] of this.otherDevices) out[id] = mergeDeviceLog(out[id], log) ?? log;
    if (this.deviceId) out[this.deviceId] = { name: this.device.name, wordLog: this.data.wordLog, wordLogBig: this.data.wordLogBig, updated: this.device.updated || Date.now() };
    this.savedDevices = out;
    return out;
  }

  /** 给本机改名（设置页） */
  async renameDevice(name: string) {
    this.device.name = name.trim() || this.defaultDeviceName();
    this.deviceDirty = true;
    await this.persist();
  }

  /** 读取独立版 Clip Dedupe 的设置（若存在），只读，不改动它的文件 */
  private async readLegacyDedupe(): Promise<unknown> {
    try {
      const path = normalizePath(`${this.app.vault.configDir}/plugins/clip-dedupe/data.json`);
      if (await this.app.vault.adapter.exists(path)) return JSON.parse(await this.app.vault.adapter.read(path)) as unknown;
    } catch (e) {
      console.warn("[note-pulse] 读取 Clip Dedupe 旧设置失败，使用默认值", e);
    }
    return {};
  }

  /** 只保存设置，不触发看板重新统计（重复内容清理的设置与看板统计无关） */
  async saveDedupeSettings() {
    this.data.dirty = true;
    await this.persist();
  }

  /** 只保存看板上的显示偏好（如本周圆点 / 柱状），不重新统计 */
  async saveViewSetting() {
    this.data.dirty = true;
    await this.persist();
  }

  /** 用已有统计结果重绘看板（比如显示 / 隐藏入口卡片） */
  refreshViewsOnly() {
    if (this.lastStats) for (const v of this.getViews()) v.render(this.lastStats);
  }

  schedulePersist() {
    if (this.data.dirty || this.data.cacheDirty || this.data.deviceDirty || this.deviceDirty) this.persistDebounced();
  }

  async persist() {
    try {
      if (this.deviceDirty || this.data.deviceDirty) {
        // 本机记录变了，data.json 里的副本也要跟上
        this.data.dirty = true;
        const adapter = this.app.vault.adapter;
        if (!(await adapter.exists(this.devicesDir))) await adapter.mkdir(this.devicesDir);
        const out: DeviceLog = { name: this.device.name, wordLog: this.data.wordLog, wordLogBig: this.data.wordLogBig, updated: Date.now() };
        await adapter.write(this.devicePath(this.deviceId), JSON.stringify(out));
        this.device = out;
        this.deviceDirty = false;
        this.data.deviceDirty = false;
      }
      if (this.data.dirty) {
        // 写之前再读一次磁盘上的副本：别的设备可能刚同步来更新的记录，合并进来，不要覆盖掉
        await this.absorbSavedDevices();
        const out: SavedData = {
          settings: this.settings,
          // 旧记录原样保留（旧版本的设备还会读它），不再增长
          wordLog: this.data.legacyLog || {},
          wordLogBig: this.data.legacyLogBig || {},
          devicesSince: this.devicesSince,
          devices: this.deviceCopies(),
          logInitialized: this.data.logInitialized,
          logStartDay: this.data.logStartDay,
          // 迁移完成前保留旧字段，保证中途退出不丢基线
          fileWords: this.data.legacyFileWords,
        };
        await this.saveData(out);
        this.data.dirty = false;
      }
      if (this.data.cacheDirty) {
        const files: Record<string, unknown> = {};
        for (const [p, c] of this.contentCache) {
          files[p] = [c.mtime, c.size, c.words, c.logged ?? null, Object.keys(c.taskLines).length ? c.taskLines : undefined];
        }
        await this.app.vault.adapter.write(this.cachePath, JSON.stringify({ v: CACHE_VERSION, files }));
        this.data.cacheDirty = false;
      }
    } catch (e) {
      console.error("[note-pulse] 保存失败", e);
    }
  }

  private settingsRefresh = debounce(() => this.requestRefresh(false), 800, true);

  async saveSettings() {
    this.data.dirty = true;
    await this.persist();
    this.buildDebouncer();
    this.settingsRefresh();
  }
}
