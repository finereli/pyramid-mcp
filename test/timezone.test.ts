import { SELF, env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { localDate, localStamp, localRange, isValidTimeZone } from '../src/time.js';
import { buildTier0Job } from '../src/pyramid.js';
import type { ModelRow } from '../src/memory-do.js';

// 2026-11-04 23:30 UTC is already Nov 5 in Skopje (UTC+1) and still Nov 4 in Vancouver.
const LATE = Date.UTC(2026, 10, 4, 23, 30);

describe('local time labels', () => {
  it('renders the local day, time and zone', () => {
    expect(localDate(LATE)).toBe('2026-11-04');
    expect(localDate(LATE, 'Europe/Skopje')).toBe('2026-11-05');
    expect(localDate(LATE, 'America/Vancouver')).toBe('2026-11-04');
    expect(localStamp(LATE, 'Europe/Skopje')).toBe('2026-11-05 00:30 GMT+1');
    expect(localRange(LATE - 3_600_000, LATE, 'Europe/Skopje')).toBe('2026-11-04 – 2026-11-05');
    expect(isValidTimeZone('Asia/Jerusalem')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });

  it('tier-0 prompts label each note in its own zone, falling back to the memory zone', () => {
    const model: ModelRow = { id: 'm', name: 'proj', description: 'p', isSeed: false, archived: false, createdAt: 0 };
    const job = buildTier0Job(model, [
      { id: 'a', text: 'written in Vancouver', timestamp: LATE, source: 'direct', tz: 'America/Vancouver' },
      { id: 'b', text: 'from before stamping', timestamp: LATE + 60_000, source: 'direct', tz: null },
    ], 'Europe/Skopje');
    expect(job.user).toContain('- [2026-11-04 15:30 PST] written in Vancouver');
    expect(job.user).toContain('- [2026-11-05 00:31 GMT+1] from before stamping');
  });
});

async function call(userId: string, name: string, args: object): Promise<string> {
  const res = await SELF.fetch('https://example.com/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': userId },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  return ((await res.json()) as { result: { content: Array<{ text: string }> } }).result.content[0]!.text;
}

describe('set_timezone', () => {
  it('stamps new notes with the current zone and keeps old stamps after a move', async () => {
    const u = 'tz-' + crypto.randomUUID();
    expect(await call(u, 'load_memory', {})).toContain('currently UTC');
    expect(await call(u, 'set_timezone', { timezone: 'Nope/Nowhere' })).toContain('IANA');
    expect(await call(u, 'set_timezone', { timezone: 'America/Vancouver' })).toContain('Timezone set to America/Vancouver (was UTC)');
    await call(u, 'record_observation', { text: 'Note written while in Vancouver', models: ['user'] });
    await call(u, 'set_timezone', { timezone: 'Europe/Skopje' });
    await call(u, 'record_observation', { text: 'Note written after the move to Skopje', models: ['user'] });

    const stub = env.MEMORY_DO.get(env.MEMORY_DO.idFromName(u));
    const rows = await stub.recentObservations(5);
    expect(rows.map(r => [r.text, r.tz])).toEqual([
      ['Note written after the move to Skopje', 'Europe/Skopje'],
      ['Note written while in Vancouver', 'America/Vancouver'],
    ]);
    const mem = await call(u, 'load_memory', {});
    expect(mem).toContain('currently Europe/Skopje');
    expect(mem).toMatch(/- \[\d{4}-\d\d-\d\d \d\d:\d\d P[SD]T\] Note written while in Vancouver/);
  });
});
