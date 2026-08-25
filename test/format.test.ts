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
    const m: ObservationMatch[] = [{ id: 'a', text: 'closed at $4k', timestamp: NOW, score: 0.1, kind: 'observation' }];
    expect(formatRecall(m)).toBe('[1] [2026-05-30] closed at $4k');
  });
  it('labels summaries with their range and tier', () => {
    const m: ObservationMatch[] = [{ id: 's', text: 'the arc', timestamp: NOW, startTimestamp: NOW - 10 * DAY, score: 0.2, kind: 'summary', tier: 1 }];
    expect(formatRecall(m)).toBe('[1] [2026-05-20–2026-05-30 · summary tier 1] the arc');
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
  it('renders the cover oldest-first with tier labels, then the tail', () => {
    const out = formatModelView(
      model,
      { obsCount: 30, earliest: NOW - 40 * DAY, latest: NOW },
      [
        { id: 's1', tier: 1, text: 'old arc', startTimestamp: NOW - 40 * DAY, endTimestamp: NOW - 20 * DAY, sourceCount: 5, obsCount: 50, sourceChars: 61234 },
        { id: 's0', tier: 0, text: 'recent batch', startTimestamp: NOW - 19 * DAY, endTimestamp: NOW - 2 * DAY, sourceCount: 10, obsCount: 10, sourceChars: 1023 },
      ],
      [{ id: 'o1', text: 'fresh note', timestamp: NOW, source: 'direct' }],
      NOW,
    );
    const i1 = out.indexOf('[tier 1 · 50 obs · 61K→7 chars · 2026-04-20–2026-05-10]\nold arc');
    const i0 = out.indexOf('[tier 0 · 10 obs · 1.0K→12 chars · 2026-05-11–2026-05-28]\nrecent batch');
    const it = out.indexOf('Recent notes (verbatim):\n- [2026-05-30] fresh note');
    expect(i1).toBeGreaterThan(0);
    expect(i0).toBeGreaterThan(i1);
    expect(it).toBeGreaterThan(i0);
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
