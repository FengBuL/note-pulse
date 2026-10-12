// 把 tests/*.test.ts 用 esbuild 打包成 ESM，再交给 node:test 运行（不需要额外依赖）
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

const entries = readdirSync("tests").filter((f) => f.endsWith(".test.ts")).map((f) => `tests/${f}`);
await build({ entryPoints: entries, bundle: true, platform: "node", format: "esm", outdir: ".test-out", outExtension: { ".js": ".mjs" }, logLevel: "warning", alias: { obsidian: "./tests/obsidian-stub.ts" } });
const out = readdirSync(".test-out").filter((f) => f.endsWith(".mjs")).map((f) => `.test-out/${f}`);
const r = spawnSync(process.execPath, ["--test", ...out], { stdio: "inherit" });
process.exit(r.status ?? 1);
