'use strict';

/**
 * Ranking metrics for comparing scorer variants against hand-labelled
 * relevance grades. Labels are graded: 2 = would apply, 1 = maybe,
 * 0 = irrelevant.
 */

/** Rank items by descending score. Ties broken by original index for stability. */
function rank(scored) {
  return [...scored]
    .map((item, idx) => ({ ...item, idx }))
    .sort((a, b) => b.score - a.score || a.idx - b.idx);
}

/**
 * Precision@k, counting a "relevant" hit as label >= minLabel.
 * Denominator is min(k, n) so short golden sets aren't unfairly penalised.
 */
function precisionAtK(scored, k, minLabel = 2) {
  const ranked = rank(scored).slice(0, k);
  if (ranked.length === 0) return 0;
  const hits = ranked.filter((r) => r.label >= minLabel).length;
  return hits / ranked.length;
}

/** Recall@k against the total number of relevant items in the set. */
function recallAtK(scored, k, minLabel = 2) {
  const totalRelevant = scored.filter((s) => s.label >= minLabel).length;
  if (totalRelevant === 0) return 0;
  const hits = rank(scored).slice(0, k).filter((r) => r.label >= minLabel).length;
  return hits / totalRelevant;
}

function dcg(labels) {
  return labels.reduce(
    (sum, label, i) => sum + (Math.pow(2, label) - 1) / Math.log2(i + 2),
    0
  );
}

/**
 * Normalised discounted cumulative gain at k. This is the headline metric:
 * unlike precision it rewards putting the *best* jobs at the very top, which is
 * what actually matters in a list the user skims from position 1.
 */
function ndcgAtK(scored, k) {
  const actual = rank(scored).slice(0, k).map((r) => r.label);
  const ideal = [...scored]
    .sort((a, b) => b.label - a.label)
    .slice(0, k)
    .map((r) => r.label);

  const idealDcg = dcg(ideal);
  if (idealDcg === 0) return 0;
  return dcg(actual) / idealDcg;
}

/** Convert values to average ranks, sharing ranks across ties. */
function toRanks(values) {
  const sorted = values
    .map((v, i) => ({ v, i }))
    .sort((a, b) => a.v - b.v);

  const ranks = new Array(values.length);
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].v === sorted[i].v) j++;
    // Average rank for the tied block (1-indexed).
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[sorted[k].i] = avg;
    i = j + 1;
  }
  return ranks;
}

/**
 * Spearman rank correlation between scores and labels. Uses the
 * Pearson-on-ranks form, which stays correct in the presence of ties (the
 * shortcut 1 - 6*sum(d^2)/(n^3-n) formula does not).
 */
function spearman(scored) {
  const n = scored.length;
  if (n < 2) return 0;

  const scoreRanks = toRanks(scored.map((s) => s.score));
  const labelRanks = toRanks(scored.map((s) => s.label));

  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const ms = mean(scoreRanks);
  const ml = mean(labelRanks);

  let num = 0;
  let dsq = 0;
  let lsq = 0;
  for (let i = 0; i < n; i++) {
    const ds = scoreRanks[i] - ms;
    const dl = labelRanks[i] - ml;
    num += ds * dl;
    dsq += ds * ds;
    lsq += dl * dl;
  }

  const denom = Math.sqrt(dsq * lsq);
  if (denom === 0) return 0;
  return num / denom;
}

/**
 * Fraction of distinct score values. A scorer that collapses many jobs onto the
 * same score cannot rank them, so this exposes discrimination loss that the
 * ranking metrics alone can hide.
 */
function scoreSpread(scored) {
  if (scored.length === 0) return { distinct: 0, ratio: 0, min: 0, max: 0 };
  const values = scored.map((s) => s.score);
  const distinct = new Set(values.map((v) => v.toFixed(4))).size;
  return {
    distinct,
    ratio: distinct / scored.length,
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

function evaluate(scored, { k = 10 } = {}) {
  return {
    n: scored.length,
    [`p@${k}`]: precisionAtK(scored, k),
    [`recall@${k}`]: recallAtK(scored, k),
    [`ndcg@${k}`]: ndcgAtK(scored, k),
    spearman: spearman(scored),
    spread: scoreSpread(scored),
  };
}

module.exports = {
  rank,
  precisionAtK,
  recallAtK,
  ndcgAtK,
  spearman,
  scoreSpread,
  toRanks,
  evaluate,
};
