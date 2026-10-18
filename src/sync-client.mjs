// Transport adapter usable by a future phone JS overlay. Import/export callbacks stay on the phone.
export class SyncClient {
  constructor(baseURL, token = '') { this.baseURL = baseURL.replace(/\/+$/, ''); this.token = token; }
  async request(path, body) {
    const response = await fetch(`${this.baseURL}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
    const data = await response.json();
    if (response.status === 409) return { ...data, conflicted: true };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }
  async pair(code, name = '手机') { const result = await this.request('/v1/pair', { code, name }); this.token = result.token; return result; }
  slots() { return this.request('/v1/slots'); }
  pull(slotId) { return this.request(`/v1/slots/${encodeURIComponent(slotId)}`); }
  push(slotId, baseRevision, save, persona, personaKey) { return this.request(`/v1/slots/${encodeURIComponent(slotId)}`, { baseRevision, save, persona, personaKey }); }
  // Decide before reading/writing game storage. Divergence always requires a retained copy.
  static decide({ lastRevision, remoteRevision, localChanged }) {
    if (!lastRevision) return 'choose-first-sync';
    if (lastRevision === remoteRevision) return localChanged ? 'push' : 'unchanged';
    return localChanged ? 'conflict' : 'pull';
  }
}
