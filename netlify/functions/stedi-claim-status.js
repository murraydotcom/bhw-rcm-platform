// netlify/functions/stedi-claim-status.js
// Real-time claim status inquiry via Stedi (276/277)
// Env vars required: STEDI_KEY_PREFIX, STEDI_KEY_SUFFIX

const STEDI_BASE = "https://healthcare.us.stedi.com/2024-04-01";

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const stediKey = process.env.STEDI_KEY_PREFIX + "." + process.env.STEDI_KEY_SUFFIX;

  try {
    const body = JSON.parse(event.body || "{}");

    const {
      payerId,          // payer ID e.g. "00435"
      memberId,         // patient insurance ID
      firstName,
      lastName,
      dateOfBirth,      // YYYY-MM-DD
      dateOfService,    // YYYY-MM-DD
      claimAmount,      // numeric, billed amount
    } = body;

    if (!payerId || !memberId || !firstName || !lastName || !dateOfBirth || !dateOfService) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "Missing required fields: payerId, memberId, firstName, lastName, dateOfBirth, dateOfService",
        }),
      };
    }

    const claimStatusPayload = {
      controlNumber: Math.floor(Math.random() * 999999999).toString().padStart(9, "0"),
      tradingPartnerServiceId: payerId,
      provider: {
        organizationName: "BHW Medical Group",
        npi: "1841844222",
        taxId: process.env.BHW_TAX_ID || "",
      },
      subscriber: {
        memberId,
        firstName,
        lastName,
        dateOfBirth: dateOfBirth.replace(/-/g, ""),
      },
      claim: {
        serviceDate: dateOfService.replace(/-/g, ""),
        ...(claimAmount && { chargeAmount: claimAmount.toString() }),
      },
    };

    const res = await fetch(`${STEDI_BASE}/claim-status`, {
      method: "POST",
      headers: {
        Authorization: stediKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(claimStatusPayload),
    });

    if (!res.ok) {
      const err = await res.text();
      return { statusCode: res.status, headers, body: JSON.stringify({ error: err }) };
    }

    const data = await res.json();

    // Normalize status for dashboard display
    const claimStatuses = data.claimStatuses || [];
    const summary = claimStatuses.map(cs => ({
      claimStatus: cs.claimStatusCode || null,
      statusDescription: cs.statusCodeValue || null,
      adjudicationDate: cs.claimServiceDate || null,
      checkNumber: cs.checkNumber || null,
      checkDate: cs.checkIssueOrEFTEffectiveDate || null,
      paidAmount: cs.claimPaymentAmount || null,
      denialReasons: cs.serviceLines?.flatMap(sl =>
        (sl.statusDetails || []).map(sd => ({
          code: sd.statusCode,
          description: sd.statusCodeValue,
        }))
      ) || [],
    }));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ claimStatuses: summary, raw: data }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
