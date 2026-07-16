// netlify/functions/stedi-eligibility.js
// Real-time insurance eligibility verification via Stedi (270/271)
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

    // Required fields from dashboard
    const {
      payerId,           // e.g. "00435" for CareFirst
      memberId,          // patient insurance ID
      dateOfBirth,       // YYYY-MM-DD
      firstName,
      lastName,
      dateOfService,     // YYYY-MM-DD (optional, defaults to today)
      serviceType,       // e.g. "30" for health benefit plan coverage
    } = body;

    if (!payerId || !memberId || !dateOfBirth || !firstName || !lastName) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Missing required fields: payerId, memberId, dateOfBirth, firstName, lastName" }),
      };
    }

    const today = new Date().toISOString().split("T")[0];

    const eligibilityPayload = {
      controlNumber: Math.floor(Math.random() * 999999999).toString().padStart(9, "0"),
      tradingPartnerServiceId: payerId,
      provider: {
        organizationName: "BHW Medical Group",
        npi: "1841844222",
        serviceProviderNumber: "6141153",
      },
      subscriber: {
        memberId,
        firstName,
        lastName,
        dateOfBirth: dateOfBirth.replace(/-/g, ""),
      },
      encounter: {
        serviceTypeCodes: [serviceType || "30"],
        dateRange: {
          start: (dateOfService || today).replace(/-/g, ""),
        },
      },
    };

    const res = await fetch(`${STEDI_BASE}/eligibility`, {
      method: "POST",
      headers: {
        Authorization: stediKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(eligibilityPayload),
    });

    if (!res.ok) {
      const err = await res.text();
      return { statusCode: res.status, headers, body: JSON.stringify({ error: err }) };
    }

    const data = await res.json();

    // Extract key fields for dashboard display
    const summary = {
      raw: data,
      eligible: data.benefitsInformation?.some(b => b.code === "1") || false,
      planName: data.planInformation?.planDescription || null,
      groupNumber: data.benefitsInformation?.find(b => b.groupNumber)?.groupNumber || null,
      copay: data.benefitsInformation?.find(b => b.name === "Co-Payment" && b.serviceTypeCodes?.includes("98"))?.benefitAmount || null,
      deductible: data.benefitsInformation?.find(b => b.name === "Deductible" && b.coverageLevelCode === "FAM")?.benefitAmount || null,
      coveredUntil: data.planDateInformation?.planEnd || null,
    };

    return { statusCode: 200, headers, body: JSON.stringify(summary) };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
