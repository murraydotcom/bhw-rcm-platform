// Netlify Function: notion-claims.js
// Reads and writes to the Charges & Claims Notion database
// Environment variables needed in Netlify:
//   NOTION_TOKEN = your Notion integration token
//   NOTION_CLAIMS_DB = a99946bdaca141e8acf9b15603babd4f

const NOTION_VERSION = "2022-06-28";
const DB_ID = process.env.NOTION_CLAIMS_DB || "a99946bdaca141e8acf9b15603babd4f";

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Type": "application/json",
  };

  // Handle preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  const token = process.env.NOTION_TOKEN;
  if (!token) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "NOTION_TOKEN not set in environment variables" }),
    };
  }

  try {
    // GET - fetch all claims
    if (event.httpMethod === "GET") {
      const response = await fetch(
        `https://api.notion.com/v1/databases/${DB_ID}/query`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Notion-Version": NOTION_VERSION,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            sorts: [{ timestamp: "created_time", direction: "descending" }],
            page_size: 100,
          }),
        }
      );

      const data = await response.json();

      if (!response.ok) {
        return {
          statusCode: response.status,
          headers,
          body: JSON.stringify({ error: data.message || "Notion API error" }),
        };
      }

      // Map Notion pages to clean claim objects
      const claims = data.results.map((page) => {
        const props = page.properties;
        return {
          id: page.id,
          claimId: getText(props["Claim ID"]),
          patient: getText(props["Patient Name"]),
          dos: getDate(props["Date of Service"]),
          provider: getText(props["Provider"]),
          program: getText(props["Program"]),
          cpt: getText(props["CPT Codes"]),
          payer: getText(props["Payer"]),
          billed: getNumber(props["Amount Billed"]),
          paid: getNumber(props["Amount Paid"]),
          status: getSelect(props["Status"]),
          denialCode: getText(props["Denial Code"]),
          notes: getText(props["Notes"]),
          createdAt: page.created_time,
        };
      });

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ claims, total: claims.length }),
      };
    }

    // POST - create a new claim
    if (event.httpMethod === "POST") {
      const claim = JSON.parse(event.body);

      const response = await fetch("https://api.notion.com/v1/pages", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          parent: { database_id: DB_ID },
          properties: {
            "Claim ID": { title: [{ text: { content: claim.claimId || "" } }] },
            "Patient Name": { rich_text: [{ text: { content: claim.patient || "" } }] },
            "Date of Service": claim.dos ? { date: { start: claim.dos } } : undefined,
            "Provider": { rich_text: [{ text: { content: claim.provider || "" } }] },
            "Program": { rich_text: [{ text: { content: claim.program || "" } }] },
            "CPT Codes": { rich_text: [{ text: { content: claim.cpt || "" } }] },
            "Payer": { rich_text: [{ text: { content: claim.payer || "" } }] },
            "Amount Billed": claim.billed ? { number: parseFloat(claim.billed) } : undefined,
            "Status": { select: { name: claim.status || "Submitted" } },
            "Notes": claim.notes ? { rich_text: [{ text: { content: claim.notes } }] } : undefined,
          },
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        return {
          statusCode: response.status,
          headers,
          body: JSON.stringify({ error: data.message || "Failed to create claim" }),
        };
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, id: data.id }),
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

// Helper functions to extract Notion property values
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
