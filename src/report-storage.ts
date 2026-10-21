import { App, TFile, TFolder, normalizePath } from "obsidian";

export class ReportStorageError extends Error {}

export function reportPath(folder: string, title: string): string {
  const cleaned = folder.trim().replace(/\\/g, "/");
  if (cleaned.split("/").some((part) => part === "." || part === "..") || /[:*?"<>|]/.test(cleaned) || Array.from(cleaned).some((char) => char.charCodeAt(0) < 32)) {
    throw new ReportStorageError("保存位置包含不能用于文件夹名称的字符，请先修改设置。");
  }
  return normalizePath(`${cleaned ? cleaned + "/" : ""}${title}.md`);
}

/** 只在配置的报告目录中查找；兼容缺少属性的旧报告和另存的副本。 */
export function latestWritingReport(app: App, folder: string): TFile | null {
  let directory: string;
  try {
    directory = reportPath(folder, "report").slice(0, -"report.md".length);
  } catch {
    return null;
  }
  let latest: TFile | null = null;
  for (const file of app.vault.getMarkdownFiles()) {
    if (!file.path.startsWith(directory)) continue;
    const type: unknown = app.metadataCache.getFileCache(file)?.frontmatter?.type;
    if (type !== "写作周报" && type !== "写作月报" && !/^写作[周月]报(?:\s|$)/u.test(file.basename)) continue;
    if (!latest || file.stat.mtime > latest.stat.mtime ||
      (file.stat.mtime === latest.stat.mtime && file.path.localeCompare(latest.path) < 0)) latest = file;
  }
  return latest;
}

export async function ensureReportFolder(app: App, path: string): Promise<void> {
  const parts = path.split("/").slice(0, -1);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    const existing = app.vault.getAbstractFileByPath(current);
    if (existing && !(existing instanceof TFolder)) throw new ReportStorageError("保存位置被同名文件占用，请修改设置。");
    if (!existing) {
      try {
        await app.vault.createFolder(current);
      } catch (error) {
        // 另一个保存操作可能刚刚创建了同一文件夹。
        if (!(app.vault.getAbstractFileByPath(current) instanceof TFolder)) throw error;
      }
    }
  }
}

export async function createReport(app: App, path: string, markdown: string, separate: boolean): Promise<TFile> {
  await ensureReportFolder(app, path);
  let target = path;
  if (separate) {
    let n = 2;
    while (app.vault.getAbstractFileByPath(target)) target = path.replace(/\.md$/, ` (${n++}).md`);
  }
  // create 遇到冲突会失败，不会覆盖刚被其他操作创建的文件。
  return app.vault.create(target, markdown);
}

export async function overwriteReport(app: App, file: TFile, original: string, markdown: string): Promise<TFile> {
  await app.vault.process(file, (current) => {
    if (current !== original) throw new ReportStorageError("这篇笔记刚刚被修改，请重新预览后再保存。");
    return markdown;
  });
  return file;
}
