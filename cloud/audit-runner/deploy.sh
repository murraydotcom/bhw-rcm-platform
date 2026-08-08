#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-constant-land-504517-i9}"
REGION="${REGION:-us-east4}"
JOB_NAME="${JOB_NAME:-bhw-chart-audit}"
SCHEDULER_NAME="${SCHEDULER_NAME:-bhw-chart-audit-1230}"
AR_REPOSITORY="${AR_REPOSITORY:-bhw-rcm}"
AUDIT_MODEL="${AUDIT_MODEL:-gemini-3.5-flash}"
RUNTIME_SA_NAME="bhw-rcm-audit"
SCHEDULER_SA_NAME="bhw-rcm-scheduler"
RUNTIME_SA="${RUNTIME_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
SCHEDULER_SA="${SCHEDULER_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPOSITORY}/${JOB_NAME}:$(date -u +%Y%m%d-%H%M%S)"

gcloud config set project "${PROJECT_ID}"
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  aiplatform.googleapis.com \
  firestore.googleapis.com \
  cloudscheduler.googleapis.com

if ! gcloud iam service-accounts describe "${RUNTIME_SA}" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${RUNTIME_SA_NAME}" --display-name="BHW RCM chart audit runner"
fi
if ! gcloud iam service-accounts describe "${SCHEDULER_SA}" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${SCHEDULER_SA_NAME}" --display-name="BHW RCM chart audit scheduler"
fi

gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${RUNTIME_SA}" --role="roles/datastore.user" --quiet >/dev/null
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${RUNTIME_SA}" --role="roles/aiplatform.user" --quiet >/dev/null

if ! gcloud artifacts repositories describe "${AR_REPOSITORY}" --location="${REGION}" >/dev/null 2>&1; then
  gcloud artifacts repositories create "${AR_REPOSITORY}" \
    --repository-format=docker --location="${REGION}" --description="BHW RCM automation images"
fi

gcloud builds submit . \
  --config=cloud/audit-runner/cloudbuild.yaml \
  --substitutions="_IMAGE=${IMAGE}" --quiet

gcloud run jobs deploy "${JOB_NAME}" \
  --image="${IMAGE}" \
  --region="${REGION}" \
  --service-account="${RUNTIME_SA}" \
  --set-env-vars="GOOGLE_CLOUD_PROJECT=${PROJECT_ID},GOOGLE_CLOUD_LOCATION=global,FIRESTORE_DATABASE=bhw-rcm-prod,AUDIT_MODEL=${AUDIT_MODEL},MAX_ENCOUNTERS=100" \
  --tasks=1 \
  --max-retries=1 \
  --task-timeout=20m \
  --cpu=1 \
  --memory=1Gi \
  --quiet

gcloud run jobs add-iam-policy-binding "${JOB_NAME}" \
  --region="${REGION}" \
  --member="serviceAccount:${SCHEDULER_SA}" \
  --role="roles/run.invoker" --quiet >/dev/null

SCHEDULER_URI="https://run.googleapis.com/v2/projects/${PROJECT_ID}/locations/${REGION}/jobs/${JOB_NAME}:run"
if gcloud scheduler jobs describe "${SCHEDULER_NAME}" --location="${REGION}" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "${SCHEDULER_NAME}" \
    --location="${REGION}" \
    --schedule="30 12 * * *" \
    --time-zone="America/New_York" \
    --uri="${SCHEDULER_URI}" \
    --http-method=POST \
    --oauth-service-account-email="${SCHEDULER_SA}" \
    --quiet
else
  gcloud scheduler jobs create http "${SCHEDULER_NAME}" \
    --location="${REGION}" \
    --schedule="30 12 * * *" \
    --time-zone="America/New_York" \
    --uri="${SCHEDULER_URI}" \
    --http-method=POST \
    --oauth-service-account-email="${SCHEDULER_SA}" \
    --quiet
fi

echo "BHW chart audit automation deployed."
echo "Schedule: 12:30 PM America/New_York every day"
echo "Job: ${JOB_NAME} (${REGION})"
echo "Run once now: gcloud run jobs execute ${JOB_NAME} --region=${REGION} --wait"
