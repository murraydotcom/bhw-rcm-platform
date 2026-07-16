// netlify/functions/notion-claims.js
// Reads claims from Notion Claims DB and returns structured data
// Env vars: NOTION_TOKEN, NOTION_CLAIMS_DB

const NOTION_DB = process.env.NOTION_CLAIMS_DB;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_BASE = 'https://api.notion.com/v1';

function getDateRange(range) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let start;

  switch (range) {
    case 'month':
      start = new Date(today.getFullYear(), today.getMonth(), 1);
      break;
    case 'last30':
      start = new Date(today);
      start.setDate(start.getDate() - 30);
      break;
    case 'quarter': {
      const q = Math.floor(today.getMonth() / 3);
      start = new Date(today.getFullYear(), q * 3, 1);
      break;
    }
    case 'year':
      start = new Date(today.getFullYear(), 0, 1);
      break;
    case 'all':
    default:
      start = null;
  }
  return { start, end: today };
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  // PATCH — update a claim's program field
  if (event.httpMethod === 'PATCH') {
    try {
      const { id, program } = JSON.parse(event.body || '{}');
      if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing page id' }) };

      const res = await fetch(`${NOTION_BASE}/pages/${id}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${NOTION_TOKEN}`,
          'Content-Type': 'application/json',
          'Notion-Version': '2022-06-28',
        },
        body: JSON.stringify({
          properties: {
            Program: { select: program ? { name: program } : null },
          },
        }),
      });
      if (!res.ok) {
        const err = await res.text();
        return { statusCode: res.status, headers, body: JSON.stringify({ error: err }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    } catch (e) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
    }
  }

  // GET — query claims
  try {
    const range = (event.queryStringParameters || {}).range || 'month';
    const { start } = getDateRange(range);

    const filter = start ? {
      property: 'Payment Date',
      date: { on_or_after: start.toISOString().split('T')[0] },
    } : undefined;

    const body = {
      page_size: 100,
      sorts: [{ property: 'Payment Date', direction: 'descending' }],
      ...(filter ? { filter } : {}),
    };

    const res = await fetch(`${NOTION_BASE}/databases/${NOTION_DB}/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      return { statusCode: res.status, headers, body: JSON.stringify({ error: err }) };
    }

    const data = await res.json();

    const claims = (data.results || []).map(page => {
      const props = page.properties || {};
      const getNum = k => props[k]?.number ?? null;
      const getText = k => props[k]?.rich_text?.[0]?.plain_text ?? props[k]?.title?.[0]?.plain_text ?? null;
      const getSelect = k => props[k]?.select?.name ?? null;
      const getDate = k => props[k]?.date?.start ?? null;

      const billed = getNum('Charge');
      const paid = getNum('Claim Payment') ?? getNum('Remit Payment');
      const status = paid > 0 ? 'Paid' : getSelect('Status') || 'Pending';

      return {
        id: page.id,
        claimId: getText('Patient Ctl No'),
        patient: getText('Patient Name'),
        dos: getDate('Payment Date'),
        cpt: getText('HCPCS/CPT'),
        payer: getText('Payer Name'),
        program: getSelect('Program') ?? getSelect('Rendering Provider'),
        billed,
        paid,
        status,
        denialReason: getText('Remit Remarks'),
        source: getSelect('Source'),
      };
    });

    const totalBilled = claims.reduce((s, c) => s + (c.billed || 0), 0);
    const totalPaid = claims.reduce((s, c) => s + (c.paid || 0), 0);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        claims,
        total: claims.length,
        summary: { totalBilled, totalPaid },
        range,
        asOf: new Date().toISOString(),
      }),
    };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
