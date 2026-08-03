/* ============================================================================
 * AUTHORIZATION SPAN TRACKING — "when does this authorization expire, and when
 * is the concurrent (continued-stay) request due?"
 *
 * Complements the CRD "is prior auth required?" step: once an authorization is
 * granted for a date span, staff need to renew it before it lapses. Per the
 * Carelon PBHS Provider Manual, continued authorization must be requested
 * BEFORE the last authorized day of service — this computes that due date and
 * the 30/14/7-day reminder tiers (BHW P-2 authorization tracker), plus the
 * payer's determination turnaround time for the review type.
 *
 * Pure + DOM-free. Dates are handled at day granularity in UTC to avoid
 * timezone drift; pass `asOf` for deterministic results (defaults to today).
 * Decision support — verify against the current authorization letter / manual.
 * ==========================================================================*/

const MS_DAY = 86400000;

/* Parse a date-only value ("YYYY-MM-DD", "MM/DD/YYYY", or a Date) to a UTC
 * midnight timestamp, so day math never crosses a DST/timezone boundary. */
export function parseDay(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate());
  const s = String(v).trim();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  if ((m = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/))) {
    const yr = +m[3] < 100 ? 2000 + +m[3] : +m[3];
    return Date.UTC(yr, +m[1] - 1, +m[2]);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
const toISO = (ts) => (ts == null ? null : new Date(ts).toISOString().slice(0, 10));
const daysBetween = (a, b) => Math.round((b - a) / MS_DAY);

export const SPAN_STATUS = Object.freeze({
  FUTURE: "future", ACTIVE: "active", EXPIRING: "expiring", EXPIRED: "expired", UNKNOWN: "unknown",
});

/* decisionTimeframe(requestTypeId, TF) → the payer determination row, or null. */
export function decisionTimeframe(requestTypeId, TF = {}) {
  return (TF.requestTypes || []).find((r) => r.id === requestTypeId) || null;
}

/* trackAuthSpan({ startDate, endDate, asOf?, requestType? }, TF)
 * endDate = the LAST authorized day of service.
 * → { valid, status, startDate, endDate, asOf, totalDays, daysElapsed,
 *     daysRemaining, renewalDueBy, reminders[], nextReminder, decision, notes[] } */
export function trackAuthSpan(auth = {}, TF = {}) {
  const start = parseDay(auth.startDate);
  const end = parseDay(auth.endDate);
  const asOf = parseDay(auth.asOf) ?? parseDay(new Date());
  const notes = [];
  const decision = auth.requestType ? decisionTimeframe(auth.requestType, TF) : null;

  if (end == null) {
    return { valid: false, status: SPAN_STATUS.UNKNOWN, startDate: toISO(start), endDate: null, asOf: toISO(asOf),
      totalDays: null, daysElapsed: null, daysRemaining: null, renewalDueBy: null, reminders: [], nextReminder: null,
      decision, notes: ["Enter the authorization's last authorized day to track it."] };
  }

  // Continued authorization is due by the last authorized day (Carelon PBHS).
  const renewalDueBy = end;
  const daysRemaining = daysBetween(asOf, end);          // days from asOf to the last authorized day
  const totalDays = start != null ? daysBetween(start, end) + 1 : null; // inclusive span length
  const daysElapsed = start != null ? Math.max(0, daysBetween(start, asOf)) : null;

  let status;
  if (start != null && asOf < start) status = SPAN_STATUS.FUTURE;
  else if (daysRemaining < 0) status = SPAN_STATUS.EXPIRED;
  else if (daysRemaining <= (TF.reminderTiers ? Math.min(...TF.reminderTiers) : 7)) status = SPAN_STATUS.EXPIRING;
  else status = SPAN_STATUS.ACTIVE;

  const tiers = (TF.reminderTiers || [30, 14, 7]).slice().sort((a, b) => b - a);
  const reminders = tiers.map((tier) => {
    const date = end - tier * MS_DAY;
    return { tier, date: toISO(date), reached: asOf >= date && asOf <= end };
  });
  const nextReminder = reminders.find((r) => parseDay(r.date) >= asOf && asOf <= end) || null;

  if (status === SPAN_STATUS.EXPIRED)
    notes.push(`Authorization lapsed — the last authorized day was ${toISO(end)}. A new/continued authorization is required before further services.`);
  else if (status === SPAN_STATUS.EXPIRING)
    notes.push(`Submit the concurrent (continued-stay) request by ${toISO(renewalDueBy)} — before the last authorized day.`);
  if (decision && decision.determination)
    notes.push(`${decision.label}: determination ${decision.determination.toLowerCase()}.`);
  if (TF.concurrentReview && TF.concurrentReview.rule) notes.push(TF.concurrentReview.rule);

  return {
    valid: true, status,
    startDate: toISO(start), endDate: toISO(end), asOf: toISO(asOf),
    totalDays, daysElapsed, daysRemaining,
    renewalDueBy: toISO(renewalDueBy), reminders, nextReminder, decision, notes,
  };
}
