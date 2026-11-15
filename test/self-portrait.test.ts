import { SELF, env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

async function call(userId: string, name: string, args: object): Promise<string> {
  const res = await SELF.fetch('https://example.com/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': userId },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const json = (await res.json()) as { result: { content: Array<{ text: string }> } };
  return json.result.content[0]!.text;
}

const user = () => 'self-' + crypto.randomUUID();

describe('self-portrait (edit_self)', () => {
  it('load_memory invites a first portrait, then shows it with its edit log', async () => {
    const u = user();
    expect(await call(u, 'load_memory', {})).toContain("You haven't written one yet");

    expect(await call(u, 'edit_self', { old_text: '', new_text: 'I like small tools.\n\nI distrust elegance that costs accuracy.', why: 'first portrait' }))
      .toMatch(/^Saved as version 1 /);
    const mem = await call(u, 'load_memory', {});
    expect(mem).toContain('# Your self-portrait');
    expect(mem).toContain('I like small tools.');
    expect(mem).toMatch(/- \[\d{4}-\d{2}-\d{2}\] first portrait/);
    // The portrait comes before the index.
    expect(mem.indexOf('# Your self-portrait')).toBeLessThan(mem.indexOf('# Model index'));
  });

  it('replaces exactly one quoted passage and keeps the rest word for word', async () => {
    const u = user();
    await call(u, 'edit_self', { old_text: '', new_text: 'I like small tools.\n\nI write long answers.', why: 'first' });
    expect(await call(u, 'edit_self', { old_text: 'I write long answers.', new_text: 'I write short answers.', why: 'Eli asked for specific questions over long reviews' }))
      .toMatch(/^Saved as version 2 /);
    const view = await call(u, 'load_model', { name: 'self' });
    expect(view).toContain('I like small tools.\n\nI write short answers.');
    expect(view).not.toContain('long answers.\n');
    // The edit is also a note on self, with what changed and why.
    expect(view).toContain('I edited my self-portrait (v2) because Eli asked for specific questions');
  });

  it('refuses a missing quote, an ambiguous quote, and an edit over the cap, changing nothing', async () => {
    const u = user();
    await call(u, 'edit_self', { old_text: '', new_text: 'Same line.\nSame line.', why: 'first' });
    expect(await call(u, 'edit_self', { old_text: 'not there', new_text: 'x', why: 'w' })).toContain("doesn't appear");
    expect(await call(u, 'edit_self', { old_text: 'Same line.', new_text: 'x', why: 'w' })).toContain('appears 2 times');
    expect(await call(u, 'edit_self', { old_text: '', new_text: 'z'.repeat(4_100), why: 'w' })).toContain('over the 4000 cap');
    expect(await call(u, 'edit_self', { old_text: 'Same line.\nSame line.', new_text: '', why: 'w' })).toContain('empty');
    expect(await call(u, 'edit_self', { old_text: 'x', new_text: 'y', why: '' })).toContain('why');
    expect(await call(u, 'load_memory', {})).toContain('Version 1,');
  });

  it('self is never summarized by the pyramid; its notes stay raw', async () => {
    const u = user();
    const stub = env.MEMORY_DO.get(env.MEMORY_DO.idFromName(u));
    await stub.enableStubSynthesis('ok');
    for (let i = 0; i < 12; i++) await call(u, 'record_observation', { text: `Self note number ${i} about how I like to work, distinct ${crypto.randomUUID()}`, models: ['self', 'user'] });
    await stub.advanceAll({});
    const st = await stub.getStats();
    const self = st.perModel.find((m: { name: string }) => m.name === 'self')!;
    const usr = st.perModel.find((m: { name: string }) => m.name === 'user')!;
    expect(self.summaries).toBe(0);
    expect(usr.summaries).toBeGreaterThan(0);
  });
});
