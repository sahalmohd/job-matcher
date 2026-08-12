'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const zlib = require('node:zlib');

const { loadScripts, loadCurrent, loadBaseline, LIB_DIR } = require('../eval/load');

const { SkillVocab, TFIDF, JobMatcher } = loadCurrent();

// ---------------------------------------------------------------------------
// Regression: the bug that made every score meaningless
// ---------------------------------------------------------------------------

test('baseline cosine was a boolean — regression guard', () => {
  // Documents that share one token vs. many should not score identically.
  // The old implementation returned exactly 1.0 for both.
  const base = loadBaseline();
  const t = (s) => base.TFIDF.tokenize(s);
  const cos = (a, b) => {
    const idf = base.TFIDF.inverseDocumentFrequency([t(a), t(b)]);
    return base.TFIDF.cosineSimilarity(
      base.TFIDF.tfidfVector(t(a), idf),
      base.TFIDF.tfidfVector(t(b), idf)
    );
  };

  // Documenting the old behaviour so nobody reintroduces it.
  assert.equal(cos('python kafka spark', 'python kafka spark'), 1);
  assert.equal(cos('python alpha beta gamma', 'python zeta eta theta'), 1);
});

test('similarity varies with how much the resume covers', () => {
  const resume = 'python kafka kubernetes terraform postgresql airflow spark';
  const strong = 'we need python kafka kubernetes terraform experience';
  const weak = 'we need cobol fortran mainframe python experience';

  const docs = [resume, strong, weak].map((d) => TFIDF.tokenize(d));
  const idf = TFIDF.buildIdf(docs);

  const strongScore = TFIDF.similarity(docs[0], docs[1], idf, docs.length);
  const weakScore = TFIDF.similarity(docs[0], docs[2], idf, docs.length);

  assert.ok(strongScore > weakScore, `expected ${strongScore} > ${weakScore}`);
  assert.ok(strongScore <= 100 && weakScore >= 0);
});

test('tokenize preserves term counts', () => {
  const tokens = TFIDF.tokenize('kafka kafka kafka python');
  const counts = TFIDF.termCounts(tokens);
  assert.equal(counts.get('kafka'), 3);
  assert.equal(counts.get('python'), 1);
});

test('idf is strictly positive for every term', () => {
  const docs = ['alpha beta', 'beta gamma', 'alpha beta gamma'].map((d) => TFIDF.tokenize(d));
  const idf = TFIDF.buildIdf(docs);
  for (const [term, weight] of idf) {
    assert.ok(weight > 0, `idf(${term}) = ${weight} should be > 0`);
  }
});

test('rarer shared terms outweigh ubiquitous ones', () => {
  // "experience" appears everywhere; "flink" is rare. A resume matching flink
  // should beat one matching only the filler word.
  const jobs = Array.from({ length: 8 }, () => 'experience required for this role');
  const corpus = [...jobs, 'experience with flink'].map((d) => TFIDF.tokenize(d));
  const idf = TFIDF.buildIdf(corpus);
  assert.ok(
    idf.get('flink') > idf.get('experience'),
    `flink (${idf.get('flink')}) should outweigh experience (${idf.get('experience')})`
  );
});

// ---------------------------------------------------------------------------
// Skill extraction
// ---------------------------------------------------------------------------

test('symbol-bearing skills are extractable', () => {
  // \bc\+\+\b can never match; these all silently failed before.
  const text = 'Strong C++ and C# experience, some F#, plus .NET and ASP.NET work.';
  const skills = JobMatcher.extractSkills(text);
  for (const expected of ['c++', 'c#', 'f#', '.net', 'asp.net']) {
    assert.ok(skills.includes(expected), `expected to extract "${expected}" from: ${text}`);
  }
});

test('aliases map to canonical skill ids', () => {
  const cases = [
    ['We run Postgres in production', 'postgresql'],
    ['k8s operators', 'kubernetes'],
    ['built in Golang', 'go'],
    ['NodeJS services', 'node.js'],
    ['scikit-learn and sklearn', 'scikit-learn'],
  ];
  for (const [text, expected] of cases) {
    assert.ok(
      JobMatcher.extractSkills(text).includes(expected),
      `"${text}" should yield "${expected}"`
    );
  }
});

test('ambiguous words do not fire on ordinary prose', () => {
  const prose =
    'You will go to conferences, handle the rest of the backlog, and do R&D work. ' +
    'We go above and beyond for the rest of the team.';
  const skills = JobMatcher.extractSkills(prose);
  assert.ok(!skills.includes('go'), 'bare "go" in prose must not match the Go language');
  assert.ok(!skills.includes('rest'), '"the rest of" must not match REST');
  assert.ok(!skills.includes('r'), '"R&D" must not match the R language');
});

test('substring collisions are avoided', () => {
  assert.ok(!JobMatcher.extractSkills('JavaScript only').includes('java'));
  assert.ok(!JobMatcher.extractSkills('We use Preact').includes('react'));
  // ...but hyphenated and dotted compounds still credit their parts.
  assert.ok(JobMatcher.extractSkills('React-based frontend').includes('react'));
});

test('years-of-experience is a role signal, not a skill', () => {
  const skills = JobMatcher.extractSkills('We need 5+ years of experience with Python');
  assert.ok(!skills.some((s) => /year/.test(s)), `no skill should mention years: ${skills}`);

  const signals = JobMatcher.extractRoleSignals('We need 5+ years of experience with Python');
  assert.equal(signals.years, 5);
});

test('skill regexes are compiled once, not per call', () => {
  // Guard against reintroducing per-call RegExp construction: 2000 extractions
  // should stay comfortably fast.
  const text = 'python kafka kubernetes terraform aws postgresql '.repeat(20);
  const started = Date.now();
  for (let i = 0; i < 2000; i++) JobMatcher.extractSkills(text);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 4000, `2000 extractions took ${elapsed}ms — regexes may be rebuilt per call`);
});

// ---------------------------------------------------------------------------
// Skill scoring
// ---------------------------------------------------------------------------

test('sparse postings cannot claim a perfect skill score', () => {
  const resumeSkills = ['python', 'kafka', 'aws', 'terraform', 'kubernetes'];

  const sparse = JobMatcher.skillMatchRatio(resumeSkills, ['python']);
  const thorough = JobMatcher.skillMatchRatio(resumeSkills, [
    'python', 'kafka', 'aws', 'terraform', 'kubernetes',
  ]);

  assert.ok(sparse < 1, `a one-skill posting should not score 100% (got ${sparse})`);
  assert.ok(
    thorough > sparse,
    `fully covering a detailed posting (${thorough}) should beat matching a sparse one (${sparse})`
  );
});

test('skill score rises with coverage', () => {
  const job = ['python', 'kafka', 'aws', 'terraform', 'kubernetes', 'airflow'];
  const none = JobMatcher.skillMatchRatio([], job);
  const half = JobMatcher.skillMatchRatio(['python', 'kafka', 'aws'], job);
  const full = JobMatcher.skillMatchRatio(job, job);
  assert.equal(none, 0);
  assert.ok(half > none && full > half, `${none} < ${half} < ${full}`);
});

// ---------------------------------------------------------------------------
// Batch scoring
// ---------------------------------------------------------------------------

const RESUME = `
Senior backend engineer, 8 years. Python and Go, Kafka and Flink streaming,
Kubernetes on AWS with Terraform, PostgreSQL and Redis. Built data pipelines
with Airflow and dbt on Snowflake. Mentored engineers.
`;

test('scoreBatch declines jobs with no description', () => {
  const [result] = JobMatcher.scoreBatch(RESUME, [
    { title: 'Engineer', company: 'X', location: 'Berlin', description: '' },
  ]);
  assert.equal(result.scoreable, false);
  assert.equal(result.score, null, 'an unfetched posting must not be reported as a 0% match');
});

test('scoreBatch ranks a relevant job above an irrelevant one', () => {
  const jobs = [
    {
      title: 'Registered Nurse, ICU',
      description:
        'Deliver direct patient care, monitor ventilated patients, administer medication ' +
        'and coordinate with consultants. German nursing registration required.',
    },
    {
      title: 'Senior Data Platform Engineer',
      description:
        'Python and Go, streaming on Kafka and Flink, Kubernetes on AWS with Terraform, ' +
        'dbt on Snowflake, Airflow orchestration. 6+ years required.',
    },
  ];
  const [nurse, engineer] = JobMatcher.scoreBatch(RESUME, jobs);
  assert.ok(
    engineer.score > nurse.score + 20,
    `engineering role (${engineer.score}) should clearly beat nursing (${nurse.score})`
  );
});

test('legacy {tfidf, skills} weights do not produce NaN', () => {
  // Settings saved by earlier versions still carry the old key name.
  const [result] = JobMatcher.scoreBatch(
    RESUME,
    [{ title: 'Backend Engineer', description: 'Python, Kafka and Kubernetes on AWS. 5+ years.' }],
    { weights: { tfidf: 0.6, skills: 0.4 } }
  );
  assert.ok(Number.isFinite(result.score), `score should be finite, got ${result.score}`);
  assert.ok(result.score > 0);
});

test('matchJobs filters by threshold and sorts descending', () => {
  const jobs = [
    { title: 'Nurse', description: 'Patient care, ventilators, medication rounds, ICU ward.' },
    { title: 'Backend Engineer', description: 'Python, Kafka, Kubernetes, AWS, Terraform, Go.' },
    { title: 'Unknown', description: '' },
  ];
  const matches = JobMatcher.matchJobs(RESUME, jobs, 0);

  assert.ok(matches.length >= 2);
  assert.equal(matches[0].job.title, 'Backend Engineer');
  for (let i = 1; i < matches.length; i++) {
    assert.ok(matches[i - 1].score >= matches[i].score, 'results must be sorted descending');
  }
  assert.ok(
    !matches.some((m) => m.job.title === 'Unknown'),
    'unscoreable jobs must not appear as matches'
  );
});

test('non-engineering roles quoting the stack are penalised', () => {
  const recruiter = {
    title: 'Technical Recruiter',
    description:
      'Source and screen candidates for roles in Python, Go, Kafka, Kubernetes, AWS, ' +
      'Terraform, PostgreSQL and Snowflake. 3+ years of technical recruiting required.',
  };
  const [result] = JobMatcher.scoreBatch(RESUME, [recruiter]);
  assert.ok(result.penalty > 0, 'recruiting role should carry a role-fit penalty');
  assert.match(result.penaltyReasons.join(' '), /recruiting/);
});

// ---------------------------------------------------------------------------
// Resume parsing
// ---------------------------------------------------------------------------

/** Build a minimal but real DOCX in memory (deflated, like Word writes). */
function buildDocx(paragraphs) {
  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('') +
    '</w:body></w:document>';

  const files = [
    { name: '[Content_Types].xml', data: Buffer.from('<?xml version="1.0"?><Types/>') },
    { name: 'word/document.xml', data: Buffer.from(documentXml, 'utf8') },
  ];

  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const compressed = zlib.deflateRawSync(file.data);
    const crc = zlib.crc32 ? zlib.crc32(file.data) : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    // Bit 3: sizes live in a trailing data descriptor, not here. This is what
    // Word does, and what broke the old local-header-walking parser.
    local.writeUInt16LE(0x0008, 6);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(0, 18); // compressed size: zeroed, per bit 3
    local.writeUInt32LE(0, 22); // uncompressed size: zeroed, per bit 3
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(compressed.length, 8);
    descriptor.writeUInt32LE(file.data.length, 12);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0008, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);

    locals.push(local, nameBuf, compressed, descriptor);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + compressed.length + descriptor.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([Buffer.concat(locals), centralBuf, eocd]);
}

test('DOCX resumes parse', async () => {
  // Previously impossible: parseZip consumed an async decompressor
  // synchronously, so word/document.xml was never found and every .docx
  // upload failed.
  const { ResumeParser } = loadScripts(
    [path.join(LIB_DIR, 'parser.js')],
    ['ResumeParser'],
    { DecompressionStream, Blob, Response }
  );

  const docx = buildDocx(['Samira Okonkwo', 'Senior Backend Engineer', 'Python, Kafka, Go']);
  const file = {
    name: 'resume.docx',
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    size: docx.length,
    arrayBuffer: async () => docx.buffer.slice(docx.byteOffset, docx.byteOffset + docx.length),
  };

  const text = await ResumeParser.parse(file);
  assert.match(text, /Samira Okonkwo/);
  assert.match(text, /Python, Kafka, Go/);
});
