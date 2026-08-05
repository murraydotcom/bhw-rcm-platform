// Netlify Function: stedi-eligibility.js
// Hits Stedi 270/271 API for real-time insurance eligibility verification.
//
// v1.1 changes (AWV / preventive):
//   • Requests preventive service type "EA" (+ keeps "30") so the 271 returns
//     Annual Wellness Visit benefit lines. NOTE: "88" is pharmacy and "12" is
//     durable medical equipment — neither is preventive. EA / BZ / 81 are.
//   • Parses AWV signal from the 271 → result.awv (string) + result.awvDetail.
//   • Accepts both field styles: {patient} OR {first,last}; {memberId} OR
//     {member}; {serviceType} OR {serviceTypeCodes}.
//
// Environment variables needed in Netlify:
//   STEDI_API_KEY (or STEDI_KEY_PREFIX + STEDI_KEY_SUFFIX)
//   NOTION_TOKEN
//   NOTION_INSURANCE_DB = 6bf580758d30828098a101e533cbed4d

const NOTION_VERSION = "2022-06-28";
const INSURANCE_DB_ID = process.env.NOTION_INSURANCE_DB || "6bf580758d30828098a101e533cbed4d";

exports.handler = async (event) => {

  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  const _auth = require("./lib/auth").requireAuth(event);
  if (!_auth.ok) return _auth.response;

  const stediKey = process.env.STEDI_KEY_PREFIX && process.env.STEDI_KEY_SUFFIX
    ? `${process.env.STEDI_KEY_PREFIX}.${process.env.STEDI_KEY_SUFFIX}`
    : process.env.STEDI_API_KEY;
  const notionToken = process.env.NOTION_TOKEN;

  if (!stediKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Stedi API key not set. Add STEDI_KEY_PREFIX and STEDI_KEY_SUFFIX to Netlify environment variables." }),
    };
  }

  try {
    // POST - run eligibility check
    if (event.httpMethod === "POST") {
      const body = JSON.parse(event.body);
      const {
        patient, dob, memberId, payer, tradingPartnerId, billingEntity,
        // command-center field aliases + AWV controls
        first, last, member, serviceType, serviceTypeCodes, includeAwv,
      } = body;

      // Accept either "Last, First" in `patient` or discrete first/last.
      const fullName = patient || [last, first].filter(Boolean).join(", ");
      const memId = memberId || member || "";

      const BILLING_ENTITIES = {
        bhw: { organizationName: "BALTIMORE HEALTHCARE AND WELLNESS LLC", npi: "1306511597", taxId: "872107587" },
        amaris: { organizationName: "AMARIS P MURRAY", npi: "1841844222", taxId: "853802386" },
        addiction: { organizationName: "BHW ADDICTION MANAGEMENT", npi: "1114626363", taxId: "932227140" },
      };
      const providerInfo = BILLING_ENTITIES[billingEntity] || BILLING_ENTITIES.bhw;

      // --- Service type codes -------------------------------------------------
      // Map an incoming serviceType string ("EA — Preventive services (AWV)")
      // to its leading code, or take an explicit array. Always include "30" for
      // a complete response; add "EA" whenever AWV/preventive detail is wanted.
      const requested = Array.isArray(serviceTypeCodes) && serviceTypeCodes.length
        ? serviceTypeCodes
        : serviceType ? [String(serviceType).trim().split(/[\s—–-]+/)[0]] : [];
      const wantAwv = !!includeAwv || requested.some((c) => ["EA", "BZ", "81"].includes(c));
      const codes = Array.from(new Set(["30", ...requested, ...(wantAwv ? ["EA"] : [])]));

      // Build Stedi 270 eligibility request
      const stediPayload = {
        controlNumber: Math.floor(Math.random() * 999999999).toString().padStart(9, "0"),
        tradingPartnerServiceId: tradingPartnerId || payer,
        provider: {
          organizationName: providerInfo.organizationName,
          npi: providerInfo.npi,
          taxId: providerInfo.taxId,
        },
        subscriber: {
          firstName: first || parseFirstName(fullName),
          lastName: last || parseLastName(fullName),
          dateOfBirth: dob ? dob.replace(/-/g, "") : "",
          memberId: memId,
          groupNumber: "",
        },
        encounter: {
          serviceTypeCodes: codes,
          dateOfService: new Date().toISOString().split("T")[0].replace(/-/g, ""),
        },
      };

      const stediResponse = await fetch(
        "https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/eligibility/v3",
        {
          method: "POST",
          headers: {
            Authorization: `Key ${stediKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(stediPayload),
        }
      );

      const stediData = await stediResponse.json();

      if (!stediResponse.ok) {
        return {
          statusCode: stediResponse.status,
          headers,
          body: JSON.stringify({
            error: stediData.message || "Stedi eligibility check failed",
            details: stediData,
          }),
        };
      }

      // AWV signal parsed from the 271 (best-effort — see extractAwv notes).
      const awvInfo = extractAwv(stediData);

      // Extract key eligibility info from response
      const result = {
        eligible: true,
        patientName: `${stediData.subscriber?.firstName || ""} ${stediData.subscriber?.lastName || ""}`.trim(),
        memberId: stediData.subscriber?.memberId || memId,
        payer: stediData.payer?.name || payer,
        planName: stediData.planInformation?.planDescription || "",
        groupNumber: stediData.subscriber?.groupNumber || "",
        deductible: extractBenefit(stediData, "deductible"),
        deductibleMet: extractBenefit(stediData, "deductibleMet"),
        copay: extractBenefit(stediData, "copay"),
        coinsurance: extractBenefit(stediData, "coinsurance"),
        outOfPocketMax: extractBenefit(stediData, "outOfPocketMax"),
        outOfPocketMet: extractBenefit(stediData, "outOfPocketMet"),
        inNetwork: true,
        awv: awvInfo.summary,          // string the dashboard renders inline
        awvDetail: awvInfo,            // structured detail for the AWV table
        checkedAt: new Date().toISOString(),
        rawResponse: stediData,
      };

      // Save verification result to Notion Insurance Verification database
      if (notionToken) {
        await fetch("https://api.notion.com/v1/pages", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${notionToken}`,
            "Notion-Version": NOTION_VERSION,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            parent: { database_id: INSURANCE_DB_ID },
            properties: {
              "Patient Name": { title: [{ text: { content: fullName || "" } }] },
              "Payer": { rich_text: [{ text: { content: payer || "" } }] },
              "Member ID": { rich_text: [{ text: { content: memId || "" } }] },
              "Verification Date": { date: { start: new Date().toISOString().split("T")[0] } },
              "Status": { select: { name: result.eligible ? "Eligible" : "Not Eligible" } },
              "Plan Name": { rich_text: [{ text: { content: result.planName } }] },
              "Deductible": result.deductible ? { number: parseFloat(result.deductible) } : undefined,
              "Copay": result.copay ? { number: parseFloat(result.copay) } : undefined,
              // Optional: add an "AWV" rich_text property to this Notion DB to persist it.
              // "AWV": { rich_text: [{ text: { content: result.awv || "" } }] },
            },
          }),
        });
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(result),
      };
    }

    // GET - fetch past verification history from Notion
    if (event.httpMethod === "GET") {
      if (!notionToken) {
        return {
          statusCode: 500,
          headers,
          body: JSON.stringify({ error: "NOTION_TOKEN not set" }),
        };
      }

      const response = await fetch(
        `https://api.notion.com/v1/databases/${INSURANCE_DB_ID}/query`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${notionToken}`,
            "Notion-Version": NOTION_VERSION,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            sorts: [{ timestamp: "created_time", direction: "descending" }],
            page_size: 50,
          }),
        }
      );

      const data = await response.json();

      const verifications = data.results.map((page) => {
        const props = page.properties;
        return {
          id: page.id,
          patient: getText(props["Patient Name"]),
          payer: getText(props["Payer"]),
          memberId: getText(props["Member ID"]),
          date: getDate(props["Verification Date"]),
          status: getSelect(props["Status"]),
          planName: getText(props["Plan Name"]),
          deductible: getNumber(props["Deductible"]),
          copay: getNumber(props["Copay"]),
        };
      });

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ verifications }),
      };
    }

    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};

// BHW's convention is "Last, First" (e.g. "STOKES, RUBY") throughout Notion and paper records.
// Also handle plain "First Last" as a fallback in case someone types it that way.
function parseLastName(patient) {
  if (!patient) return "";
  if (patient.includes(",")) {
    return patient.split(",")[0].trim();
  }
  const parts = patient.trim().split(" ");
  return parts.length > 1 ? parts.slice(1).join(" ") : parts[0];
}

function parseFirstName(patient) {
  if (!patient) return "";
  if (patient.includes(",")) {
    return patient.split(",").slice(1).join(",").trim();
  }
  const parts = patient.trim().split(" ");
  return parts[0];
}

function extractBenefit(data, type) {
  try {
    const benefits = data.benefitsInformation || [];
    const match = benefits.find((b) =>
      b.name?.toLowerCase().includes(type.toLowerCase())
    );
    return match?.benefitAmount || match?.benefitPercent || null;
  } catch {
    return null;
  }
}

// --- AWV extraction ---------------------------------------------------------
// Best-effort parse of Annual Wellness Visit status from a Stedi JSON 271.
// Traditional Medicare (HETS) is the most complete source; Medicare Advantage
// and commercial plans vary and may return nothing here. The 271 is a PROMPT,
// not billing proof — AWV pays once per 12 months to the first biller only, so
// always confirm the interval against claims / your MAC before billing.
// Refine the field paths below once you see a real Medicare 271 for your payers.
function extractAwv(data) {
  const benefits = data.benefitsInformation || [];

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
      covered: null,
      lastDate: null,
      recommend: null,
      summary: "AWV benefit not returned by this payer’s 271 (common for Medicare Advantage). Confirm via claims / MAC.",
    };
  }

  const lastDate = findAwvDate(lines);
  // Evidence of a PRIOR AWV (a G-code on file or a last-visit date) means the
  // patient's initial is done, so the NEXT visit is the subsequent (G0439).
  // No prior evidence → default to the initial (G0438).
  const hadPriorAwv = lines.some((b) => /G0438|G0439/i.test(JSON.stringify(b))) || !!lastDate;
  const recommend = hadPriorAwv ? "G0439 (subsequent)" : "G0438 (initial)";

  const summary = lastDate
    ? `Last AWV ${lastDate} — next covered ~12 months later. Recommend ${recommend}. Confirm interval before billing.`
    : `AWV is a covered Part B benefit; no last-visit date returned. Recommend ${recommend} — verify the 12-month interval before billing.`;

  return { covered: true, hadPriorAwv, lastDate: lastDate || null, recommend, summary };
}

// Pull a date out of the benefit's date information, whatever qualifier Stedi used.
function findAwvDate(lines) {
  for (const b of lines) {
    const di = b.benefitsDateInformation || {};
    const cand =
      di.lastVisitOrConsultation || di.service || di.serviceStart ||
      di.eligibilityBegin || di.plan || di.date || null;
    if (cand) return formatYmd(cand);
    // some responses tuck a date into additionalInformation text
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

function getText(prop) {
  if (!prop) return "";
  if (prop.type === "title") return prop.title?.map((t) => t.plain_text).join("") || "";
  if (prop.type === "rich_text") return prop.rich_text?.map((t) => t.plain_text).join("") || "";
  return "";
}

function getDate(prop) {
  if (!prop || prop.type !== "date") return null;
  return prop.date?.start || null;
}

function getNumber(prop) {
  if (!prop || prop.type !== "number") return null;
  return prop.number || null;
}

function getSelect(prop) {
  if (!prop || prop.type !== "select") return null;
  return prop.select?.name || null;
}
