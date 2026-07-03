Netlify Function: notion-claims.js
// Reads and writes to the Charges & Claims Notion database
// Supports date-range filtering: week, month, quarter, year, all
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
    if (event.httpMethod === "GET") {
      // Read range param: week | month | quarter | year | all (default: all)
      const params = event.queryStringParameters || {};
      const range = params.range || "all";
 
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
 
      const debugColumns = data.results[0] ? Object.keys(data.results[0].properties) : [];
 
      let claims = data.results.map((page) => {
        const props = page.properties;
        return {
          id: page.id,
          claimId: getAny(props, ["Claim #", "Patient Ctrl No.", "Patient Ctl No", "Claim ID"]),
          patient: getAny(props, ["Patient Name"]),
          memberId: getAny(props, ["Member ID"]),
          dos: getAnyDate(props, ["Date of Service", "Note Date", "Create Date"]),
          dob: getAnyDate(props, ["Patient DOB"]),
          provider: getAny(props, ["Rendering Provider", "Billing Provider Name"]),
          renderingNPI: getAny(props, ["Rendering NPI"]),
          program: getAny(props, ["Program"]),
          cpt: getAny(props, ["HCPCS/CPT"]),
          payer: getAny(props, ["Payer Name"]),
          payee: getAny(props, ["Payee Name"]),
          billed: getAnyNumber(props, ["Charge", "Charged"]),
          paid: getAnyNumber(props, ["Payment Amount", "Payment Amt", "Claim Payment"]),
          patientResp: getAnyNumber(props, ["Patient Resp"]),
          status: getAnySelect(props, ["Status", "Claim Status Code"]),
          claimType: getAnySelect(props, ["Claim Type"]),
          denialReason: getAny(props, ["Denial Reason"]),
          remitStatus: getAnySelect(props, ["Remit Status"]),
          remitRemarks: getAny(props, ["Remit Remarks"]),
          paymentMethod: getAny(props, ["Payment Method"]),
          checkEFT: getAny(props, ["Check/EFT No", "Check/EFT Number"]),
          createdAt: page.created_time,
        };
      });
 
      // Apply date range filter based on Date of Service, falling back to createdAt
      const { start, end, label } = getDateRange(range);
      if (range !== "all") {
        claims = claims.filter((c) => {
          const dateStr = c.dos || c.createdAt;
          if (!dateStr) return false;
          const d = new Date(dateStr);
          return d >= start && d <= end;
        });
      }
 
      // Summary totals for the filtered range
      const totalBilled = claims.reduce((s, c) => s + (c.billed || 0), 0);
      const totalPaid = claims.reduce((s, c) => s + (c.paid || 0), 0);
 
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          claims,
          total: claims.length,
          range: { key: range, label, start: start?.toISOString(), end: end?.toISOString() },
          summary: { totalBilled, totalPaid },
          debugColumns,
        }),
      };
    }
 
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
            "Patient Ctrl No.": { title: [{ text: { content: claim.claimId || "" } }] },
            "Patient Name": { rich_text: [{ text: { content: claim.patient || "" } }] },
            "Program": { rich_text: [{ text: { content: claim.program || "" } }] },
            "HCPCS/CPT": { rich_text: [{ text: { content: claim.cpt || "" } }] },
            "Payer Name": { rich_text: [{ text: { content: claim.payer || "" } }] },
            "Charge": claim.billed ? { number: parseFloat(claim.billed) } : undefined,
            "Status": { select: { name: claim.status || "Submitted" } },
            "Date of Service": claim.dos ? { date: { start: claim.dos } } : undefined,
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
 
// Calculate date range boundaries. Fiscal year = calendar year (Jan-Dec).
// Billing week = Tuesday through Monday.
function getDateRange(range) {
  const now = new Date();
  let start, end, label;
 
  if (range === "week") {
    const day = now.getDay(); // 0=Sun...6=Sat
    const diff = day >= 2 ? day - 2 : day + 5; // days since last Tuesday
    start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(now.getDate() - diff);
    end = new Date(start);
    end.setDate(start.getDate() + 6);
    end.setHours(23, 59, 59, 999);
    label = `Week of ${start.toDateString()}`;
  } else if (range === "month") {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
    end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    label = start.toLocaleString("default", { month: "long", year: "numeric" });
  } else if (range === "quarter") {
    const q = Math.floor(now.getMonth() / 3);
    start = new Date(now.getFullYear(), q * 3, 1);
    end = new Date(now.getFullYear(), q * 3 + 3, 0, 23, 59, 59, 999);
    label = `Q${q + 1} ${now.getFullYear()}`;
  } else if (range === "year") {
    start = new Date(now.getFullYear(), 0, 1);
    end = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
    label = `${now.getFullYear()}`;
  } else {
    start = null;
    end = null;
    label = "All time";
  }
 
  return { start, end, label };
}
 
function getAny(props, names) {
  for (const name of names) {
    const prop = props[name];
    if (!prop) continue;
    if (prop.type === "title" && prop.title?.length) return prop.title.map((t) => t.plain_text).join("");
    if (prop.type === "rich_text" && prop.rich_text?.length) return prop.rich_text.map((t) => t.plain_text).join("");
  }
  return "";
}
 
function getAnyDate(props, names) {
  for (const name of names) {
    const prop = props[name];
    if (prop?.type === "date" && prop.date?.start) return prop.date.start;
  }
  return null;
}
 
function getAnyNumber(props, names) {
  for (const name of names) {
    const prop = props[name];
    if (prop?.type === "number" && prop.number !== null && prop.number !== undefined) return prop.number;
  }
  return null;
}
 
function getAnySelect(props, names) {
  for (const name of names) {
    const prop = props[name];
    if (prop?.type === "select" && prop.select?.name) return prop.select.name;
    if (prop?.type === "status" && prop.status?.name) return prop.status.name;
  }
  return null;
}
 
