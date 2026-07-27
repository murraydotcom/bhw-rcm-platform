/* ============================================================================
 * CRISP CEND / ENS integration  —  Hospital & TCM board
 * ----------------------------------------------------------------------------
 * CRISP (Maryland's HIE) does NOT expose a simple public "pull ENS" API.
 * The real flow is roster-in, notifications-out:
 *
 *   1. PANEL OUT   You submit a patient panel (CSV) to CRISP — via the
 *                  Self-Service Panel Loader, SFTP, or Direct — refreshed at
 *                  least every 90 days.  (GET ?action=panel builds that CSV.)
 *   2. NOTIFY IN   CRISP pushes a notification whenever a paneled patient has
 *                  an encounter: an HL7 ADT message (to an endpoint/EHR) or a
 *                  PDF/flat file over the Direct protocol / SFTP.
 *                  (POST here ingests one message → a normalized event.)
 *   3. READ        The dashboard reads normalized events. (GET ?feed=adt)
 *
 * Because Netlify functions are stateless, ingested events should be persisted
 * (this scaffold writes to / reads from a Notion "ADT / Encounters" database
 * when NOTION_TOKEN + NOTION_DB_ADT are set). Until CRISP_* env vars are set,
 * every path returns representative sample data so the UI is demonstrable.
 *
 * Env vars:
 *   CRISP_INGEST_TOKEN   shared secret CRISP includes when POSTing to this URL
 *   CRISP_SFTP_HOST/…    (optional) if you poll an SFTP drop instead of webhook
 *   NOTION_TOKEN         (optional) to persist + read events
 *   NOTION_DB_ADT        (optional) the ADT/Encounters database id
 * ==========================================================================*/

const { parseHL7ADT, parseDelimited } = require('./lib/adt');

const CRISP_ENABLED = !!(process.env.CRISP_INGEST_TOKEN || process.env.CRISP_SFTP_HOST);
const NOTION_TOKEN  = process.env.NOTION_TOKEN;
const NOTION_DB_ADT = process.env.NOTION_DB_ADT;

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  const method = event.httpMethod || 'GET';
  try {
    if (method === 'POST')   return await ingest(event);   // CRISP → normalized event
    if (q.action === 'panel') return panelCsv();            // roster → CEND CSV
    return await adtFeed();                                 // default: GET ?feed=adt
  } catch (e) {
    return json({ ok: false, error: e.message });
  }
};

/* ---- READ: normalized ADT events for the dashboard ----------------------- */
async function adtFeed() {
  if (!CRISP_ENABLED) {
    return json({ ok: true, sampleMode: true, rosterSync: 'not configured — set CRISP_* env vars' });
  }
  // Live: read persisted events (last ~35 days covers the 30-day TCM period).
  if (NOTION_TOKEN && NOTION_DB_ADT) {
    const rows = await readNotionAdt();
    return json({ ok: true, sampleMode: false, rosterSync: process.env.CRISP_ROSTER_SYNCED || 'synced', rows });
  }
  // Enabled but no store wired yet — return empty rather than fake data.
  return json({ ok: true, sampleMode: false, rosterSync: 'synced', rows: [] });
}

/* ---- INGEST: one CRISP notification → a normalized event ----------------- */
async function ingest(event) {
  // Verify the shared secret CRISP is configured to send.
  const token = (event.headers['x-crisp-token'] || event.headers['X-CRISP-Token'] || '');
  if (process.env.CRISP_INGEST_TOKEN && token !== process.env.CRISP_INGEST_TOKEN) {
    return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'bad ingest token' }) };
  }
  const body = event.body || '';
  const normalized = body.trimStart().startsWith('MSH')
    ? parseHL7ADT(body)              // HL7 v2 ADT message
    : parseDelimited(body);          // ENS flat-file row / JSON

  if (NOTION_TOKEN && NOTION_DB_ADT) await writeNotionAdt(normalized);
  return json({ ok: true, normalized });   // echo so the webhook is testable
}

/* ---- PANEL OUT: build the CEND patient-panel CSV ------------------------- */
function panelCsv() {
  const cols = ['LastName','FirstName','DOB','Gender','Address1','City','State','Zip','MRN','MemberID','PanelID'];
  // Live: replace `roster` with your active-patient export (e.g. from Notion/EHR).
  const roster = [
    ['Ellison','Jordan','1986-04-12','M','100 Main St','Baltimore','MD','21201','BHW1001','MD8840217','BHW-PRIMARY'],
    ['Ruiz','Maria','1958-01-17','F','8 Elm Ct','Columbia','MD','21044','BHW1003','MCR770021','BHW-CCM'],
  ];
  const esc = v => /[",\n]/.test(v) ? '"' + String(v).replace(/"/g,'""') + '"' : v;
  const csv = [cols.join(',')].concat(roster.map(r => r.map(esc).join(','))).join('\n');
  return { statusCode: 200, headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="CEND_panel.csv"' }, body: csv };
}

/* ---- Notion persistence (optional) --------------------------------------- */
async function writeNotionAdt(ev) {
  await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: notionHeaders(),
    body: JSON.stringify({
      parent: { database_id: NOTION_DB_ADT },
      properties: {
        Patient:    { title: [{ text: { content: ev.patient || '' } }] },
        Type:       { select: { name: ev.type || 'update' } },
        Event:      { rich_text: [{ text: { content: ev.event || '' } }] },
        Facility:   { rich_text: [{ text: { content: ev.facility || '' } }] },
        Date:       ev.date ? { date: { start: ev.date } } : { date: null },
        Disposition:{ rich_text: [{ text: { content: ev.dispo || '' } }] },
      }
    })
  });
}
async function readNotionAdt() {
  const r = await fetch(`https://api.notion.com/v1/databases/${NOTION_DB_ADT}/query`, {
    method: 'POST', headers: notionHeaders(),
    body: JSON.stringify({ page_size: 100, sorts: [{ property: 'Date', direction: 'descending' }] })
  });
  const j = await r.json();
  const txt = p => (p?.rich_text?.[0]?.plain_text) || (p?.title?.[0]?.plain_text) || '';
  return (j.results || []).map(pg => {
    const P = pg.properties || {};
    return {
      patient: txt(P.Patient), type: P.Type?.select?.name || 'discharge',
      event: txt(P.Event), facility: txt(P.Facility),
      date: P.Date?.date?.start || null, dispo: txt(P.Disposition), complexity: null
    };
  });
}
function notionHeaders() {
  return { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' };
}

/* ---- helpers ------------------------------------------------------------- */
function json(obj) {
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}
