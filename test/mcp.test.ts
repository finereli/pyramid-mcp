import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

interface RpcResponse {
  jsonrpc: string;
  id: number | string | null;
  result?: any;
  error?: { code: number; message: string };
}

async function rpc(userId: string, body: object, openaiKey?: string): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-user-id': userId,
  };
  if (openaiKey) headers['x-openai-key'] = openaiKey;
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
    expect(json.result.instructions).toContain('WORK for it'); // effortful-recall reinforcement nudge
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

    // No OpenAI key in test → stored without embedding, still recorded.
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
  });

  it('recall without an embedding key fails gracefully', async () => {
    const res = await rpc(user(), { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'recall', arguments: { query: 'what is the deal size' } } });
    const text = ((await res.json()) as RpcResponse).result.content[0].text;
    expect(text).toContain('unavailable');
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
});
