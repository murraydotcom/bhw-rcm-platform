FROM node:22-slim

WORKDIR /app

COPY cloud/audit-runner/package.json ./cloud/audit-runner/package.json
RUN cd cloud/audit-runner && npm install --omit=dev

COPY engine ./engine
COPY cloud/audit-runner/runner.mjs ./cloud/audit-runner/runner.mjs

WORKDIR /app/cloud/audit-runner
CMD ["node", "runner.mjs"]
