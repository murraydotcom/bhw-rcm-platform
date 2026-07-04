// Netlify Function: stedi-eligibility.js
// Hits Stedi 270/271 API for real-time insurance eligibility verification
// Environment variables needed in Netlify:
//   STEDI_API_KEY = your Stedi API key
//   NOTION_TOKEN = your Notion integration token
//   NOTION_INSURANCE_DB = 6bf580758d30828098a101e533cbed4d

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
    // POST - run eligibility check
    if (event.httpMethod === "POST") {
      const { patient, dob, memberId, payer, tradingPartnerId } = JSON.parse(event.body);

      // Build Stedi 270 eligibility request
      const stediPayload = {
        controlNumber: Math.floor(Math.random() * 999999999).toString().padStart(9, "0"),
        tradingPartnerServiceId: tradingPartnerId || payer,
        provider: {
          organizationName: "BHW Medical Group",
          npi: "1841844222",
          taxId: process.env.BHW_TAX_ID || "",
        },
        subscriber: {
          firstName: patient.split(" ")[0] || "",
          lastName: patient.split(" ").slice(1).join(" ") || "",
          dateOfBirth: dob ? dob.replace(/-/g, "") : "",
          memberId: memberId || "",
          groupNumber: "",
        },
        encounter: {
          serviceTypeCodes: ["30"],
          dateRange: {
            start: new Date().toISOString().split("T")[0].replace(/-/g, ""),
          },
        },
      };

      const stediResponse = await fetch(
        "https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/eligibility/v3",
        {
          method: "POST",
          headers: {
            Authorization: `Key ${stediKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(stediPayload),
        }
      );

      const stediData = await stediResponse.json();

      if (!stediResponse.ok) {
        return {
          statusCode: stediResponse.status,
          headers,
          body: JSON.stringify({
            error: stediData.message || "Stedi eligibility check failed",
            details: stediData,
          }),
        };
      }

      // Extract key eligibility info from response
      const result = {
        eligible: true,
        patientName: `${stediData.subscriber?.firstName || ""} ${stediData.subscriber?.lastName || ""}`.trim(),
        memberId: stediData.subscriber?.memberId || memberId,
        payer: stediData.payer?.name || payer,
        planName: stediData.planInformation?.planDescription || "",
        groupNumber: stediData.subscriber?.groupNumber || "",
        deductible: extractBenefit(stediData, "deductible"),
        deductibleMet: extractBenefit(stediData, "deductibleMet"),
        copay: extractBenefit(stediData, "copay"),
        coinsurance: extractBenefit(stediData, "coinsurance"),
        outOfPocketMax: extractBenefit(stediData, "outOfPocketMax"),
        outOfPocketMet: extractBenefit(stediData, "outOfPocketMet"),
        inNetwork: true,
        checkedAt: new Date().toISOString(),
        rawResponse: stediData,
      };

      // Save verification result to Notion Insurance Verification database
      if (notionToken) {
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
              "Patient Name": { title: [{ text: { content: patient || "" } }] },
              "Payer": { rich_text: [{ text: { content: payer || "" } }] },
              "Member ID": { rich_text: [{ text: { content: memberId || "" } }] },
              "Verification Date": { date: { start: new Date().toISOString().split("T")[0] } },
              "Status": { select: { name: result.eligible ? "Eligible" : "Not Eligible" } },
              "Plan Name": { rich_text: [{ text: { content: result.planName } }] },
              "Deductible": result.deductible ? { number: parseFloat(result.deductible) } : undefined,
              "Copay": result.copay ? { number: parseFloat(result.copay) } : undefined,
            },
          }),
        });
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(result),
      };
    }

    // GET - fetch past verification history from Notion
    if (event.httpMethod === "GET") {
      if (!notionToken) {
        return {
          statusCode: 500,
          headers,
          body: JSON.stringify({ error: "NOTION_TOKEN not set" }),
        };
      }

      const response = await fetch(
        `https://api.notion.com/v1/databases/${INSURANCE_DB_ID}/query`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${notionToken}`,
            "Notion-Version": NOTION_VERSION,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            sorts: [{ timestamp: "created_time", direction: "descending" }],
            page_size: 50,
          }),
        }
      );

      const data = await response.json();

      const verifications = data.results.map((page) => {
        const props = page.properties;
        return {
          id: page.id,
          patient: getText(props["Patient Name"]),
          payer: getText(props["Payer"]),
          memberId: getText(props["Member ID"]),
          date: getDate(props["Verification Date"]),
          status: getSelect(props["Status"]),
          planName: getText(props["Plan Name"]),
          deductible: getNumber(props["Deductible"]),
          copay: getNumber(props["Copay"]),
        };
      });

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ verifications }),
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

function extractBenefit(data, type) {
  try {
    const benefits = data.benefitsInformation || [];
    const match = benefits.find((b) =>
      b.name?.toLowerCase().includes(type.toLowerCase())
    );
    return match?.benefitAmount || match?.benefitPercent || null;
  } catch {
    return null;
  }
}

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
}      const response = await fetch(
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

      let payments = data.results.map((page) => {
        const props = page.properties;
        return {
          id: page.id,
          eraNumber: getAny(props, ["Payment Record", "Batch / ERA ID", "Claim #"]),
          batchId: getAny(props, ["Batch / ERA ID"]),
          patient: getAny(props, ["Patient Name"]),
          payer: getAny(props, ["Payer Name", "Payer"]),
          datePaid: getAnyDate(props, ["Date Paid", "Payment Date", "Deposit Date"]),
          amountBilled: getAnyNumber(props, ["Amount Billed", "Expected Amount", "Charge", "Charged"]),
          amountAllowed: getAnyNumber(props, ["Amount Allowed"]),
          amountPaid: getAnyNumber(props, ["Amount Paid", "Payment Amount", "Payment Amt", "Claim Payment"]),
          adjustmentCode: getAny(props, ["Adjustment Code"]),
          patientBalance: getAnyNumber(props, ["Patient Balance", "Patient Resp"]),
          status: getAnySelect(props, ["Workflow Status", "Reconciliation Status", "Status"]),
          checkTraceNum: getAny(props, ["Check / Trace #"]),
          claimCount: getAnyNumber(props, ["Claim Count"]),
          paymentMethod: getAny(props, ["Payment Method"]),
          paymentSource: getAny(props, ["Payment Source"]),
          notes: getAny(props, ["Notes"]),
          createdAt: page.created_time,
        };
      });

      const { start, end, label } = getDateRange(range);
      if (range !== "all") {
        payments = payments.filter((p) => {
          const dateStr = p.datePaid || p.createdAt;
          if (!dateStr) return false;
          const d = new Date(dateStr);
          return d >= start && d <= end;
        });
      }

      const totalBilled = payments.reduce((s, p) => s + (p.amountBilled || 0), 0);
      const totalPaid = payments.reduce((s, p) => s + (p.amountPaid || 0), 0);
      const totalBalance = payments.reduce((s, p) => s + (p.patientBalance || 0), 0);
      const variance = totalBilled - totalPaid - totalBalance;

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
          range: { key: range, label, start: start?.toISOString(), end: end?.toISOString() },
          summary: { totalBilled, totalPaid, totalBalance, variance },
          byPayer,
          debugColumns,
        }),
      };
    }

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
            "Payer Name": { rich_text: [{ text: { content: payment.payer || "" } }] },
            "Date Paid": payment.datePaid ? { date: { start: payment.datePaid } } : undefined,
            "Amount Billed": payment.amountBilled ? { number: parseFloat(payment.amountBilled) } : undefined,
            "Amount Paid": payment.amountPaid ? { number: parseFloat(payment.amountPaid) } : undefined,
            "Status": { select: { name: payment.status || "Posted" } },
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
