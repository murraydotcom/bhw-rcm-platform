// netlify/functions/stedi-eras.js
// Retrieves 835 ERA transactions from Stedi
// Env vars required: STEDI_KEY_PREFIX, STEDI_KEY_SUFFIX

const STEDI_BASE = "https://healthcare.us.stedi.com/2024-04-01";

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  const stediKey = process.env.STEDI_KEY_PREFIX + "." + process.env.STEDI_KEY_SUFFIX;

  try {
    const params = event.queryStringParameters || {};

    // If a specific transactionId is passed, retrieve that single ERA
    if (params.transactionId) {
      const res = await fetch(
        `${STEDI_BASE}/electronic-remittance-advice/${params.transactionId}`,
        { headers: { Authorization: stediKey } }
      );
      if (!res.ok) {
        const err = await res.text();
        return { statusCode: res.status, headers, body: JSON.stringify({ error: err }) };
      }
      const data = await res.json();
      return { statusCode: 200, headers, body: JSON.stringify(data) };
    }

    // Otherwise poll for transactions — default to July 1 2026 start (when ERAs began)
    const startDateTime = params.startDateTime || "2026-07-01T00:00:00Z";
    const pollUrl = new URL(`${STEDI_BASE}/transactions`);
    pollUrl.searchParams.set("startDateTime", startDateTime);
    // Filter to 835 ERAs only
    pollUrl.searchParams.set("transactionSetIdentifier", "835");
    if (params.pageToken) pollUrl.searchParams.set("pageToken", params.pageToken);

    const pollRes = await fetch(pollUrl.toString(), {
      headers: { Authorization: stediKey },
    });

    if (!pollRes.ok) {
      const err = await pollRes.text();
      return { statusCode: pollRes.status, headers, body: JSON.stringify({ error: err }) };
    }

    const pollData = await pollRes.json();

    // For each transaction, fetch the full ERA detail
    const transactions = pollData.transactions || [];
    const eras = await Promise.all(
      transactions.map(async (tx) => {
        try {
          const eraRes = await fetch(
            `${STEDI_BASE}/electronic-remittance-advice/${tx.transactionId}`,
            { headers: { Authorization: stediKey } }
          );
          if (!eraRes.ok) return { transactionId: tx.transactionId, error: "fetch failed" };
          return await eraRes.json();
        } catch {
          return { transactionId: tx.transactionId, error: "network error" };
        }
      })
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        eras,
        nextPageToken: pollData.nextPageToken || null,
        total: eras.length,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
