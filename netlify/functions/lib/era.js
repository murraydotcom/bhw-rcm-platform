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

module.exports = { summarizeEra, claimPayments };
