// Netlify Function: notion-denials.js
// Reads the Denials Notion database
// Supports date-range filtering: week, month, quarter, year, all
// Environment variables needed in Netlify:
//   NOTION_TOKEN = your Notion integration token
//   NOTION_DENIALS_DB = 2e0a41c66b5b4c78b1391e4ba726b400

const NOTION_VERSION = "2022-06-28";
const DB_ID = process.env.NOTION_DENIALS_DB || "2e0a41c66b5b4c78b1391e4ba726b400";

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

      let denials = data.results.map((page) => {
        const props = page.properties;
        return {
          id: page.id,
          claimId: getAny(props, ["Claim #", "Patient Ctrl No.", "Patient Ctl No"]),
          patient: getAny(props, ["Patient Name"]),
          memberId: getAny(props, ["Member ID"]),
          cpt: getAny(props, ["HCPCS/CPT"]),
          program: getAny(props, ["Program"]),
          payer: getAny(props, ["Payer Name"]),
          amount: getAnyNumber(props, ["Charge", "Charged"]),
          paymentAmount: getAnyNumber(props, ["Payment Amount", "Payment Amt", "Claim Payment"]),
          status: getAnySelect(props, ["Status", "Claim Status Code"]),
          denialReason: getAny(props, ["Denial Reason"]),
          remitStatus: getAnySelect(props, ["Remit Status"]),
          remitRemarks: getAny(props, ["Remit Remarks"]),
          rendering: getAny(props, ["Rendering Provider", "Billing Provider Name"]),
          dateOfService: getAnyDate(props, ["Note Date", "Create Date"]),
          createdAt: page.created_time,
        };
      });

      const { start, end, label } = getDateRange(range);
      if (range !== "all") {
        denials = denials.filter((d) => {
          const dateStr = d.dateOfService || d.createdAt;
          if (!dateStr) return false;
          const dt = new Date(dateStr);
          return dt >= start && dt <= end;
        });
      }

      const byCode = {};
      denials.forEach((d) => {
        const code = d.denialReason || "Unknown";
        if (!byCode[code]) byCode[code] = { count: 0, total: 0 };
        byCode[code].count++;
        byCode[code].total += d.amount || 0;
      });

      const totalDenied = denials.reduce((sum, d) => sum + (d.amount || 0), 0);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          denials,
          byCode,
          totalDenied,
          range: { key: range, label, start: start?.toISOString(), end: end?.toISOString() },
          debugColumns,
        }),
      };
    }

    if (event.httpMethod === "POST") {
      const denial = JSON.parse(event.body);

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
            "Patient Ctrl No.": { title: [{ text: { content: denial.claimId || "" } }] },
            "Patient Name": { rich_text: [{ text: { content: denial.patient || "" } }] },
            "Payer Name": { rich_text: [{ text: { content: denial.payer || "" } }] },
            "Denial Reason": { rich_text: [{ text: { content: denial.denialReason || "" } }] },
            "Charge": denial.amount ? { number: parseFloat(denial.amount) } : undefined,
          },
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        return {
          statusCode: response.status,
          headers,
          body: JSON.stringify({ error: data.message || "Failed to log denial" }),
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

function getDateRange(range) {
  const now = new Date();
  let start, end, label;

  if (range === "week") {
    const day = now.getDay();
    const diff = day >= 2 ? day - 2 : day + 5;
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
