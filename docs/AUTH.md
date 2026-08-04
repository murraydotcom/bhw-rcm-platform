# Staff authentication (RCM Command Center)

The internal tools — the RCM & Billing Command Center (`index.html`), the Weekly
Billing Tracker, and the Provider app (`/provider/*`) — sit behind a staff login.
The public HIPAA pages (`npp.html`, `privacy.html`) and the login page itself
stay open.

It's self-contained: no third-party identity provider and no extra npm
dependency. Passwords are scrypt-hashed, the session is an HMAC-signed
`HttpOnly` cookie, and a shared `requireAuth()` gate protects the sensitive
Netlify functions (Notion, Stripe, payments, eligibility, ADT reads, …).

## Fail-safe-off

**Authentication is OFF until you set `AUTH_SECRET`.** With no secret configured
the app behaves exactly as it did before (this matches how every function in the
repo no-ops until its env vars are present), so deploying this change does not
lock anyone out. You turn auth **on** by adding the two env vars below and
redeploying.

## Turn it on

Set these in **Netlify → Site settings → Environment variables**:

| Variable | Required | Notes |
| --- | --- | --- |
| `AUTH_SECRET` | yes | Long random string used to sign sessions. Generate with `openssl rand -hex 32`. Rotating it signs everyone out. |
| `AUTH_USERS` | yes | JSON array of user objects (see below). |
| `AUTH_SESSION_TTL_HOURS` | no | Session lifetime in hours. Default `12`. |

Then **redeploy** (env changes need a new deploy to take effect).

## Add / change users

Passwords never go in the repo or in argv. Generate a hashed record per person:

```bash
# interactive (password prompt, echo muted)
node tools/hash-password.mjs amaris@bhwmedical.org "Amaris Murray" admin

# or piped (keeps it out of shell history)
printf '%s' 'their-password' | node tools/hash-password.mjs amaris@bhwmedical.org "Amaris Murray" admin
```

Each run prints one object:

```json
{ "email": "amaris@bhwmedical.org", "name": "Amaris Murray", "role": "admin", "hash": "scrypt$16384$8$1$…" }
```

Collect one object per staff member into a JSON **array** and paste that as the
`AUTH_USERS` value, e.g.:

```json
[
  {"email":"amaris@bhwmedical.org","name":"Amaris Murray","role":"admin","hash":"scrypt$…"},
  {"email":"yahaira@bhwmedical.org","name":"Yahaira Matias","role":"staff","hash":"scrypt$…"}
]
```

- **Reset a password:** regenerate the hash for that user and replace their object.
- **Remove access:** delete their object from the array and redeploy.
- `role` is stored in the session (`admin` / `staff`) and available to the
  functions for future role checks; nothing enforces role-specific access yet.

## What's protected

- **Pages** (client gate `auth-gate.js` → bounces to `/login.html`): `index.html`,
  `bhw_billing_tracker.html`, `provider/index.html`, `provider/risk.html`,
  `provider/prior-auth.html`, `provider/claims.html`.
- **Functions** (`requireAuth()` → `401` without a valid session): `notion`,
  `stedi`, `stedi-discovery`, `stedi-eligibility`, `crisp` (dashboard reads only),
  `payment-post`, `note-post`, `stripe-bank`, `albert`.

The function gate is the real security boundary — even if someone loads a page's
HTML, the data calls behind it return `401` without a session. The client gate is
UX (don't show an empty shell to a logged-out user).

### Intentionally left open

- `login.html`, `npp.html`, `privacy.html` — public by design.
- `stedi-webhook` — external caller, already authed by its own `STEDI_WEBHOOK_TOKEN`.
- `crisp-sftp-poll` — scheduled function, no HTTP caller.
- `crisp` **POST ingest** — external CRISP callee (no browser cookie). It stays
  ungated here; guard it with its own shared secret if CRISP posts to it directly.

## How it works

1. `POST /.netlify/functions/auth-login` with `{ email, password }` verifies the
   scrypt hash and sets `bhw_session=<token>; HttpOnly; Secure; SameSite=Strict`.
2. The token is `base64url(payload).HMAC_SHA256(payload, AUTH_SECRET)` with an
   `exp` claim — tamper- and expiry-checked on every request, no server session store.
3. Protected pages call `auth-me` on load; `401` → redirect to login.
4. Protected functions call `requireAuth(event)` and return its `401` if there's
   no valid session.

## Testing

`npm test` covers the auth library (hashing, signing, tamper/expiry rejection,
the gate) and an end-to-end login → session → gated-call → logout flow against the
real handlers.

## Future option: Google Workspace SSO

Because staff are on `@bhwmedical.org` (Google Workspace), "Sign in with Google"
restricted to that domain is a strong upgrade — no passwords to manage, MFA
handled by Google. The session cookie, `requireAuth()` gate, and client gate here
are reusable as-is; only the credential-verification step in `auth-login` would be
swapped for a Google OIDC token exchange (needs a Google Cloud OAuth client ID/secret).
