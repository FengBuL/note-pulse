// 打包“重复内容清理”页的预览：node scripts/preview/build-dedupe.mjs，然后打开 scripts/preview/dedupe.html（可加 ?lang=en）
import { build } from "esbuild";
await build({
  entryPoints: ["scripts/preview/dedupe.ts"], bundle: true, format: "iife", outfile: "scripts/preview/dedupe.js",
  alias: { obsidian: "./scripts/preview/obsidian-preview.ts" }, logLevel: "warning", loader: { ".json": "json" },
});
console.log("dedupe preview built");
