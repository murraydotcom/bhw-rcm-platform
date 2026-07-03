// Netlify Function: notion-denials.js
// Reads the Denials Notion database
// Environment variables needed in Netlify:
//   NOTION_TOKEN = your Notion integration token
//   NOTION_DENIALS_DB = 33581e499fb24e02a0db85f936fd1f57

const NOTION_VERSION = "2022-06-28";
const DB_ID = process.env.NOTION_DENIALS_DB || "33581e499fb24e02a0db85f936fd1f57";

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

      const denials = data.results.map((page) => {
        const props = page.properties;
        return {
          id: page.id,
          claimId: getText(props["Claim ID"]),
          patient: getText(props["Patient Name"]),
          denialCode: getText(props["Denial Code"]),
          denialReason: getText(props["Denial Reason"]),
          payer: getText(props["Payer"]),
          amount: getNumber(props["Amount"]),
          dos: getDate(props["Date of Service"]),
          appealStatus: getSelect(props["Appeal Status"]),
          appealDeadline: getDate(props["Appeal Deadline"]),
          notes: getText(props["Notes"]),
          createdAt: page.created_time,
        };
      });

      // Summarize by denial code
      const byCode = {};
      denials.forEach((d) => {
        const code = d.denialCode || "Unknown";
        if (!byCode[code]) byCode[code] = { count: 0, total: 0 };
        byCode[code].count++;
        byCode[code].total += d.amount || 0;
      });

      const totalDenied = denials.reduce((sum, d) => sum + (d.amount || 0), 0);
      const appealsPending = denials.filter((d) => d.appealStatus === "Submitted" || d.appealStatus === "In Progress").length;

      // Flag urgent ones - appeal deadline within 14 days
      const today = new Date();
      const urgent = denials.filter((d) => {
        if (!d.appealDeadline) return false;
        const deadline = new Date(d.appealDeadline);
        const daysLeft = Math.ceil((deadline - today) / (1000 * 60 * 60 * 24));
        return daysLeft <= 14 && daysLeft >= 0;
      }).map((d) => {
        const deadline = new Date(d.appealDeadline);
        const daysLeft = Math.ceil((deadline - today) / (1000 * 60 * 60 * 24));
        return { ...d, daysLeft };
      });

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          denials,
          byCode,
          totalDenied,
          appealsPending,
          urgent,
        }),
      };
    }

    // POST - log a new denial
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
            "Claim ID": { title: [{ text: { content: denial.claimId || "" } }] },
            "Patient Name": { rich_text: [{ text: { content: denial.patient || "" } }] },
            "Denial Code": { rich_text: [{ text: { content: denial.denialCode || "" } }] },
            "Denial Reason": { rich_text: [{ text: { content: denial.denialReason || "" } }] },
            "Payer": { rich_text: [{ text: { content: denial.payer || "" } }] },
            "Amount": denial.amount ? { number: parseFloat(denial.amount) } : undefined,
            "Appeal Status": { select: { name: denial.appealStatus || "Not Started" } },
            "Appeal Deadline": denial.appealDeadline ? { date: { start: denial.appealDeadline } } : undefined,
            "Notes": denial.notes ? { rich_text: [{ text: { content: denial.notes } }] } : undefined,
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
