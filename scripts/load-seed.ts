/**
 * load-seed.ts — load the embedded Glopus seed into a running pyramid-mcp
 * (wrangler dev) under a STABLE user id, so you can connect an MCP client and
 * try it out. Unlike eval-recall.ts (fresh user per run), this targets one user
 * you keep using.
 *
 * Prereq: `npm run dev` running, seed-data/seed.json built with --embed.
 * Usage: tsx scripts/load-seed.ts [--user eli] [--url http://127.0.0.1:8787]
 */
import { readFileSync, existsSync } from 'node:fs';

function arg(flag: string, def: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1]! : def;
}

const BASE = arg('--url', 'http://127.0.0.1:8787');
const USER = arg('--user', 'eli');
const SEED = 'seed-data/seed.json';

async function post(body: object): Promise<any> {
  const res = await fetch(`${BASE}/seed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': USER },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`/seed ${res.status}: ${await res.text()}`);
  return res.json();
}

async function main() {
  if (!existsSync(SEED)) throw new Error(`${SEED} missing — run: tsx scripts/build-seed.ts --embed`);
  const seed = JSON.parse(readFileSync(SEED, 'utf8')) as { models: any[]; observations: any[] };
  if (!seed.observations[0]?.embedding) throw new Error('seed has no embeddings — run build-seed.ts --embed');

  console.log(`loading ${seed.models.length} models + ${seed.observations.length} observations as user "${USER}" → ${BASE}`);
  await post({ models: seed.models, observations: [] });
  const CHUNK = 200;
  let tags = 0;
  for (let i = 0; i < seed.observations.length; i += CHUNK) {
    const r = await post({ observations: seed.observations.slice(i, i + CHUNK) });
    tags += r.tags ?? 0;
    process.stdout.write(`\r  loaded ${Math.min(i + CHUNK, seed.observations.length)}/${seed.observations.length}`);
  }
  console.log(`\ndone — user "${USER}" now has ${seed.observations.length} observations (${tags} tags) across ${seed.models.length} models.`);
}

main().catch(e => { console.error(e); process.exit(1); });
