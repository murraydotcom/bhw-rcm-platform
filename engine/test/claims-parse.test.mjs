/* Tests for engine/claims-parse.mjs — rolling a clearinghouse status export up
 * to an actionable per-claim worklist. All data below is synthetic. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClaims, parseClaimEvents, rollupClaims, CLAIM_STAGE } from "../claims-parse.mjs";

const rec = (o) =>
  `${o.name}  [${o.bhwId}]Status${o.status}Invoice #${o.invoice}Member ID${o.member}Provider Name${o.provider}` +
  `Encounter Date${o.enc}Payer${o.payer}  [${o.payerId}]Provider Tax ID${o.tax}Claim Amount${o.amt}ECT #${o.ect}` +
  `Report Date${o.report}As on Date${o.ason}Status Remarks${o.remarks}Mapped by-Mapped on-Comments-`;

const base = { member: "M1", provider: "Jane Doe", enc: "Jul 24, 2026", payerId: "ENSAK", tax: "999999999", ect: "E1", report: "Jul 27, 2026", ason: "Jul 27, 2026" };

test("parses each labeled status event", () => {
  const ev = parseClaimEvents(rec({ ...base, name: "A Patient", bhwId: "BHW1", status: "Accepted by Clearing House", invoice: "INV1", payer: "Medicaid of Maryland", amt: "200.0", remarks: "ACCEPTED - ECT #: E1 ICH---> Medicaid" }));
  assert.equal(ev.length, 1);
  assert.equal(ev[0].name, "A Patient");
  assert.equal(ev[0].invoice, "INV1");
  assert.equal(ev[0].amount, 200);
  assert.equal(ev[0].payer, "Medicaid of Maryland");
  assert.equal(ev[0].stage, CLAIM_STAGE.CLEARINGHOUSE);
});

test("rolls multiple events for one invoice into a single claim at its furthest stage", () => {
  const text =
    rec({ ...base, name: "B Patient", bhwId: "BHW2", status: "Accepted by Clearing House", invoice: "INV2", payer: "UHC", amt: "150.0", remarks: "ACCEPTED - ECT" }) +
    rec({ ...base, name: "B Patient", bhwId: "BHW2", status: "Acknowledged by Payer", invoice: "INV2", payer: "UHC", amt: "150.0", ason: "Jul 28, 2026", remarks: "CLAIM ACCEPTED; STATUS CODE: A1:19" });
  const { claims, events } = parseClaims(text);
  assert.equal(events.length, 2);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].stage, CLAIM_STAGE.ACKNOWLEDGED);
  assert.equal(claims[0].events, 2);
  assert.equal(claims[0].needsAction, false);
});

test("flags a rejection needing action, with its reason", () => {
  const text = rec({ ...base, name: "C Patient", bhwId: "BHW3", status: "Rejected by Payer", invoice: "INV3", payer: "Riverside Health", payerId: "45281", amt: "160.0", ason: "Jul 22, 2026", remarks: "CLAIM REJECTED; STATUS CODE: A3:33; Subscriber and subscriber id not found." });
  const { claims, summary } = parseClaims(text);
  assert.equal(claims[0].needsAction, true);
  assert.equal(claims[0].stage, CLAIM_STAGE.REJECTED);
  assert.match(claims[0].reason, /subscriber and subscriber id not found/i);
  assert.equal(summary.actionCount, 1);
  assert.equal(summary.actionAmount, 160);
});

test("a rejection later accepted is surfaced but not flagged for action", () => {
  const text =
    rec({ ...base, name: "D Patient", bhwId: "BHW4", status: "Rejected by Payer", invoice: "INV4", payer: "Riverside Health", payerId: "45281", amt: "200.0", ason: "Jul 22, 2026", remarks: "CLAIM REJECTED; A3:21; Missing or invalid information." }) +
    rec({ ...base, name: "D Patient", bhwId: "BHW4", status: "Accepted by Payer", invoice: "INV4", payer: "Riverside Health", payerId: "45281", amt: "200.0", ason: "Jul 22, 2026", remarks: "CLAIM ACCEPTED; A2:20; Accepted into adjudication system." });
  const c = rollupClaims(parseClaimEvents(text))[0];
  assert.equal(c.wasRejected, true);
  assert.equal(c.needsAction, false);        // accepted after the rejection
  assert.equal(c.stage, CLAIM_STAGE.ACCEPTED);
});

test("summary totals count/amount by stage and payer", () => {
  const text =
    rec({ ...base, name: "E", bhwId: "B5", status: "Accepted by Payer", invoice: "INV5", payer: "Medicare Part B of Maryland", payerId: "00901", amt: "150.0", remarks: "A2:20" }) +
    rec({ ...base, name: "F", bhwId: "B6", status: "Rejected by Payer", invoice: "INV6", payer: "Riverside Health", payerId: "45281", amt: "160.0", remarks: "A3:33; not found" });
  const { summary } = parseClaims(text);
  assert.equal(summary.total, 2);
  assert.equal(summary.totalAmount, 310);
  assert.equal(summary.byPayer["Riverside Health"].needsAction, 1);
});
