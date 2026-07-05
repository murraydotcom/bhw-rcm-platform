// Netlify Function: notion-expenses.js
// Reads and writes to the Expenses Notion database
// This database mirrors a bank transaction export: Date, Description, Amount, Category, Receipt, Asset, Card, Note, Tags, Split
// Handles Amount/Category as either proper Notion types OR plain text (common after CSV import)
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
    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
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
      const debugTypes = data.results[0]
        ? Object.fromEntries(Object.entries(data.results[0].properties).map(([k, v]) => [k, v.type]))
        : {};

      let expenses = data.results.map((page) => {
        const props = page.properties;
        return {
          id: page.id,
          description: getFlexText(props["Description"]),
          program: getFlexText(props["Program"]),
          category: getFlexCategory(props["Category"]),
          amount: getFlexNumber(props["Amount"]),
          vendor: getFlexText(props["Vendor"]) || getFlexText(props["Description"]),
          date: getFlexDate(props["Date"]),
          card: getFlexText(props["Card"]),
          note: getFlexText(props["Note"]),
          reference: getFlexText(props["Reference"]),
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
        const prog = e.program || "Unassigned";
        if (!byProgram[prog]) byProgram[prog] = 0;
        byProgram[prog] += Math.abs(e.amount || 0);
      });

      const byCategory = {};
      expenses.forEach((e) => {
        const cat = e.category || "Uncategorized";
        if (!byCategory[cat]) byCategory[cat] = 0;
        byCategory[cat] += Math.abs(e.amount || 0);
      });

      // Amounts from bank exports are typically negative for spend - use absolute value for totals
      const total = expenses.reduce((sum, e) => sum + Math.abs(e.amount || 0), 0);

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
          debugTypes,
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
            "Amount": expense.amount ? { number: -Math.abs(parseFloat(expense.amount)) } : undefined,
            "Category": { select: { name: expense.category || "Other" } },
            "Date": expense.date ? { date: { start: expense.date } } : undefined,
            "Program": expense.program ? { rich_text: [{ text: { content: expense.program } }] } : undefined,
            "Note": expense.vendor ? { rich_text: [{ text: { content: expense.vendor } }] } : undefined,
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

    // PATCH - update Program and/or Category on an existing expense (inline dropdown edit)
    if (event.httpMethod === "PATCH") {
      const { id, program, category } = JSON.parse(event.body);
      if (!id) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing expense id" }) };
      }

      const properties = {};
      if (program !== undefined) {
        properties["Program"] = { rich_text: [{ text: { content: program || "" } }] };
      }
      if (category !== undefined) {
        properties["Category"] = { select: { name: category || "Other" } };
      }

      let patchResponse = await fetch(`https://api.notion.com/v1/pages/${id}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ properties }),
      });

      let patchData = await patchResponse.json();

      // If Category is actually a rich_text field in this database, select will fail - retry as text
      if (!patchResponse.ok && category !== undefined) {
        properties["Category"] = { rich_text: [{ text: { content: category || "" } }] };
        patchResponse = await fetch(`https://api.notion.com/v1/pages/${id}`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
            "Notion-Version": NOTION_VERSION,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ properties }),
        });
        patchData = await patchResponse.json();
      }

      if (!patchResponse.ok) {
        return { statusCode: patchResponse.status, headers, body: JSON.stringify({ error: patchData.message || "Failed to update expense" }) };
      }

      return { statusCode: 200, headers, body: JSON.stringify({ success: true, id: patchData.id }) };
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
  } else if (range === "last30") {
    end = new Date(now);
    end.setHours(23, 59, 59, 999);
    start = new Date(now);
    start.setDate(now.getDate() - 30);
    start.setHours(0, 0, 0, 0);
    label = "Last 30 days";
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

// Flexible getters: handle the property whether Notion stored it as its "proper" type
// or as plain text/rich_text (common after CSV import auto-detection)

function getFlexText(prop) {
  if (!prop) return "";
  if (prop.type === "title" && prop.title?.length) return prop.title.map((t) => t.plain_text).join("");
  if (prop.type === "rich_text" && prop.rich_text?.length) return prop.rich_text.map((t) => t.plain_text).join("");
  return "";
}

function getFlexDate(prop) {
  if (!prop) return null;
  if (prop.type === "date" && prop.date?.start) return prop.date.start;
  if (prop.type === "rich_text" && prop.rich_text?.length) {
    const txt = prop.rich_text.map((t) => t.plain_text).join("");
    const parsed = new Date(txt);
    if (!isNaN(parsed)) return parsed.toISOString().split("T")[0];
  }
  return null;
}

function getFlexNumber(prop) {
  if (!prop) return null;
  if (prop.type === "number" && prop.number !== null && prop.number !== undefined) return prop.number;
  if (prop.type === "formula" && prop.formula?.type === "number") return prop.formula.number;
  if (prop.type === "rich_text" && prop.rich_text?.length) {
    const txt = prop.rich_text.map((t) => t.plain_text).join("").replace(/[^0-9.\-]/g, "");
    const parsed = parseFloat(txt);
    if (!isNaN(parsed)) return parsed;
  }
  if (prop.type === "title" && prop.title?.length) {
    const txt = prop.title.map((t) => t.plain_text).join("").replace(/[^0-9.\-]/g, "");
    const parsed = parseFloat(txt);
    if (!isNaN(parsed)) return parsed;
  }
  return null;
}

function getFlexCategory(prop) {
  if (!prop) return null;
  if (prop.type === "select" && prop.select?.name) return prop.select.name;
  if (prop.type === "multi_select" && prop.multi_select?.length) return prop.multi_select.map((s) => s.name).join(", ");
  if (prop.type === "status" && prop.status?.name) return prop.status.name;
  if (prop.type === "rich_text" && prop.rich_text?.length) return prop.rich_text.map((t) => t.plain_text).join("");
  return null;
}
