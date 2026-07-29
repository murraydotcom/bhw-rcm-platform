/* ============================================================================
 * 835 ERA parsing — shared by the polling feed (stedi.js) and the webhook
 * receiver (stedi-webhook.js) so both interpret a remittance identically.
 * Field paths are best-effort; 835 layouts vary by payer — confirm against one
 * real ERA for your payers and tighten as needed.
 * ==========================================================================*/

// One 835 report → a remittance summary row {payer, eraNumber, check, amount, claims, posting}.
function summarizeEra(report, id) {
  const tx = (report.transactions && report.transactions[0]) || {};
  const payments = (tx.detailInfo || []).flatMap((d) => d.paymentInfo || []);
  let total = 0, claims = 0;
  for (const p of payments) {
    const amt = Number(p.claimPaymentInfo && p.claimPaymentInfo.claimPaymentAmount || 0);
    if (!Number.isNaN(amt)) total += amt;
    claims += 1;
  }
  const payer = (payments[0] && payments[0].payer && (payments[0].payer.name || payments[0].payer.organizationName))
    || (tx.payer && tx.payer.name) || "Payer";
  return {
    payer,
    eraNumber: tx.controlNumber || (id ? String(id).slice(0, 8) : ""),
    check: (tx.financialInformation && tx.financialInformation.checkOrEftTraceNumber) || tx.checkNumber || "",
    amount: `$${total.toLocaleString()}`,
    claims: String(claims),
    posting: "auto",
  };
}

// One 835 report → per-claim payment records for posting + reconciliation.
// patientControlNumber correlates to YOUR original claim number.
function claimPayments(report) {
  const tx = (report.transactions && report.transactions[0]) || {};
  const payerName = (tx.payer && tx.payer.name) || "";
  const check = (tx.financialInformation && tx.financialInformation.checkOrEftTraceNumber) || "";
  const out = [];
  for (const d of (tx.detailInfo || [])) {
    for (const p of (d.paymentInfo || [])) {
      const cpi = p.claimPaymentInfo || {};
      const nm = p.patientName || {};
      const patient = (nm.lastName || nm.firstName)
        ? [nm.lastName, nm.firstName].filter(Boolean).join(", ")
        : (nm.name || "");
      out.push({
        patient,
        payer: (p.payer && p.payer.name) || payerName,
        check,
        claimNumber: cpi.patientControlNumber || "",       // your claim id
        payerClaimNumber: cpi.payerClaimControlNumber || "",
        paid: Number(cpi.claimPaymentAmount || 0),
        statusCode: cpi.claimStatusCode || "",
      });
    }
  }
  return out;
}

// One 835 report → the click-to-expand drill-down the dashboard renders:
// [{ claim, patient, billed, allowed, paid, patResp, status,
//    services:[{ cpt, desc, billed, allowed, paid, adjCode, adjDesc, patResp, prCode }] }].
// Shapes match DATA.eraList[i].claims in index.html so live remits expand like the samples.
// Field paths are best-effort — confirm against one real 835 for your payers.
function claimDetail(report) {
  const tx = (report.transactions && report.transactions[0]) || {};
  const out = [];
  for (const d of (tx.detailInfo || [])) {
    for (const p of (d.paymentInfo || [])) {
      const cpi = p.claimPaymentInfo || {};
      const nm = p.patientName || {};
      const patient = (nm.lastName || nm.firstName)
        ? [nm.lastName, nm.firstName].filter(Boolean).join(", ")
        : (nm.name || "");
      const billed = num(cpi.totalClaimChargeAmount, cpi.claimChargeAmount);
      const paid = num(cpi.claimPaymentAmount);
      const patResp = num(cpi.patientResponsibilityAmount);
      // Claim-level adjustments (CARC) — first one surfaces as the row's reason.
      const cadj = firstAdjustment(cpi.claimAdjustments || p.claimAdjustments);
      const lines = p.serviceLines || p.serviceLineInformation || p.serviceInfo || [];
      const services = lines.map((s) => {
        const sp = s.servicePaymentInformation || s.serviceInfo || s;
        const sadj = firstAdjustment(s.serviceAdjustments || s.claimAdjustments || sp.adjustments);
        return {
          cpt: sp.procedureCode || sp.adjudicatedProcedureCode || "",
          desc: sp.procedureDescription || s.description || "",
          billed: num(sp.lineItemChargeAmount, sp.submittedChargeAmount, s.chargeAmount),
          allowed: num(sp.allowedAmount, s.allowedAmount),
          paid: num(sp.lineItemProviderPaymentAmount, sp.paidAmount, s.paidAmount),
          adjCode: sadj.code, adjDesc: sadj.reason,
          patResp: num(sp.patientResponsibilityAmount, s.patientResponsibilityAmount),
          prCode: sadj.group === "PR" ? sadj.code : "",
        };
      });
      out.push({
        claim: cpi.patientControlNumber || "",
        patient, billed, allowed: num(cpi.allowedAmount), paid, patResp,
        status: paid > 0 ? (billed && paid < billed ? "partial" : "paid") : "denied",
        comment: "",
        denialReason: cadj.reason || "",
        services,
      });
    }
  }
  return out;
}

function num(...vals) {
  for (const v of vals) { const n = Number(v); if (v != null && v !== "" && !Number.isNaN(n)) return n; }
  return 0;
}
// Normalize the many shapes a CARC adjustment can take → {group, code, reason}.
function firstAdjustment(adj) {
  if (!adj) return { group: "", code: "", reason: "" };
  const a = Array.isArray(adj) ? adj[0] : adj;
  if (!a) return { group: "", code: "", reason: "" };
  const detail = Array.isArray(a.adjustmentDetails) ? a.adjustmentDetails[0] : (a.adjustmentDetails || a);
  return {
    group: a.claimAdjustmentGroupCode || a.adjustmentGroupCode || a.groupCode || "",
    code: (detail && (detail.adjustmentReasonCode || detail.reasonCode)) || a.adjustmentReasonCode || a.reasonCode || "",
    reason: (detail && (detail.adjustmentReasonDescription || detail.description)) || a.adjustmentReasonDescription || a.description || "",
  };
}

module.exports = { summarizeEra, claimPayments, claimDetail };
