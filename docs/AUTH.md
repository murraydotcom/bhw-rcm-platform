# Staff authentication (RCM Command Center)

The internal tools — the RCM & Billing Command Center (`index.html`), the Weekly
Billing Tracker, and the Provider app (`/provider/*`) — sit behind a staff login.
The public HIPAA pages (`npp.html`, `privacy.html`) and the login page itself
stay open.

It's self-contained: no third-party identity provider and no extra npm
dependency. Passwords are scrypt-hashed, the session is an HMAC-signed
`HttpOnly` cookie, and a shared `requireAuth()` gate protects the sensitive
Netlify functions (Notion, Stripe, payments, eligibility, ADT reads, …).

## Fail closed

Protected pages and functions stay unavailable until `AUTH_SECRET` and an
approved login method are configured. An authentication outage returns the user
to the login page instead of revealing a cached clinical workspace.

## Turn it on

Set these in **Netlify → Site settings → Environment variables**:

| Variable | Required | Notes |
| --- | --- | --- |
| `AUTH_SECRET` | yes | Long random string used to sign sessions. Generate with `openssl rand -hex 32`. Rotating it signs everyone out. |
| `AUTH_USERS` | see note | JSON array of user objects (see below). Required for **password** login. Optional with Google sign-in — use it only to grant admin role. |
| `AUTH_SESSION_TTL_HOURS` | no | Session lifetime in hours. Default `12`. |
| `GOOGLE_CLIENT_ID` | for Google | OAuth client ID (see "Google Workspace sign-in" below). |
| `GOOGLE_CLIENT_SECRET` | for Google | OAuth client secret. |
| `GOOGLE_ALLOWED_DOMAIN` | no | Workspace domain(s) allowed to sign in, comma-separated. Default `bhwmedical.org`. |
| `GOOGLE_ALLOWED_EMAILS` | for Google | Exact comma-separated Workspace accounts allowed to sign in. Start with one account and expand deliberately. |
| `GOOGLE_REDIRECT_URI` | no | Exact callback URL. Leave unset to derive it from the request host (works for the normal site URL). |

You need **at least one** login method: set `AUTH_USERS` (password), or the
`GOOGLE_*` vars (Google), or both. The login page shows whichever are enabled.
Then **redeploy** (env changes need a new deploy to take effect).

## Users & roles (`AUTH_USERS`)

`AUTH_USERS` is a JSON **array** of user objects. Each object needs an `email`;
`name` and `role` are optional (role defaults to `staff`), and `hash` is
optional — include it only for **password** login.

**Google-only (no passwords):** set `GOOGLE_ALLOWED_EMAILS` to the exact approved
accounts. `AUTH_USERS` is optional and can be used to assign names and roles:

```json
[
  {"email":"approved-admin@bhwmedical.org","name":"Approved Admin","role":"admin"}
]
```

(Role is stored in the session and available to the functions for future
role-specific checks; nothing enforces admin-only access yet, so `admin` vs
`staff` is harmless to set now.)

**With password login:** add a `hash` to each entry (see below). A person can
have both — a password *and* Google sign-in — by having a `hash` and a Workspace
account on the same email.

## Add / change passwords

**One step for the whole team** — prompts for each password and prints the
finished `AUTH_USERS` value (leave a password blank to keep that person
Google-only):

```bash
node tools/make-auth-users.mjs \
  approved-admin@bhwmedical.org:"Approved Admin":admin
```

Or generate a single hashed record at a time. Passwords never go in the repo or
in argv:

```bash
# interactive (password prompt, echo muted)
node tools/hash-password.mjs approved-admin@bhwmedical.org "Approved Admin" admin

# or piped (keeps it out of shell history)
printf '%s' 'their-password' | node tools/hash-password.mjs approved-admin@bhwmedical.org "Approved Admin" admin
```

Each run prints one object:

```json
{ "email": "approved-admin@bhwmedical.org", "name": "Approved Admin", "role": "admin", "hash": "scrypt$16384$8$1$…" }
```

Collect one object per staff member into a JSON **array** and paste that as the
`AUTH_USERS` value, e.g.:

```json
[
  {"email":"approved-admin@bhwmedical.org","name":"Approved Admin","role":"admin","hash":"scrypt$…"},
  {"email":"approved-staff@bhwmedical.org","name":"Approved Staff","role":"staff","hash":"scrypt$…"}
]
```

- **Reset a password:** regenerate the hash for that user and replace their object.
- **Remove access:** delete their object from the array and redeploy.
- `role` is stored in the session (`admin` / `staff`) and available to the
  functions for future role checks; nothing enforces role-specific access yet.

## What's protected

- **Pages** (client gate `auth-gate.js` → bounces to `/login.html`): `index.html`,
  `bhw_billing_tracker.html`, `provider/index.html`, `provider/risk.html`,
  `provider/prior-auth.html`, and `provider/workflow.html`.
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

## Google Workspace sign-in

"Sign in with Google" restricted to the practice's Workspace domain — no
passwords to manage, MFA handled by Google. It uses the OAuth 2.0 Authorization
Code flow (`auth-google-start` → Google → `auth-google-callback`) and mints the
**same** `bhw_session` cookie as the password flow, so the gate, logout, and
client redirect all work identically.

### One-time Google Cloud setup

1. In the **Google Cloud console** (console.cloud.google.com), pick or create a
   project owned by your `bhwmedical.org` Workspace.
2. **APIs & Services → OAuth consent screen:** choose **Internal** (this alone
   limits sign-in to your Workspace), app name e.g. "BHW RCM", your support email.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID:**
   - Application type: **Web application**.
   - **Authorized redirect URI:** your site URL + `/.netlify/functions/auth-google-callback`
     (e.g. `https://bhw-rcm.netlify.app/.netlify/functions/auth-google-callback`).
     If you use a custom domain, add that one too. It must match exactly.
4. Copy the **Client ID** and **Client secret**.

### Netlify env

Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_ALLOWED_EMAILS` (plus `AUTH_SECRET` if not
already set). `GOOGLE_ALLOWED_DOMAIN` defaults to `bhwmedical.org`. If your
site's public URL differs from the host Netlify sees, set `GOOGLE_REDIRECT_URI`
to the exact URL you registered in step 3. Redeploy.

That's it — the login page shows a **Sign in with Google** button, and only
verified, explicitly allowlisted `@bhwmedical.org` accounts are allowed through.

### How the domain restriction is enforced

The callback verifies the Google ID token's RS256 signature against Google's
published keys, validates its claims (`iss`, `aud`, `exp`, `email_verified`),
requires Google's Workspace hosted-domain claim, and then checks the exact email allowlist. A
foreign or unapproved account is bounced back with a clear message.
CSRF is covered by a signed, short-lived `state` value cross-checked against a
`SameSite=Lax` cookie.
