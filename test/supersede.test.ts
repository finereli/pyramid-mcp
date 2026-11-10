import { SELF, env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { buildTier0Job, SUPERSEDED_MARK } from '../src/pyramid.js';
import { formatRecall } from '../src/format.js';
import type { ModelRow, ObservationRow } from '../src/memory-do.js';

function freshUser() {
  return env.MEMORY_DO.get(env.MEMORY_DO.idFromName('sup-' + crypto.randomUUID()));
}

async function call(userId: string, name: string, args: object): Promise<string> {
  const res = await SELF.fetch('https://example.com/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': userId },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  return ((await res.json()) as any).result.content[0].text as string;
}

describe('supersession — storage', () => {
  it('finds live notes by quote, case-insensitively, and hides superseded ones from current views', async () => {
    const u = freshUser();
    const old = await u.addObservation('Layout set to scrolling columns on workspace one', ['user']);
    const fix = await u.addObservation('Layout back to dwindle — scrolling wrecked it', ['user']);
    if (!old.ok || !fix.ok) throw new Error('setup');

    const hits = await u.findObservationsByQuote('SCROLLING COLUMNS');
    expect(hits.map(h => h.id)).toEqual([old.id]);

    expect(await u.markSuperseded([old.id], fix.id)).toBe(1);
    expect(await u.markSuperseded([old.id], fix.id)).toBe(0); // idempotent
    expect((await u.findObservationsByQuote('scrolling columns')).length).toBe(0); // no longer live

    const recent = await u.recentObservations(10);
    expect(recent.map(o => o.id)).toEqual([fix.id]);

    const user = await u.getModel('user');
    const view = await u.listViewForModel(user!.id);
    expect(view.observations.map(o => o.id)).toEqual([fix.id]);

    // Still in the store: the raw listing keeps both.
    expect((await u.listObservationsForModel(user!.id)).length).toBe(2);
    expect([...(await u.supersededAmong([old.id, fix.id]))]).toEqual([old.id]);
  });
});

describe('supersession — tier-0 prompt', () => {
  const model: ModelRow = { id: 'm', name: 'desk', description: 'desktop setup', isSeed: false, archived: false, createdAt: 0 };
  const o = (id: string, text: string, ts: number): ObservationRow => ({ id, text, timestamp: ts, source: 'direct' });
  it('marks superseded observations as history, and says nothing when there are none', () => {
    const batch = [o('a', 'set scrolling', 1), o('b', 'back to dwindle', 2)];
    const marked = buildTier0Job(model, batch, new Set(['a']));
    expect(marked.user).toContain(`${SUPERSEDED_MARK} set scrolling`);
    expect(marked.user).not.toContain(`${SUPERSEDED_MARK} back to dwindle`);
    expect(marked.user).toContain("Don't present them as current");
    const plain = buildTier0Job(model, batch);
    expect(plain.user).not.toContain('SUPERSEDED');
    expect(plain.sourceIds).toEqual(['a', 'b']); // still summarized exactly once
  });
});

describe('supersession — recall label', () => {
  it('labels a superseded receipt with when and by what', () => {
    const out = formatRecall([{
      id: 'x', text: 'old setting', timestamp: Date.UTC(2026, 10, 9), score: 0.2, kind: 'observation',
      supersededBy: { timestamp: Date.UTC(2026, 10, 10), text: 'new setting' },
    }]);
    expect(out).toBe('[1] [2026-11-09 · SUPERSEDED on 2026-11-10 by: "new setting"] old setting');
  });
});

describe('supersession — record_observation', () => {
  it('records a correction and supersedes the quoted note', async () => {
    const u = 'sup-mcp-' + crypto.randomUUID();
    await call(u, 'record_observation', { text: 'Tom wants split_width_multiplier set to 1.5', models: ['user'] });
    const out = await call(u, 'record_observation', {
      text: 'Tom wants tiling left at the default: removed split_width_multiplier',
      models: ['user'],
      supersedes: ['multiplier set to 1.5'],
    });
    expect(out).toContain('Recorded against: user.');
    expect(out).toContain('Superseded 1 earlier note.');
    const lm = await call(u, 'load_memory', {});
    const recent = lm.slice(lm.indexOf('# Recent notes'), lm.indexOf('# Loaded model'));
    expect(recent).toContain('left at the default');
    expect(recent).not.toContain('set to 1.5');
  });

  it('records nothing when a quote is ambiguous, missing, or too short', async () => {
    const u = 'sup-mcp-' + crypto.randomUUID();
    await call(u, 'record_observation', { text: 'Workspace one has Claude on the left half', models: ['user'] });
    await call(u, 'record_observation', { text: 'Workspace one has Spotify as a narrow strip', models: ['user'] });

    const ambiguous = await call(u, 'record_observation', { text: 'Workspace one rebuilt from scratch', models: ['user'], supersedes: ['Workspace one has'] });
    expect(ambiguous).toContain('matches 2 notes');
    expect(ambiguous).toContain('Nothing was recorded.');

    const missing = await call(u, 'record_observation', { text: 'Workspace one rebuilt again', models: ['user'], supersedes: ['this phrase is nowhere'] });
    expect(missing).toContain('No current note contains');

    const short = await call(u, 'record_observation', { text: 'Workspace one rebuilt once more', models: ['user'], supersedes: ['Claude'] });
    expect(short).toContain('too short');

    const stub = env.MEMORY_DO.get(env.MEMORY_DO.idFromName(u));
    expect((await stub.recentObservations(10)).length).toBe(2); // none of the three got in
  });
});
