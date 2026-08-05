// engine/test/xlsx-lite.test.mjs — pure parsers of the lite spreadsheet reader.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDelimited, serialToISO, parseSharedStrings, sheetToObjects, pickSheet } from "../../engine/xlsx-lite.mjs";

test("parseDelimited maps headers and handles quoted commas", () => {
  const csv = 'First Name,Last Name,Facility\nKaren,Minor,"Hospital, Midtown"\n';
  const rows = parseDelimited(csv);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { "First Name": "Karen", "Last Name": "Minor", "Facility": "Hospital, Midtown" });
});

test("parseDelimited skips blank lines", () => {
  assert.equal(parseDelimited("A,B\n1,2\n\n3,4\n").length, 2);
});

test("serialToISO converts Excel serials (date and date-time)", () => {
  assert.equal(serialToISO(25569), "1970-01-01");
  assert.equal(serialToISO(44197), "2021-01-01");
  assert.equal(serialToISO(44197.5), "2021-01-01T12:00");
});

test("parseSharedStrings concatenates rich-text runs", () => {
  const xml = `<sst><si><t>Hello</t></si><si><r><t>Ka</t></r><r><t>ren</t></r></si><si><t>A &amp; B</t></si></sst>`;
  assert.deepEqual(parseSharedStrings(xml), ["Hello", "Karen", "A & B"]);
});

test("sheetToObjects keys rows by header and converts date-serial columns", () => {
  const shared = ["First Name", "Last Name", "Discharge Date / Time", "Karen", "Minor"];
  const xml = `
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>
    <row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" t="s"><v>4</v></c><c r="C2"><v>44197.5</v></c></row>`;
  const rows = sheetToObjects(xml, shared);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]["First Name"], "Karen");
  assert.equal(rows[0]["Last Name"], "Minor");
  assert.equal(rows[0]["Discharge Date / Time"], "2021-01-01T12:00");
});

test("sheetToObjects handles sparse rows (missing cells) and inline strings", () => {
  const xml = `
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>
    <row r="2"><c r="A2" t="inlineStr"><is><t>Solo</t></is></c></row>`;
  const rows = sheetToObjects(xml, ["Name", "Facility"]);
  assert.equal(rows[0]["Name"], "Solo");
  assert.equal(rows[0]["Facility"], "");
});

test("pickSheet resolves the panel sheet via workbook relationships", () => {
  const wb = `<workbook><sheets>
    <sheet name="Panel_MD_BMOREHW" sheetId="1" r:id="rId1"/>
    <sheet name="About" sheetId="2" r:id="rId2"/></sheets></workbook>`;
  const rels = `<Relationships>
    <Relationship Id="rId1" Target="worksheets/sheet1.xml"/>
    <Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>`;
  const files = { "xl/worksheets/sheet1.xml": new Uint8Array(1), "xl/worksheets/sheet2.xml": new Uint8Array(1) };
  const { name, path } = pickSheet(wb, rels, files);
  assert.equal(name, "Panel_MD_BMOREHW");
  assert.equal(path, "xl/worksheets/sheet1.xml");
});
