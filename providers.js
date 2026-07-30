/* ============================================================================
 * AWV extraction — parse Annual Wellness Visit status from a Stedi JSON 271.
 * Shared by stedi.js (eligibility). Traditional Medicare (HETS) is the most
 * complete source; Medicare Advantage / commercial vary and may return nothing.
 * The 271 is a PROMPT, not billing proof — AWV pays once per 12 months to the
 * first biller only, so always confirm the interval vs. claims / MAC.
 * ==========================================================================*/

function extractAwv(data) {
  const benefits = (data && data.benefitsInformation) || [];

  const looksAwv = (b) => {
    const hay = [
      b.name,
      (b.serviceTypeCodes || []).join(" "),
      (b.serviceTypes || []).join(" "),
      (b.additionalInformation || []).map((a) => a && a.description).join(" "),
      b.procedureCode || b.procedure || "",
    ].join(" ").toUpperCase();
    if (/G0438|G0439|G0402|G0468|ANNUAL WELLNESS|WELLNESS VISIT|PREVENTIVE/.test(hay)) return true;
    return (b.serviceTypeCodes || []).some((c) => ["EA", "BZ", "81"].includes(c));
  };

  const lines = benefits.filter(looksAwv);
  if (!lines.length) {
    return {
      covered: null, lastDate: null, recommend: null,
      summary: "AWV benefit not returned by this payer’s 271 (common for Medicare Advantage). Confirm via claims / MAC.",
    };
  }

  const lastDate = findAwvDate(lines);
  // Evidence of a PRIOR AWV (a G-code on file or a last-visit date) means the
  // initial is done, so the NEXT visit is the subsequent (G0439). No prior
  // evidence → default to the initial (G0438).
  const hadPriorAwv = lines.some((b) => /G0438|G0439/i.test(JSON.stringify(b))) || !!lastDate;
  const recommend = hadPriorAwv ? "G0439 (subsequent)" : "G0438 (initial)";

  const summary = lastDate
    ? `Last AWV ${lastDate} — next covered ~12 months later. Recommend ${recommend}. Confirm interval before billing.`
    : `AWV is a covered Part B benefit; no last-visit date returned. Recommend ${recommend} — verify the 12-month interval before billing.`;

  return { covered: true, hadPriorAwv, lastDate: lastDate || null, recommend, summary };
}

function findAwvDate(lines) {
  for (const b of lines) {
    const di = b.benefitsDateInformation || {};
    const cand =
      di.lastVisitOrConsultation || di.service || di.serviceStart ||
      di.eligibilityBegin || di.plan || di.date || null;
    if (cand) return formatYmd(cand);
    const txt = (b.additionalInformation || []).map((a) => a && a.description).join(" ");
    const m = txt && txt.match(/(20\d{2})[-/]?(\d{2})[-/]?(\d{2})/);
    if (m) return `${m[2]}/${m[3]}/${m[1]}`;
  }
  return null;
}

function formatYmd(s) {
  const d = String(s).replace(/[-/]/g, "");
  return d.length === 8 ? `${d.slice(4, 6)}/${d.slice(6, 8)}/${d.slice(0, 4)}` : String(s);
}

module.exports = { extractAwv };
