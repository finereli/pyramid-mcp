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
