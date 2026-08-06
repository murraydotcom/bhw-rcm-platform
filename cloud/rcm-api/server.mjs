import http from "node:http";
import crypto from "node:crypto";
import { Firestore } from "@google-cloud/firestore";
import { createHandler } from "./app.mjs";

const databaseId = process.env.FIRESTORE_DATABASE || "bhw-rcm-prod";
const firestore = new Firestore({ projectId: process.env.GOOGLE_CLOUD_PROJECT, databaseId });
const collection = firestore.collection("encounters");
const keyFor = (id) => crypto.createHash("sha256").update(String(id)).digest("hex");

const repository = {
  async list() {
    const snapshot = await collection.get();
    return snapshot.docs.map((doc) => doc.data().encounter).filter(Boolean);
  },
  async save(encounter, user) {
    await collection.doc(keyFor(encounter.id)).set({
      encounter,
      updatedAt: new Date().toISOString(),
      updatedBy: user.sub,
    });
  },
  async remove(id) {
    await collection.doc(keyFor(id)).delete();
  },
};

const handle = createHandler(repository);
const server = http.createServer(async (incoming, outgoing) => {
  const protocol = incoming.headers["x-forwarded-proto"] || "http";
  const host = incoming.headers.host || "localhost";
  const body = ["GET", "HEAD"].includes(incoming.method) ? undefined : incoming;
  const request = new Request(`${protocol}://${host}${incoming.url}`, {
    method: incoming.method,
    headers: incoming.headers,
    body,
    duplex: body ? "half" : undefined,
  });
  const response = await handle(request);
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body) {
    for await (const chunk of response.body) outgoing.write(chunk);
  }
  outgoing.end();
});

server.listen(Number(process.env.PORT || 8080), "0.0.0.0");
