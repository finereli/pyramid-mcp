/**
 * seed-prod.ts — one-time seed of a deployed pyramid-mcp via the token-gated
 * /admin endpoints. Loads the embedded seed into a specific user's DO and
 * rebuilds the pyramid.
 *
 * Reads ADMIN_TOKEN and OPENAI_API_KEY from .dev.vars.
 * Usage: tsx scripts/seed-prod.ts --user <google-sub> [--url https://pyramid.finereli.com]
 */
import { readFileSync, existsSync } from 'node:fs';

function arg(flag: string, def?: string): string {
  const i = process.argv.indexOf(flag);
  if (i >= 0) return process.argv[i + 1]!;
  if (def !== undefined) return def;
  throw new Error(`missing ${flag}`);
}
function fromDevVars(key: string): string {
  for (const line of readFileSync('.dev.vars', 'utf8').split('\n')) {
    const m = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`));
    if (m) return m[1]!.replace(/^["']|["']$/g, '');
  }
  throw new Error(`${key} not in .dev.vars`);
}

const BASE = arg('--url', 'https://pyramid.finereli.com');
const USER = arg('--user');
const ADMIN_TOKEN = fromDevVars('ADMIN_TOKEN');
const OPENAI_KEY = fromDevVars('OPENAI_API_KEY');
const SEED = 'seed-data/seed.json';

async function admin(path: string, body: object, extraHeaders: Record<string, string> = {}): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-token': ADMIN_TOKEN, ...extraHeaders },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} ${res.status}: ${await res.text()}`);
  return res.json();
}

async function main() {
  if (!existsSync(SEED)) throw new Error(`${SEED} missing — run build-seed.ts --embed`);
  const seed = JSON.parse(readFileSync(SEED, 'utf8')) as { models: any[]; observations: any[] };
  if (!seed.observations[0]?.embedding) throw new Error('seed has no embeddings');

  console.log(`seeding ${seed.observations.length} obs / ${seed.models.length} models → ${BASE} for user ${USER}`);
  await admin('/admin/seed', { userId: USER, models: seed.models, observations: [] });
  const CHUNK = 200;
  for (let i = 0; i < seed.observations.length; i += CHUNK) {
    await admin('/admin/seed', { userId: USER, observations: seed.observations.slice(i, i + CHUNK) });
    process.stdout.write(`\r  loaded ${Math.min(i + CHUNK, seed.observations.length)}/${seed.observations.length}`);
  }
  console.log('\nbuilding pyramid…');
  console.log('  ' + JSON.stringify(await admin('/admin/rebuild', { userId: USER }, { 'x-openai-key': OPENAI_KEY })));
  console.log('done.');
}

main().catch(e => { console.error(e); process.exit(1); });
