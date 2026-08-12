'use strict';

/**
 * The extension's lib/*.js files are classic scripts: each assigns a single
 * global (TFIDF, JobMatcher, ResumeParser) via an IIFE. They cannot be
 * `require`d directly because matcher.js references the TFIDF global that
 * tfidf.js defines. Rather than restructure them into modules — the popup and
 * the MV3 service worker both load them as classic scripts — evaluate them in
 * one shared vm context, exactly as a browser would.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO_ROOT = path.join(__dirname, '..');
const LIB_DIR = path.join(REPO_ROOT, 'extension', 'lib');
const BASELINE_DIR = path.join(__dirname, 'baseline');

/**
 * Evaluate the given script files into a fresh shared context and return an
 * object holding the named globals they define.
 *
 * The files are concatenated into a single script rather than run one at a
 * time. Each `vm.runInContext` call is its own script, and these libraries
 * declare their globals with top-level `const` — a lexical binding, which is
 * scoped to the script and never becomes a property of the global object. So
 * running them separately leaves `TFIDF` invisible to matcher.js, and running
 * them together still leaves both invisible to the caller. Concatenating fixes
 * the first problem; the appended epilogue fixes the second by copying the
 * bindings onto the context.
 */
function loadScripts(files, exportNames, extraGlobals = {}) {
  const context = vm.createContext({
    console,
    TextDecoder,
    TextEncoder,
    URL,
    ...extraGlobals,
  });

  // The trailing `if (typeof module !== 'undefined')` export guard in each file
  // is inert here because the context has no `module` binding.
  const sources = files.map((file) => `/* ${path.basename(file)} */\n${fs.readFileSync(file, 'utf8')}`);

  const epilogue = [
    ';globalThis.__exports = {};',
    ...exportNames.map(
      (name) => `try { globalThis.__exports[${JSON.stringify(name)}] = ${name}; } catch (e) {}`
    ),
  ].join('\n');

  vm.runInContext([...sources, epilogue].join('\n;\n'), context, {
    filename: files.map((f) => path.basename(f)).join('+'),
  });

  const exported = context.__exports;
  for (const name of exportNames) {
    if (!exported[name]) {
      throw new Error(
        `Expected global "${name}" to be defined by ${files.map((f) => path.basename(f)).join(', ')}`
      );
    }
  }

  return exported;
}

/** Load the live extension scorer (extension/lib). */
function loadCurrent() {
  return loadScripts(
    [
      path.join(LIB_DIR, 'vocab.js'),
      path.join(LIB_DIR, 'tfidf.js'),
      path.join(LIB_DIR, 'matcher.js'),
    ],
    ['SkillVocab', 'TFIDF', 'JobMatcher']
  );
}

/**
 * Load the frozen pre-fix scorer snapshot. Kept so the eval harness can still
 * report the original numbers after extension/lib has been repaired.
 */
function loadBaseline() {
  return loadScripts(
    [
      path.join(BASELINE_DIR, 'tfidf.baseline.js'),
      path.join(BASELINE_DIR, 'matcher.baseline.js'),
    ],
    ['TFIDF', 'JobMatcher']
  );
}

module.exports = { loadScripts, loadCurrent, loadBaseline, REPO_ROOT, LIB_DIR };
