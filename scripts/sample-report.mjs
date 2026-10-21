// node scripts/sample-report.mjs [输出目录]；沿用测试的 Obsidian 替身，无需启动 Obsidian。
import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// 放在子目录，避免测试 runner 把示例当作测试执行。
await mkdir(".test-out/samples", { recursive: true });
const outfile = ".test-out/samples/sample-report.mjs";
await build({
  entryPoints: ["scripts/sample-report.ts"], bundle: true, platform: "node", format: "esm",
  outfile, alias: { obsidian: "./tests/obsidian-stub.ts" },
});
await import(pathToFileURL(resolve(outfile)).href);
