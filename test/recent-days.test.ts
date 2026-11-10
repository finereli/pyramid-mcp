import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { formatRecentDays } from '../src/format.js';
import { buildDayDigestJob } from '../src/pyramid.js';
import type { ObservationRow, RecentDays } from '../src/memory-do.js';

const DAY = 86_400_000;
const T = (iso: string) => Date.parse(iso);
const obs = (text: string, ts: number): ObservationRow => ({ id: crypto.randomUUID(), text, timestamp: ts, source: 'direct' });

function freshUser() {
  return env.MEMORY_DO.get(env.MEMORY_DO.idFromName('days-' + crypto.randomUUID()));
}

describe('formatRecentDays', () => {
  const recent: RecentDays = {
    latestDay: '2026-11-10',
    latest: [obs('evening note', T('2026-11-10T18:00:00Z')), obs('morning note', T('2026-11-10T08:00:00Z'))],
    earlier: [
      { day: '2026-11-09', notes: [obs('Backed up worlds. Then more.', T('2026-11-09T12:00:00Z'))] },
      { day: '2026-11-07', notes: [1, 2, 3, 4, 5].map(i => obs(`Note ${i} of the day.`, T('2026-11-07T10:00:00Z') + i)) },
    ],
  };

  it('renders the latest day verbatim, then a digest per earlier day, falling back to a gist', () => {
    const out = formatRecentDays(recent, new Map([['2026-11-09', { text: 'Backed up Prism worlds before the install.', sourceCount: 1 }]]));
    expect(out).toContain('## 2026-11-10 — latest day, verbatim (2 notes)\n- [2026-11-10] evening note\n- [2026-11-10] morning note');
    expect(out).toContain('## Earlier days — one digest each');
    expect(out).toContain('- 2026-11-09 (1 note): Backed up Prism worlds before the install.');
    expect(out).toContain('- 2026-11-07 (5 notes, digest pending): Note 1 of the day. · Note 2 of the day. · Note 3 of the day. · +2 more');
    expect(out.indexOf('2026-11-09')).toBeLessThan(out.indexOf('2026-11-07'));
  });

  it('treats a digest whose note count is out of date as pending', () => {
    const out = formatRecentDays(recent, new Map([['2026-11-09', { text: 'old digest', sourceCount: 4 }]]));
    expect(out).not.toContain('old digest');
    expect(out).toContain('- 2026-11-09 (1 note, digest pending): Backed up worlds.');
  });

  it('says how many of the latest day\'s notes the cap held back', () => {
    const busy: RecentDays = { latestDay: '2026-11-10', latest: [1, 2, 3].map(i => obs('x'.repeat(300), T('2026-11-10T10:00:00Z') - i)), earlier: [] };
    const out = formatRecentDays(busy, new Map(), 400);
    expect(out).toContain('+2 earlier notes from 2026-11-10 not shown; recall finds them.');
    expect(out).not.toContain('Earlier days');
  });

  it('is empty with no notes', () => {
    expect(formatRecentDays({ latestDay: null, latest: [], earlier: [] }, new Map())).toBe('');
  });
});

describe('buildDayDigestJob', () => {
  it('lists the day\'s notes oldest first with UTC times and states the target', () => {
    const job = buildDayDigestJob('2026-11-10', [obs('later', T('2026-11-10T15:30:00Z')), obs('earlier', T('2026-11-10T09:05:00Z'))]);
    expect(job.kind).toBe('digest');
    expect(job.user.indexOf('[09:05 UTC] earlier')).toBeLessThan(job.user.indexOf('[15:30 UTC] later'));
    expect(job.user).toContain('Day: 2026-11-10 (2 notes)');
    expect(job.user).toContain(`~${job.targetChars}-character digest`);
  });
});

describe('MemoryDO recent days + digests', () => {
  it('groups live notes by UTC day: the latest day in full, earlier days within the window', async () => {
    const u = freshUser();
    const now = Date.now();
    await u.bulkLoad([], [
      { text: 'today a', timestamp: now - 1000, models: ['user'] },
      { text: 'today b', timestamp: now - 2000, models: ['user'] },
      { text: 'two days back', timestamp: now - 2 * DAY, models: ['user'] },
      { text: 'five days back', timestamp: now - 5 * DAY, models: ['world'] },
      { text: 'a month back', timestamp: now - 30 * DAY, models: ['user'] }, // outside the 14-day window
    ]);
    const r = await u.recentDays();
    expect(r.latestDay).toBe(new Date(now - 1000).toISOString().slice(0, 10));
    expect(r.latest.map(o => o.text)).toContain('today a');
    const earlierTexts = r.earlier.flatMap(d => d.notes.map(o => o.text));
    expect(earlierTexts).toContain('two days back');
    expect(earlierTexts).toContain('five days back');
    expect(earlierTexts).not.toContain('a month back');
  });

  it('writes digests for earlier days only, refreshes one when its notes change, and leaves the rest alone', async () => {
    const u = freshUser();
    await u.enableStubSynthesis();
    const now = Date.now();
    const twoBack = now - 2 * DAY;
    await u.bulkLoad([], [
      { text: 'today, the latest day', timestamp: now, models: ['user'] },
      { text: 'a thing that happened two days back', timestamp: twoBack, models: ['user'] },
    ]);
    const d2 = new Date(twoBack).toISOString().slice(0, 10);
    const today = new Date(now).toISOString().slice(0, 10);

    expect(await u.ensureDayDigests()).toBe(1);
    let digests = await u.getDayDigests([d2, today]);
    expect(digests.get(d2)?.sourceCount).toBe(1);
    expect(digests.get(d2)?.text).toContain('stub digest');
    expect(digests.has(today)).toBe(false); // the latest day is shown verbatim, never digested

    expect(await u.ensureDayDigests()).toBe(0); // nothing changed

    await u.bulkLoad([], [{ text: 'another thing from two days back', timestamp: twoBack + 1000, models: ['user'] }]);
    expect(await u.ensureDayDigests()).toBe(1);
    digests = await u.getDayDigests([d2]);
    expect(digests.get(d2)?.sourceCount).toBe(2);
  });

  it('a failed synthesis writes nothing and is retried next time', async () => {
    const u = freshUser();
    await u.enableStubSynthesis('fail');
    const now = Date.now();
    await u.bulkLoad([], [
      { text: 'today', timestamp: now, models: ['user'] },
      { text: 'yesterday-ish', timestamp: now - 2 * DAY, models: ['user'] },
    ]);
    expect(await u.ensureDayDigests()).toBe(0);
    await u.enableStubSynthesis('ok');
    expect(await u.ensureDayDigests()).toBe(1);
  });
});
