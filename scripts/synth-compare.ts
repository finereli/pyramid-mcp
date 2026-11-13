/**
 * synth-compare.ts - compare pyramid summarizers on REAL jobs from a live memory.
 *
 * For each chosen model it pulls the export (/admin/model), takes the newest
 * tier-0 summaries and the newest rollup, rebuilds each job from its stored
 * sources with the production prompt builders, and runs every candidate on
 * the identical prompt. Writes a side-by-side report plus mechanical checks:
 *   - length against the tier target
 *   - leak: output that opens like reasoning ("The user wants...", "Okay, ...")
 *   - kept: share of the sources' numbers and capitalized names that survive
 *   - invented: numbers in the output that appear nowhere in the sources
 *
 * Usage:
 *   tsx scripts/synth-compare.ts --user <googleSub> [--models a,b] [--per 2]
 * Auth: ADMIN_TOKEN from .dev.vars, CLOUDFLARE_API_TOKEN from env.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { buildTier0Job, buildRollupJob, type SynthJob } from '../src/pyramid.js';
import type { ModelRow, ObservationRow, SummaryRow } from '../src/memory-do.js';
import { SYNTH_MODELS, extractText, synthRequestBody, looksLikeReasoning } from '../src/synth.js';

const BASE = 'https://pyramid.finereli.com';
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID ?? '7485eb8ab648601f411b650cd794bce3';
const CANDIDATES = [SYNTH_MODELS.llama, SYNTH_MODELS.qwen];

function arg(flag: string, dflt?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : dflt;
}
function devVar(name: string): string {
  const line = readFileSync('.dev.vars', 'utf8').split('\n').find(l => l.startsWith(`${name}=`));
  if (!line) throw new Error(`${name} missing from .dev.vars`);
  return line.slice(name.length + 1).trim();
}

const ADMIN = devVar('ADMIN_TOKEN');
const CF = process.env.CLOUDFLARE_API_TOKEN ?? '';
const USER = arg('--user');
if (!USER || !CF) { console.error('Need --user and CLOUDFLARE_API_TOKEN.'); process.exit(1); }

interface Export { model: ModelRow; summaries: Array<SummaryRow & { sources: Array<{ type: string; id: string }> }>; observations: ObservationRow[] }

async function exportModel(name: string): Promise<Export> {
  const r = await fetch(`${BASE}/admin/model`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': ADMIN },
    body: JSON.stringify({ userId: USER, model: name }),
  });
  if (!r.ok) throw new Error(`export ${name}: ${r.status}`);
  return r.json() as Promise<Export>;
}

async function run(model: string, job: SynthJob): Promise<{ text: string; ms: number; neurons: number }> {
  const t0 = Date.now();
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${model}`, {
    method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${CF}` },
    body: JSON.stringify(synthRequestBody(model, job.system, job.user, job.maxTokens)),
  });
  const json = await r.json() as { success: boolean; result?: any; errors?: unknown };
  if (!json.success) throw new Error(JSON.stringify(json.errors));
  return { text: extractText(json.result), ms: Date.now() - t0, neurons: json.result?.usage?.neurons ?? 0 };
}

// ---------- mechanical checks ----------
const NUM = /\$?\d[\d,.]*[KkMm%]?/g;
const NAME = /\b[A-Z][a-zA-ZÀ-ɏ'-]{2,}\b/g;
const STOP = new Set(['The', 'This', 'That', 'Then', 'When', 'Between', 'After', 'Before', 'And', 'But', 'His', 'Her', 'They', 'Its', 'With', 'From', 'For', 'Also', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Eli']);
const norm = (s: string) => s.replace(/[,$]/g, '').replace(/\.$/, '').toLowerCase();
const nums = (s: string) => new Set((s.match(NUM) ?? []).map(norm).filter(n => n.length >= 2 && !/^20\d\d$/.test(n)));
const names = (s: string) => new Set((s.match(NAME) ?? []).filter(n => !STOP.has(n)));

function check(source: string, out: string, target: number) {
  const sn = nums(source), on = nums(out), sm = names(source), om = names(out);
  const keptNums = [...on].filter(n => sn.has(n)).length;
  const keptNames = [...om].filter(n => sm.has(n)).length;
  const invented = [...on].filter(n => !sn.has(n) && !source.includes(n));
  return {
    chars: out.length, ratio: +(out.length / target).toFixed(2),
    leak: looksLikeReasoning(out),
    kept: `${keptNums}/${sn.size} nums, ${keptNames}/${sm.size} names`,
    keptScore: (keptNums + keptNames) / Math.max(1, sn.size + sm.size),
    invented,
  };
}

async function main() {
  const models = (arg('--models') ?? 'bizdev,coaching,memory-architecture,user,side-projects,system').split(',');
  const per = Number(arg('--per', '2'));
  const lines = [`# Summarizer comparison: ${CANDIDATES.join(' vs ')}`, '', `Real jobs from live memory, rebuilt with the production prompts, ${new Date().toISOString().slice(0, 10)}.`, ''];
  const totals = new Map<string, { kept: number; n: number; leaks: number; invented: number; ms: number; neurons: number; ratio: number }>();
  for (const c of CANDIDATES) totals.set(c, { kept: 0, n: 0, leaks: 0, invented: 0, ms: 0, neurons: 0, ratio: 0 });

  for (const name of models) {
    const ex = await exportModel(name);
    const obsById = new Map(ex.observations.map(o => [o.id, o]));
    const sumById = new Map(ex.summaries.map(s => [s.id, s]));
    const newest = (t: number) => ex.summaries.filter(s => t === 0 ? s.tier === 0 : s.tier >= 1).sort((a, b) => b.endTimestamp - a.endTimestamp);
    const jobs: Array<{ job: SynthJob; source: string; label: string }> = [];
    for (const s of newest(0).slice(0, per)) {
      const batch = s.sources.map(x => obsById.get(x.id)).filter((o): o is ObservationRow => !!o);
      if (batch.length < 2) continue;
      jobs.push({ job: buildTier0Job(ex.model, batch), source: batch.map(o => o.text).join('\n'), label: `tier 0, ${batch.length} notes` });
    }
    const roll = newest(1)[0];
    if (roll) {
      const children = roll.sources.map(x => sumById.get(x.id)).filter((c): c is NonNullable<typeof c> => !!c);
      if (children.length >= 2) jobs.push({ job: buildRollupJob(ex.model, children), source: children.map(c => c.text).join('\n'), label: `tier ${roll.tier}, ${children.length} summaries` });
    }
    lines.push('---', '', `## ${name}`, '');
    for (const { job, source, label } of jobs) {
      console.log(`${name}: ${label}`);
      lines.push(`### ${label}, target ~${job.targetChars} chars`, '');
      for (const c of CANDIDATES) {
        let out: { text: string; ms: number; neurons: number };
        try { out = await run(c, job); } catch (e) { out = { text: `ERROR: ${String(e)}`, ms: 0, neurons: 0 }; }
        const k = check(source, out.text, job.targetChars);
        const t = totals.get(c)!;
        t.n++; t.kept += k.keptScore; t.leaks += k.leak ? 1 : 0; t.invented += k.invented.length; t.ms += out.ms; t.neurons += out.neurons; t.ratio += k.ratio;
        lines.push(`**${c.split('/').pop()}** · ${out.ms}ms · ${k.chars} chars (${k.ratio}× target) · kept ${k.kept}${k.leak ? ' · **LEAK**' : ''}${k.invented.length ? ` · numbers not in sources: ${k.invented.join(', ')}` : ''}`, '', `> ${out.text.replace(/\n/g, '\n> ')}`, '');
      }
    }
  }

  const summary = ['## Totals', '', '| model | jobs | avg kept | leaks | numbers not in sources | avg length × target | avg ms | neurons |', '|---|---|---|---|---|---|---|---|'];
  for (const [c, t] of totals) summary.push(`| ${c.split('/').pop()} | ${t.n} | ${(t.kept / t.n).toFixed(2)} | ${t.leaks} | ${t.invented} | ${(t.ratio / t.n).toFixed(2)} | ${Math.round(t.ms / t.n)} | ${Math.round(t.neurons)} |`);
  lines.splice(4, 0, ...summary, '');
  const outPath = arg('--out', 'scripts/synth-compare-report.md')!;
  writeFileSync(outPath, lines.join('\n'));
  console.log(summary.join('\n'));
  console.log(`\nWrote ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
