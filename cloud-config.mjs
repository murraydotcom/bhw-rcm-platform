function env(name) {
  if (globalThis.Netlify?.env?.get) return globalThis.Netlify.env.get(name);
  return process.env[name];
}

function safeApiBase(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:") return "";
    return url.origin + url.pathname.replace(/\/$/, "");
  } catch {
    return "";
  }
}

export default async () => {
  const apiBase = safeApiBase(env("RCM_CLOUD_API_URL"));
  return new Response(JSON.stringify({ ok: true, enabled: Boolean(apiBase), apiBase }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
};

export const config = { path: "/api/rcm-cloud-config" };
