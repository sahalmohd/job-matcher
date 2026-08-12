/**
 * Job scoring: lexical similarity + skill coverage + role-fit signals.
 *
 * The skill vocabulary lives in lib/vocab.js (SkillVocab) so it is not
 * duplicated between here and the tokenizer.
 */
const JobMatcher = (() => {
  const DEFAULT_WEIGHTS = {
    lexical: 0.55,
    skills: 0.45,
  };

  /**
   * Postings that name only a handful of skills cannot support a confident
   * skill score: matching the 2 skills a sparse posting mentions is not
   * evidence of a good fit the way matching 15 of 18 is. Below this count the
   * skill component's influence is scaled down rather than taken at face value.
   */
  const CONFIDENT_SKILL_COUNT = 5;

  /** Job text worth scoring at all. Shorter than this and we decline. */
  const MIN_SCOREABLE_CHARS = 40;

  /**
   * Accept both the current {lexical, skills} shape and the legacy
   * {tfidf, skills} shape. Settings saved by earlier versions are still in
   * chrome.storage, and reading `lexical` off them would yield undefined and
   * poison every score with NaN.
   */
  function normalizeWeights(weights) {
    if (!weights) return DEFAULT_WEIGHTS;
    const lexical = weights.lexical != null ? weights.lexical : weights.tfidf;
    const skills = weights.skills;
    if (typeof lexical !== 'number' || typeof skills !== 'number') return DEFAULT_WEIGHTS;

    const total = lexical + skills;
    if (total <= 0) return DEFAULT_WEIGHTS;
    return { lexical: lexical / total, skills: skills / total };
  }

  function jobText(job) {
    return [job.title, job.company, job.location, job.description]
      .filter(Boolean)
      .join('\n');
  }

  /** Text that describes the role's requirements, excluding company/location noise. */
  function requirementText(job) {
    return [job.title, job.description].filter(Boolean).join('\n');
  }

  function extractSkills(text) {
    return SkillVocab.extract(String(text || ''));
  }

  /**
   * Role-fit signals that are constraints to compare, not skills to match.
   *
   * These used to be pushed into the skills array as matched literal text, so
   * "5+ years of experience" became a "skill" the resume had to contain
   * verbatim — permanently inflating missingSkills and deflating the ratio.
   */
  function extractRoleSignals(text) {
    const lower = String(text || '').toLowerCase();

    const yearsMatch = lower.match(/(\d+)\s*\+?\s*years?(?:\s+of)?\s+(?:relevant\s+|professional\s+|industry\s+)?experience/);
    const years = yearsMatch ? Number(yearsMatch[1]) : null;

    const seniority =
      /\b(?:staff|principal|distinguished)\b/.test(lower) ? 'staff'
      : /\b(?:senior|sr\.?|lead)\b/.test(lower) ? 'senior'
      : /\b(?:junior|jr\.?|graduate|entry[- ]level|intern)\b/.test(lower) ? 'junior'
      : /\b(?:head of|director|vp of engineering)\b/.test(lower) ? 'executive'
      : null;

    const roleType =
      /\b(?:engineering manager|people manager|manage a team|line management|you will not be writing production code)\b/.test(lower) ? 'management'
      : /\b(?:recruiter|recruiting|talent acquisition|sourcing candidates)\b/.test(lower) ? 'recruiting'
      : /\b(?:account executive|sales|quota|prospecting)\b/.test(lower) ? 'sales'
      : /\b(?:front[- ]?end)\b/.test(lower) && !/\b(?:back[- ]?end|full[- ]?stack)\b/.test(lower) ? 'frontend'
      : /\b(?:back[- ]?end)\b/.test(lower) ? 'backend'
      : /\bfull[- ]?stack\b/.test(lower) ? 'fullstack'
      : /\b(?:site reliability|sre|platform engineer|devops)\b/.test(lower) ? 'platform'
      : /\b(?:data engineer|data platform|analytics engineer)\b/.test(lower) ? 'data'
      : /\b(?:machine learning engineer|ml engineer|data scientist)\b/.test(lower) ? 'ml'
      : /\b(?:ios|android|mobile) (?:engineer|developer)\b/.test(lower) ? 'mobile'
      : null;

    const remote =
      /\b(?:fully remote|remote[- ]first|100% remote|remote \()/.test(lower) ? 'remote'
      : /\bhybrid\b/.test(lower) ? 'hybrid'
      : /\b(?:onsite|on[- ]site|in[- ]office|five days a week)\b/.test(lower) ? 'onsite'
      : null;

    return { years, seniority, roleType, remote };
  }

  /**
   * Skill coverage of the job's requirements by the resume.
   *
   * The old ratio divided only by jobSkills.length, so a posting naming two
   * skills the candidate happened to have scored a perfect 100 while a
   * thorough posting naming 25 was punished for being specific. This keeps
   * coverage as the numerator but damps the result when the posting named too
   * few skills to justify confidence.
   */
  function skillMatchRatio(resumeSkills, jobSkills) {
    if (jobSkills.length === 0) return 0;

    const resumeSet = new Set(resumeSkills.map((s) => s.toLowerCase()));
    const matched = jobSkills.filter((s) => resumeSet.has(s.toLowerCase())).length;
    const coverage = matched / jobSkills.length;

    // Shrink toward 0.5 (no information) when the posting is skill-sparse.
    const confidence = Math.min(1, jobSkills.length / CONFIDENT_SKILL_COUNT);
    return coverage * confidence + 0.5 * coverage * (1 - confidence);
  }

  /**
   * Penalty in points for role-fit mismatches the lexical scorer cannot see.
   * A recruiter posting that lists every technology in the stack overlaps
   * heavily with an engineer's resume; the role type is what separates them.
   */
  function roleFitPenalty(resumeSignals, jobSignals) {
    let penalty = 0;
    const reasons = [];

    // Non-engineering roles that nonetheless quote the whole engineering stack.
    if (['recruiting', 'sales'].includes(jobSignals.roleType)) {
      penalty += 35;
      reasons.push(`role is ${jobSignals.roleType}, not engineering`);
    }

    if (jobSignals.roleType === 'management' && resumeSignals.roleType !== 'management') {
      penalty += 12;
      reasons.push('people-management role');
    }

    // Seniority: being well over-qualified is a real mismatch, not a bonus.
    const rank = { junior: 1, senior: 3, staff: 4, executive: 5 };
    const jobRank = rank[jobSignals.seniority];
    const resumeRank = rank[resumeSignals.seniority];
    if (jobRank && resumeRank && resumeRank - jobRank >= 2) {
      penalty += 15;
      reasons.push(`posting is ${jobSignals.seniority}-level`);
    }

    // Years of experience required well beyond what the resume evidences.
    if (jobSignals.years && resumeSignals.years && jobSignals.years - resumeSignals.years >= 3) {
      penalty += 10;
      reasons.push(`wants ${jobSignals.years}+ years`);
    }

    return { penalty, reasons };
  }

  /**
   * Score every job in one pass.
   *
   * This is the production entry point. It builds the IDF corpus from all jobs
   * plus the resume — the previous per-job path computed IDF over just two
   * documents, which is what made the similarity degenerate — and extracts the
   * resume's skills once instead of once per job.
   */
  function scoreBatch(resumeText, jobs, options = {}) {
    const weights = normalizeWeights(options.weights);

    const resumeTokens = TFIDF.tokenize(resumeText);
    const resumeSkills = extractSkills(resumeText);
    const resumeSignals = extractRoleSignals(resumeText);

    const jobTokenList = jobs.map((job) => TFIDF.tokenize(jobText(job)));

    // Corpus = the resume plus every job in this batch.
    const corpus = [resumeTokens, ...jobTokenList];
    const idf = TFIDF.buildIdf(corpus);
    const corpusSize = corpus.length;

    return jobs.map((job, i) => {
      const reqText = requirementText(job);

      // A job we have no real text for is not a zero — it is unknown. Saying
      // "0% match" about a posting we never fetched is a different claim from
      // "we could not score this", and the UI should be able to tell them apart.
      if (reqText.trim().length < MIN_SCOREABLE_CHARS) {
        return {
          score: null,
          scoreable: false,
          reason: 'no job description available',
          lexicalScore: null,
          skillScore: null,
          matchedSkills: [],
          missingSkills: [],
          roleSignals: extractRoleSignals(reqText),
        };
      }

      const lexicalScore = TFIDF.similarity(resumeTokens, jobTokenList[i], idf, corpusSize);
      const jobSkills = extractSkills(reqText);
      const jobSignals = extractRoleSignals(reqText);

      const resumeSet = new Set(resumeSkills.map((s) => s.toLowerCase()));
      const matchedSkills = jobSkills.filter((s) => resumeSet.has(s.toLowerCase()));
      const missingSkills = jobSkills.filter((s) => !resumeSet.has(s.toLowerCase()));

      const skillScore = Math.round(skillMatchRatio(resumeSkills, jobSkills) * 100 * 100) / 100;

      // With no skills named at all, the skill component has nothing to say;
      // let the lexical score carry the full weight rather than averaging in a
      // guaranteed zero.
      const effective = jobSkills.length === 0
        ? { lexical: 1, skills: 0 }
        : weights;

      const base = (lexicalScore || 0) * effective.lexical + skillScore * effective.skills;
      const { penalty, reasons } = roleFitPenalty(resumeSignals, jobSignals);
      const finalScore = Math.max(0, Math.round((base - penalty) * 100) / 100);

      return {
        score: finalScore,
        scoreable: true,
        lexicalScore,
        skillScore,
        matchedSkills,
        missingSkills,
        roleSignals: jobSignals,
        penalty,
        penaltyReasons: reasons,
        resumeSkillCount: resumeSkills.length,
        jobSkillCount: jobSkills.length,
      };
    });
  }

  /**
   * Score a single job. Kept for the interactive path; note that a one-job
   * corpus gives weak IDF, so prefer scoreBatch when scoring a whole scan.
   */
  function scoreJob(resumeText, job, weights = DEFAULT_WEIGHTS) {
    return scoreBatch(resumeText, [job], { weights })[0];
  }

  /**
   * Score jobs and return those at or above the threshold, best first.
   *
   * Jobs with no usable description are excluded rather than scored as zero —
   * callers that need to see them (to retry enrichment, say) should use
   * scoreBatch, which reports every job with a `scoreable` flag.
   */
  function matchJobs(resumeText, jobs, threshold = 0, weights = DEFAULT_WEIGHTS) {
    return scoreBatch(resumeText, jobs, { weights })
      .map((result, i) => ({ job: jobs[i], ...result }))
      .filter((entry) => entry.scoreable && entry.score >= threshold)
      .sort((a, b) => b.score - a.score);
  }

  function getScoreCategory(score) {
    if (score == null) return 'unknown';
    if (score >= 75) return 'excellent';
    if (score >= 55) return 'good';
    if (score >= 35) return 'fair';
    return 'low';
  }

  return {
    scoreBatch,
    scoreJob,
    matchJobs,
    extractSkills,
    extractRoleSignals,
    skillMatchRatio,
    roleFitPenalty,
    getScoreCategory,
    DEFAULT_WEIGHTS,
    SKILL_IDS: SkillVocab.ids(),
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = JobMatcher;
}
