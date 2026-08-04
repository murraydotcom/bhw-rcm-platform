// engine/xlsx-lite.mjs
// Minimal, dependency-free spreadsheet reader for the browser (and Node): reads
// a CRISP .xlsx export (ZIP + DEFLATE via the built-in DecompressionStream, then
// plain-string XML parsing) or a .csv, returning rows as objects keyed by the
// header row. No third-party library, nothing uploaded.

const DATE_HEADERS = new Set(["Discharge Date / Time", "Admit Date / Time", "Date of Birth"]);

// ---- public entry -----------------------------------------------------------

// Accepts a File/Blob (browser) or any object with .name + .arrayBuffer()/.text().
export async function readSpreadsheet(file) {
  const name = (file.name || "").toLowerCase();
  if (name.endsWith(".csv") || name.endsWith(".tsv")) {
    const text = await file.text();
    return { sheet: "", rows: parseDelimited(text, name.endsWith(".tsv") ? "\t" : ",") };
  }
  const buf = await file.arrayBuffer();
  return await readXlsx(buf);
}

// ---- CSV / TSV --------------------------------------------------------------

export function parseDelimited(text, delim = ",") {
  const rows = parseDelimitedRows(text, delim);
  if (!rows.length) return [];
  const headers = rows[0].map((h) => String(h).trim());
  return rows.slice(1).filter((r) => r.some((c) => String(c).trim() !== ""))
    .map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] == null ? "" : r[i]])));
}

// RFC-4180-ish: quoted fields, doubled quotes, embedded newlines.
function parseDelimitedRows(text, delim) {
  const rows = []; let row = [], field = "", q = false;
  const s = String(text).replace(/\r\n?/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ---- XLSX -------------------------------------------------------------------

async function readXlsx(arrayBuffer) {
  const files = await unzip(new Uint8Array(arrayBuffer));
  const dec = new TextDecoder();
  const text = (path) => (files[path] ? dec.decode(files[path]) : "");

  const shared = parseSharedStrings(text("xl/sharedStrings.xml"));
  const { name, path } = pickSheet(text("xl/workbook.xml"), text("xl/_rels/workbook.xml.rels"), files);
  const sheetXml = text(path);
  if (!sheetXml) throw new Error("worksheet not found in workbook");
  return { sheet: name, rows: sheetToObjects(sheetXml, shared) };
}

export function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml))) {
    // concatenate every <t>…</t> inside the <si> (handles rich-text runs)
    let s = "", tm; const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    while ((tm = tRe.exec(m[1]))) s += decodeXml(tm[1]);
    out.push(s);
  }
  return out;
}

// Pick the data sheet: prefer one whose name looks like a CRISP panel, else the
// first sheet listed. Resolve its target via the workbook relationships.
export function pickSheet(workbookXml, relsXml, files) {
  const rels = {};
  let r; const relRe = /<Relationship\b[^>]*>/g;
  while ((r = relRe.exec(relsXml))) {
    const id = (r[0].match(/Id="([^"]*)"/) || [])[1];
    const target = (r[0].match(/Target="([^"]*)"/) || [])[1];
    if (id && target) rels[id] = target.replace(/^\//, "").replace(/^xl\//, "");
  }
  const sheets = [];
  let s; const shRe = /<sheet\b[^>]*>/g;
  while ((s = shRe.exec(workbookXml))) {
    const name = decodeXml((s[0].match(/name="([^"]*)"/) || [])[1] || "");
    const rid = (s[0].match(/r:id="([^"]*)"/) || [])[1];
    sheets.push({ name, rid });
  }
  const resolve = (sh) => "xl/" + (rels[sh.rid] || "worksheets/sheet1.xml");
  const chosen = sheets.find((sh) => /panel/i.test(sh.name) && files[resolve(sh)])
    || sheets.find((sh) => files[resolve(sh)]) || { name: "", rid: "" };
  return { name: chosen.name, path: resolve(chosen) };
}

// Turn a worksheet XML into an array of header-keyed row objects.
export function sheetToObjects(sheetXml, shared) {
  const rows = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(sheetXml))) rows.push(parseCells(rm[1], shared));
  if (!rows.length) return [];
  const headers = [];
  rows[0].forEach((v, i) => { headers[i] = v == null ? "" : String(v).trim(); });
  const dateCols = new Set(headers.map((h, i) => (DATE_HEADERS.has(h) ? i : -1)).filter((i) => i >= 0));
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (!cells.some((c) => c != null && c !== "")) continue;
    const obj = {};
    for (let i = 0; i < headers.length; i++) {
      if (!headers[i]) continue;
      let v = cells[i];
      if (v != null && v !== "" && dateCols.has(i) && typeof v === "number") v = serialToISO(v);
      obj[headers[i]] = v == null ? "" : v;
    }
    out.push(obj);
  }
  return out;
}

// Parse one <row>…</row> body into a sparse array indexed by column number.
function parseCells(rowBody, shared) {
  const arr = [];
  const cRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let m;
  while ((m = cRe.exec(rowBody))) {
    const attrs = m[1], inner = m[2] || "";
    const ref = (attrs.match(/r="([A-Z]+)\d+"/) || [])[1];
    const t = (attrs.match(/t="([^"]*)"/) || [])[1] || "n";
    const idx = ref ? colIndex(ref) : arr.length;
    let val = "";
    if (t === "inlineStr") {
      const im = inner.match(/<t\b[^>]*>([\s\S]*?)<\/t>/);
      val = im ? decodeXml(im[1]) : "";
    } else {
      const vm = inner.match(/<v>([\s\S]*?)<\/v>/);
      const raw = vm ? vm[1] : "";
      if (t === "s") val = shared[Number(raw)] ?? "";
      else if (t === "str" || t === "e") val = decodeXml(raw);
      else if (t === "b") val = raw === "1" ? "TRUE" : "FALSE";
      else val = raw === "" ? "" : Number(raw); // numeric (may be a date serial)
    }
    arr[idx] = val;
  }
  return arr;
}

// Excel 1900 serial (days since 1899-12-30) → "YYYY-MM-DD" or "…THH:MM".
export function serialToISO(n) {
  const ms = Math.round((n - 25569) * 86400000);
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, "0");
  const base = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  const frac = Math.abs(n - Math.trunc(n));
  return frac > 1e-9 ? `${base}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` : base;
}

function colIndex(letters) {
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n - 1;
}

function decodeXml(s) {
  return String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

// ---- ZIP (store + deflate) --------------------------------------------------

// Parse the ZIP central directory and inflate each entry. Returns { path: Uint8Array }.
async function unzip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // End of Central Directory: scan backwards for signature 0x06054b50.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) { if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) throw new Error("not a valid .xlsx (no ZIP end record)");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = {};
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const fnLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + fnLen));
    // Local header → data start.
    const lFnLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lFnLen + lExtraLen;
    const comp = bytes.subarray(dataStart, dataStart + compSize);
    out[name] = method === 0 ? comp.slice() : await inflateRaw(comp);
    p += 46 + fnLen + extraLen + commentLen;
  }
  return out;
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("this browser can't unzip .xlsx (no DecompressionStream) — export as .csv");
  }
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
