// engine/test/tcm-parse.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeRecord, classify, deadlines, addBusinessDays, buildWorklist, CRISP_HEADERS,
  normalizeRoster, buildRosterIndex, matchRoster,
} from "../../engine/tcm-parse.mjs";

// A raw row keyed by the real CRISP "Panel Details" headers.
const row = (o) => ({
  "First Name": o.first ?? "",
  "Last Name": o.last ?? "",
  "Gender": o.gender ?? "",
  "Discharge Date / Time": o.discharge ?? "",
  "Discharge Disposition": o.dispo ?? "",
  "Encounter Type": o.enc ?? "",
  "Facility": o.facility ?? "",
  "Date of Birth": o.dob ?? "",
  "Primary Diagnosis Codes": o.dx ?? "",
});

test("normalizeRecord maps CRISP headers and coerces a Date to ISO", () => {
  const r = normalizeRecord({ "First Name": "Karen", "Last Name": "Minor", "Discharge Date / Time": new Date(Date.UTC(2026, 7, 3, 13, 15)) });
  assert.equal(r.firstName, "Karen");
  assert.equal(r.lastName, "Minor");
  assert.equal(r.dischargeAt, "2026-08-03T13:15");
});

test("CRISP_HEADERS lists the expected columns", () => {
  assert.ok(CRISP_HEADERS.includes("Discharge Date / Time"));
  assert.ok(CRISP_HEADERS.includes("Encounter Type"));
});

test("classify: inpatient discharge to home is a TCM candidate", () => {
  const c = classify(normalizeRecord(row({ enc: "Inpatient", discharge: "2026-08-03T10:00", dispo: "Home" })));
  assert.equal(c.category, "tcm");
  assert.equal(c.flags.length, 0);
});

test("classify: inpatient with no discharge date is 'admitted'", () => {
  assert.equal(classify(normalizeRecord(row({ enc: "Inpatient" }))).category, "admitted");
});

test("classify: observation discharge is TCM with an observation flag", () => {
  const c = classify(normalizeRecord(row({ enc: "Observation", discharge: "2026-08-03", dispo: "Home" })));
  assert.equal(c.category, "tcm");
  assert.ok(c.flags.some((f) => /observation/.test(f)));
});

test("classify: emergency and EMS are 'ed' (not TCM-billable)", () => {
  assert.equal(classify(normalizeRecord(row({ enc: "Emergency", discharge: "2026-08-03", dispo: "Home" }))).category, "ed");
  assert.equal(classify(normalizeRecord(row({ enc: "EMS" }))).category, "ed");
});

test("classify: outpatient is 'ambulatory'; expired is 'excluded'", () => {
  assert.equal(classify(normalizeRecord(row({ enc: "Outpatient" }))).category, "ambulatory");
  assert.equal(classify(normalizeRecord(row({ enc: "Inpatient", discharge: "2026-08-03", dispo: "Expired" }))).category, "excluded");
});

test("classify: unusual disposition on a TCM row raises a verify flag", () => {
  const c = classify(normalizeRecord(row({ enc: "Inpatient", discharge: "2026-08-03", dispo: "AA" })));
  assert.equal(c.category, "tcm");
  assert.ok(c.flags.some((f) => /verify disposition/.test(f)));
});

test("addBusinessDays skips weekends (Fri + 2 → Tue)", () => {
  // 2026-01-02 is a Friday.
  const fri = new Date(2026, 0, 2);
  const res = addBusinessDays(fri, 2);
  assert.equal(res.getFullYear(), 2026);
  assert.equal(res.getMonth(), 0);
  assert.equal(res.getDate(), 6); // Mon=5 is 1 business day, Tue=6 is 2
});

test("deadlines: call window, visit windows, and status transitions", () => {
  const d = deadlines("2026-01-02", new Date(2026, 0, 5));
  assert.equal(d.dischargeDate, "2026-01-02");
  assert.equal(d.callBy, "2026-01-06");
  assert.equal(d.callState, "due");
  assert.equal(d.visitBy99496, "2026-01-09");
  assert.equal(d.visitBy99495, "2026-01-16");
  assert.equal(d.daysSince, 3);
  assert.equal(d.windowState, "7");
  assert.equal(d.billable, "99495 or 99496");

  assert.equal(deadlines("2026-01-02", new Date(2026, 0, 6)).callState, "due-today");
  assert.equal(deadlines("2026-01-02", new Date(2026, 0, 7)).callState, "passed");
  assert.equal(deadlines("2026-01-02", new Date(2026, 0, 12)).windowState, "14");
  assert.equal(deadlines("2026-01-02", new Date(2026, 0, 20)).windowState, "closed");
});

test("buildWorklist dedupes, categorizes, sorts, and summarizes", () => {
  const rows = [
    row({ first: "A", last: "Alpha", enc: "Inpatient", discharge: "2026-01-02", dispo: "Home", dob: "1970-01-01" }),
    row({ first: "A", last: "Alpha", enc: "Inpatient", discharge: "2026-01-02", dispo: "Home", dob: "1970-01-01" }), // dup
    row({ first: "B", last: "Bravo", enc: "Emergency", discharge: "2026-01-02", dispo: "Home", dob: "1980-01-01" }),
    row({ first: "C", last: "Charlie", enc: "Outpatient", dob: "1990-01-01" }),
    row({ first: "D", last: "Delta", enc: "Inpatient", dob: "1960-01-01" }), // admitted, no discharge
    row({ first: "E", last: "Echo", enc: "Inpatient", discharge: "2026-01-02", dispo: "Expired", dob: "1950-01-01" }),
  ];
  const { items, stats } = buildWorklist(rows, { today: new Date(2026, 0, 5) });
  assert.equal(items.length, 5); // one duplicate removed
  assert.equal(stats.tcm, 1);
  assert.equal(stats.admitted, 1);
  assert.equal(stats.ed, 1);
  assert.equal(stats.ambulatory, 1);
  assert.equal(stats.excluded, 1);
  assert.equal(items[0].category, "tcm"); // TCM sorts first
  assert.equal(items[0].name, "Alpha, A");
  assert.ok(items[0].dl);
});

test("normalizeRoster maps varied headers, a Name column, and a DOB serial", () => {
  const a = normalizeRoster([{ "Last Name": "Alpha", "First Name": "Ann", "DOB": "1970-01-02", "MRN": "123", "PCP": "Murray" }]);
  assert.deepEqual(a[0], { last: "Alpha", first: "Ann", dob: "1970-01-02", mrn: "123", pcp: "Murray", program: "", name: "Alpha, Ann" });
  const b = normalizeRoster([{ "Patient Name": "Bravo, Bob", "Date of Birth": 25569 }]); // Excel serial → 1970-01-01
  assert.equal(b[0].last, "Bravo");
  assert.equal(b[0].first, "Bob");
  assert.equal(b[0].dob, "1970-01-01");
});

test("matchRoster: exact match, DOB-variant review, and no match", () => {
  const idx = buildRosterIndex(normalizeRoster([
    { "Last Name": "Alpha", "First Name": "Ann", "DOB": "1970-01-02", "MRN": "A1" },
  ]));
  assert.equal(matchRoster({ lastName: "Alpha", firstName: "Ann", dob: "1970-01-02" }, idx).confidence, "match");
  assert.equal(matchRoster({ lastName: "Alpha", firstName: "Annie", dob: "1970-01-02" }, idx).confidence, "review"); // DOB matches, name variant
  assert.equal(matchRoster({ lastName: "Zeta", firstName: "Zed", dob: "1980-01-01" }, idx).onPanel, false);
  assert.equal(matchRoster({ lastName: "Alpha", firstName: "Ann", dob: "1970-01-02" }, idx).mrn, "A1");
});

test("buildWorklist annotates panel membership and stats", () => {
  const rows = [
    row({ first: "Ann", last: "Alpha", enc: "Inpatient", discharge: "2026-01-02", dispo: "Home", dob: "1970-01-02" }),
    row({ first: "Zed", last: "Zeta", enc: "Inpatient", discharge: "2026-01-02", dispo: "Home", dob: "1980-01-01" }),
  ];
  const roster = normalizeRoster([{ "Last Name": "Alpha", "First Name": "Ann", "DOB": "1970-01-02", "MRN": "A1" }]);
  const { items, stats } = buildWorklist(rows, { today: new Date(2026, 0, 5), roster });
  assert.equal(stats.rosterLoaded, true);
  assert.equal(stats.onPanel, 1);
  assert.equal(stats.tcmOnPanel, 1);
  const ann = items.find((i) => i.lastName === "Alpha");
  assert.equal(ann.panel.onPanel, true);
  assert.equal(ann.panel.mrn, "A1");
  assert.equal(items.find((i) => i.lastName === "Zeta").panel.onPanel, false);
});

test("buildWorklist: overdue-call and closed-window stats", () => {
  const rows = [
    row({ first: "F", last: "Foxtrot", enc: "Inpatient", discharge: "2026-01-02", dispo: "Home", dob: "1970-01-01" }),
    row({ first: "G", last: "Golf", enc: "Inpatient", discharge: "2025-12-01", dispo: "Home", dob: "1971-01-01" }),
  ];
  // today far enough that Foxtrot's call is passed but window open, Golf window closed
  const { stats } = buildWorklist(rows, { today: new Date(2026, 0, 10) });
  assert.equal(stats.callsOverdue >= 1, true);
  assert.equal(stats.windowClosed >= 1, true);
});
