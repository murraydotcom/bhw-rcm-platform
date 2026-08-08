/* Documentation-coverage report: which of BHW's charge-master codes have a
 * doc-assist entry (the note↔code map) and which still need a guide.
 * Run:  node tools/coverage.mjs        (prints + rewrites docs/doc-assist-coverage.md)
 * This is how we track "all of them" — nothing hides. */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { DATA } = require(join(ROOT, "engine", "themis.js"));
const doc = JSON.parse(readFileSync(join(ROOT, "engine", "data", "doc-assist.json"), "utf8"));
const have = new Set(Object.keys(doc).filter((k) => !k.startsWith("_")));

const byProg = {};
for (const [code, desc, prog] of DATA.cdm) (byProg[prog] ||= []).push({ code, desc, covered: have.has(code) });

const totalCovered = DATA.cdm.filter(([c]) => have.has(c)).length;
let md = `# Documentation-assist coverage\n\n`;
md += `Which BHW charge-master codes have a documentation-assist entry (\`engine/data/doc-assist.json\`).\n`;
md += `The **scrub engine** already covers every code with NCCI/MUE/rule data; this table tracks the\n`;
md += `note↔code documentation layer, which is built from real guidance code-by-code.\n\n`;
md += `**Coverage: ${totalCovered} / ${DATA.cdm.length} charge-master codes.** Regenerate with \`node tools/coverage.mjs\`.\n\n`;

const lines = [`| Program | Covered | Codes still needing a guide |`, `|---|---|---|`];
for (const prog of Object.keys(byProg).sort()) {
  const rows = byProg[prog];
  const cov = rows.filter((r) => r.covered).length;
  const missing = rows.filter((r) => !r.covered).map((r) => r.code).join(", ") || "—";
  lines.push(`| ${prog} | ${cov}/${rows.length} | ${missing} |`);
}
md += lines.join("\n") + "\n";

writeFileSync(join(ROOT, "docs", "doc-assist-coverage.md"), md);
console.log(`coverage: ${totalCovered}/${DATA.cdm.length}`);
for (const prog of Object.keys(byProg).sort()) {
  const rows = byProg[prog];
  console.log(`  ${prog}: ${rows.filter((r) => r.covered).length}/${rows.length}`);
}
console.log("wrote docs/doc-assist-coverage.md");
