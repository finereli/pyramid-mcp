/**
 * synth-ab.ts — A/B the pyramid synthesizer: OpenAI gpt-4o-mini vs Cloudflare
 * Workers AI Llama 3.3 70B (fp8-fast), on REAL synth jobs built from the seed.
 *
 * Both providers are called over REST so this runs in plain tsx (no Worker /
 * env.AI binding needed). It reuses the production prompt builder (pyramid.ts)
 * so what we judge is exactly what the DO would generate.
 *
 * Usage:
 *   tsx scripts/synth-ab.ts [--models a,b,c] [--out scripts/synth-ab-report.md]
 *
 * Auth:
 *   OpenAI     — OPENAI_API_KEY (env or .dev.vars)
 *   Workers AI — WORKERS_AI_TOKEN (env) or CLOUDFLARE_API_TOKEN; needs the
 *                "Workers AI: Read" account permission. CF_ACCOUNT_ID overrides
 *                the default account.
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { buildSynthJob, bucketObservations } from '../src/pyramid.js';
import type { ModelRow, ObservationRow } from '../src/memory-do.js';

const SEED_PATH = 'seed-data/seed.json';
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID ?? '7485eb8ab648601f411b650cd794bce3';
const WORKERS_AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

/** OpenAI chat completion over REST (self-contained — the production synth.ts
 *  now targets Workers AI, so the A/B keeps its own OpenAI caller). */
async function synthesizeOpenAI(system: string, user: string, apiKey: string, maxTokens: number): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0.4,
      max_tokens: maxTokens,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  return (json.choices[0]?.message?.content ?? '').trim();
}

interface SeedObs { text: string; timestamp: number; models: string[] }
interface Seed { models: Array<{ name: string; description: string }>; observations: SeedObs[] }

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function loadDevVar(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  if (existsSync('.dev.vars')) {
    for (const line of readFileSync('.dev.vars', 'utf8').split('\n')) {
      const m = line.match(new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*$`));
      if (m) return m[1]!.replace(/^["']|["']$/g, '');
    }
  }
  return undefined;
}

/** Workers AI chat completion over REST — mirrors synthesize()'s contract. */
async function synthesizeWorkersAI(system: string, user: string, token: string, maxTokens: number): Promise<string> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${WORKERS_AI_MODEL}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.4,
        max_tokens: maxTokens,
      }),
    },
  );
  const json = (await res.json()) as { result?: { response?: string }; success: boolean; errors?: unknown };
  if (!res.ok || !json.success) {
    throw new Error(`Workers AI failed: ${res.status} ${JSON.stringify(json.errors ?? json)}`);
  }
  return (json.result?.response ?? '').trim();
}

/** Pick a default set of judgment-heavy models: the ones with the most observations. */
function pickModels(byModel: Map<string, ObservationRow[]>, explicit?: string[]): string[] {
  if (explicit && explicit.length) return explicit;
  return [...byModel.entries()]
    .filter(([name]) => name !== 'recent')
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 5)
    .map(([name]) => name);
}

async function main() {
  const openaiKey = loadDevVar('OPENAI_API_KEY');
  const cfToken = loadDevVar('WORKERS_AI_TOKEN') ?? process.env.CLOUDFLARE_API_TOKEN;
  if (!openaiKey) { console.error('No OPENAI_API_KEY (env or .dev.vars).'); process.exit(1); }
  if (!cfToken) { console.error('No WORKERS_AI_TOKEN / CLOUDFLARE_API_TOKEN.'); process.exit(1); }

  if (!existsSync(SEED_PATH)) { console.error(`Missing ${SEED_PATH}. Run build-seed first.`); process.exit(1); }
  const seed = JSON.parse(readFileSync(SEED_PATH, 'utf8')) as Seed;
  const descByName = new Map(seed.models.map(m => [m.name, m.description]));

  // Group observations by model (one row per (text,model) pair, like the DO sees).
  const byModel = new Map<string, ObservationRow[]>();
  for (const o of seed.observations) {
    for (const name of o.models) {
      const row: ObservationRow = { id: '', text: o.text, timestamp: o.timestamp, source: 'direct' };
      (byModel.get(name) ?? byModel.set(name, []).get(name)!).push(row);
    }
  }

  const modelNames = pickModels(byModel, arg('--models')?.split(','));
  const now = Date.now();
  const outPath = arg('--out') ?? 'scripts/synth-ab-report.md';

  const lines: string[] = [
    `# Synth A/B — gpt-4o-mini vs Llama 3.3 70B (fp8-fast)`,
    ``,
    `Generated from \`${SEED_PATH}\` using the production \`buildSynthJob\` prompts.`,
    `Models under test: ${modelNames.join(', ')}`,
    ``,
  ];

  for (const name of modelNames) {
    const obs = (byModel.get(name) ?? []).sort((a, b) => a.timestamp - b.timestamp);
    if (!obs.length) { console.warn(`skip ${name}: no observations`); continue; }
    const model: ModelRow = {
      id: name, name, description: descByName.get(name) ?? null,
      isSeed: false, archived: false, createdAt: now,
    };
    const buckets = bucketObservations(obs, now);
    console.log(`\n=== ${name} — ${obs.length} obs, ${buckets.length} tier(s) ===`);
    lines.push(`---\n\n## Model: \`${name}\` — ${obs.length} obs`, `_Lens: ${model.description ?? '(none)'}_`, ``);

    for (const bucket of buckets) {
      const job = buildSynthJob(model, bucket);
      console.log(`  tier ${job.tier} (${bucket.tier.label}, ${job.sourceCount} obs) …`);

      const t0 = Date.now();
      let openaiOut = '', cfOut = '';
      try { openaiOut = await synthesizeOpenAI(job.system, job.user, openaiKey, job.maxTokens); }
      catch (e) { openaiOut = `ERROR: ${e instanceof Error ? e.message : String(e)}`; }
      const t1 = Date.now();
      try { cfOut = await synthesizeWorkersAI(job.system, job.user, cfToken, job.maxTokens); }
      catch (e) { cfOut = `ERROR: ${e instanceof Error ? e.message : String(e)}`; }
      const t2 = Date.now();

      lines.push(
        `### Tier ${job.tier} — ${bucket.tier.label} (${job.sourceCount} obs, target ~${bucket.tier.targetChars} chars)`,
        ``,
        `**gpt-4o-mini** (${t1 - t0}ms, ${openaiOut.length} chars)`,
        ``, `> ${openaiOut.replace(/\n/g, '\n> ')}`, ``,
        `**Llama 3.3 70B** (${t2 - t1}ms, ${cfOut.length} chars)`,
        ``, `> ${cfOut.replace(/\n/g, '\n> ')}`, ``,
      );
    }
  }

  writeFileSync(outPath, lines.join('\n'));
  console.log(`\nWrote ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
