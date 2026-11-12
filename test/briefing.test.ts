import { SELF, env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { formatModelIndex, formatLoops, INDEX_DESC_CHARS } from '../src/format.js';
import { buildTier0Job, buildDayDigestJob, ROLLUP_SYSTEM } from '../src/pyramid.js';
import type { ModelRow } from '../src/memory-do.js';

async function call(userId: string, name: string, args: object): Promise<string> {
  const res = await SELF.fetch('https://example.com/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': userId },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  return ((await res.json()) as any).result.content[0].text as string;
}
const fresh = () => 'brief-' + crypto.randomUUID();

describe('pins', () => {
  it('pin, reword, unpin — and pins lead the briefing verbatim', async () => {
    const u = fresh();
    expect(await call(u, 'pin', { text: 'Always say "I" about myself, never "that version of me".' })).toBe('Pinned as p1.');
    expect(await call(u, 'pin', { text: 'No animated wallpapers.' })).toBe('Pinned as p2.');
    expect(await call(u, 'pin', { text: 'No animated or striking wallpapers; lead with muted options.', replaces: 'p2' })).toBe('Reworded pin p2.');
    expect(await call(u, 'pin', { text: 'x', replaces: 'p9' })).toBe('No current pin p9.');
    expect(await call(u, 'pin', { text: 'x', replaces: 'banana' })).toContain("isn't a pin id");

    let lm = await call(u, 'load_memory', {});
    expect(lm.startsWith('# Pinned')).toBe(true);
    expect(lm).toContain('- [p1] Always say "I" about myself');
    expect(lm).toContain('- [p2] No animated or striking wallpapers; lead with muted options.');
    expect(lm).not.toContain('- [p2] No animated wallpapers.');

    expect(await call(u, 'unpin', { id: '1' })).toBe('Unpinned p1.');
    expect(await call(u, 'unpin', { id: 'p1' })).toBe('No current pin p1.');
    lm = await call(u, 'load_memory', {});
    expect(lm).not.toContain('[p1]');
    expect(lm).toContain('[p2]');
  });

  it('no pins, no pinned section', async () => {
    const lm = await call(fresh(), 'load_memory', {});
    expect(lm).not.toContain('# Pinned');
  });
});

describe('open loops', () => {
  it('open, list, close with an outcome, and show recently closed', async () => {
    const u = fresh();
    expect(await call(u, 'open_loop', { text: 'Remove the temporary suno.debugLoad command before committing Hum' })).toBe('Opened loop l1.');
    expect(await call(u, 'open_loop', { text: 'Push tom/memory-improvements and open a PR for Eli' })).toBe('Opened loop l2.');
    let lm = await call(u, 'load_memory', {});
    expect(lm).toContain('# Open loops');
    expect(lm).toMatch(/- \[l1 · since \d{4}-\d{2}-\d{2}\] Remove the temporary suno\.debugLoad/);

    expect(await call(u, 'close_loop', { id: 'l1', outcome: 'removed in 4f2a1c0' })).toBe('Closed l1: Remove the temporary suno.debugLoad command before committing Hum');
    expect(await call(u, 'close_loop', { id: 'l1' })).toBe('No open loop l1.');
    lm = await call(u, 'load_memory', {});
    const loops = lm.slice(lm.indexOf('# Open loops'));
    expect(loops).toMatch(/- \[l2 · since/);
    expect(loops).toMatch(/Recently closed:\n- \[l1 · closed \d{4}-\d{2}-\d{2}\] Remove the temporary .* → removed in 4f2a1c0/);
  });

  it('formatLoops says none open when only closed ones remain', () => {
    const out = formatLoops([], [{ id: 3, text: 'done thing', openedAt: 0, closedAt: Date.UTC(2026, 10, 12), outcome: null }]);
    expect(out).toContain('_None open._');
    expect(out).toContain('- [l3 · closed 2026-11-12] done thing');
  });
});

describe('quiet notes', () => {
  it('a quiet note stays out of recent notes and model views, never gets summarized, and recall labels it', async () => {
    const u = fresh();
    await call(u, 'record_observation', { text: 'Tom fixed the F keys with fnmode=3', models: ['user'] });
    expect(await call(u, 'record_observation', { text: 'Tom told me something tender about his first crush', models: ['user'], quiet: true }))
      .toBe('Recorded quietly against: user.');
    const lm = await call(u, 'load_memory', {});
    expect(lm).toContain('fnmode=3');
    expect(lm).not.toContain('first crush');
    expect(await call(u, 'load_model', { name: 'user' })).not.toContain('first crush');

    const stub = env.MEMORY_DO.get(env.MEMORY_DO.idFromName(u));
    const user = await stub.getModel('user');
    expect((await stub.unsummarizedObservations(user!.id)).map(o => o.text)).toEqual(['Tom fixed the F keys with fnmode=3']);
  });

  it('make_quiet quiets an existing note by quote, and says when a summary already holds it', async () => {
    const u = fresh();
    await call(u, 'record_observation', { text: 'Tom shared how his grandmother is doing in hospital', models: ['user'] });
    expect(await call(u, 'make_quiet', { quotes: ['grandmother is doing'] })).toBe('Made 1 note quiet.');
    expect(await call(u, 'load_memory', {})).not.toContain('grandmother');
    expect(await call(u, 'make_quiet', { quotes: ['nowhere at all in memory'] })).toContain('Nothing was changed.');
    expect(await call(u, 'make_quiet', { quotes: ['short'] })).toContain('too short');
  });

  it('recall marks quiet matches', async () => {
    const { formatRecall } = await import('../src/format.js');
    expect(formatRecall([{ id: 'q', text: 'private', timestamp: Date.UTC(2026, 10, 12), score: 0.1, kind: 'observation', quiet: true }]))
      .toBe('[1] [2026-11-12 · quiet] private');
  });
});

describe('lighter briefing', () => {
  it('orders pins, loops, recent notes, compact core, then the index', async () => {
    const u = fresh();
    await call(u, 'pin', { text: 'Stop-coding rule holds until he sleeps.' });
    await call(u, 'open_loop', { text: 'Run the Pyramid tests on the laptop' });
    await call(u, 'record_observation', { text: 'Tom asked for the round-2 Pyramid list', models: ['memory'] });
    const lm = await call(u, 'load_memory', {});
    const at = (h: string) => lm.indexOf(h);
    expect(at('# Pinned')).toBe(0);
    expect(at('# Pinned') < at('# Open loops')).toBe(true);
    expect(at('# Open loops') < at('# Recent notes')).toBe(true);
    expect(at('# Recent notes') < at('# Core model (compact)')).toBe(true);
    expect(at('# Core model (compact)') < at('# Model index')).toBe(true);
  });

  it('cuts long model descriptions in the index at a word boundary', () => {
    const long = 'Tom\'s shader pack project: editing BSL (Iris-compatible, modern Minecraft) into a fullbright/no-shadow edit that keeps sky, water, waving foliage and strips shadow map darkening.';
    const models: ModelRow[] = [{ id: 'a', name: 'bsl', description: long, isSeed: false, archived: false, createdAt: 0 }];
    const line = formatModelIndex(models).split('\n').find(l => l.startsWith('- bsl'))!;
    const desc = line.slice('- bsl: '.length);
    expect(desc.endsWith('…')).toBe(true);
    expect(desc.length).toBeLessThanOrEqual(INDEX_DESC_CHARS + 1);
    expect(long.startsWith(desc.slice(0, -1))).toBe(true);
  });
});

describe('diary-voice prompts', () => {
  const model: ModelRow = { id: 'm', name: 'user', description: 'the human', isSeed: true, archived: false, createdAt: 0 };
  it('every summary prompt asks for first person and meaning, and bans the book-report frame', () => {
    const t0 = buildTier0Job(model, [{ id: 'a', text: 'x', timestamp: 1, source: 'direct' }]);
    for (const sys of [t0.system, ROLLUP_SYSTEM]) {
      expect(sys).toContain('first person as the agent ("I")');
      expect(sys).toContain('Keep what things meant');
      expect(sys).toContain('navigated');
    }
    expect(buildDayDigestJob('2026-11-12', [{ id: 'a', text: 'x', timestamp: 1, source: 'direct' }]).system).toContain('first person');
  });
});
