const CONFIG_URL = "/api/rcm-cloud-config";
const TOKEN_URL = "/api/rcm-cloud-token";

export async function createEncounterCloudClient(fetchImpl = fetch) {
  const configResponse = await fetchImpl(CONFIG_URL, { credentials: "same-origin", cache: "no-store" });
  if (!configResponse.ok) return null;
  const config = await configResponse.json();
  if (!config.enabled || !config.apiBase) return null;

  let token = "";
  let tokenExpiresAt = 0;

  async function getToken(force = false) {
    if (!force && token && tokenExpiresAt > Date.now() + 30000) return token;
    const response = await fetchImpl(TOKEN_URL, { method: "POST", credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw Object.assign(new Error("Google Cloud authorization failed"), { status: response.status });
    const body = await response.json();
    token = body.token;
    tokenExpiresAt = Date.now() + Number(body.expiresIn || 300) * 1000;
    return token;
  }

  async function request(path, options = {}, retry = true) {
    const bearer = await getToken();
    const response = await fetchImpl(`${config.apiBase}${path}`, {
      ...options,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
        Authorization: `Bearer ${bearer}`,
      },
      cache: "no-store",
    });
    if (response.status === 401 && retry) {
      await getToken(true);
      return request(path, options, false);
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw Object.assign(new Error(body.error || `Google Cloud request failed (${response.status})`), { status: response.status });
    }
    return response.json();
  }

  return {
    apiBase: config.apiBase,
    async list() {
      const body = await request("/v1/encounters");
      return Array.isArray(body.encounters) ? body.encounters : [];
    },
    async save(encounter) {
      return request(`/v1/encounters/${encodeURIComponent(encounter.id)}`, {
        method: "PUT",
        body: JSON.stringify(encounter),
      });
    },
    async saveAll(encounters) {
      await Promise.all(encounters.map((encounter) => this.save(encounter)));
    },
    async remove(id) {
      return request(`/v1/encounters/${encodeURIComponent(id)}`, { method: "DELETE" });
    },
  };
}
