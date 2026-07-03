// Netlify Function: notion-expenses.js
// Reads and writes to the Expenses Notion database
// Environment variables needed in Netlify:
//   NOTION_TOKEN = your Notion integration token
//   NOTION_EXPENSES_DB = 490eb2d5fd1044d4aa86aa5c2f35bc59

const NOTION_VERSION = "2022-06-28";
const DB_ID = process.env.NOTION_EXPENSES_DB || "490eb2d5fd1044d4aa86aa5c2f35bc59";

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
    // GET - fetch all expenses
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

      const expenses = data.results.map((page) => {
        const props = page.properties;
        return {
          id: page.id,
          description: getText(props["Description"]),
          program: getText(props["Program"]),
          category: getSelect(props["Category"]),
          amount: getNumber(props["Amount"]),
          vendor: getText(props["Vendor"]),
          date: getDate(props["Date"]),
          reference: getText(props["Reference"]),
          createdAt: page.created_time,
        };
      });

      // Calculate totals by program
      const byProgram = {};
      expenses.forEach((e) => {
        const prog = e.program || "Unknown";
        if (!byProgram[prog]) byProgram[prog] = 0;
        byProgram[prog] += e.amount || 0;
      });

      // Calculate totals by category
      const byCategory = {};
      expenses.forEach((e) => {
        const cat = e.category || "Other";
        if (!byCategory[cat]) byCategory[cat] = 0;
        byCategory[cat] += e.amount || 0;
      });

      const total = expenses.reduce((sum, e) => sum + (e.amount || 0), 0);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ expenses, total, byProgram, byCategory }),
      };
    }

    // POST - log a new expense
    if (event.httpMethod === "POST") {
      const expense = JSON.parse(event.body);

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
            "Description": { title: [{ text: { content: expense.description || "" } }] },
            "Program": { rich_text: [{ text: { content: expense.program || "" } }] },
            "Category": { select: { name: expense.category || "Other" } },
            "Amount": expense.amount ? { number: parseFloat(expense.amount) } : undefined,
            "Vendor": expense.vendor ? { rich_text: [{ text: { content: expense.vendor } }] } : undefined,
            "Date": expense.date ? { date: { start: expense.date } } : undefined,
            "Reference": expense.reference ? { rich_text: [{ text: { content: expense.reference } }] } : undefined,
          },
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        return {
          statusCode: response.status,
          headers,
          body: JSON.stringify({ error: data.message || "Failed to log expense" }),
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
