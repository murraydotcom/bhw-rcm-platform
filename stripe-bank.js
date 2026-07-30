// Netlify Function: stedi-discovery.js
// Stedi Insurance Discovery — find a patient's ACTIVE coverage from demographics
// (no member ID needed). Great for self-pay / uninsured and for finding hidden
// secondary coverage. Endpoint: insurance-discovery/check/v1.
//
//   POST  → run a discovery check
//   GET   → recent discovery history (stub → sampleMode until a store is wired)
//
// Env: STEDI_API_KEY (or STEDI_KEY_PREFIX + STEDI_KEY_SUFFIX)

const { provider } = require("./lib/providers");
const DISCOVERY_URL = "https://healthcare.us.stedi.com/2024-04-01/insurance-discovery/check/v1";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };

  const stediKey = (process.env.STEDI_KEY_PREFIX && process.env.STEDI_KEY_SUFFIX)
    ? `${process.env.STEDI_KEY_PREFIX}.${process.env.STEDI_KEY_SUFFIX}`
    : process.env.STEDI_API_KEY;

  try {
    // GET → recent discoveries. No discovery store yet — keep the dashboard on
    // its sample table. Persist runs to a Notion DB later and read them here.
    if (event.httpMethod === "GET") return json(200, { ok: true, sampleMode: true });

    if (event.httpMethod === "POST") {
      if (!stediKey) return json(200, { ok: true, sampleMode: true, error: "STEDI_API_KEY not set" });

      const b = JSON.parse(event.body || "{}");
      const { first, last, dob, sex, zip, dos, ssn4, billingEntity, address1, city, state } = b;
      const prov = provider(billingEntity);
      const svc = (dos || new Date().toISOString().split("T")[0]).replace(/-/g, "");

      // Sensitive identifiers travel in the POST body only. Stedi strongly
      // recommends SSN for matching; we send the last-4 the front desk collects.
      const payload = {
        provider: { npi: prov.npi },
        encounter: { beginningDateOfService: svc, endDateOfService: svc },
        subscriber: {
          firstName: first || "",
          lastName: last || "",
          dateOfBirth: dob ? dob.replace(/-/g, "") : "",
          ...(ssn4 ? { ssn: String(ssn4).replace(/\D/g, "") } : {}),
          ...(sex ? { gender: /^m/i.test(sex) ? "M" : /^f/i.test(sex) ? "F" : "U" } : {}),
          // Only send an address when a street line is actually present — Stedi rejects
          // an empty address1 (must be 1–55 chars). Discovery still matches on SSN + name + DOB.
          ...(address1 && address1.trim()
            ? { address: { address1: address1.trim(), city: city || "", state: state || "", ...(zip ? { postalCode: zip } : {}) } }
            : {}),
        },
      };

      const r = await fetch(DISCOVERY_URL, {
        method: "POST",
        headers: { Authorization: `Key ${stediKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await r.json();
      if (!r.ok) return json(r.status, { ok: false, error: data.message || "Discovery failed", details: data });

      const item = (data.items || [])[0];
      if (!item || data.coveragesFound === 0) {
        return json(200, { ok: true, sampleMode: false, result: { found: false }, status: data.status });
      }

      const bi = item.benefitsInformation || [];
      const planLine = bi.find((x) => x.name && !/active coverage/i.test(x.name));
      const result = {
        found: true,
        payer: (item.payer && item.payer.name) || "",
        memberId: (item.subscriber && item.subscriber.memberId) || "",
        plan: (planLine && planLine.name) || "Active coverage",
        coverageStart: null,
        confidence: (item.confidence && item.confidence.level) || "",
        note: (item.confidence && item.confidence.level === "REVIEW_NEEDED")
          ? "Match needs review — verify patient identity, then confirm benefits in Eligibility before billing."
          : "Confirm benefits in Eligibility before billing.",
      };
      return json(200, { ok: true, sampleMode: false, result, status: data.status, coveragesFound: data.coveragesFound });
    }

    return json(405, { error: "Method not allowed" });
  } catch (err) {
    return json(500, { ok: false, error: err.message });
  }
};

function json(statusCode, obj) { return { statusCode, headers: CORS, body: JSON.stringify(obj) }; }
