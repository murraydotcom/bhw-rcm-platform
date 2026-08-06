# Google Cloud encounter queue

The 24-hour encounter workflow can use the Firestore database `bhw-rcm-prod`
in Google Cloud project `constant-land-504517-i9`.

## Data path

- Netlify serves the static user interface and completes staff sign-in.
- Netlify returns a five-minute, allowlisted authorization token. It does not
  receive encounter notes, codes, diagnoses, or patient identifiers.
- The browser sends encounter packets directly to the BHW Cloud Run API.
- Cloud Run validates the token and exact staff email before using Firestore.
- Firestore is a workflow copy. Freed and CharmHealth remain the designated
  medical records.

## Required environment configuration

Use the exact approved account in the deployment environment; do not hard-code
staff email addresses or secrets in this public repository.

### Netlify

In addition to the existing Google OAuth variables:

| Variable | Value |
| --- | --- |
| `GOOGLE_ALLOWED_EMAILS` | Exact approved Workspace account(s), comma separated |
| `RCM_CLOUD_TOKEN_SECRET` | Same random secret stored in Google Secret Manager |
| `RCM_CLOUD_API_URL` | HTTPS URL returned by the Cloud Run deployment |
| `GOOGLE_REDIRECT_URI` | `https://rcm.bhwmedical.org/.netlify/functions/auth-google-callback` |

### Cloud Run

| Variable | Value |
| --- | --- |
| `FIRESTORE_DATABASE` | `bhw-rcm-prod` |
| `ALLOWED_ORIGIN` | `https://rcm.bhwmedical.org` |
| `ALLOWED_EMAILS` | Exact approved Workspace account(s), comma separated |
| `RCM_CLOUD_TOKEN_SECRET` | Secret Manager reference, never plain source code |

The Cloud Run runtime service account needs `roles/datastore.user` and access
to only the `bhw-rcm-token-secret` Secret Manager secret. Do not create or
download a service-account key; Cloud Run uses its attached service account.

## Deployment outline

Run these steps from an authenticated Google Cloud Shell with the project set
to `constant-land-504517-i9`. Replace the email placeholder locally. Never send
the generated secret through chat, email, or source control.

```bash
gcloud config set project constant-land-504517-i9
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com firestore.googleapis.com secretmanager.googleapis.com

gcloud iam service-accounts create bhw-rcm-api --display-name="BHW RCM Cloud API"
gcloud projects add-iam-policy-binding constant-land-504517-i9 \
  --member="serviceAccount:bhw-rcm-api@constant-land-504517-i9.iam.gserviceaccount.com" \
  --role="roles/datastore.user"

openssl rand -hex 32 | gcloud secrets create bhw-rcm-token-secret --data-file=-
gcloud secrets add-iam-policy-binding bhw-rcm-token-secret \
  --member="serviceAccount:bhw-rcm-api@constant-land-504517-i9.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

gcloud run deploy bhw-rcm-api \
  --source=cloud/rcm-api \
  --region=us-east4 \
  --service-account=bhw-rcm-api@constant-land-504517-i9.iam.gserviceaccount.com \
  --allow-unauthenticated \
  --set-env-vars="FIRESTORE_DATABASE=bhw-rcm-prod,ALLOWED_ORIGIN=https://rcm.bhwmedical.org,ALLOWED_EMAILS=approved-user@bhwmedical.org" \
  --set-secrets="RCM_CLOUD_TOKEN_SECRET=bhw-rcm-token-secret:latest"
```

`--allow-unauthenticated` makes the HTTPS route reachable from the browser;
the application still denies every clinical endpoint unless the request has a
valid five-minute BHW token for an allowlisted account. CORS is restricted to
the production RCM origin.

After deployment, add its HTTPS URL and the same generated token secret to the
Netlify environment, then redeploy Netlify. Test first with a synthetic
encounter. Confirm that it appears on a second signed-in device before enabling
real-patient use.

## Guardrails

- Keep Google OAuth set to Internal.
- Keep the exact email allowlist; do not authorize the whole Workspace domain.
- Keep Firestore initial browser security rules restrictive. The Cloud Run
  service uses IAM, not public Firestore web access.
- Do not create patient collections manually in Firestore Studio.
- Do not put patient names in the workflow encounter ID.
- Keep Cloud Audit Logs enabled and review access regularly.
