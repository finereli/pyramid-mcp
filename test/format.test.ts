import { describe, it, expect } from 'vitest';
import {
  formatConfidenceMeta,
  formatRecall,
  formatRecentNotes,
  formatModelIndex,
  formatModelView,
} from '../src/format.js';
import type { ModelRow, ObservationRow, ObservationMatch } from '../src/memory-do.js';

const NOW = Date.UTC(2026, 4, 30); // 2026-05-30
const DAY = 86_400_000;

describe('formatConfidenceMeta', () => {
  it('handles the empty model', () => {
    expect(formatConfidenceMeta('x', { obsCount: 0, earliest: null, latest: null }, NOW)).toBe('[x · 0 obs]');
  });
  it('reports span and recency', () => {
    const s = formatConfidenceMeta('client-cristi', { obsCount: 5, earliest: NOW - 90 * DAY, latest: NOW }, NOW);
    expect(s).toBe('[client-cristi · 5 obs · spans 3mo · latest 2026-05-30 (today)]');
  });
  it('says yesterday for 1 day ago', () => {
    const s = formatConfidenceMeta('m', { obsCount: 2, earliest: NOW - 3 * DAY, latest: NOW - DAY }, NOW);
    expect(s).toContain('(yesterday)');
    expect(s).toContain('spans 2d');
  });
});

describe('formatRecentNotes', () => {
  const obs = (t: string, ts: number): ObservationRow => ({ id: crypto.randomUUID(), text: t, timestamp: ts, source: 'direct' });
  it('returns empty for no obs', () => {
    expect(formatRecentNotes([])).toBe('');
  });
  it('caps by character budget but always keeps at least one', () => {
    const big = obs('x'.repeat(500), NOW);
    const out = formatRecentNotes([big, obs('y'.repeat(500), NOW - DAY)], 100);
    expect(out.split('\n').length).toBe(1); // only the first fits
  });
});

describe('formatRecall', () => {
  it('numbers and dates matches', () => {
    const m: ObservationMatch[] = [{ id: 'a', text: 'closed at $4k', timestamp: NOW, score: 0.1 }];
    expect(formatRecall(m)).toBe('[1] [2026-05-30] closed at $4k');
  });
  it('handles no matches', () => {
    expect(formatRecall([])).toBe('No relevant memories found.');
  });
});

describe('formatModelIndex / formatModelView', () => {
  const model: ModelRow = { id: 'm1', name: 'coaching', description: 'coaching practice', isSeed: false, archived: false, createdAt: NOW };
  it('lists models sorted', () => {
    const out = formatModelIndex([model]);
    expect(out).toContain('# Model index');
    expect(out).toContain('- coaching: coaching practice');
  });
  it('renders a view with confidence + verbatim notes', () => {
    const out = formatModelView(
      model,
      { obsCount: 1, earliest: NOW, latest: NOW },
      [],
      [{ id: 'o1', text: 'first note', timestamp: NOW, source: 'direct' }],
      NOW,
    );
    expect(out).toContain('## coaching — coaching practice');
    expect(out).toContain('Recent notes (verbatim):');
    expect(out).toContain('first note');
  });
});
