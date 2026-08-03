/* Tests for engine/auth-span.mjs — authorization span tracking + Carelon PBHS
 * determination turnaround times. Values track the manual's standard time
 * frames and the March 1–4 continued-stay example. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { trackAuthSpan, decisionTimeframe, parseDay, SPAN_STATUS } from "../auth-span.mjs";

const TF = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "data", "carelon-auth-timeframes.json"), "utf8"));

test("parseDay normalizes ISO and US formats to the same UTC day", () => {
  assert.equal(parseDay("2026-03-04"), parseDay("03/04/2026"));
  assert.equal(parseDay(""), null);
});

test("manual example: span Mar 1–4, continued-stay due by the last authorized day (Mar 4)", () => {
  const r = trackAuthSpan({ startDate: "2026-03-01", endDate: "2026-03-04", asOf: "2026-03-02" }, TF);
  assert.equal(r.renewalDueBy, "2026-03-04");
  assert.equal(r.totalDays, 4);         // inclusive span length
  assert.equal(r.daysRemaining, 2);     // Mar 2 → Mar 4
});

test("status transitions: future → active → expiring → expired", () => {
  const span = { startDate: "2026-03-01", endDate: "2026-03-30" };
  assert.equal(trackAuthSpan({ ...span, asOf: "2026-02-20" }, TF).status, SPAN_STATUS.FUTURE);
  assert.equal(trackAuthSpan({ ...span, asOf: "2026-03-10" }, TF).status, SPAN_STATUS.ACTIVE);
  assert.equal(trackAuthSpan({ ...span, asOf: "2026-03-26" }, TF).status, SPAN_STATUS.EXPIRING); // ≤7 days left
  assert.equal(trackAuthSpan({ ...span, asOf: "2026-04-05" }, TF).status, SPAN_STATUS.EXPIRED);
});

test("30/14/7-day reminder tiers are computed off the last authorized day", () => {
  const r = trackAuthSpan({ startDate: "2026-03-01", endDate: "2026-04-30", asOf: "2026-03-15" }, TF);
  const byTier = Object.fromEntries(r.reminders.map((x) => [x.tier, x.date]));
  assert.equal(byTier[30], "2026-03-31");
  assert.equal(byTier[14], "2026-04-16");
  assert.equal(byTier[7], "2026-04-23");
});

test("determination turnaround is surfaced from the request type", () => {
  const r = trackAuthSpan({ startDate: "2026-03-01", endDate: "2026-03-04", asOf: "2026-03-02", requestType: "prospective_urgent" }, TF);
  assert.equal(r.decision.determinationDays, 3);
  assert.ok(r.notes.some((n) => /72 hours/i.test(n)));
  assert.equal(decisionTimeframe("retrospective", TF).determinationDays, 30);
});

test("missing end date is handled without throwing (unknown status)", () => {
  const r = trackAuthSpan({ startDate: "2026-03-01" }, TF);
  assert.equal(r.valid, false);
  assert.equal(r.status, SPAN_STATUS.UNKNOWN);
});

test("expired span notes that a new authorization is required", () => {
  const r = trackAuthSpan({ startDate: "2026-03-01", endDate: "2026-03-04", asOf: "2026-03-10" }, TF);
  assert.equal(r.status, SPAN_STATUS.EXPIRED);
  assert.ok(r.notes.some((n) => /lapsed|required/i.test(n)));
});
