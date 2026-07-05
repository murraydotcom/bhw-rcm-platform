// Netlify Function: stedi-discovery.js
// Runs a Stedi Insurance Discovery check to find unknown active coverage for self-pay patients
// Different from stedi-eligibility.js - this searches by demographics rather than checking a known payer
// Environment variables needed in Netlify:
//   STEDI_KEY_PREFIX / STEDI_KEY_SUFFIX (or STEDI_API_KEY) = your Stedi API key
//   NOTION_TOKEN = your Notion integration token
//   NOTION_INSURANCE_DB = 6bf580758d30828098a101e533cbed4d
//
// IMPORTANT: For best results, enroll each billing NPI with Stedi's DISCOVERY payer ID first.
// This is a one-time setup step in the Stedi portal under Enrollments - it improves match quality,
// especially for Medicare. Discovery works without it but with lower confidence results.

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
    // POST - submit a new discovery check
    if (event.httpMethod === "POST") {
      const {
        firstName, lastName, middleName, dob, ssn, gender,
        address1, city, state, postalCode,
        npi, dateOfService,
      } = JSON.parse(event.body);

      if (!firstName || !lastName || !dob) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: "First name, last name, and date of birth are required." }),
        };
      }

      const dos = dateOfService ? dateOfService.replace(/-/g, "") : new Date().toISOString().split("T")[0].replace(/-/g, "");

      const discoveryPayload = {
        provider: {
          npi: npi || "1306511597",
        },
        subscriber: {
          firstName,
          lastName,
          ...(middleName ? { middleName } : {}),
          dateOfBirth: dob.replace(/-/g, ""),
          ...(ssn ? { ssn: ssn.replace(/\D/g, "") } : {}),
          ...(gender ? { gender } : {}),
          ...(address1 || city || state || postalCode
            ? {
                address: {
                  ...(address1 ? { address1 } : {}),
                  ...(city ? { city } : {}),
                  ...(state ? { state } : {}),
                  ...(postalCode ? { postalCode } : {}),
                },
              }
            : {}),
        },
        encounter: {
          beginningDateOfService: dos,
          endDateOfService: dos,
        },
      };

      const stediResponse = await fetch(
        "https://healthcare.us.stedi.com/2024-04-01/insurance-discovery/check/v1",
        {
          method: "POST",
          headers: {
            Authorization: `Key ${stediKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(discoveryPayload),
        }
      );

      const stediData = await stediResponse.json();

      if (!stediResponse.ok) {
        return {
          statusCode: stediResponse.status,
          headers,
          body: JSON.stringify({ error: stediData.message || "Stedi discovery check failed", details: stediData }),
        };
      }

      // If still processing, return the discoveryId so the frontend can poll for results
      if (stediData.status === "PENDING" || !stediData.items) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            status: "PENDING",
            discoveryId: stediData.discoveryId,
            message: "Discovery check still processing. Poll again in a few seconds using the discoveryId.",
          }),
        };
      }

      const items = (stediData.items || []).map((item) => ({
        payer: item.payer?.name || "Unknown payer",
        memberId: item.subscriber?.memberId || "",
        groupNumber: item.planInformation?.groupNumber || "",
        planDescription: item.planInformation?.groupDescription || "",
        planBegin: item.planDateInformation?.planBegin || null,
        eligibilityBegin: item.planDateInformation?.eligibilityBegin || null,
        matchConfidence: item.matchConfidence?.confidenceLevel || "Unknown",
        matchReason: item.matchConfidence?.confidenceReason || "",
      }));

      // Save each found coverage result to Notion Insurance Verification database
      if (notionToken && items.length) {
        for (const item of items) {
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
                "Patient Name": { title: [{ text: { content: `${lastName}, ${firstName}` } }] },
                "Payer": { rich_text: [{ text: { content: item.payer } }] },
                "Member ID": { rich_text: [{ text: { content: item.memberId } }] },
                "Verification Date": { date: { start: new Date().toISOString().split("T")[0] } },
                "Status": { select: { name: "Discovery Match" } },
                "Plan Name": { rich_text: [{ text: { content: item.planDescription } }] },
              },
            }),
          });
        }
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          status: "COMPLETE",
          discoveryId: stediData.discoveryId,
          matchCount: items.length,
          items,
        }),
      };
    }

    // GET - poll for results using a discoveryId from a previous PENDING response
    if (event.httpMethod === "GET") {
      const params = event.queryStringParameters || {};
      const discoveryId = params.discoveryId;

      if (!discoveryId) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: "Missing discoveryId query parameter" }),
        };
      }

      const stediResponse = await fetch(
        `https://healthcare.us.stedi.com/2024-04-01/insurance-discovery/check/v1/${discoveryId}`,
        {
          method: "GET",
          headers: { Authorization: `Key ${stediKey}` },
        }
      );

      const stediData = await stediResponse.json();

      if (!stediResponse.ok) {
        return {
          statusCode: stediResponse.status,
          headers,
          body: JSON.stringify({ error: stediData.message || "Failed to retrieve discovery results" }),
        };
      }

      if (stediData.status === "PENDING") {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ status: "PENDING", discoveryId }),
        };
      }

      const items = (stediData.items || []).map((item) => ({
        payer: item.payer?.name || "Unknown payer",
        memberId: item.subscriber?.memberId || "",
        groupNumber: item.planInformation?.groupNumber || "",
        planDescription: item.planInformation?.groupDescription || "",
        matchConfidence: item.matchConfidence?.confidenceLevel || "Unknown",
      }));

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ status: "COMPLETE", discoveryId, matchCount: items.length, items }),
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
