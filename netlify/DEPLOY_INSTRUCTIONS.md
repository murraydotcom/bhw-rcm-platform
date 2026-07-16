# BHW Stedi Functions — Deployment Instructions

## What's in this folder

```
netlify/
  functions/
    stedi-eras.js          ← pulls 835 ERA data from Stedi
    stedi-eligibility.js   ← real-time insurance eligibility checks
    stedi-claim-status.js  ← real-time claim status (276/277)
netlify.toml               ← tells Netlify where functions live + clean API URLs
```

## How to add these to your GitHub repo

1. Open your BHW RCM GitHub repo
2. If a `netlify/functions/` folder doesn't already exist, create it
3. Add all three `.js` files into `netlify/functions/`
4. Add `netlify.toml` to the **root** of the repo (same level as your index.html)
5. Commit and push — Netlify auto-deploys

## One extra env var to add in Netlify

Go to **Site config → Environment variables** and add:

| Variable | Value |
|---|---|
| `BHW_TAX_ID` | Your group EIN (no dashes) |

You already have `STEDI_KEY_PREFIX` and `STEDI_KEY_SUFFIX` set — those are all that's needed for ERA and eligibility. The tax ID is needed for claim status lookups.

## How the dashboard calls these functions

From your dashboard HTML/JS, call the functions like this:

### Pull all ERAs since July 1
```javascript
const res = await fetch('/api/stedi-eras?startDateTime=2026-07-01T00:00:00Z');
const data = await res.json();
// data.eras = array of ERA objects
// data.total = count
// data.nextPageToken = pass back for pagination
```

### Check eligibility
```javascript
const res = await fetch('/api/stedi-eligibility', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    payerId: '00435',         // CareFirst payer ID
    memberId: 'ABC123456',
    firstName: 'John',
    lastName: 'Smith',
    dateOfBirth: '1965-03-15',
    dateOfService: '2026-07-16'
  })
});
const data = await res.json();
// data.eligible = true/false
// data.planName, data.copay, data.deductible, etc.
```

### Check claim status
```javascript
const res = await fetch('/api/stedi-claim-status', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    payerId: '00435',
    memberId: 'ABC123456',
    firstName: 'John',
    lastName: 'Smith',
    dateOfBirth: '1965-03-15',
    dateOfService: '2026-06-24',
    claimAmount: 200.00
  })
});
const data = await res.json();
// data.claimStatuses = array with status, paid amount, denial reasons
```

## Common payer IDs for BHW

| Payer | ID |
|---|---|
| CareFirst BCBS | 00435 |
| CareFirst Community (Medicaid MCO) | CAREFIRST-MCD |
| Medicare (CMS) | CMS |
| Aetna | 60054 |
| United Healthcare | 87726 |
| Maryland Medicaid FFS | 77013 |

> Verify these in the Stedi Payer Network at stedi.com/healthcare/network before using in production.
