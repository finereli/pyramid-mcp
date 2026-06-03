/**
 * build-seed.ts — extract the MVP seed substrate from Glopus's test6.db
 * (the direct-only k111 carve: 16 models + multi-tag observations + the built
 * pyramid). Groups the duplicated single-tag rows back into multi-tag
 * observations, and (optionally) embeds them with OpenAI.
 *
 * Usage:
 *   tsx scripts/build-seed.ts [--db <path/to/test6.db>] [--out seed-data/seed.json] [--embed]
 *
 * --embed requires a Workers AI token (CLOUDFLARE_API_TOKEN env, or
 * WORKERS_AI_TOKEN in .dev.vars) with the "Workers AI" permission. Embeds via
 * bge-m3 (1024-dim) — the same model the Worker uses at runtime, so the seed
 * vectors live in the same cosine space. Costs well under a cent. Without it, a
 * structural seed is written (no vectors) so recall is unavailable until backfilled.
 *
 * Output is gitignored (seed-data/) — it's real user memory.
 */
import Database from 'better-sqlite3';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { embedRest } from '../src/embeddings.js';

const DEFAULT_DB = '/Users/eli/source/glopus/data/memory-redesign/k111/test6.db';
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID ?? '7485eb8ab648601f411b650cd794bce3';
const SKIP_MODELS = new Set(['recent']); // pyramid-mcp covers continuity via recentObservations()

interface SeedObservation { text: string; timestamp: number; models: string[]; embedding?: number[] }
interface Seed { models: Array<{ name: string; description: string }>; observations: SeedObservation[] }

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function loadToken(): string | undefined {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  // fall back to .dev.vars (KEY=VALUE lines)
  if (existsSync('.dev.vars')) {
    for (const line of readFileSync('.dev.vars', 'utf8').split('\n')) {
      const m = line.match(/^\s*WORKERS_AI_TOKEN\s*=\s*(.+?)\s*$/);
      if (m) return m[1]!.replace(/^["']|["']$/g, '');
    }
  }
  return undefined;
}

async function main() {
  const dbPath = arg('--db') ?? DEFAULT_DB;
  const outPath = arg('--out') ?? 'seed-data/seed.json';
  const doEmbed = process.argv.includes('--embed');

  const db = new Database(dbPath, { readonly: true });

  const modelRows = db.prepare('SELECT id, name, description FROM models').all() as Array<{ id: string; name: string; description: string }>;
  const id2name = new Map(modelRows.map(m => [m.id, m.name]));
  const models = modelRows.filter(m => !SKIP_MODELS.has(m.name)).map(m => ({ name: m.name, description: m.description }));

  // Group the duplicated single-tag rows back into multi-tag observations.
  const rows = db.prepare('SELECT text, timestamp, model_id FROM observations WHERE source = ?').all('direct') as Array<{ text: string; timestamp: number; model_id: string }>;
  const byText = new Map<string, SeedObservation>();
  for (const r of rows) {
    const name = id2name.get(r.model_id);
    if (!name || SKIP_MODELS.has(name)) continue;
    let g = byText.get(r.text);
    if (!g) { g = { text: r.text, timestamp: r.timestamp, models: [] }; byText.set(r.text, g); }
    g.timestamp = Math.min(g.timestamp, r.timestamp);
    if (!g.models.includes(name)) g.models.push(name);
  }
  const observations = [...byText.values()].filter(o => o.models.length > 0);
  db.close();

  const tagTotal = observations.reduce((s, o) => s + o.models.length, 0);
  console.log(`models: ${models.length}`);
  console.log(`observations: ${observations.length} (tag assignments ${tagTotal}, inflation ${(tagTotal / observations.length).toFixed(2)})`);

  if (doEmbed) {
    const token = loadToken();
    if (!token) { console.error('--embed set but no Workers AI token (CLOUDFLARE_API_TOKEN env or WORKERS_AI_TOKEN in .dev.vars). Aborting.'); process.exit(1); }

    // bge-m3 caps a request at 60k tokens across the whole batch, and dense
    // maintenance-log text tokenizes far heavier than chars/4 suggests. Rather
    // than guess the ratio, embed adaptively: try a batch, and on the cap error
    // split it in half and retry until it fits.
    async function embedAdaptive(texts: string[]): Promise<number[][]> {
      try {
        return await embedRest(token!, CF_ACCOUNT_ID, texts);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (texts.length > 1 && /Max context|context reached|too large|400/.test(msg)) {
          const mid = Math.ceil(texts.length / 2);
          const [a, b] = await Promise.all([embedAdaptive(texts.slice(0, mid)), embedAdaptive(texts.slice(mid))]);
          return [...a, ...b];
        }
        throw e;
      }
    }

    console.log('embedding via Workers AI bge-m3 (adaptive batches)…');
    const START_BATCH = 50;
    let done = 0;
    for (let i = 0; i < observations.length; i += START_BATCH) {
      const slice = observations.slice(i, i + START_BATCH);
      const vecs = await embedAdaptive(slice.map(o => o.text));
      slice.forEach((o, j) => { o.embedding = vecs[j]; });
      done += slice.length;
      console.log(`  embedded ${done}/${observations.length}`);
    }
  }

  const seed: Seed = { models, observations };
  if (!existsSync(dirname(outPath))) mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(seed));
  console.log(`wrote ${outPath} (${doEmbed ? 'with' : 'without'} embeddings)`);
}

main().catch(e => { console.error(e); process.exit(1); });
