// netlify/functions/notion-payments.js
// Reads payments from Notion Payments DB
// Env vars: NOTION_TOKEN, NOTION_PAYMENTS_DB

const NOTION_DB = process.env.NOTION_PAYMENTS_DB;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_BASE = 'https://api.notion.com/v1';

function getDateRange(range) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let start;
  switch (range) {
    case 'month': start = new Date(today.getFullYear(), today.getMonth(), 1); break;
    case 'last30': start = new Date(today); start.setDate(start.getDate() - 30); break;
    case 'quarter': { const q = Math.floor(today.getMonth() / 3); start = new Date(today.getFullYear(), q * 3, 1); break; }
    case 'year': start = new Date(today.getFullYear(), 0, 1); break;
    default: start = null;
  }
  return { start, end: today };
}

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const range = (event.queryStringParameters || {}).range || 'month';
    const { start } = getDateRange(range);

    const filter = start ? {
      property: 'Payment Date',
      date: { on_or_after: start.toISOString().split('T')[0] },
    } : undefined;

    const res = await fetch(`${NOTION_BASE}/databases/${NOTION_DB}/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28',
      },
      body: JSON.stringify({
        page_size: 100,
        sorts: [{ property: 'Payment Date', direction: 'descending' }],
        ...(filter ? { filter } : {}),
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      return { statusCode: res.status, headers, body: JSON.stringify({ error: err }) };
    }

    const data = await res.json();

    const payments = (data.results || []).map(page => {
      const props = page.properties || {};
      const getNum = k => props[k]?.number ?? null;
      const getText = k => props[k]?.rich_text?.[0]?.plain_text ?? props[k]?.title?.[0]?.plain_text ?? null;
      const getSelect = k => props[k]?.select?.name ?? null;
      const getDate = k => props[k]?.date?.start ?? null;

      return {
        id: page.id,
        payer: getText('Payer Name'),
        eraNumber: getText('Check/EFT Number'),
        datePaid: getDate('Payment Date'),
        amountBilled: getNum('Charge'),
        amountAllowed: getNum('Remit Payment'),
        amountPaid: getNum('Claim Payment'),
        status: getText('Remit Remarks'),
        source: getSelect('Source'),
        patient: getText('Patient Name'),
      };
    });

    const totalPaid = payments.reduce((s, p) => s + (p.amountPaid || 0), 0);
    const totalBilled = payments.reduce((s, p) => s + (p.amountBilled || 0), 0);

    // Group by payer for reconciliation view
    const byPayer = {};
    payments.forEach(p => {
      if (!byPayer[p.payer]) byPayer[p.payer] = { payer: p.payer, billed: 0, paid: 0, count: 0 };
      byPayer[p.payer].billed += p.amountBilled || 0;
      byPayer[p.payer].paid += p.amountPaid || 0;
      byPayer[p.payer].count++;
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        payments,
        total: payments.length,
        summary: { totalPaid, totalBilled },
        byPayer: Object.values(byPayer),
        range,
        asOf: new Date().toISOString(),
      }),
    };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
