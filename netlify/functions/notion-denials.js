// netlify/functions/notion-denials.js
// Reads denied claims from Notion Claims DB (where Remit Remarks has a value = denial code)
// Env vars: NOTION_TOKEN, NOTION_CLAIMS_DB

const NOTION_DB = process.env.NOTION_CLAIMS_DB;
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

    // Filter: has a denial reason (Remit Remarks not empty) AND within date range
    const dateFilter = start ? {
      property: 'Payment Date',
      date: { on_or_after: start.toISOString().split('T')[0] },
    } : null;

    const denialFilter = {
      property: 'Remit Remarks',
      rich_text: { is_not_empty: true },
    };

    const filter = dateFilter ? {
      and: [denialFilter, dateFilter],
    } : denialFilter;

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
        filter,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      return { statusCode: res.status, headers, body: JSON.stringify({ error: err }) };
    }

    const data = await res.json();

    const denials = (data.results || []).map(page => {
      const props = page.properties || {};
      const getNum = k => props[k]?.number ?? null;
      const getText = k => props[k]?.rich_text?.[0]?.plain_text ?? props[k]?.title?.[0]?.plain_text ?? null;
      const getSelect = k => props[k]?.select?.name ?? null;
      const getDate = k => props[k]?.date?.start ?? null;

      return {
        id: page.id,
        denialId: getText('Patient Ctl No'),
        patient: getText('Patient Name'),
        payer: getText('Payer Name'),
        dos: getDate('Payment Date'),
        cpt: getText('HCPCS/CPT'),
        denialReason: getText('Remit Remarks'),
        deniedAmount: getNum('Charge'),
        status: getSelect('Status') || 'New',
        source: getSelect('Source'),
      };
    });

    // Tally by denial code for breakdown chart
    const byCode = {};
    let totalDenied = 0;
    denials.forEach(d => {
      const code = d.denialReason || 'Unknown';
      if (!byCode[code]) byCode[code] = { code, count: 0, amount: 0 };
      byCode[code].count++;
      byCode[code].amount += d.deniedAmount || 0;
      totalDenied += d.deniedAmount || 0;
    });

    const breakdown = Object.values(byCode)
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 10);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        denials,
        total: denials.length,
        totalDenied,
        breakdown,
        range,
        asOf: new Date().toISOString(),
      }),
    };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
