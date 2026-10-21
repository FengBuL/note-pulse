import { mkdir, writeFile } from "node:fs/promises";
import { buildWritingReport } from "../src/report-logic";
import { DEFAULT_SETTINGS } from "../src/settings";
import { reportFixture } from "../tests/helpers/report-fixture";

const destination = process.argv[2] || "/workspace/np-report-shots";
await mkdir(destination, { recursive: true });
const stats = reportFixture();
for (const kind of ["week", "month"] as const) {
  const report = buildWritingReport(stats, DEFAULT_SETTINGS, kind, 0, true);
  const path = `${destination}/sample-${kind}.md`;
  await writeFile(path, report.markdown, "utf8");
  console.log(path);
}
