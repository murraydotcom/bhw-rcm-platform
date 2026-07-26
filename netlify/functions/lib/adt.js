/* ============================================================================
 * Shared ADT normalizer — used by BOTH the webhook (crisp.js) and the
 * scheduled SFTP poller (crisp-sftp-poll.js) so a CRISP notification maps to
 * the same event shape no matter how it arrived (push vs. file drop).
 *
 * Normalized event: { patient, type, event, facility, date(ISO), dispo, complexity }
 *   type: admit | discharge | transfer | ed | update
 *   complexity: null (99495 moderate vs 99496 high is a clinical call, set later)
 * ==========================================================================*/

/* HL7 v2 ADT message (MSH/EVN/PID/PV1). After split('|'), MSH-n lives at index
 * n-1 (the field separator is MSH-1). */
function parseHL7ADT(msg) {
  const segs = msg.split(/\r\n|\r|\n/).filter(Boolean).map(s => s.split('|'));
  const seg = id => segs.find(s => s[0] === id) || [];
  const msh = seg('MSH'), evn = seg('EVN'), pid = seg('PID'), pv1 = seg('PV1');

  const trigger = (msh[8] || '').split('^')[1] || (evn[1] || '');    // A01/A03/A04…
  const typeMap = { A01: 'admit', A04: 'admit', A03: 'discharge', A02: 'transfer', A08: 'update' };
  let type = typeMap[trigger] || 'update';

  const name = (pid[5] || '').split('^');                             // LAST^FIRST
  const patient = name.length >= 2 && name[1]
    ? `${name[0]}, ${name[1][0]}.`
    : (pid[5] || 'Unknown');

  const patientClass = pv1[2] || '';                                  // I / E / O
  if (patientClass === 'E') type = 'ed';                              // ED encounter
  const classLabel = type === 'ed' ? ''                               // label already says "ED visit"
                   : patientClass === 'I' ? ' — inpatient'
                   : patientClass === 'O' ? ' — observation' : '';
  const eventLabel = { admit: 'Admission', discharge: 'Discharge', transfer: 'Transfer', ed: 'ED visit', update: 'Update' }[type];

  const facility = (pv1[3] || '').split('^')[0] || (msh[3] || '');
  const dispo = pv1[36] || '';
  const when = (evn[6] || msh[6] || '').slice(0, 8);                  // YYYYMMDD
  const date = when.length === 8 ? `${when.slice(0,4)}-${when.slice(4,6)}-${when.slice(6,8)}` : null;

  return { patient, type, event: `${eventLabel}${classLabel}`, facility, date, dispo, complexity: null };
}

/* ENS flat-file row (pipe/comma/tab) or a JSON line → normalized. Adjust the
 * column order to match your CRISP feed layout. */
function parseDelimited(body) {
  const line = String(body).trim();
  try { return normalizeObj(JSON.parse(line)); } catch (_) { /* not JSON */ }
  const p = line.split(/[|,\t]/).map(s => s.trim());
  // last, first, eventType, facility, date, disposition
  const type = /disch/i.test(p[2]) ? 'discharge'
             : /adm/i.test(p[2]) ? 'admit'
             : /ed|emerg/i.test(p[2]) ? 'ed' : 'update';
  return {
    patient: p[0] && p[1] ? `${p[0]}, ${p[1][0]}.` : (p[0] || 'Unknown'),
    type, event: p[2] || 'Encounter', facility: p[3] || '',
    date: p[4] || null, dispo: p[5] || '', complexity: null
  };
}

function normalizeObj(o) {
  return {
    patient: o.patient || (o.last && o.first ? `${o.last}, ${String(o.first)[0]}.` : (o.last || 'Unknown')),
    type: o.type || 'update', event: o.event || 'Encounter',
    facility: o.facility || '', date: o.date || null, dispo: o.dispo || '', complexity: null
  };
}

/* Split a multi-message file: HL7 batches on the MSH boundary, delimited files
 * on newlines. Returns an array of normalized events. */
function parseFile(text) {
  const t = String(text);
  if (t.trimStart().startsWith('MSH')) {
    return t.split(/(?=MSH\|)/).map(m => m.trim()).filter(Boolean).map(parseHL7ADT);
  }
  return t.split(/\r\n|\r|\n/).map(l => l.trim()).filter(Boolean).map(parseDelimited);
}

module.exports = { parseHL7ADT, parseDelimited, parseFile };
