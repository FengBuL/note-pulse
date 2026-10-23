// 打包本地预览：node scripts/preview/build.mjs，然后用浏览器打开 scripts/preview/index.html
import { build } from "esbuild";
await build({
  entryPoints: ["scripts/preview/main.ts"], bundle: true, format: "iife", outfile: "scripts/preview/preview.js",
  alias: { obsidian: "./scripts/preview/obsidian-preview.ts" }, logLevel: "warning", loader: { ".json": "json" },
});
console.log("preview built");
