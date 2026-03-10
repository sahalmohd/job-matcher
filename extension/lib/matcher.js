const JobMatcher = (() => {
  const SKILLS_DB = [
    // Programming Languages
    'javascript', 'typescript', 'python', 'java', 'c++', 'c#', 'go', 'golang',
    'rust', 'ruby', 'php', 'swift', 'kotlin', 'scala', 'r', 'matlab',
    'perl', 'haskell', 'elixir', 'clojure', 'dart', 'lua', 'objective-c',
    'assembly', 'cobol', 'fortran', 'groovy', 'julia',

    // Frontend
    'react', 'angular', 'vue', 'svelte', 'next.js', 'nuxt', 'gatsby',
    'html', 'css', 'sass', 'less', 'tailwind', 'bootstrap', 'material-ui',
    'webpack', 'vite', 'babel', 'jquery', 'redux', 'mobx', 'zustand',

    // Backend
    'node.js', 'express', 'django', 'flask', 'fastapi', 'spring', 'spring-boot',
    'rails', 'laravel', 'asp.net', '.net', 'gin', 'fiber', 'nest.js',
    'graphql', 'rest', 'grpc', 'websocket', 'microservices',

    // Databases
    'sql', 'mysql', 'postgresql', 'mongodb', 'redis', 'elasticsearch',
    'cassandra', 'dynamodb', 'firebase', 'supabase', 'sqlite', 'oracle',
    'mariadb', 'neo4j', 'couchdb', 'influxdb',

    // Cloud & DevOps
    'aws', 'azure', 'gcp', 'docker', 'kubernetes', 'terraform', 'ansible',
    'jenkins', 'github-actions', 'gitlab-ci', 'circleci', 'ci/cd',
    'nginx', 'apache', 'linux', 'bash', 'shell',
    'cloudformation', 'pulumi', 'helm', 'istio', 'prometheus', 'grafana',
    'datadog', 'splunk', 'elk',

    // Data & ML
    'machine-learning', 'deep-learning', 'tensorflow', 'pytorch', 'keras',
    'scikit-learn', 'pandas', 'numpy', 'scipy', 'spark', 'hadoop',
    'airflow', 'kafka', 'flink', 'dbt', 'snowflake', 'bigquery',
    'tableau', 'power-bi', 'looker', 'data-engineering', 'etl',
    'nlp', 'computer-vision', 'reinforcement-learning',

    // Mobile
    'react-native', 'flutter', 'ios', 'android', 'swiftui', 'jetpack-compose',
    'xamarin', 'ionic', 'cordova',

    // Testing
    'jest', 'mocha', 'cypress', 'selenium', 'playwright', 'pytest',
    'junit', 'rspec', 'testing-library', 'vitest', 'storybook',

    // Tools & Practices
    'git', 'github', 'gitlab', 'bitbucket', 'jira', 'confluence',
    'agile', 'scrum', 'kanban', 'tdd', 'bdd', 'solid',
    'design-patterns', 'system-design', 'architecture',

    // Security
    'oauth', 'jwt', 'ssl', 'encryption', 'penetration-testing',
    'soc2', 'gdpr', 'hipaa', 'cybersecurity',
  ];

  const DEFAULT_WEIGHTS = {
    tfidf: 0.6,
    skills: 0.4,
  };

  const DEFAULT_THRESHOLD = 70;

  /**
   * Extract skills from text by matching against the skills database.
   * Returns an array of matched skill strings.
   */
  function extractSkills(text) {
    const lower = text.toLowerCase();
    const found = [];

    for (const skill of SKILLS_DB) {
      // Build a regex that matches the skill as a whole word
      const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`\\b${escaped}\\b`, 'i');
      if (pattern.test(lower)) {
        found.push(skill);
      }
    }

    // Also extract multi-word phrases commonly found in job postings
    const multiWordPatterns = [
      /\b(\d+)\+?\s*years?\s*(?:of\s*)?experience\b/gi,
      /\bfull[- ]?stack\b/gi,
      /\bfront[- ]?end\b/gi,
      /\bback[- ]?end\b/gi,
      /\bdata\s*scien(?:ce|tist)\b/gi,
      /\bdevops\s*engineer\b/gi,
      /\bsite\s*reliability\b/gi,
      /\bproject\s*management\b/gi,
      /\bproduct\s*management\b/gi,
    ];

    for (const pattern of multiWordPatterns) {
      const matches = lower.match(pattern);
      if (matches) {
        found.push(...matches.map((m) => m.trim()));
      }
    }

    return [...new Set(found)];
  }

  /**
   * Compute skill match ratio between resume skills and job skills.
   * Returns a value between 0 and 1.
   */
  function skillMatchRatio(resumeSkills, jobSkills) {
    if (jobSkills.length === 0) return 0;

    const resumeSet = new Set(resumeSkills.map((s) => s.toLowerCase()));
    let matched = 0;

    for (const skill of jobSkills) {
      if (resumeSet.has(skill.toLowerCase())) {
        matched++;
      }
    }

    return matched / jobSkills.length;
  }

  /**
   * Score a single job against the resume.
   *
   * @param {string} resumeText - Full text of the resume
   * @param {Object} job - Job object with at least { description }
   * @param {Object} [weights] - Optional { tfidf: 0.6, skills: 0.4 }
   * @returns {Object} { score, tfidfScore, skillScore, matchedSkills, missingSkills }
   */
  function scoreJob(resumeText, job, weights = DEFAULT_WEIGHTS) {
    const jobText = [job.title, job.company, job.description, job.location]
      .filter(Boolean)
      .join(' ');

    // TF-IDF cosine similarity (0-100)
    const tfidfScore = TFIDF.score(resumeText, jobText);

    // Skill matching
    const resumeSkills = extractSkills(resumeText);
    const jobSkills = extractSkills(jobText);
    const ratio = skillMatchRatio(resumeSkills, jobSkills);
    const skillScore = Math.round(ratio * 100 * 100) / 100;

    const matchedSkills = jobSkills.filter((s) =>
      resumeSkills.some((rs) => rs.toLowerCase() === s.toLowerCase())
    );
    const missingSkills = jobSkills.filter(
      (s) => !resumeSkills.some((rs) => rs.toLowerCase() === s.toLowerCase())
    );

    const finalScore =
      Math.round((tfidfScore * weights.tfidf + skillScore * weights.skills) * 100) / 100;

    return {
      score: finalScore,
      tfidfScore,
      skillScore,
      matchedSkills,
      missingSkills,
      resumeSkillCount: resumeSkills.length,
      jobSkillCount: jobSkills.length,
    };
  }

  /**
   * Score multiple jobs and filter by threshold.
   *
   * @param {string} resumeText - Full resume text
   * @param {Array} jobs - Array of job objects
   * @param {number} [threshold] - Minimum score to include (0-100)
   * @param {Object} [weights] - TF-IDF / skill weights
   * @returns {Array} Sorted array of { job, ...scoreDetails } above threshold
   */
  function matchJobs(resumeText, jobs, threshold = DEFAULT_THRESHOLD, weights = DEFAULT_WEIGHTS) {
    const results = [];

    for (const job of jobs) {
      const result = scoreJob(resumeText, job, weights);
      if (result.score >= threshold) {
        results.push({ job, ...result });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results;
  }

  /**
   * Get score category for UI color coding.
   */
  function getScoreCategory(score) {
    if (score >= 80) return 'excellent';
    if (score >= 60) return 'good';
    if (score >= 40) return 'fair';
    return 'low';
  }

  return {
    scoreJob,
    matchJobs,
    extractSkills,
    skillMatchRatio,
    getScoreCategory,
    DEFAULT_WEIGHTS,
    DEFAULT_THRESHOLD,
    SKILLS_DB,
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = JobMatcher;
}
