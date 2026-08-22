import { describe, it, expect } from 'vitest';
import {
  batchTier0, batchRollup, buildTier0Job, buildRollupJob, renderWithBudget, stubSynthesize,
  targetCharsForTier, ceilingTokensForTier, TIER0_MAX_OBS, TIER0_MAX_CHARS, ROLLUP_FAN_IN,
} from '../src/pyramid.js';
import type { ModelRow, ObservationRow, SummaryRow } from '../src/memory-do.js';

const NOW = Date.UTC(2026, 4, 30);
const DAY = 86_400_000;
const obs = (text: string, daysAgo: number): ObservationRow => ({ id: crypto.randomUUID(), text, timestamp: NOW - daysAgo * DAY, source: 'direct' });
const sum = (tier: number, startDaysAgo: number, endDaysAgo: number, text = 'summary'): SummaryRow =>
  ({ id: crypto.randomUUID(), tier, text, startTimestamp: NOW - startDaysAgo * DAY, endTimestamp: NOW - endDaysAgo * DAY, sourceCount: 5 });
const model: ModelRow = { id: 'm', name: 'cristi', description: 'The Cristi partnership', isSeed: false, archived: false, createdAt: NOW };

describe('batchTier0', () => {
  it('closes a batch at TIER0_MAX_OBS and leaves the partial tail pending, oldest first', () => {
    const many = Array.from({ length: 23 }, (_, i) => obs(`o${i}`, 100 - i));
    const { batches, pending } = batchTier0(many.reverse()); // input order shouldn't matter
    expect(batches.length).toBe(2);
    expect(batches[0]!.length).toBe(TIER0_MAX_OBS);
    expect(batches[0]!.map(o => o.text)).toEqual(Array.from({ length: 10 }, (_, i) => `o${i}`)); // oldest first
    expect(pending.map(o => o.text)).toEqual(['o20', 'o21', 'o22']);
  });

  it('closes a batch at TIER0_MAX_CHARS even with few observations', () => {
    const big = Array.from({ length: 4 }, (_, i) => obs('x'.repeat(3000), 10 - i));
    const { batches, pending } = batchTier0(big);
    expect(batches.length).toBe(1);        // 3 × 3000 ≥ 8000 closes after the third
    expect(batches[0]!.length).toBe(3);
    expect(pending.length).toBe(1);
  });

  it('a single oversize observation forms a batch by itself', () => {
    const { batches, pending } = batchTier0([obs('y'.repeat(TIER0_MAX_CHARS + 1), 5), obs('small', 4)]);
    expect(batches.length).toBe(1);
    expect(batches[0]!.length).toBe(1);
    expect(pending.map(o => o.text)).toEqual(['small']);
  });

  it('has no time rule: sparse old observations stay pending until the batch fills', () => {
    const { batches, pending } = batchTier0([obs('a', 400), obs('b', 300), obs('c', 2)]);
    expect(batches.length).toBe(0);
    expect(pending.length).toBe(3);
  });
});

describe('batchRollup', () => {
  it('groups exactly ROLLUP_FAN_IN oldest-first and leaves the remainder', () => {
    const s = Array.from({ length: 12 }, (_, i) => sum(0, 120 - i * 10, 111 - i * 10, `s${i}`));
    const groups = batchRollup([...s].reverse());
    expect(groups.length).toBe(2);
    expect(groups[0]!.map(x => x.text)).toEqual(['s0', 's1', 's2', 's3', 's4']);
    expect(groups[1]!.length).toBe(ROLLUP_FAN_IN);
  });
  it('returns nothing below the fan-in', () => {
    expect(batchRollup([sum(0, 10, 5), sum(0, 4, 1)])).toEqual([]);
  });
});

describe('prompts', () => {
  it('tier-0 job carries lens, window, every observation, target length, and provenance ids', () => {
    const batch = [obs('first call', 60), obs('signed the deal', 40)];
    const job = buildTier0Job(model, batch);
    expect(job.kind).toBe('tier0');
    expect(job.tier).toBe(0);
    expect(job.user).toContain('Purpose: The Cristi partnership');
    expect(job.user).toContain('first call');
    expect(job.user).toContain('signed the deal');
    expect(job.user).toContain(`~${targetCharsForTier(0)}-character`);
    expect(job.system).toContain('date ranges');
    expect(job.system).toContain('never invent');
    expect(job.sourceIds).toEqual(batch.map(o => o.id));
    expect(job.startTs).toBeLessThan(job.endTs);
    expect(job.maxTokens).toBe(ceilingTokensForTier(0));
  });

  it('rollup job is one tier up, built only from summaries, with their ranges', () => {
    const kids = Array.from({ length: 5 }, (_, i) => sum(1, 100 - i * 10, 95 - i * 10, `child ${i}`));
    const job = buildRollupJob(model, kids);
    expect(job.kind).toBe('rollup');
    expect(job.tier).toBe(2);
    expect(job.user).toContain('tier-1 summaries');
    expect(job.user).toContain('child 0');
    expect(job.user).toContain(`~${targetCharsForTier(2)}-character`);
    expect(job.sourceIds.length).toBe(5);
    expect(job.startTs).toBe(kids[0]!.startTimestamp);
    expect(job.endTs).toBe(kids[4]!.endTimestamp);
  });

  it('ceiling is a safety net well above target (≈2.5x), and targets grow with depth', () => {
    expect(targetCharsForTier(0)).toBeLessThan(targetCharsForTier(1));
    expect(targetCharsForTier(2)).toBeLessThan(targetCharsForTier(3));
    expect(targetCharsForTier(7)).toBe(targetCharsForTier(3));
    expect(ceilingTokensForTier(0) * 3.5).toBeGreaterThan(targetCharsForTier(0) * 2);
  });

  it('stub synthesis is deterministic and within target', () => {
    const job = buildTier0Job(model, [obs('alpha', 3), obs('beta', 2)]);
    const a = stubSynthesize(job), b = stubSynthesize(job);
    expect(a).toBe(b);
    expect(a).toContain('tier 0');
    expect(a).toContain('2 sources');
    expect(a.length).toBeLessThanOrEqual(job.targetChars);
  });
});

describe('renderWithBudget', () => {
  it('keeps the top tier always, then newest lower summaries, then newest observations; output chronological', () => {
    const top = sum(2, 300, 100, 'T'.repeat(100));
    const lowOld = sum(1, 99, 60, 'L'.repeat(100));
    const lowNew = sum(0, 59, 30, 'N'.repeat(100));
    const tail = [obs('o'.repeat(100), 20), obs('p'.repeat(100), 10), obs('q'.repeat(100), 1)];
    // Budget 250 fits top (100) + the newest lower (100); the older lower would
    // overflow; observations then get the at-least-one guarantee only.
    const v = renderWithBudget([lowOld, top, lowNew], tail, 250);
    expect(v.summaries.map(s => s.text[0])).toEqual(['T', 'N']); // top always; newest lower first; chronological output
    expect(v.observations.map(o => o.text[0])).toEqual(['q']);   // newest observation survives even over budget
    expect(v.droppedSummaries).toBe(1);
    expect(v.droppedObservations).toBe(2);

    // Budget 400 fits all three summaries and one observation.
    const w = renderWithBudget([lowOld, top, lowNew], tail, 400);
    expect(w.summaries.map(s => s.text[0])).toEqual(['T', 'L', 'N']);
    expect(w.observations.map(o => o.text[0])).toEqual(['q']);
  });
  it('with a generous budget nothing is dropped', () => {
    const v = renderWithBudget([sum(0, 10, 5, 'a'), sum(0, 4, 2, 'b')], [obs('c', 1)], 16_000);
    expect(v.droppedSummaries).toBe(0);
    expect(v.droppedObservations).toBe(0);
    expect(v.summaries.map(s => s.text)).toEqual(['a', 'b']);
  });
  it('always keeps at least one observation when there are no summaries', () => {
    const v = renderWithBudget([], [obs('z'.repeat(500), 1)], 100);
    expect(v.observations.length).toBe(1);
  });
});
