/* ============================================================================
 * CRISP SFTP poller  —  scheduled Netlify function
 * ----------------------------------------------------------------------------
 * Use this instead of (or alongside) the crisp.js webhook when CRISP delivers
 * ENS/CEND notifications as FILES to an SFTP drop rather than pushing them.
 *
 * On each run it: connects to the CRISP SFTP folder, downloads every new file,
 * parses each into normalized ADT events (shared lib — same normalizer the
 * webhook uses), persists them to Notion, then moves the file to a processed
 * folder so it is never ingested twice.
 *
 * SCHEDULE is set in netlify.toml:
 *     [functions."crisp-sftp-poll"]
 *       schedule = "* /15 * * * *"      # every 15 minutes
 *
 * Requires the `ssh2-sftp-client` dependency (see package.json).
 * Env vars:
 *   CRISP_SFTP_HOST, CRISP_SFTP_PORT(=22), CRISP_SFTP_USER
 *   CRISP_SFTP_PASSWORD  — or —  CRISP_SFTP_KEY (private key contents)
 *   CRISP_SFTP_DIR(=/outbound)        folder CRISP writes notifications to
 *   CRISP_SFTP_DONE_DIR(=/processed)  folder to move handled files into
 *   NOTION_TOKEN, NOTION_DB_ADT       to persist events (functions are stateless)
 * ==========================================================================*/

const Client = require('ssh2-sftp-client');
const { parseFile } = require('./lib/adt');

const {
  CRISP_SFTP_HOST, CRISP_SFTP_PORT = '22', CRISP_SFTP_USER,
  CRISP_SFTP_PASSWORD, CRISP_SFTP_KEY,
  CRISP_SFTP_DIR = '/outbound', CRISP_SFTP_DONE_DIR = '/processed',
  NOTION_TOKEN, NOTION_DB_ADT
} = process.env;

exports.handler = async () => {
  if (!CRISP_SFTP_HOST || !CRISP_SFTP_USER) {
    return log('CRISP SFTP not configured — skipping');
  }
  const sftp = new Client();
  let files = 0, events = 0;
  try {
    await sftp.connect({
      host: CRISP_SFTP_HOST,
      port: Number(CRISP_SFTP_PORT),
      username: CRISP_SFTP_USER,
      ...(CRISP_SFTP_KEY ? { privateKey: CRISP_SFTP_KEY } : { password: CRISP_SFTP_PASSWORD })
    });

    const list = await sftp.list(CRISP_SFTP_DIR);
    const toProcess = list.filter(f => f.type === '-');   // regular files only

    for (const f of toProcess) {
      const remote = `${CRISP_SFTP_DIR}/${f.name}`;
      const buf = await sftp.get(remote);                 // returns a Buffer
      const evts = parseFile(buf.toString('utf8'));
      for (const ev of evts) { await persist(ev); events++; }

      // Move handled file out of the inbound folder so it is not re-ingested.
      try { await sftp.rename(remote, `${CRISP_SFTP_DONE_DIR}/${f.name}`); }
      catch (_) { await sftp.delete(remote); }
      files++;
    }
    return log(`processed ${files} file(s), ${events} event(s)`);
  } catch (e) {
    return log('SFTP poll error: ' + e.message, false);
  } finally {
    try { await sftp.end(); } catch (_) { /* ignore */ }
  }
};

async function persist(ev) {
  if (!(NOTION_TOKEN && NOTION_DB_ADT)) return;   // set Notion vars to persist
  await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      parent: { database_id: NOTION_DB_ADT },
      properties: {
        Patient:     { title: [{ text: { content: ev.patient || '' } }] },
        Type:        { select: { name: ev.type || 'update' } },
        Event:       { rich_text: [{ text: { content: ev.event || '' } }] },
        Facility:    { rich_text: [{ text: { content: ev.facility || '' } }] },
        Date:        ev.date ? { date: { start: ev.date } } : { date: null },
        Disposition: { rich_text: [{ text: { content: ev.dispo || '' } }] }
      }
    })
  });
}

function log(msg, ok = true) {
  console.log('[crisp-sftp-poll]', msg);
  return { statusCode: ok ? 200 : 500, body: msg };
}
