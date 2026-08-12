#!/usr/bin/env node
'use strict';

/**
 * Turn your own scraped matches into a golden set skeleton for labelling.
 *
 * The shipped fixture set is synthetic and was written alongside the scorer, so
 * it is a regression guard, not evidence. Numbers that mean anything about YOUR
 * job search have to come from YOUR resume and YOUR scraped postings.
 *
 * 1. Open the extension's service worker console:
 *      chrome://extensions -> Job Matcher -> "service worker"
 * 2. Run:
 *      chrome.storage.local.get(['matches','resumeText'], (d) => copy(JSON.stringify(d)))
 * 3. Paste into a file, then:
 *      node eval/seed.js --input dump.json --output eval/fixtures/mine.json
 * 4. Open the output and set "label" on each job: 2 = would apply,
 *    1 = maybe, 0 = irrelevant. Leave none unlabelled.
 * 5. node eval/run.js --golden eval/fixtures/mine.json
 */

const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const args = { input: null, output: null, minChars: 200 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--input' || arg === '-i') args.input = argv[++i];
    else if (arg === '--output' || arg === '-o') args.output = argv[++i];
    else if (arg === '--min-chars') args.minChars = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unrecognised argument: ${arg}`);
  }
  return args;
}

function usage() {
  console.log(`
Usage: node eval/seed.js --input <dump.json> --output <golden.json>

  -i, --input <path>    Storage dump containing "matches" (and ideally "resumeText").
  -o, --output <path>   Where to write the golden-set skeleton.
      --min-chars <n>   Skip jobs whose description is shorter than this. Default 200.
                        Jobs never enriched with a real description cannot be
                        judged fairly and would just add noise.
  -h, --help            This message.

Get a dump from the extension's service worker console:
  chrome.storage.local.get(['matches','resumeText'], (d) => copy(JSON.stringify(d)))
`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.input || !args.output) return usage();

  const raw = JSON.parse(fs.readFileSync(path.resolve(args.input), 'utf8'));

  // Accept either the full storage dump or a bare matches array.
  const matches = Array.isArray(raw) ? raw : raw.matches;
  if (!Array.isArray(matches)) {
    throw new Error('Input has no "matches" array. Dump chrome.storage.local first.');
  }

  const seen = new Set();
  const jobs = [];
  let skippedShort = 0;
  let skippedDupe = 0;

  for (const match of matches) {
    const job = match.job || match;
    const url = job.url || '';
    const key = url.split('?')[0] || `${job.title}|${job.company}`;

    if (seen.has(key)) {
      skippedDupe++;
      continue;
    }
    seen.add(key);

    if ((job.description || '').length < args.minChars) {
      skippedShort++;
      continue;
    }

    jobs.push({
      id: key.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '-').slice(0, 60).toLowerCase(),
      label: null,
      title: job.title || '',
      company: job.company || '',
      location: job.location || '',
      url,
      description: job.description || '',
      // Carried through so you can see what the old scorer thought while
      // labelling — but label on the posting, not on this number.
      previousScore: match.score ?? null,
    });
  }

  const output = {
    $comment:
      'Set "label" on every job before running the harness: 2 = would apply, ' +
      '1 = maybe, 0 = irrelevant. Delete "previousScore" once labelled if you ' +
      'want to avoid anchoring on it.',
    resumeText: raw.resumeText || undefined,
    resumeFile: raw.resumeText ? undefined : 'resume.txt',
    jobs,
  };

  fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
  fs.writeFileSync(path.resolve(args.output), JSON.stringify(output, null, 2));

  console.log(`
Wrote ${jobs.length} jobs to ${args.output}
  skipped ${skippedShort} with descriptions under ${args.minChars} chars
  skipped ${skippedDupe} duplicates
${raw.resumeText ? '  resume text embedded from the dump' : '  no resumeText in dump — set resumeFile or resumeText yourself'}

Next: label every job, then
  node eval/run.js --golden ${args.output}
`);
}

try {
  main();
} catch (err) {
  console.error(`\n${err.message}\n`);
  process.exitCode = 1;
}
