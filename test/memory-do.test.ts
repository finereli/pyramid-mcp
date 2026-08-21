import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

/** Fresh isolated DO per test — unique name → fresh SQLite + seed. */
function freshUser() {
  const id = env.MEMORY_DO.idFromName('user-' + crypto.randomUUID());
  return env.MEMORY_DO.get(id);
}

describe('MemoryDO storage', () => {
  it('seeds the five base models on first use, all marked seed', async () => {
    const u = freshUser();
    const models = await u.listModels();
    expect(models.map(m => m.name).sort()).toEqual(['memory', 'self', 'system', 'user', 'world']);
    expect(models.every(m => m.isSeed)).toBe(true);
  });

  it('upserts models by name (same id, updated description)', async () => {
    const u = freshUser();
    const id1 = await u.createModel('client-cristi', 'Cristi engagement');
    const id2 = await u.createModel('client-cristi', 'Cristi engagement — updated terms');
    expect(id1).toBe(id2);
    const m = await u.getModel('client-cristi');
    expect(m?.description).toContain('updated');
  });

  it('records multi-tag observations and rejects unknown model names', async () => {
    const u = freshUser();
    await u.createModel('coaching', 'coaching practice');

    const bad = await u.addObservation('should fail', ['coaching', 'does-not-exist']);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.unknown).toEqual(['does-not-exist']);

    const ok = await u.addObservation('Eli closed the Cristi deal at $4k/mo + 10% rev share', ['user', 'coaching']);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.tagged.sort()).toEqual(['coaching', 'user']);
      const user = await u.getModel('user');
      const obs = await u.listObservationsForModel(user!.id);
      expect(obs.length).toBe(1);
      expect(obs[0]!.text).toContain('$4k/mo');
    }
  });

  it('dedups identical-prefix observations recorded within 24h', async () => {
    const u = freshUser();
    const text = 'A sufficiently long observation prefix that should be caught by the deduper on repeat';
    const a = await u.addObservation(text, ['user']);
    const b = await u.addObservation(text, ['user']);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.deduped).toBe(true);
    const user = await u.getModel('user');
    const obs = await u.listObservationsForModel(user!.id);
    expect(obs.length).toBe(1);
  });

  it('reports confidence and stats', async () => {
    const u = freshUser();
    await u.addObservation('first thing worth remembering about Eli', ['user']);
    await u.addObservation('second distinct thing worth remembering', ['user']);
    const user = await u.getModel('user');
    const conf = await u.getModelConfidence(user!.id);
    expect(conf.obsCount).toBe(2);
    expect(conf.earliest).not.toBeNull();

    const stats = await u.getStats();
    expect(stats.models).toBe(5);
    expect(stats.observations).toBe(2);
    expect(stats.observationSize.count).toBe(2);
    expect(stats.observationSize.minChars).toBe('first thing worth remembering about Eli'.length);
    expect(stats.observationSize.maxChars).toBe('second distinct thing worth remembering'.length);
    expect(stats.observationSize.meanTokens).toBe(Math.round(stats.observationSize.meanChars / 4));
    expect(stats.summarySize.count).toBe(0);
    const userRow = stats.perModel.find(m => m.name === 'user')!;
    expect(userRow.observations).toBe(2);
    expect(userRow.seed).toBe(true);
    expect(userRow.observationChars).toBe(stats.observationSize.totalChars);
    expect(userRow.summaries).toBe(0);
    expect(userRow.topTier).toBe(-1);
    expect(stats.perModel[0]!.name).toBe('user');
  });

  it('recentObservations returns newest-first across all models', async () => {
    const u = freshUser();
    await u.addObservation('older note', ['world']);
    await u.addObservation('newer note', ['world']);
    const recent = await u.recentObservations(10);
    expect(recent[0]!.text).toBe('newer note');
    expect(recent[1]!.text).toBe('older note');
  });
});

describe('summary coverage — verbatim tails exclude summarized observations', () => {
  const DAY = 86_400_000;

  it('listObservationsForModel with afterTs returns only the unsummarized tail', async () => {
    const u = freshUser();
    const now = Date.now();
    await u.bulkLoad(
      [{ name: 'proj', description: 'a project' }],
      [
        { text: 'old obs one', timestamp: now - 10 * DAY, models: ['proj'] },
        { text: 'old obs two', timestamp: now - 8 * DAY, models: ['proj'] },
        { text: 'fresh obs', timestamp: now - DAY, models: ['proj'] },
      ],
    );
    const m = await u.getModel('proj');
    await u.insertSummary(m!.id, { tier: 0, text: 'the compressed arc', startTimestamp: now - 10 * DAY, endTimestamp: now - 8 * DAY, sourceCount: 2 });

    // Synthesis path (no afterTs) still sees everything.
    const all = await u.listObservationsForModel(m!.id);
    expect(all.length).toBe(3);

    // Read path: only what the summary hasn't rolled up. The boundary is
    // strict — an obs stamped exactly at end_timestamp is covered.
    const tail = await u.listObservationsForModel(m!.id, 15, now - 8 * DAY);
    expect(tail.map(o => o.text)).toEqual(['fresh obs']);
  });

  it('recentObservations skips observations every tagged model has summarized', async () => {
    const u = freshUser();
    const now = Date.now();
    await u.bulkLoad(
      [{ name: 'a', description: 'A' }, { name: 'b', description: 'B' }],
      [
        { text: 'covered everywhere', timestamp: now - 10 * DAY, models: ['a'] },
        { text: 'covered in a but not b', timestamp: now - 9 * DAY, models: ['a', 'b'] },
        { text: 'not covered at all', timestamp: now - DAY, models: ['a'] },
      ],
    );
    const a = await u.getModel('a');
    await u.insertSummary(a!.id, { tier: 0, text: 'arc of a', startTimestamp: now - 10 * DAY, endTimestamp: now - 9 * DAY, sourceCount: 2 });

    const texts = (await u.recentObservations(10)).map(o => o.text);
    expect(texts).toContain('not covered at all');
    expect(texts).toContain('covered in a but not b'); // b hasn't summarized it yet
    expect(texts).not.toContain('covered everywhere');

    // Once b's pyramid covers it too, the dual-tagged obs drops out as well.
    const b = await u.getModel('b');
    await u.insertSummary(b!.id, { tier: 0, text: 'arc of b', startTimestamp: now - 9 * DAY, endTimestamp: now - 9 * DAY, sourceCount: 1 });
    const texts2 = (await u.recentObservations(10)).map(o => o.text);
    expect(texts2).not.toContain('covered in a but not b');
  });
});
