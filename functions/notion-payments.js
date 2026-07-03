// Netlify Function: notion-payments.js
// Reads the Payments Notion database
// Environment variables needed in Netlify:
//   NOTION_TOKEN = your Notion integration token
//   NOTION_PAYMENTS_DB = 73cb304d2fef478989871374c4e2bf8f

const NOTION_VERSION = "2022-06-28";
const DB_ID = process.env.NOTION_PAYMENTS_DB || "73cb304d2fef478989871374c4e2bf8f";

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

      const payments = data.results.map((page) => {
        const props = page.properties;
        return {
          id: page.id,
          eraNumber: getText(props["ERA/EOB Number"]),
          payer: getText(props["Payer"]),
          datePaid: getDate(props["Date Paid"]),
          amountBilled: getNumber(props["Amount Billed"]),
          amountAllowed: getNumber(props["Amount Allowed"]),
          amountPaid: getNumber(props["Amount Paid"]),
          adjustmentCode: getText(props["Adjustment Code"]),
          patientBalance: getNumber(props["Patient Balance"]),
          status: getSelect(props["Status"]),
          notes: getText(props["Notes"]),
          createdAt: page.created_time,
        };
      });

      // Calculate payment summary
      const totalBilled = payments.reduce((s, p) => s + (p.amountBilled || 0), 0);
      const totalPaid = payments.reduce((s, p) => s + (p.amountPaid || 0), 0);
      const totalBalance = payments.reduce((s, p) => s + (p.patientBalance || 0), 0);
      const variance = totalBilled - totalPaid - totalBalance;

      // Group by payer
      const byPayer = {};
      payments.forEach((p) => {
        const payer = p.payer || "Unknown";
        if (!byPayer[payer]) byPayer[payer] = { billed: 0, paid: 0, count: 0 };
        byPayer[payer].billed += p.amountBilled || 0;
        byPayer[payer].paid += p.amountPaid || 0;
        byPayer[payer].count++;
      });

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          payments,
          summary: { totalBilled, totalPaid, totalBalance, variance },
          byPayer,
        }),
      };
    }

    // POST - log a new payment/ERA
    if (event.httpMethod === "POST") {
      const payment = JSON.parse(event.body);

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
            "ERA/EOB Number": { title: [{ text: { content: payment.eraNumber || "" } }] },
            "Payer": { rich_text: [{ text: { content: payment.payer || "" } }] },
            "Date Paid": payment.datePaid ? { date: { start: payment.datePaid } } : undefined,
            "Amount Billed": payment.amountBilled ? { number: parseFloat(payment.amountBilled) } : undefined,
            "Amount Allowed": payment.amountAllowed ? { number: parseFloat(payment.amountAllowed) } : undefined,
            "Amount Paid": payment.amountPaid ? { number: parseFloat(payment.amountPaid) } : undefined,
            "Adjustment Code": payment.adjustmentCode ? { rich_text: [{ text: { content: payment.adjustmentCode } }] } : undefined,
            "Patient Balance": payment.patientBalance ? { number: parseFloat(payment.patientBalance) } : undefined,
            "Status": { select: { name: payment.status || "Posted" } },
            "Notes": payment.notes ? { rich_text: [{ text: { content: payment.notes } }] } : undefined,
          },
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        return {
          statusCode: response.status,
          headers,
          body: JSON.stringify({ error: data.message || "Failed to log payment" }),
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
