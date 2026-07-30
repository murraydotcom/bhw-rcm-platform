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

/* ============================================================================
 * Stedi GuideJSON 835 (from a core transaction's OUTPUT artifact:
 * https://core.us.stedi.com/2023-08-01/transactions/{id}/output).
 * GuideJSON keys carry segment ids (…_CLP, …_SVC, …_CAS, …_NM1) and element
 * positions (_01, _02…). We locate segments/elements by key SUBSTRING so minor
 * guide-name drift doesn't break parsing.
 * ==========================================================================*/
function _norm(k) { return String(k).toLowerCase().replace(/[^a-z0-9]/g, ""); }
// Every object that CONTAINS a key matching keyTest (keeps sibling access).
function containersWith(node, keyTest, acc) {
  acc = acc || [];
  if (Array.isArray(node)) { for (const n of node) containersWith(n, keyTest, acc); }
  else if (node && typeof node === "object") {
    if (Object.keys(node).some(keyTest)) acc.push(node);
    for (const k in node) containersWith(node[k], keyTest, acc);
  }
  return acc;
}
const hasSeg = (id) => (k) => _norm(k).includes(_norm(id));
// First sub-object whose key includes the segment id (e.g. "CLP").
function subSeg(obj, id) { id = _norm(id); if (obj && typeof obj === "object") for (const k in obj) if (_norm(k).includes(id)) return obj[k]; return null; }
// First element value whose key includes any of the wanted substrings.
function el(obj, ...wants) { if (!obj || typeof obj !== "object") return undefined; const nw = wants.map(_norm); for (const k in obj) { const nk = _norm(k); if (nw.some((w) => nk.includes(w))) return obj[k]; } return undefined; }
function gnum(...v) { for (const x of v) { if (x && typeof x === "object") continue; const n = Number(x); if (x != null && x !== "" && !Number.isNaN(n)) return n; } return 0; }
function bizId(item, element) { const bis = (item && item.businessIdentifiers) || []; const hit = bis.find((b) => String(b.element) === element); return hit ? hit.value : ""; }

function payerFromGuide(rep) {
  for (const c of containersWith(rep, hasSeg("N1"))) {
    const n1 = subSeg(c, "N1");
    if (n1 && String(el(n1, "entityidentifiercode", "_01")) === "PR") { const nm = el(n1, "name", "_02"); if (nm) return nm; }
  }
  return "";
}

function summarizeGuide(rep, item) {
  const bpr = subSeg(containersWith(rep, hasSeg("BPR"))[0], "BPR");
  const total = gnum(el(bpr, "totalactualproviderpaymentamount", "monetaryamount", "_02"));
  const trn = subSeg(containersWith(rep, hasSeg("TRN"))[0], "TRN");
  const check = el(trn, "referenceidentification", "_02") || bizId(item, "TRN-02") || "";
  const clps = containersWith(rep, hasSeg("CLP"));
  const meta = item && item.x12 && item.x12.metadata;
  return {
    payer: payerFromGuide(rep) || "Payer",
    eraNumber: (meta && meta.transaction && meta.transaction.controlNumber) || "",
    check: String(check || ""),
    amount: `$${Math.round(total).toLocaleString()}`,
    claims: String(clps.length),
    posting: "auto",
    date: (meta && meta.functionalGroup && meta.functionalGroup.date) || undefined,
  };
}

function claimDetailGuide(rep) {
  return containersWith(rep, hasSeg("CLP")).map((c) => {
    const clp = subSeg(c, "CLP");
    let nm1 = null;
    for (const nc of containersWith(c, hasSeg("NM1"))) {
      const n = subSeg(nc, "NM1");
      if (n && ["QC", ""].includes(String(el(n, "entityidentifiercode", "_01") || ""))) { nm1 = n; break; }
      if (!nm1 && n) nm1 = n;
    }
    const patient = [el(nm1, "namelastororganizationname", "_03"), el(nm1, "namefirst", "_04")].filter(Boolean).join(", ");
    const billed = gnum(el(clp, "totalclaimchargeamount", "_03"));
    const paid = gnum(el(clp, "claimpaymentamount", "_04"));
    const patResp = gnum(el(clp, "patientresponsibilityamount", "_05"));
    const services = containersWith(c, hasSeg("SVC")).map((sc) => {
      const svc = subSeg(sc, "SVC");
      const comp = el(svc, "compositemedicalprocedureidentifier", "_01");
      const cpt = (comp && typeof comp === "object") ? el(comp, "procedurecode", "_02") : comp;
      const cas = subSeg(sc, "CAS");
      const grp = cas ? el(cas, "claimadjustmentgroupcode", "_01") : "";
      const rc = cas ? el(cas, "adjustmentreasoncode", "_02") : "";
      return { cpt: String(cpt || ""), desc: "", billed: gnum(el(svc, "lineitemchargeamount", "_02")), allowed: 0,
        paid: gnum(el(svc, "lineitemproviderpaymentamount", "_03")),
        adjCode: rc ? String((grp ? grp + "-" : "") + rc) : "", adjDesc: "", patResp: 0, prCode: grp === "PR" ? String(rc || "") : "" };
    });
    return { claim: el(clp, "claimsubmitteridentifier", "claimsubmittersidentifier", "_01") || "", patient,
      billed, allowed: 0, paid, patResp, status: paid > 0 ? (billed && paid < billed ? "partial" : "paid") : "denied",
      comment: "", services };
  });
}

module.exports = { summarizeEra, claimPayments, claimDetail, summarizeGuide, claimDetailGuide };
