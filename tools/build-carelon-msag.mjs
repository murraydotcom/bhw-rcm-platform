/* Transform the Carelon / CBH (Maryland Public Behavioral Health System)
 * Master Service Authorization Grid (MSAG) into the engine's lookup JSON.
 * Regenerate with:  node tools/build-carelon-msag.mjs
 *
 * Source CSV lives in engine/data/sources/carelon-msag/ (committed for
 * provenance — it is the MDH-current grid Carelon publishes). This only pivots
 * the grid into the shape engine/prior-auth.mjs reads; the authorization policy
 * is Carelon's / MDH's.
 *
 * Grid layout (see the source): metadata columns 0-15, then a 13-column
 * "Covered Services" block (one column per benefit package / fund code) and a
 * matching 13-column "Pre-Authorization Required" block, then the send-to +
 * claim-form columns. */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "engine", "data", "sources", "carelon-msag", "CBH_MSAG_MDH_current.csv");
const OUT = join(ROOT, "engine", "data", "carelon-msag.json");

/* CSV parser handling quotes and newlines embedded inside quoted cells. */
function parseCSV(text) {
  const rows = []; let cur = [], cell = "", q = false;
  text = text.replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ",") { cur.push(cell); cell = ""; }
    else if (c === "\n") { cur.push(cell); rows.push(cur); cur = []; cell = ""; }
    else cell += c;
  }
  if (cell !== "" || cur.length) { cur.push(cell); rows.push(cur); }
  return rows;
}

const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
const normCode = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
/* Split a cell that may list several codes / modifiers (newline- or comma-separated). */
const splitCell = (s) => String(s || "").split(/[\n,]/).map((x) => x.trim()).filter(Boolean);

/* Column geometry (0-indexed) of the MDH-current grid. */
const COV_START = 16, PA_START = 29, NPKG = 13; // Covered[16..28] · Pre-Auth[29..41]
const COL = { svcType: 0, authClass: 1, eff: 2, term: 3, code: 4,
  mod1: 5, mod2: 6, mod3: 7, addOn: 8, desc: 12, coverableDx: 13, openDx: 14, pos: 15,
  sendTo: 42, ub04: 43, hcfa: 44 };

/* Human labels for the fund-code benefit packages (from the grid's header rows). */
const PACKAGE_LABELS = {
  FSX0: "X02/X03, Federally Funded", SSX0: "X02/X03, State Funded",
  SBTP: "Baltimore Project, State Funded", FMDC: "Medicaid, Federally Funded",
  FDUA: "Medicare/Medicaid, Federally Funded", SMDC: "Medicaid, State Funded",
  SDUA: "Medicare/Medicaid (SLMB and QMB), State Funded", SUNI: "Uninsured, State Funded",
  SGMB: "Gambling, State Funded", SCFD: "Crisis, State Funded",
  SEMR: "Emergency Petition (Uninsured), State Funded", FXAO: "X02/X03 Auth Only",
  FMCO: "Courtesy Reviews (Auth Only)",
};

function build() {
  const rows = parseCSV(readFileSync(SRC, "utf8"));
  // Row 0 columns 16.. carry the fund codes; take the first NPKG of them.
  const fundCodes = rows[0].slice(COV_START, COV_START + NPKG).map(clean);
  const packages = fundCodes.map((code) => ({ code, label: PACKAGE_LABELS[code] || code }));

  const data = rows.slice(5); // first data row
  const codes = {};
  let rowCount = 0, entryCount = 0, codeSet = new Set();
  let svcType = "", authClass = "";

  for (const r of data) {
    if (!r || r.every((c) => clean(c) === "")) continue;
    // Service Type / Auth Class use a merged-cell layout — forward-fill blanks.
    if (clean(r[COL.svcType])) svcType = clean(r[COL.svcType]);
    if (clean(r[COL.authClass])) authClass = clean(r[COL.authClass]);
    const rawCodes = splitCell(r[COL.code]);
    if (!rawCodes.length) continue;
    rowCount++;

    const pkgMap = {};
    for (let i = 0; i < NPKG; i++) {
      const fc = fundCodes[i];
      const covered = clean(r[COV_START + i]).toLowerCase() === "yes";
      const paRaw = clean(r[PA_START + i]);
      // preAuth: Yes | No | N/C (not covered) | free-text conditional note
      let preAuth;
      if (/^yes$/i.test(paRaw)) preAuth = "required";
      else if (/^no$/i.test(paRaw)) preAuth = "not_required";
      else if (/^n\/?c$/i.test(paRaw)) preAuth = "not_covered";
      else if (paRaw) preAuth = "conditional";
      else preAuth = covered ? "unknown" : "not_covered";
      pkgMap[fc] = { covered, preAuth };
      if (preAuth === "conditional") pkgMap[fc].note = clean(r[PA_START + i]);
    }

    const entry = {
      serviceType: svcType, authClass,
      description: clean(r[COL.desc]),
      coverableDx: clean(r[COL.coverableDx]) || null,
      openDx: clean(r[COL.openDx]) || null,
      pos: clean(r[COL.pos]) || null,
      modifiers: [r[COL.mod1], r[COL.mod2], r[COL.mod3]].flatMap(splitCell),
      addOnCodes: splitCell(r[COL.addOn]).map(normCode),
      eff: clean(r[COL.eff]) || null, term: clean(r[COL.term]) || null,
      sendTo: clean(r[COL.sendTo]) || null,
      claimForm: [clean(r[COL.ub04]) ? "UB04" : null, clean(r[COL.hcfa]) ? "HCFA-1500" : null].filter(Boolean),
      packages: pkgMap,
    };

    for (const raw of rawCodes) {
      const code = normCode(raw);
      if (!code) continue;
      (codes[code] ||= []).push(entry);
      codeSet.add(code);
      entryCount++;
    }
  }

  const model = {
    _meta: {
      source: "Carelon / CBH Master Service Authorization Grid (MSAG) — MDH current",
      administrator: "Carelon Behavioral Health (Maryland Public Behavioral Health System / PBHS)",
      illustrative: false,
      note: "Authoritative pre-authorization requirements per benefit package (fund code). Point-of-care decision support — the live answer is the payer's CRD response / a current MSAG. Some cells carry package-specific conditions (POS, day thresholds); read the per-package note.",
      regenerate: "node tools/build-carelon-msag.mjs",
      stats: { codes: codeSet.size, rows: rowCount, entries: entryCount, packages: packages.length },
    },
    administrator: "Carelon (PBHS)",
    packages,
    codes,
  };
  writeFileSync(OUT, JSON.stringify(model) + "\n");
  console.log(`carelon-msag.json: ${codeSet.size} codes · ${rowCount} service rows · ${packages.length} benefit packages`);
}

build();
