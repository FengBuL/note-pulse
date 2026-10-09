import { Notice, Plugin, TAbstractFile, TFile, TFolder, WorkspaceLeaf, debounce, Debouncer } from "obsidian";
import { DashboardSettings, DEFAULT_SETTINGS, DashboardSettingTab } from "./settings";
import { ContentInfo, PersistentData, VaultStats, computeStats } from "./stats";
import { DashboardView, VIEW_TYPE_PULSE, noticeError } from "./view";

interface SavedData {
  settings: DashboardSettings;
  wordLog: Record<string, number>;
  fileWords: Record<string, number>;
  logInitialized: boolean;
}

export default class NotePulsePlugin extends Plugin {
  settings: DashboardSettings = { ...DEFAULT_SETTINGS };
  data: PersistentData = { wordLog: {}, fileWords: {}, logInitialized: false };
  lastStats: VaultStats | null = null;
  private contentCache = new Map<string, ContentInfo>();
  private running = false;
  private rerun = false;
  private autoRefresh!: Debouncer<[], void>;

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

    this.addSettingTab(new DashboardSettingTab(this.app, this));

    this.buildDebouncer();

    // 布局就绪后再监听，避免启动时大量 create 事件
    this.app.workspace.onLayoutReady(() => {
      const trigger = () => this.onVaultChanged();
      this.registerEvent(this.app.metadataCache.on("changed", trigger));
      this.registerEvent(this.app.vault.on("create", (f: TAbstractFile) => f instanceof TFile && trigger()));
      this.registerEvent(this.app.vault.on("delete", trigger));
      this.registerEvent(this.app.vault.on("rename", trigger));
    });
  }

  onunload() {
    // 视图会被 Obsidian 自动卸载
  }

  private buildDebouncer() {
    const ms = Math.max(500, (this.settings.refreshDelaySec || 3) * 1000);
    this.autoRefresh = debounce(() => this.requestRefresh(false), ms, true);
  }

  private onVaultChanged() {
    if (!this.settings.autoRefresh) return;
    if (this.getViews().length === 0) {
      // 看板未打开时只标记数据过期，下次打开再统计
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
    workspace.revealLeaf(leaf);
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
        for (const v of this.getViews()) v.showLoading("正在统计…");
        const stats = await computeStats(this.app, this.settings, this.contentCache, this.data, (d, t) => {
          for (const v of this.getViews()) v.setProgress(d, t);
        });
        this.lastStats = stats;
        await this.persist();
        for (const v of this.getViews()) v.render(stats);
      } while (this.rerun);
      if (force) new Notice("Note Pulse：看板已刷新");
    } catch (e) {
      noticeError(e);
    } finally {
      this.running = false;
    }
  }

  async openFile(file: TFile, line?: number, evt?: MouseEvent) {
    const newTab = this.settings.openInNewTab || (evt && (evt.ctrlKey || evt.metaKey));
    const leaf = this.app.workspace.getLeaf(newTab ? "tab" : false);
    await leaf.openFile(file, line !== undefined ? { eState: { line } } : undefined);
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  openSearch(query: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const search = (this.app as any).internalPlugins?.getPluginById?.("global-search");
    if (search && search.instance && typeof search.instance.openGlobalSearch === "function") {
      search.instance.openGlobalSearch(query);
    } else {
      new Notice(`请启用核心插件“搜索”。查询：${query}`);
    }
  }

  revealFolder(path: string) {
    const folder = this.app.vault.getAbstractFileByPath(path);
    if (!(folder instanceof TFolder)) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const explorer = (this.app as any).internalPlugins?.getPluginById?.("file-explorer");
    if (explorer?.instance?.revealInFolder) {
      explorer.instance.revealInFolder(folder);
    } else {
      this.openSearch(`path:"${path}"`);
    }
  }

  async loadAll() {
    const raw = ((await this.loadData()) || {}) as Partial<SavedData>;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, raw.settings || {});
    // 0.2.0 起移除了“类型/主题”统计，清理旧版本遗留的设置项
    const legacy = this.settings as unknown as Record<string, unknown>;
    delete legacy.typeFields;
    delete legacy.themeFields;
    this.data = {
      wordLog: raw.wordLog || {},
      fileWords: raw.fileWords || {},
      logInitialized: !!raw.logInitialized,
    };
  }

  async persist() {
    const out: SavedData = {
      settings: this.settings,
      wordLog: this.data.wordLog,
      fileWords: this.data.fileWords,
      logInitialized: this.data.logInitialized,
    };
    await this.saveData(out);
  }

  private settingsRefresh = debounce(() => this.requestRefresh(false), 800, true);

  async saveSettings() {
    await this.persist();
    this.buildDebouncer();
    this.settingsRefresh();
  }
}

