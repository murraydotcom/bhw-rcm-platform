// Netlify Function: notion-expenses.js
// Reads and writes to the Expenses Notion database
// Supports date-range filtering: week, month, quarter, year, all
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

      let expenses = data.results.map((page) => {
        const props = page.properties;
        return {
          id: page.id,
          description: getAny(props, ["Description"]),
          program: getAny(props, ["Program"]),
          category: getAnySelect(props, ["Category"]),
          amount: getAnyNumber(props, ["Amount"]),
          vendor: getAny(props, ["Vendor"]),
          date: getAnyDate(props, ["Date"]),
          reference: getAny(props, ["Reference"]),
          createdAt: page.created_time,
        };
      });

      const { start, end, label } = getDateRange(range);
      if (range !== "all") {
        expenses = expenses.filter((e) => {
          const dateStr = e.date || e.createdAt;
          if (!dateStr) return false;
          const d = new Date(dateStr);
          return d >= start && d <= end;
        });
      }

      const byProgram = {};
      expenses.forEach((e) => {
        const prog = e.program || "Unknown";
        if (!byProgram[prog]) byProgram[prog] = 0;
        byProgram[prog] += e.amount || 0;
      });

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
        body: JSON.stringify({
          expenses,
          total,
          byProgram,
          byCategory,
          range: { key: range, label, start: start?.toISOString(), end: end?.toISOString() },
          debugColumns,
        }),
      };
    }

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
