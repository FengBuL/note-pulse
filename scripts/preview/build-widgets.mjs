// 打包 2.0 小组件原型：node scripts/preview/build-widgets.mjs，然后打开 scripts/preview/widgets.html
import { build } from "esbuild";
await build({
  entryPoints: ["scripts/preview/widgets.ts"], bundle: true, format: "iife", outfile: "scripts/preview/widgets.js",
  alias: { obsidian: "./scripts/preview/obsidian-preview.ts" }, logLevel: "warning", loader: { ".json": "json" },
});
console.log("widgets prototype built");
