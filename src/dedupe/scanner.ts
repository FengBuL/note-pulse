import type { App, TFile } from "obsidian";
import { Analysis, FileRecord, analyze } from "./core/group";
import { TokenizeOptions, tokenize } from "./core/tokenize";
import type { ClipDedupeSettings } from "./settings";
import { splitList } from "./settings";
import { ScanCache, packBlocks, unpackBlocks } from "./store";

/** Notes larger than this are skipped (huge dumps would dominate memory and time). */
const MAX_BYTES = 3_000_000;
const SLICE_MS = 14;

export function tokenizeOptions(s: ClipDedupeSettings): TokenizeOptions {
  return {
    ignoreFrontmatter: s.ignoreFrontmatter,
    ignoreCode: s.ignoreCode,
    ignoreHeadings: s.ignoreHeadings,
    ignoreLinkOnly: s.ignoreLinkOnly,
    minLength: s.minLength,
    detectStatusIds: s.detectStatusIds,
  };
}

export function cacheKey(s: ClipDedupeSettings): string {
  return JSON.stringify(tokenizeOptions(s));
}

const inFolder = (path: string, folder: string) => path === folder || path.startsWith(folder + "/");

export function scanTargets(app: App, s: ClipDedupeSettings): TFile[] {
  const include = splitList(s.includeFolders);
  const exclude = splitList(s.excludeFolders);
  return app.vault.getMarkdownFiles().filter((f) => {
    if (exclude.some((x) => inFolder(f.path, x))) return false;
    return include.length === 0 || include.some((x) => inFolder(f.path, x));
  });
}

export interface ScanControl {
  cancelled: boolean;
}

export interface ScanProgress {
  done: number;
  total: number;
  phase: "read" | "group";
}

const nextTick = () => new Promise<void>((resolve) => window.setTimeout(resolve, 0));

/** Reads (or takes from the cache) every note in scope, then groups the duplicates. Returns null when cancelled. */
export async function runScan(
  app: App,
  settings: ClipDedupeSettings,
  cache: ScanCache,
  ctl: ScanControl,
  onProgress: (p: ScanProgress) => void
): Promise<Analysis | null> {
  cache.useKey(cacheKey(settings));
  const opts = tokenizeOptions(settings);
  const targets = scanTargets(app, settings);
  const records: FileRecord[] = [];
  let sliceStart = performance.now();
  for (let i = 0; i < targets.length; i++) {
    if (ctl.cancelled) return null;
    const file = targets[i];
    const { mtime, size, ctime } = file.stat;
    if (size <= MAX_BYTES) {
      let entry = cache.get(file.path, mtime, size);
      if (!entry) {
        const text = await app.vault.cachedRead(file);
        const t = tokenize(text, opts);
        entry = [mtime, size, text.length, t.lines, t.totalW, packBlocks(t.blocks)];
        cache.set(file.path, entry);
      }
      records.push({ path: file.path, ctime, mtime, len: entry[2], lines: entry[3], totalW: entry[4], blocks: unpackBlocks(entry[5]) });
    }
    if (performance.now() - sliceStart > SLICE_MS) {
      onProgress({ done: i + 1, total: targets.length, phase: "read" });
      await nextTick();
      sliceStart = performance.now();
    }
  }
  onProgress({ done: targets.length, total: targets.length, phase: "group" });
  await nextTick();
  cache.prune(new Set(app.vault.getMarkdownFiles().map((f) => f.path)));
  const result = analyze(records, { keepRule: settings.keepRule, overlapThreshold: settings.overlapPercent / 100 });
  await cache.save();
  return result;
}
