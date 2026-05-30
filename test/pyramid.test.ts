import { describe, it, expect } from 'vitest';
import { tierForAgeDays, bucketObservations, buildSynthJob, SUMMARY_TIERS } from '../src/pyramid.js';
import type { ModelRow, ObservationRow } from '../src/memory-do.js';

const NOW = Date.UTC(2026, 4, 30);
const DAY = 86_400_000;
const obs = (text: string, daysAgo: number): ObservationRow => ({ id: crypto.randomUUID(), text, timestamp: NOW - daysAgo * DAY, source: 'direct' });

describe('tierForAgeDays', () => {
  it('maps ages to concentric tiers', () => {
    expect(tierForAgeDays(5)).toBe(0);
    expect(tierForAgeDays(45)).toBe(1);
    expect(tierForAgeDays(200)).toBe(2);
    expect(tierForAgeDays(500)).toBe(3);
  });
});

describe('bucketObservations', () => {
  it('groups into non-empty tiers, sorted oldest-first within a tier', () => {
    const buckets = bucketObservations([obs('recent', 2), obs('mid', 50), obs('old', 200), obs('recent2', 10)], NOW);
    expect(buckets.map(b => b.tier.idx)).toEqual([0, 1, 2]); // no tier-3 → omitted
    const t0 = buckets.find(b => b.tier.idx === 0)!;
    expect(t0.observations.map(o => o.text)).toEqual(['recent2', 'recent']); // oldest-first: 10d before 2d
  });

  it('omits empty tiers entirely', () => {
    const buckets = bucketObservations([obs('a', 1), obs('b', 3)], NOW);
    expect(buckets.length).toBe(1);
    expect(buckets[0]!.tier.idx).toBe(0);
  });
});

describe('buildSynthJob', () => {
  const model: ModelRow = { id: 'm', name: 'cristi', description: 'The Cristi partnership', isSeed: false, archived: false, createdAt: NOW };
  it('produces a focus-aware prompt with the lens, window, and obs', () => {
    const buckets = bucketObservations([obs('signed the deal', 40), obs('first call', 60)], NOW);
    const job = buildSynthJob(model, buckets[0]!);
    expect(job.tier).toBe(1);
    expect(job.sourceCount).toBe(2);
    expect(job.system).toContain('SINGLE mental model');
    expect(job.user).toContain('Lens: The Cristi partnership');
    expect(job.user).toContain('cristi');
    expect(job.user).toContain('signed the deal');
    expect(job.startTs).toBeLessThan(job.endTs);
  });
});
