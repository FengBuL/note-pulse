// Browser-compatibility check for styles.css (the same idea as the directory's CSS review). Usage: node scripts/check-css.cjs styles.css
const fs = require("fs");
const postcss = require("postcss");
const doiuse = require("doiuse");
const file = process.argv[2] || "styles.css";
const css = fs.readFileSync(file, "utf8");
if (/!important/.test(css)) {
  console.log("!important found");
  process.exit(1);
}
postcss(doiuse({ browsers: ["chrome >= 128", "ios_saf >= 16.4", "android >= 128"] }))
  .process(css, { from: file })
  .then((r) => {
    const w = r.warnings();
    console.log(`css compatibility warnings: ${w.length}`);
    w.forEach((x) => console.log(`${x.line}: ${x.text}`));
    process.exit(w.length ? 1 : 0);
  });
