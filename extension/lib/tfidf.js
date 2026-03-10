const TFIDF = (() => {
  const STOP_WORDS = new Set([
    'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
    'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
    'could', 'should', 'may', 'might', 'shall', 'can', 'need', 'dare',
    'ought', 'used', 'this', 'that', 'these', 'those', 'i', 'me', 'my',
    'myself', 'we', 'our', 'ours', 'ourselves', 'you', 'your', 'yours',
    'yourself', 'yourselves', 'he', 'him', 'his', 'himself', 'she', 'her',
    'hers', 'herself', 'it', 'its', 'itself', 'they', 'them', 'their',
    'theirs', 'themselves', 'what', 'which', 'who', 'whom', 'whose',
    'when', 'where', 'why', 'how', 'all', 'each', 'every', 'both', 'few',
    'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only',
    'own', 'same', 'so', 'than', 'too', 'very', 'just', 'because', 'as',
    'until', 'while', 'about', 'between', 'through', 'during', 'before',
    'after', 'above', 'below', 'up', 'down', 'out', 'off', 'over',
    'under', 'again', 'further', 'then', 'once', 'here', 'there', 'any',
    'also', 'etc', 'able', 'using', 'work', 'working', 'including',
  ]);

  /**
   * Tokenize text: lowercase, split on non-alphanumeric (keeping tech terms like c++, c#, .net),
   * remove stop words, and filter short tokens.
   */
  function tokenize(text) {
    const normalized = text.toLowerCase();
    // Preserve common tech terms before generic splitting
    const techTerms = extractTechTerms(normalized);

    const words = normalized
      .replace(/[^a-z0-9#+.\-]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 2 && !STOP_WORDS.has(w))
      .map((w) => w.replace(/^[.\-]+|[.\-]+$/g, ''));

    return [...new Set([...words, ...techTerms])].filter((w) => w.length >= 2);
  }

  function extractTechTerms(text) {
    const patterns = [
      /\b(node\.js|react\.js|vue\.js|next\.js|express\.js)\b/g,
      /\b(c\+\+|c#|\.net|f#)\b/g,
      /\b(aws|gcp|azure|docker|kubernetes|k8s)\b/g,
      /\b(postgresql|mongodb|mysql|redis|elasticsearch)\b/g,
      /\b(tensorflow|pytorch|scikit-learn|pandas|numpy)\b/g,
      /\b(ci\/cd|devops|rest\s*api|graphql)\b/g,
      /\b(machine\s*learning|deep\s*learning|natural\s*language\s*processing)\b/g,
    ];

    const found = [];
    for (const pattern of patterns) {
      let m;
      while ((m = pattern.exec(text)) !== null) {
        found.push(m[1].replace(/\s+/g, '-'));
      }
    }
    return found;
  }

  /**
   * Compute term frequency: count of each token / total tokens.
   */
  function termFrequency(tokens) {
    const tf = {};
    for (const token of tokens) {
      tf[token] = (tf[token] || 0) + 1;
    }
    const total = tokens.length || 1;
    for (const key of Object.keys(tf)) {
      tf[key] = tf[key] / total;
    }
    return tf;
  }

  /**
   * Compute IDF across a set of documents.
   * idf(t) = log(N / (1 + df(t))) where df(t) = number of docs containing term t.
   */
  function inverseDocumentFrequency(documents) {
    const N = documents.length;
    const df = {};
    for (const doc of documents) {
      const seen = new Set(doc);
      for (const token of seen) {
        df[token] = (df[token] || 0) + 1;
      }
    }
    const idf = {};
    for (const [term, count] of Object.entries(df)) {
      idf[term] = Math.log(N / (1 + count));
    }
    return idf;
  }

  /**
   * Build a TF-IDF vector for a single document given precomputed IDF.
   */
  function tfidfVector(tokens, idf) {
    const tf = termFrequency(tokens);
    const vec = {};
    for (const [term, freq] of Object.entries(tf)) {
      vec[term] = freq * (idf[term] || 0);
    }
    return vec;
  }

  /**
   * Cosine similarity between two sparse vectors (objects).
   * Returns a value between 0 and 1.
   */
  function cosineSimilarity(vecA, vecB) {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (const [key, val] of Object.entries(vecA)) {
      normA += val * val;
      if (vecB[key] !== undefined) {
        dotProduct += val * vecB[key];
      }
    }
    for (const val of Object.values(vecB)) {
      normB += val * val;
    }

    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    if (denom === 0) return 0;
    return dotProduct / denom;
  }

  /**
   * Score the similarity between a resume and a job description.
   * Uses the two documents to build a small corpus for IDF, then computes cosine similarity.
   * Returns a score between 0 and 100.
   */
  function score(resumeText, jobText) {
    const resumeTokens = tokenize(resumeText);
    const jobTokens = tokenize(jobText);

    if (resumeTokens.length === 0 || jobTokens.length === 0) return 0;

    const idf = inverseDocumentFrequency([resumeTokens, jobTokens]);
    const resumeVec = tfidfVector(resumeTokens, idf);
    const jobVec = tfidfVector(jobTokens, idf);

    return Math.round(cosineSimilarity(resumeVec, jobVec) * 100 * 100) / 100;
  }

  return {
    tokenize,
    termFrequency,
    inverseDocumentFrequency,
    tfidfVector,
    cosineSimilarity,
    score,
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = TFIDF;
}
