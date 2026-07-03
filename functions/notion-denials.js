// Netlify Function: notion-denials.js
// Reads the Denials Notion database (dedicated denial workflow database)
// Supports date-range filtering: week, month, quarter, year, all
// Environment variables needed in Netlify:
//   NOTION_TOKEN = your Notion integration token
//   NOTION_DENIALS_DB = 13b57fe4edbd497fa988d32ec5131aae

const NOTION_VERSION = "2022-06-28";
const DB_ID = process.env.NOTION_DENIALS_DB || "13b57fe4edbd497fa988d32ec5131aae";

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
          denialId: getTitle(props["Denial ID"]),
          originalClaimNum: getNumber(props["Original Claim #"]),
          patient: getText(props["Patient Name"]),
          denialDate: getDate(props["Denial Date"]),
          dos: getDate(props["Date of Service"]),
          appealDeadline: getDate(props["Appeal Deadline"]),
          appealSubmittedDate: getDate(props["Appeal Submitted Date"]),
          resolutionDate: getDate(props["Resolution Date"]),
          chargedAmount: getNumber(props["Charged Amount"]),
          deniedAmount: getNumber(props["Denied Amount"]),
          recoveredAmount: getNumber(props["Recovered Amount"]),
          status: getStatus(props["Status"]),
          denialReason: getSelect(props["Denial Reason"]),
          program: getSelect(props["Program"]),
          cpt: getText(props["HCPCS/CPT Code"]),
          payer: getText(props["Payer Name"]),
          remitRemarks: getText(props["Remit Remarks"]),
          assignedTo: getPeople(props["Assigned To"]),
          actionNotes: getText(props["Action Notes"]),
          createdAt: page.created_time,
        };
      });

      const { start, end, label } = getDateRange(range);
      if (range !== "all") {
        denials = denials.filter((d) => {
          const dateStr = d.denialDate || d.dos || d.createdAt;
          if (!dateStr) return false;
          const dt = new Date(dateStr);
          return dt >= start && dt <= end;
        });
      }

      // Summarize by denial reason
      const byReason = {};
      denials.forEach((d) => {
        const reason = d.denialReason || "Unclassified";
        if (!byReason[reason]) byReason[reason] = { count: 0, total: 0 };
        byReason[reason].count++;
        byReason[reason].total += d.deniedAmount || 0;
      });

      // Summarize by program
      const byProgram = {};
      denials.forEach((d) => {
        const prog = d.program || "Unassigned";
        if (!byProgram[prog]) byProgram[prog] = { count: 0, total: 0 };
        byProgram[prog].count++;
        byProgram[prog].total += d.deniedAmount || 0;
      });

      const totalDenied = denials.reduce((sum, d) => sum + (d.deniedAmount || 0), 0);
      const totalRecovered = denials.reduce((sum, d) => sum + (d.recoveredAmount || 0), 0);
      const openCount = denials.filter((d) =>
        ["New", "Under Review", "Appeal Prepared", "Appeal Submitted"].includes(d.status)
      ).length;

      // Flag urgent: appeal deadline within 14 days and not yet submitted/resolved
      const today = new Date();
      const urgent = denials
        .filter((d) => {
          if (!d.appealDeadline) return false;
          if (["Overturned", "Upheld", "Written Off"].includes(d.status)) return false;
          const deadline = new Date(d.appealDeadline);
          const daysLeft = Math.ceil((deadline - today) / (1000 * 60 * 60 * 24));
          return daysLeft <= 14;
        })
        .map((d) => {
          const deadline = new Date(d.appealDeadline);
          const daysLeft = Math.ceil((deadline - today) / (1000 * 60 * 60 * 24));
          return { ...d, daysLeft };
        })
        .sort((a, b) => a.daysLeft - b.daysLeft);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          denials,
          byReason,
          byProgram,
          totalDenied,
          totalRecovered,
          openCount,
          urgent,
          range: { key: range, label, start: start?.toISOString(), end: end?.toISOString() },
          debugColumns,
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
            "Denial ID": { title: [{ text: { content: denial.denialId || "DEN-" + Date.now().toString().slice(-6) } }] },
            "Patient Name": { rich_text: [{ text: { content: denial.patient || "" } }] },
            "Payer Name": { rich_text: [{ text: { content: denial.payer || "" } }] },
            "HCPCS/CPT Code": { rich_text: [{ text: { content: denial.cpt || "" } }] },
            "Denial Reason": denial.denialReason ? { select: { name: denial.denialReason } } : undefined,
            "Program": denial.program ? { select: { name: denial.program } } : undefined,
            "Status": { status: { name: denial.status || "New" } },
            "Denied Amount": denial.deniedAmount ? { number: parseFloat(denial.deniedAmount) } : undefined,
            "Charged Amount": denial.chargedAmount ? { number: parseFloat(denial.chargedAmount) } : undefined,
            "Denial Date": denial.denialDate ? { date: { start: denial.denialDate } } : undefined,
            "Appeal Deadline": denial.appealDeadline ? { date: { start: denial.appealDeadline } } : undefined,
            "Action Notes": denial.actionNotes ? { rich_text: [{ text: { content: denial.actionNotes } }] } : undefined,
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

function getTitle(prop) {
  if (!prop || prop.type !== "title") return "";
  return prop.title?.map((t) => t.plain_text).join("") || "";
}

function getText(prop) {
  if (!prop || prop.type !== "rich_text") return "";
  return prop.rich_text?.map((t) => t.plain_text).join("") || "";
}

function getNumber(prop) {
  if (!prop || prop.type !== "number") return null;
  return prop.number;
}

function getDate(prop) {
  if (!prop || prop.type !== "date") return null;
  return prop.date?.start || null;
}

function getSelect(prop) {
  if (!prop || prop.type !== "select") return null;
  return prop.select?.name || null;
}

function getStatus(prop) {
  if (!prop) return null;
  if (prop.type === "status") return prop.status?.name || null;
  if (prop.type === "select") return prop.select?.name || null;
  return null;
}

function getPeople(prop) {
  if (!prop || prop.type !== "people") return [];
  return prop.people?.map((p) => p.name || p.id) || [];
}
