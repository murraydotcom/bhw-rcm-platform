// Netlify Function: stripe-bank.js
// Bank feed via Stripe Financial Connections (uses your existing Stripe account).
//
//   POST ?action=session   → create a Financial Connections session (balances +
//                            transactions) → returns clientSecret + publishableKey.
//                            The front-end opens Stripe's secure connect window with it.
//   GET  ?action=accounts  → connected accounts + balances + recent transactions,
//                            normalized for the dashboard.
//
// Cost: ~$0.30 / account / month (transactions) + $0.10 / balance call. No setup fee.
//
// Env: STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY
//      STRIPE_FC_CUSTOMER   (a Stripe customer id representing the practice; the
//                            session's account_holder — create one once)
//      STRIPE_FC_ACCOUNTS   (comma-separated fcacct_… ids you connected — persist
//                            these after the first connect, e.g. from a webhook)
//
// One-time in Stripe: enable Financial Connections, and turn on the Transactions
// feature. After the first connect, save the returned account ids to STRIPE_FC_ACCOUNTS
// (or a small store) so this function can read them back.

const KEY = process.env.STRIPE_SECRET_KEY;
const PUB = process.env.STRIPE_PUBLISHABLE_KEY || "";
const CUSTOMER = process.env.STRIPE_FC_CUSTOMER || "";
const ACCOUNTS = (process.env.STRIPE_FC_ACCOUNTS || "").split(",").map(s => s.trim()).filter(Boolean);
const BASE = "https://api.stripe.com/v1";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Content-Type": "application/json" };

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  const _auth = require("./lib/auth").requireAuth(event);
  if (!_auth.ok) return _auth.response;
  const q = event.queryStringParameters || {};
  if (!KEY) return json(200, { ok: true, sampleMode: true });   // demo → front-end keeps sample data

  try {
    if (event.httpMethod === "POST" && q.action === "session") return await createSession();
    return await accountsFeed();   // default GET ?action=accounts
  } catch (e) {
    return json(200, { ok: false, error: e.message });
  }
};

// Stripe expects form-encoded bodies; this flattens nested keys (permissions[], account_holder[...]).
function form(obj, prefix, out) {
  out = out || new URLSearchParams();
  for (const k in obj) {
    const key = prefix ? `${prefix}[${k}]` : k;
    const v = obj[k];
    if (Array.isArray(v)) v.forEach((val, i) => out.append(`${key}[${i}]`, val));
    else if (v && typeof v === "object") form(v, key, out);
    else if (v != null) out.append(key, v);
  }
  return out;
}
async function stripe(method, path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: body ? form(body).toString() : undefined,
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || `Stripe ${r.status}`);
  return j;
}

async function createSession() {
  // account_holder must be a customer; create one on the fly if not configured.
  let customer = CUSTOMER;
  if (!customer) { const c = await stripe("POST", "/customers", { description: "BHW practice bank connection" }); customer = c.id; }
  const session = await stripe("POST", "/financial_connections/sessions", {
    account_holder: { type: "customer", customer },
    permissions: ["balances", "transactions"],
  });
  return json(200, { ok: true, sampleMode: false, clientSecret: session.client_secret, publishableKey: PUB, customer });
}

async function accountsFeed() {
  // Prefer listing every account linked to your practice customer — no manual
  // account-id collection. Falls back to an explicit STRIPE_FC_ACCOUNTS list.
  let ids = ACCOUNTS;
  if (!ids.length && CUSTOMER) {
    const list = await stripe("GET", `/financial_connections/accounts?account_holder[customer]=${CUSTOMER}&limit=25`);
    ids = (list.data || []).map((a) => a.id);
  }
  if (!ids.length) return json(200, { ok: true, sampleMode: true });   // nothing connected yet

  const accounts = [];
  let txns = [];
  for (const id of ids) {
    const a = await stripe("GET", `/financial_connections/accounts/${id}`);
    accounts.push({
      name: a.display_name || a.institution_name || "Account",
      inst: a.institution_name || "",
      last4: a.last4 || "",
      type: a.subcategory || a.category || "",
      balance: a.balance && a.balance.current ? centsToDollars(a.balance.current) : 0,
    });
    // transactions (requires the Transactions feature subscribed on the account)
    try {
      const t = await stripe("GET", `/financial_connections/transactions?account=${id}&limit=50`);
      (t.data || []).forEach(x => txns.push([
        (x.transacted_at ? new Date(x.transacted_at * 1000) : new Date(x.transaction_refresh ? Date.now() : Date.now())).toISOString().slice(0, 10),
        x.description || "", centsToDollars(x.amount), a.last4 || "", null,
      ]));
    } catch (_) { /* transactions not enabled for this institution */ }
  }
  txns.sort((x, y) => (x[0] < y[0] ? 1 : -1));
  return json(200, { ok: true, sampleMode: false, accounts, transactions: txns });
}

function centsToDollars(v) { return Math.round(Number(v || 0)) / 100; }
function json(statusCode, obj) { return { statusCode, headers: CORS, body: JSON.stringify(obj) }; }
