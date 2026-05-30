/**
 * eval-recall.ts — the MVP acceptance gate. Loads the embedded Glopus seed into
 * a running pyramid-mcp (wrangler dev) and runs two recall suites end-to-end
 * through the real /mcp tools:
 *   - integrative recall via load_memory(model topics) → do model views carry the arcs?
 *   - direct recall via recall(query) → do the receipts (names, dates, numbers) come back?
 *
 * Produces hard assertions on a few high-confidence facts + a human-readable
 * markdown report (eval-report.md) for the qualitative judgments.
 *
 * Prereq: `wrangler dev` running (default 127.0.0.1:8787) and seed-data/seed.json
 * built with --embed. Run: tsx scripts/eval-recall.ts
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const BASE = process.env.PYRAMID_URL ?? 'http://127.0.0.1:8787';
const USER = 'eval-' + Date.now(); // fresh DO each run
const SEED = 'seed-data/seed.json';

function apiKey(): string {
  for (const line of readFileSync('.dev.vars', 'utf8').split('\n')) {
    const m = line.match(/^\s*OPENAI_API_KEY\s*=\s*(.+?)\s*$/);
    if (m) return m[1]!.replace(/^["']|["']$/g, '');
  }
  throw new Error('OPENAI_API_KEY not in .dev.vars');
}
const KEY = apiKey();

async function callTool(name: string, args: object): Promise<string> {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': USER, 'x-openai-key': KEY },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const json = (await res.json()) as any;
  if (json.error) throw new Error(`${name}: ${json.error.message}`);
  return json.result.content[0].text as string;
}

interface Query {
  kind: 'direct' | 'integrative';
  q: string;
  topics?: string[];      // integrative
  expect?: string[];      // case-insensitive substrings that must appear
}

const QUERIES: Query[] = [
  // direct recall — fact-shaped
  { kind: 'direct', q: 'What are the terms of the Cristi partnership deal?', expect: ['Cristi'] },
  { kind: 'direct', q: "What is the name of Eli's wife?", expect: ['Yael'] },
  { kind: 'direct', q: 'Who is Daniel Blank and what is his situation?', expect: ['Daniel'] },
  { kind: 'direct', q: 'What is the 30/30 sales approach?' },
  { kind: 'direct', q: 'When did Eli move toward fractional BD / indie hacking?' },
  // integrative recall — completion-shaped, via model views
  { kind: 'integrative', q: 'Tell me about the Cristi engagement', topics: ['cristi', 'bizdev'], expect: ['cristi'] },
  { kind: 'integrative', q: 'How is the coaching practice going?', topics: ['coaching'], expect: ['coaching'] },
  { kind: 'integrative', q: 'What have we been building in the memory system?', topics: ['memory-architecture'], expect: ['memory-architecture'] },
  { kind: 'integrative', q: 'Who are you?', topics: ['self'] },
  { kind: 'integrative', q: "What has Eli been working through emotionally?", topics: ['inner-life'] },
];

async function loadSeed(): Promise<void> {
  const seed = JSON.parse(readFileSync(SEED, 'utf8')) as { models: any[]; observations: any[] };
  if (!seed.observations[0]?.embedding) throw new Error('seed has no embeddings — run build-seed.ts --embed first');
  console.log(`loading ${seed.models.length} models + ${seed.observations.length} observations as ${USER}…`);

  // models first
  await post({ models: seed.models, observations: [] });
  const CHUNK = 200;
  for (let i = 0; i < seed.observations.length; i += CHUNK) {
    const r = await post({ observations: seed.observations.slice(i, i + CHUNK) });
    process.stdout.write(`\r  loaded ${Math.min(i + CHUNK, seed.observations.length)}/${seed.observations.length}`);
  }
  console.log('');
}

async function post(body: object): Promise<any> {
  const res = await fetch(`${BASE}/seed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': USER },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`/seed ${res.status}: ${await res.text()}`);
  return res.json();
}

function truncate(s: string, n = 1400): string {
  return s.length > n ? s.slice(0, n) + `\n… (+${s.length - n} chars)` : s;
}

async function main() {
  if (!existsSync(SEED)) throw new Error(`${SEED} missing`);
  await loadSeed();

  const report: string[] = [`# pyramid-mcp recall eval\n\nSeed: 16 models, 1,727 observations (Glopus k111 carve). User: \`${USER}\`.\n`];
  let pass = 0, fail = 0;
  const failures: string[] = [];

  for (const query of QUERIES) {
    const text = query.kind === 'direct'
      ? await callTool('recall', { query: query.q })
      : await callTool('load_memory', { topics: query.topics });

    let verdict = '';
    if (query.expect) {
      const missing = query.expect.filter(e => !text.toLowerCase().includes(e.toLowerCase()));
      if (missing.length === 0) { pass++; verdict = `✅ asserts: ${query.expect.join(', ')}`; }
      else { fail++; verdict = `❌ missing: ${missing.join(', ')}`; failures.push(`${query.q} — missing ${missing.join(', ')}`); }
    }

    report.push(`## [${query.kind}] ${query.q}`);
    if (query.topics) report.push(`_topics: ${query.topics.join(', ')}_`);
    if (verdict) report.push(verdict);
    report.push('\n```\n' + truncate(text) + '\n```\n');
    console.log(`[${query.kind}] ${query.q.slice(0, 50)} ${verdict}`);
  }

  const summary = `**Assertions: ${pass} passed, ${fail} failed.**` + (failures.length ? `\n\nFailures:\n${failures.map(f => `- ${f}`).join('\n')}` : '');
  report.splice(1, 0, summary + '\n');
  writeFileSync('eval-report.md', report.join('\n'));
  console.log(`\n${summary}\nwrote eval-report.md`);
  if (fail > 0) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exit(1); });
