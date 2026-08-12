#!/usr/bin/env node
'use strict';

/**
 * Scorer evaluation harness.
 *
 *   node eval/run.js                                  # all available variants
 *   node eval/run.js --variant baseline --variant current
 *   node eval/run.js --golden path/to/golden.json --k 10
 *   node eval/run.js --detail current                 # per-job ranking dump
 *
 * Exit code is non-zero if a requested variant errored, so this can gate CI.
 */

const fs = require('node:fs');
const path = require('node:path');

const { VARIANTS, getVariant } = require('./scorers');
const { evaluate, rank } = require('./metrics');

function parseArgs(argv) {
  const args = { variants: [], golden: null, k: 10, detail: null, json: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--variant' || arg === '-v') args.variants.push(argv[++i]);
    else if (arg === '--golden' || arg === '-g') args.golden = argv[++i];
    else if (arg === '--k') args.k = Number(argv[++i]);
    else if (arg === '--detail' || arg === '-d') args.detail = argv[++i];
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unrecognised argument: ${arg}`);
  }

  return args;
}

function usage() {
  console.log(`
Usage: node eval/run.js [options]

  -v, --variant <name>   Variant to run (repeatable). Default: all available.
  -g, --golden <path>    Golden set JSON. Default: eval/fixtures/golden.json
      --k <n>            Cutoff for p@k / ndcg@k. Default: 10
  -d, --detail <name>    Print the full ranked list for one variant.
      --json             Emit machine-readable JSON instead of a table.
  -h, --help             This message.

Variants:
${VARIANTS.map((v) => `  ${v.name.padEnd(16)} ${v.describe}`).join('\n')}
`);
}

function loadGolden(goldenPath) {
  const resolved = goldenPath
    ? path.resolve(goldenPath)
    : path.join(__dirname, 'fixtures', 'golden.json');

  if (!fs.existsSync(resolved)) {
    throw new Error(
      `Golden set not found: ${resolved}\n` +
        `Seed one from your own scraped matches with: node eval/seed.js --help`
    );
  }

  const golden = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  const baseDir = path.dirname(resolved);

  let resumeText = golden.resumeText;
  if (!resumeText && golden.resumeFile) {
    resumeText = fs.readFileSync(path.resolve(baseDir, golden.resumeFile), 'utf8');
  }
  if (!resumeText) {
    throw new Error(`Golden set ${resolved} has neither "resumeText" nor "resumeFile"`);
  }

  const jobs = (golden.jobs || []).filter((j) => j && j.id);
  if (jobs.length === 0) throw new Error(`Golden set ${resolved} contains no labelled jobs`);

  const unlabelled = jobs.filter((j) => typeof j.label !== 'number');
  if (unlabelled.length > 0) {
    throw new Error(
      `${unlabelled.length} job(s) missing a numeric "label" ` +
        `(e.g. ${unlabelled.slice(0, 3).map((j) => j.id).join(', ')}). ` +
        `Label every job 0/1/2 before evaluating.`
    );
  }

  return { resumeText, jobs, source: resolved };
}

const pct = (v) => (v * 100).toFixed(1).padStart(5) + '%';
const num = (v) => v.toFixed(3).padStart(6);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return usage();

  const { resumeText, jobs, source } = loadGolden(args.golden);
  const labelById = new Map(jobs.map((j) => [j.id, j.label]));

  const requested = args.variants.length > 0
    ? args.variants.map(getVariant)
    : VARIANTS;

  if (!args.json) {
    console.log(`\nGolden set: ${source}`);
    console.log(`Jobs: ${jobs.length}  (label 2: ${jobs.filter((j) => j.label === 2).length}, ` +
      `label 1: ${jobs.filter((j) => j.label === 1).length}, ` +
      `label 0: ${jobs.filter((j) => j.label === 0).length})`);
    console.log(`Resume: ${resumeText.length} chars\n`);
  }

  const rows = [];
  const details = new Map();
  let hadError = false;

  for (const variant of requested) {
    const availability = await variant.available();
    if (!availability.ok) {
      rows.push({ variant: variant.name, skipped: availability.reason });
      continue;
    }

    const started = Date.now();
    let scored;
    try {
      scored = await variant.score(resumeText, jobs);
    } catch (err) {
      hadError = true;
      rows.push({ variant: variant.name, error: err.message });
      continue;
    }
    const elapsedMs = Date.now() - started;

    // A null score means "declined to score" — keep it out of the ranking
    // metrics rather than letting it masquerade as a zero.
    const usable = scored
      .filter((s) => s.score != null)
      .map((s) => ({ ...s, label: labelById.get(s.id) ?? 0 }));
    const unscored = scored.length - usable.length;

    details.set(variant.name, usable);
    rows.push({
      variant: variant.name,
      elapsedMs,
      unscored,
      ...evaluate(usable, { k: args.k }),
    });
  }

  if (args.json) {
    console.log(JSON.stringify({ source, k: args.k, rows }, null, 2));
  } else {
    report(rows, args.k);
  }

  if (args.detail) {
    printDetail(args.detail, details.get(args.detail), jobs);
  }

  process.exitCode = hadError ? 1 : 0;
}

function report(rows, k) {
  const header =
    'variant'.padEnd(16) +
    `p@${k}`.padStart(7) +
    `ndcg@${k}`.padStart(10) +
    'spearman'.padStart(10) +
    'spread'.padStart(9) +
    'unscored'.padStart(10) +
    'time'.padStart(9);
  console.log(header);
  console.log('-'.repeat(header.length));

  for (const row of rows) {
    if (row.skipped) {
      console.log(`${row.variant.padEnd(16)}${'— skipped: ' + row.skipped}`);
      continue;
    }
    if (row.error) {
      console.log(`${row.variant.padEnd(16)}${'! error: ' + row.error}`);
      continue;
    }
    console.log(
      row.variant.padEnd(16) +
        pct(row[`p@${k}`]).padStart(7) +
        num(row[`ndcg@${k}`]).padStart(10) +
        num(row.spearman).padStart(10) +
        pct(row.spread.ratio).padStart(9) +
        String(row.unscored).padStart(10) +
        `${row.elapsedMs}ms`.padStart(9)
    );
  }

  console.log(
    '\nspread = fraction of distinct score values; a low value means the scorer ' +
      'cannot separate jobs.\nndcg@k is the headline metric.\n'
  );
}

function printDetail(name, scored, jobs) {
  if (!scored) {
    console.log(`\nNo detail available for "${name}" (not run, skipped, or errored).`);
    return;
  }

  const jobById = new Map(jobs.map((j) => [j.id, j]));
  console.log(`\nRanked list — ${name}\n`);
  console.log(
    '  #'.padEnd(5) + 'score'.padStart(7) + '  ' + 'label'.padEnd(7) + 'id'.padEnd(30) + 'probes'
  );
  console.log('-'.repeat(90));

  rank(scored).forEach((item, i) => {
    const job = jobById.get(item.id) || {};
    const flag = item.label === 2 ? '++' : item.label === 1 ? ' +' : '  ';
    console.log(
      String(i + 1).padEnd(5) +
        item.score.toFixed(2).padStart(7) +
        '  ' +
        `${flag} ${item.label}`.padEnd(7) +
        String(item.id).padEnd(30) +
        (job.probes || []).join(',')
    );
  });
  console.log();
}

main().catch((err) => {
  console.error(`\n${err.message}\n`);
  process.exitCode = 1;
});
