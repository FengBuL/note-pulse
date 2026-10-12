import { Notice, Plugin, TAbstractFile, TFile, TFolder, WorkspaceLeaf, debounce, Debouncer, normalizePath } from "obsidian";
import { DashboardSettings, DEFAULT_SETTINGS, DashboardSettingTab, SETTINGS_VERSION, normalizeFolder, splitList } from "./settings";
import { ContentInfo, PersistentData, VaultStats, computeStats, includedFiles, syncContent, dayKey } from "./stats";
import { DashboardView, VIEW_TYPE_PULSE, noticeError } from "./view";
import { WordPropsService } from "./wordprops";

interface SavedData {
  settings: DashboardSettings;
  wordLog: Record<string, number>;
  wordLogBig?: Record<string, number>;
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
const CACHE_VERSION = 1;

export default class NotePulsePlugin extends Plugin {
  settings: DashboardSettings = { ...DEFAULT_SETTINGS };
  data: PersistentData = { wordLog: {}, wordLogBig: {}, logInitialized: false, logStartDay: "" };
  lastStats: VaultStats | null = null;
  wordProps: WordPropsService = new WordPropsService(this);
  private contentCache = new Map<string, ContentInfo>();
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

    this.addRibbonIcon("layout-dashboard", "打开看板", () => this.activateView());

    this.addCommand({
      id: "open-dashboard",
      name: "打开看板",
      callback: () => this.activateView(),
    });
    this.addCommand({
      id: "refresh-dashboard",
      name: "刷新看板数据",
      callback: () => this.requestRefresh(true),
    });

    this.addCommand({
      id: "update-word-property",
      name: "更新当前笔记字数属性",
      callback: () => void this.wordProps.updateCurrent(),
    });
    this.addCommand({
      id: "update-all-word-properties",
      name: "批量更新所有笔记字数属性",
      callback: () => void this.wordProps.batchUpdate(),
    });
    this.addCommand({
      id: "remove-word-properties",
      name: "移除所有字数属性",
      callback: () => void this.wordProps.removeAll(),
    });

    this.addSettingTab(new DashboardSettingTab(this.app, this));

    this.buildDebouncer();

    // 布局就绪后再监听，避免启动时大量 create 事件
    this.app.workspace.onLayoutReady(() => {
      const trigger = () => this.onVaultChanged();
      this.wordProps.register();
      this.registerEvent(this.app.metadataCache.on("changed", trigger));
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
          trigger();
        })
      );
      // 切回看板标签页时，补上它不可见期间错过的刷新
      this.registerEvent(
        this.app.workspace.on("active-leaf-change", (leaf) => {
          if (this.stale && leaf && leaf.view instanceof DashboardView) void this.requestRefresh(false);
        })
      );
      // 启动后在后台补记一次（只会读取上次之后改动过的文件），这样看板没打开时写的字数也不会丢
      window.setTimeout(() => {
        if (this.getViews().length === 0) void this.enqueue(() => this.silentSync());
      }, 4000);
    });
  }

  onunload() {
    this.wordProps.dispose();
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
        for (const v of this.getViews()) v.showLoading("正在统计…");
        const stats = await this.enqueue(() =>
          computeStats(this.app, this.settings, this.contentCache, this.data, (d, t) => {
            for (const v of this.getViews()) v.setProgress(d, t);
          })
        );
        this.lastStats = stats;
        this.schedulePersist();
        for (const v of this.getViews()) v.render(stats);
      } while (this.rerun);
      if (force) new Notice("Note Pulse：看板已刷新");
    } catch (e) {
      noticeError(e);
      for (const v of this.getViews()) v.showError();
    } finally {
      this.running = false;
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
      new Notice(`请启用核心插件“搜索”。查询：${query}`);
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
    this.settings.settingsVersion = SETTINGS_VERSION;

    const wordLog = raw.wordLog || {};
    const logDays = Object.keys(wordLog).sort();
    this.data = {
      wordLog,
      wordLogBig: raw.wordLogBig || {},
      logInitialized: !!raw.logInitialized,
      logStartDay: raw.logStartDay || (raw.logInitialized ? logDays[0] || dayKey(Date.now()) : ""),
      legacyFileWords: raw.fileWords && Object.keys(raw.fileWords).length ? raw.fileWords : undefined,
      dirty: !!raw.fileWords || (raw.settings?.settingsVersion ?? 1) < 2,
    };

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

  schedulePersist() {
    if (this.data.dirty || this.data.cacheDirty) this.persistDebounced();
  }

  async persist() {
    try {
      if (this.data.dirty) {
        const out: SavedData = {
          settings: this.settings,
          wordLog: this.data.wordLog,
          wordLogBig: this.data.wordLogBig,
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
