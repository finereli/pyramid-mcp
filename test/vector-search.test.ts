import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

function freshUser() {
  const id = env.MEMORY_DO.idFromName('vec-' + crypto.randomUUID());
  return env.MEMORY_DO.get(id);
}

describe('in-DO cosine search', () => {
  it('ranks the most similar embedded observation first', async () => {
    const u = freshUser();
    // Synthetic 4-dim vectors (not pre-normalized — the DO normalizes on store).
    await u.addObservation('aligned with query', ['world'], 'direct', [0.9, 0.1, 0, 0]);
    await u.addObservation('orthogonal', ['world'], 'direct', [0, 1, 0, 0]);
    await u.addObservation('off-axis', ['world'], 'direct', [0.2, 0, 0.9, 0]);

    const hits = await u.searchObservations([1, 0, 0, 0], 10, 0); // pure similarity
    expect(hits[0]!.text).toBe('aligned with query');
    expect(hits.length).toBe(3);
    // scores ascend (lower = closer)
    expect(hits[0]!.score).toBeLessThanOrEqual(hits[1]!.score);
    expect(hits[1]!.score).toBeLessThanOrEqual(hits[2]!.score);
  });

  it('excludes observations that have no embedding', async () => {
    const u = freshUser();
    await u.addObservation('embedded', ['world'], 'direct', [1, 0, 0, 0]);
    await u.addObservation('not embedded', ['world']); // no vector
    const hits = await u.searchObservations([1, 0, 0, 0], 10, 0);
    expect(hits.map(h => h.text)).toEqual(['embedded']);
  });

  it('idsMissingEmbedding finds the un-embedded ones for backfill', async () => {
    const u = freshUser();
    await u.addObservation('has vector', ['world'], 'direct', [1, 0, 0, 0]);
    await u.addObservation('needs vector', ['world']);
    const missing = await u.idsMissingEmbedding();
    expect(missing.map(m => m.text)).toEqual(['needs vector']);
  });

  it('can backfill an embedding after the fact', async () => {
    const u = freshUser();
    const res = await u.addObservation('backfill me', ['world']);
    expect(res.ok).toBe(true);
    if (res.ok) {
      await u.setObservationEmbedding(res.id, [1, 0, 0, 0]);
      const hits = await u.searchObservations([1, 0, 0, 0], 10, 0);
      expect(hits.map(h => h.text)).toContain('backfill me');
    }
  });
});
