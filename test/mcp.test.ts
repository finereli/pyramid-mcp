import { SELF, env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

interface RpcResponse {
  jsonrpc: string;
  id: number | string | null;
  result?: any;
  error?: { code: number; message: string };
}

async function rpc(userId: string, body: object): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-user-id': userId,
  };
  return SELF.fetch('https://example.com/mcp', { method: 'POST', headers, body: JSON.stringify(body) });
}

function user() {
  return 'mcp-' + crypto.randomUUID();
}

describe('MCP transport over /mcp', () => {
  it('rejects requests without dev auth', async () => {
    const res = await SELF.fetch('https://example.com/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    expect(res.status).toBe(401);
  });

  it('initialize returns capabilities + instructions', async () => {
    const res = await rpc(user(), { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    const json = (await res.json()) as RpcResponse;
    expect(json.result.serverInfo.name).toBe('pyramid-mcp');
    expect(json.result.capabilities.tools).toBeDefined();
    expect(json.result.protocolVersion).toBe('2025-06-18');
    expect(json.result.instructions).toContain('long-term memory');
    expect(json.result.instructions).toContain('record_observation');
    expect(json.result.instructions).toContain('active recollection'); // effortful-recall reinforcement nudge
    expect(json.result.instructions).toContain('deeper the compression'); // confidence legend for summary labels
    expect(json.result.instructions).toContain('cheap next time'); // recall-struggle recording nudge
    expect(json.result.instructions).toContain('enumerate the specific dated notes'); // no counting by vibes
  });

  it('notifications/initialized is a 202 with no body', async () => {
    const res = await rpc(user(), { jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res.status).toBe(202);
  });

  it('tools/list advertises the three reactive tools', async () => {
    const res = await rpc(user(), { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const json = (await res.json()) as RpcResponse;
    const names = json.result.tools.map((t: any) => t.name);
    expect(names).toEqual(expect.arrayContaining(['create_model', 'record_observation', 'update_model_description']));
    const rec = json.result.tools.find((t: any) => t.name === 'record_observation');
    expect(rec.inputSchema.required).toContain('text');
    expect(rec.inputSchema.required).toContain('models');
  });

  it('create_model then record_observation (multi-tag), and rejects unknown models', async () => {
    const u = user();
    const mk = await rpc(u, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'create_model', arguments: { name: 'coaching', description: 'coaching practice' } } });
    expect(((await mk.json()) as RpcResponse).result.content[0].text).toContain('ready');

    // Embedding rides env.AI; if it's unavailable the obs is stored without a
    // vector. Either way the record succeeds.
    const rec = await rpc(u, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'record_observation', arguments: { text: 'Eli closed Cristi at $4k/mo', models: ['user', 'coaching'] } } });
    const recText = ((await rec.json()) as RpcResponse).result.content[0].text;
    expect(recText).toContain('Recorded against');
    expect(recText).toContain('coaching');

    const bad = await rpc(u, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'record_observation', arguments: { text: 'x', models: ['nope'] } } });
    expect(((await bad.json()) as RpcResponse).result.content[0].text).toContain('Unknown model');
  });

  it('unknown tool yields a JSON-RPC error', async () => {
    const res = await rpc(user(), { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'does_not_exist', arguments: {} } });
    const json = (await res.json()) as RpcResponse;
    expect(json.error?.code).toBe(-32602);
  });

  it('tools/list includes recall and load_memory', async () => {
    const res = await rpc(user(), { jsonrpc: '2.0', id: 7, method: 'tools/list' });
    const names = ((await res.json()) as RpcResponse).result.tools.map((t: any) => t.name);
    expect(names).toContain('recall');
    expect(names).toContain('load_memory');
    expect(names).toContain('memory_stats');
  });

  it('memory_stats reports counts and size distribution', async () => {
    const u = user();
    await rpc(u, { jsonrpc: '2.0', id: 70, method: 'tools/call', params: { name: 'record_observation', arguments: { text: 'a short note about Eli', models: ['user'] } } });
    const res = await rpc(u, { jsonrpc: '2.0', id: 71, method: 'tools/call', params: { name: 'memory_stats', arguments: {} } });
    const text = ((await res.json()) as RpcResponse).result.content[0].text as string;
    expect(text).toMatch(/Observations: 1/);
    expect(text).toMatch(/Observations \(1\): min 22 chars/);
    expect(text).toMatch(/- user \[seed\]: 1 obs/);
  });

  it('recall returns a well-formed result (no BYOK key required)', async () => {
    // Embedding rides env.AI now — no per-user key gate. Whether the binding is
    // reachable in the test env or not, recall must return a valid content
    // payload (real hits, an empty-result message, or a graceful embed-error),
    // never the old "no key configured" rejection.
    const res = await rpc(user(), { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'recall', arguments: { query: 'what is the deal size' } } });
    const text = ((await res.json()) as RpcResponse).result.content[0].text;
    expect(typeof text).toBe('string');
    expect(text).not.toContain('no embedding key');
  });

  it('load_memory remembers a valid timezone and ignores an invalid one', async () => {
    const u = user();
    const stub = env.MEMORY_DO.get(env.MEMORY_DO.idFromName(u));
    await rpc(u, { jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'load_memory', arguments: { topics: [], timezone: 'Asia/Jerusalem' } } });
    expect(await stub.getTimezone()).toBe('Asia/Jerusalem');
    // An invalid name is rejected at set time; the stored one survives.
    await rpc(u, { jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'load_memory', arguments: { topics: [], timezone: 'Not/AZone' } } });
    expect(await stub.getTimezone()).toBe('Asia/Jerusalem');
    // Recent notes render local-day labels once the timezone is known.
    await rpc(u, { jsonrpc: '2.0', id: 22, method: 'tools/call', params: { name: 'record_observation', arguments: { text: 'a freshly recorded note about timezones', models: ['user'] } } });
    const res = await rpc(u, { jsonrpc: '2.0', id: 23, method: 'tools/call', params: { name: 'load_memory', arguments: { topics: [] } } });
    const text = ((await res.json()) as RpcResponse).result.content[0].text as string;
    expect(text).toMatch(/- \[just now\] a freshly recorded note/);
  });

  it('load_memory returns the index, recent notes, and a matched model view', async () => {
    const u = user();
    await rpc(u, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'create_model', arguments: { name: 'coaching', description: 'coaching practice' } } });
    await rpc(u, { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'record_observation', arguments: { text: 'Eli ran a strong coaching call with Cristi', models: ['coaching', 'user'] } } });

    const res = await rpc(u, { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'load_memory', arguments: { topics: ['coaching', 'some-free-text-topic'] } } });
    const text = ((await res.json()) as RpcResponse).result.content[0].text;
    expect(text).toContain('# Model index');
    expect(text).toContain('# Recent notes');
    expect(text).toContain('# Loaded models');
    expect(text).toContain('## coaching');
    expect(text).toContain('coaching call with Cristi');
  });

  it('load_memory shows summaries plus only the unsummarized verbatim tail', async () => {
    const u = user();
    const DAY = 86_400_000;
    const now = Date.now();
    await rpc(u, { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'create_model', arguments: { name: 'coaching', description: 'coaching practice' } } });

    // Seed pyramid state directly in the user's DO (same idFromName mapping the
    // worker uses): one old observation, rolled into a tier summary.
    const stub = env.MEMORY_DO.get(env.MEMORY_DO.idFromName(u));
    await stub.bulkLoad([], [{ text: 'ancient covered detail about Cristi pricing', timestamp: now - 10 * DAY, models: ['coaching'] }]);
    const m = await stub.getModel('coaching');
    const covered = (await stub.listObservationsForModel(m!.id))[0]!;
    await stub.insertSummary(m!.id, { tier: 0, text: 'Compressed arc: the Cristi engagement took shape.', startTimestamp: now - 10 * DAY, endTimestamp: now - 10 * DAY, sourceCount: 1 },
      [{ type: 'observation', id: covered.id }]);

    await rpc(u, { jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'record_observation', arguments: { text: 'Fresh note recorded after the summary', models: ['coaching'] } } });

    const res = await rpc(u, { jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'load_memory', arguments: { topics: ['coaching'] } } });
    const text = ((await res.json()) as RpcResponse).result.content[0].text;
    expect(text).toContain('Compressed arc');                       // summary carries the history
    expect(text).toContain('Fresh note recorded after the summary'); // unsummarized tail stays verbatim
    // The covered observation still shows — as part of the resolution ramp, marked as such.
    expect(text).toMatch(/· also summarized above\] ancient covered detail/);
  });
});

describe('MCP — pyramid growth through the tools', () => {
  it('record_observation triggers a bounded background advance; load_memory renders the cover + tail', async () => {
    const u = user();
    const stub = env.MEMORY_DO.get(env.MEMORY_DO.idFromName(u));
    await stub.enableStubSynthesis();
    await rpc(u, { jsonrpc: '2.0', id: 80, method: 'tools/call', params: { name: 'create_model', arguments: { name: 'proj', description: 'a project' } } });
    for (let i = 0; i < 12; i++) {
      await rpc(u, { jsonrpc: '2.0', id: 81, method: 'tools/call', params: { name: 'record_observation', arguments: { text: `note number ${i} about the project, distinct enough to pass dedup`, models: ['proj'] } } });
    }
    // The advance runs in the background (waitUntil); give it a moment, then also let load_memory trigger it.
    for (let tries = 0; tries < 20; tries++) {
      const m = await stub.getModel('proj');
      if ((await stub.listAllSummariesForModel(m!.id)).length > 0) break;
      await new Promise(r => setTimeout(r, 100));
      await stub.maybeResummarize(['proj']);
    }
    const res = await rpc(u, { jsonrpc: '2.0', id: 82, method: 'tools/call', params: { name: 'load_memory', arguments: { topics: ['proj'] } } });
    const text = ((await res.json()) as RpcResponse).result.content[0].text as string;
    expect(text).toMatch(/\[tier 0 · 10 obs · [\d.]+K?→[\d.]+K? chars · \d{4}-\d{2}-\d{2}–\d{4}-\d{2}-\d{2}/); // cover label: transitive obs count + compression
    expect(text).toContain('[stub tier0 tier 0 · 10 sources');                       // the summary text
    expect(text).toContain('note number 10 about');                                     // tail verbatim
    expect(text).toContain('note number 11 about');
    // Recent notes (the block between its header and '# Loaded models') is the newest across models, covered or not.
    const recent = text.slice(text.indexOf('# Recent notes'), text.indexOf('# Loaded models'));
    expect(recent).toContain('note number 11 about');
    expect(recent).toContain('note number 3 about');
    // The model view's verbatim tail: the 2 uncovered + 3 covered (ramp, V=5), never the oldest.
    const tail = text.slice(text.indexOf('Recent notes (verbatim):'));
    expect(tail).toContain('note number 10 about');
    expect(tail).toMatch(/also summarized above\] note number 9 about/);
    expect(tail).not.toContain('note number 0 about');
  });
});
