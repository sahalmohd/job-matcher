'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseResponse, extractJsonObject, validateResponse } = require('../server/llm');

test('parses a clean JSON reply', () => {
  const parsed = parseResponse('{"score": 82, "rationale": "Strong overlap", "keyStrengths": ["Kafka"], "gaps": []}');
  assert.equal(parsed.score, 82);
  assert.equal(parsed.rationale, 'Strong overlap');
  assert.deepEqual(parsed.keyStrengths, ['Kafka']);
});

test('parses a reply wrapped in markdown fences', () => {
  const parsed = parseResponse('```json\n{"score": 70, "rationale": "ok"}\n```');
  assert.equal(parsed.score, 70);
});

test('parses a reply with prose around the JSON', () => {
  const parsed = parseResponse('Here is my assessment:\n{"score": 45, "rationale": "partial"}\nHope that helps!');
  assert.equal(parsed.score, 45);
});

test('nested objects survive extraction', () => {
  // The old non-greedy /\{[\s\S]*?\}/ stopped at the first closing brace and
  // produced invalid JSON, discarding the whole score.
  const reply = '{"score": 77, "breakdown": {"skills": 80, "seniority": 70}, "rationale": "good"}';
  assert.equal(extractJsonObject(reply), reply);

  const parsed = parseResponse(`Sure!\n${reply}`);
  assert.equal(parsed.score, 77);
});

test('braces inside strings do not end extraction early', () => {
  const reply = '{"score": 50, "rationale": "uses {curly} braces in text"}';
  const parsed = parseResponse(reply);
  assert.equal(parsed.score, 50);
  assert.match(parsed.rationale, /\{curly\}/);
});

test('a non-numeric score yields null, not a confident zero', () => {
  // `Number(x) || 0` used to turn every one of these into a 0% match that was
  // then blended into the hybrid score.
  for (const bad of ['{"score": "high", "rationale": "x"}', '{"rationale": "no score"}', '{"score": null}']) {
    assert.equal(parseResponse(bad), null, `expected null for ${bad}`);
  }
});

test('scores are clamped into range', () => {
  assert.equal(validateResponse({ score: 140 }).score, 100);
  assert.equal(validateResponse({ score: -20 }).score, 0);
});

test('unparseable replies yield null', () => {
  assert.equal(parseResponse('I cannot score this posting.'), null);
  assert.equal(parseResponse(''), null);
});
