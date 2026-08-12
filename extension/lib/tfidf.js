/**
 * Lexical similarity between a resume and a job posting.
 *
 * Previous implementation was inert. tokenize() de-duplicated its output, so
 * every term frequency collapsed to 1/N and carried no information; IDF was
 * then computed over a corpus of exactly two documents, giving every
 * shared term the identical weight log(2/3) and every unique term log(1) = 0.
 * Each vector therefore became a constant multiple of the shared-term
 * indicator vector, making the two vectors always parallel — the cosine
 * returned exactly 1.0 whenever the documents shared a single token, and 0.0
 * otherwise. It was a boolean, and it supplied 60% of every displayed score.
 *
 * This version keeps term counts, builds IDF over the whole batch of jobs, and
 * scores with IDF-weighted coverage: what fraction of the job's weighted term
 * mass is present in the resume. Coverage answers the question the product
 * actually asks ("does this resume cover what the posting wants?") and, unlike
 * cosine, does not penalise a candidate for having experience beyond the role.
 */
const TFIDF = (() => {
  /**
   * Structural English words only. The previous list also contained 'work',
   * 'working', 'using', 'including' and 'able', which strip real signal —
   * "working knowledge of Kubernetes" and "able to mentor" lose their verb.
   */
  const STOP_WORDS = new Set([
    'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
    'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
    'could', 'should', 'may', 'might', 'shall', 'can', 'this', 'that',
    'these', 'those', 'i', 'me', 'my', 'myself', 'we', 'our', 'ours',
    'ourselves', 'you', 'your', 'yours', 'yourself', 'yourselves', 'he',
    'him', 'his', 'himself', 'she', 'her', 'hers', 'herself', 'it', 'its',
    'itself', 'they', 'them', 'their', 'theirs', 'themselves', 'what',
    'which', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how', 'all',
    'each', 'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such',
    'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
    'just', 'because', 'as', 'until', 'while', 'about', 'between', 'through',
    'during', 'before', 'after', 'above', 'below', 'up', 'down', 'out',
    'off', 'over', 'under', 'again', 'further', 'then', 'once', 'here',
    'there', 'any', 'also', 'etc', 'we', 'us', 'if', 'into', 'per',
  ]);

  /** Vocabulary surface tokens must never be stemmed. */
  const PROTECTED = typeof SkillVocab !== 'undefined' ? SkillVocab.SURFACE_TOKENS : new Set();
  const MULTIWORD = typeof SkillVocab !== 'undefined' ? SkillVocab.MULTIWORD : [];

  /**
   * Conservative suffix stemmer so engineer/engineering/engineers collapse to
   * one term. Deliberately does not strip -er: "engineering" -> "engineer"
   * already converges with "engineers" -> "engineer", and stripping -er would
   * over-stem "engineer" to "engine".
   */
  function stem(word) {
    if (word.length <= 3 || PROTECTED.has(word)) return word;

    if (/ies$/.test(word) && word.length > 4) return word.slice(0, -3) + 'y';
    if (/sses$/.test(word)) return word.slice(0, -2);
    if (/[^s]s$/.test(word) && !/(?:us|is|ss)$/.test(word)) {
      const base = word.slice(0, -1);
      if (!PROTECTED.has(base) && base.length >= 3) return base;
      return word;
    }
    if (/ing$/.test(word) && word.length > 5) {
      let base = word.slice(0, -3);
      // "running" -> "runn" -> "run"
      if (/([bdfglmnprt])\1$/.test(base)) base = base.slice(0, -1);
      if (base.length >= 3) return base;
    }
    if (/ed$/.test(word) && word.length > 4) {
      const base = word.slice(0, -2);
      if (base.length >= 3) return base;
    }
    return word;
  }

  /**
   * Tokenize into a term list that PRESERVES duplicates, so term frequency is
   * real. Multi-word vocabulary phrases are collapsed to single tokens first.
   */
  function tokenize(text) {
    let normalized = String(text || '').toLowerCase();

    // "machine learning" -> "machine-learning" before generic splitting, so the
    // phrase is one term rather than two independently common words.
    for (const { pattern, token } of MULTIWORD) {
      normalized = normalized.replace(pattern, token);
    }

    return normalized
      .replace(/[^a-z0-9#+./\-]/g, ' ')
      .split(/\s+/)
      .map((w) => w.replace(/^[.\-/]+|[.\-/]+$/g, ''))
      .filter((w) => w.length >= 2 && !STOP_WORDS.has(w))
      .map(stem)
      .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
  }

  /** Raw term counts (not normalised — callers decide). */
  function termCounts(tokens) {
    const counts = new Map();
    for (const token of tokens) {
      counts.set(token, (counts.get(token) || 0) + 1);
    }
    return counts;
  }

  /** Term frequency normalised by document length. */
  function termFrequency(tokens) {
    const counts = termCounts(tokens);
    const total = tokens.length || 1;
    const tf = {};
    for (const [term, count] of counts) tf[term] = count / total;
    return tf;
  }

  /**
   * Smoothed IDF over a corpus of tokenized documents.
   *
   * Uses log(1 + N/(1 + df)), which stays strictly positive for every term.
   * The previous log(N/(1+df)) went to exactly 0 for terms in a single document
   * and negative for terms in all of them.
   *
   * Pass the whole batch of jobs plus the resume. With only two documents there
   * is no meaningful document frequency to measure, so callers should prefer
   * the batch path.
   */
  function buildIdf(documents) {
    const N = documents.length;
    const df = new Map();
    for (const doc of documents) {
      for (const token of new Set(doc)) {
        df.set(token, (df.get(token) || 0) + 1);
      }
    }
    const idf = new Map();
    for (const [term, count] of df) {
      idf.set(term, Math.log(1 + N / (1 + count)));
    }
    return idf;
  }

  /** Fallback weight for a term absent from the corpus IDF (i.e. maximally rare). */
  function idfFor(idf, term, corpusSize) {
    const known = idf.get(term);
    if (known !== undefined) return known;
    return Math.log(1 + corpusSize / 1);
  }

  function tfidfVector(tokens, idf, corpusSize) {
    const tf = termFrequency(tokens);
    const vec = {};
    for (const [term, freq] of Object.entries(tf)) {
      vec[term] = freq * idfFor(idf, term, corpusSize);
    }
    return vec;
  }

  function cosineSimilarity(vecA, vecB) {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (const [key, val] of Object.entries(vecA)) {
      normA += val * val;
      if (vecB[key] !== undefined) dot += val * vecB[key];
    }
    for (const val of Object.values(vecB)) normB += val * val;
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  /**
   * IDF-weighted coverage: of the job's total weighted term mass, how much
   * appears in the resume at all. Rare terms (a specific technology) dominate;
   * common filler contributes little.
   *
   * This is asymmetric on purpose. Cosine punishes a broad resume for
   * containing terms the posting does not mention, which is exactly backwards
   * for candidate-to-role fit.
   */
  function weightedCoverage(resumeTokens, jobTokens, idf, corpusSize) {
    const resumeSet = new Set(resumeTokens);
    const jobCounts = termCounts(jobTokens);

    let total = 0;
    let covered = 0;
    for (const [term, count] of jobCounts) {
      // Sublinear count weighting so a term repeated 20 times in boilerplate
      // does not dominate the posting's requirement profile.
      const weight = (1 + Math.log(count)) * idfFor(idf, term, corpusSize);
      total += weight;
      if (resumeSet.has(term)) covered += weight;
    }

    return total === 0 ? 0 : covered / total;
  }

  /**
   * Similarity of one job to the resume, given a corpus IDF.
   * Returns 0-100, or null when the job has no scoreable text.
   */
  function similarity(resumeTokens, jobTokens, idf, corpusSize) {
    if (resumeTokens.length === 0 || jobTokens.length === 0) return null;

    const coverage = weightedCoverage(resumeTokens, jobTokens, idf, corpusSize);
    const cosine = cosineSimilarity(
      tfidfVector(resumeTokens, idf, corpusSize),
      tfidfVector(jobTokens, idf, corpusSize)
    );

    // Coverage carries the signal; cosine contributes a modest amount of
    // whole-document shape so two jobs with identical coverage but very
    // different emphasis do not tie.
    const blended = 0.8 * coverage + 0.2 * cosine;
    return Math.round(blended * 100 * 100) / 100;
  }

  /**
   * Convenience single-pair score. The two-document corpus makes IDF weak, so
   * production code should use the batch path in JobMatcher.scoreBatch, which
   * builds IDF across every job in the scan.
   */
  function score(resumeText, jobText) {
    const resumeTokens = tokenize(resumeText);
    const jobTokens = tokenize(jobText);
    if (resumeTokens.length === 0 || jobTokens.length === 0) return null;

    const docs = [resumeTokens, jobTokens];
    return similarity(resumeTokens, jobTokens, buildIdf(docs), docs.length);
  }

  return {
    tokenize,
    stem,
    termCounts,
    termFrequency,
    buildIdf,
    tfidfVector,
    cosineSimilarity,
    weightedCoverage,
    similarity,
    score,
    STOP_WORDS,
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = TFIDF;
}
