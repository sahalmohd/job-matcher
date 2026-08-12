/**
 * Single source of truth for the skill vocabulary.
 *
 * This previously lived in two places that had already drifted apart:
 * SKILLS_DB in matcher.js and the extractTechTerms patterns in tfidf.js. Both
 * now read from here.
 *
 * Each entry is { id, aliases, ambiguous }:
 *   id        - canonical name, the form reported in matched/missing skills
 *   aliases   - other surface forms that mean the same thing. Matching any
 *               alias credits the canonical id, so a resume saying "Postgres"
 *               matches a posting saying "PostgreSQL".
 *   ambiguous - the surface form is also an ordinary English word ("go", "r",
 *               "rest"). These are matched only via contextPatterns, never as
 *               a bare token, because matching them freely fires on prose like
 *               "go to production" or "the rest of the team".
 */
const SkillVocab = (() => {
  /**
   * Boundary lookarounds used instead of \b.
   *
   * \b is a word-character boundary, so `\bc\+\+\b` can never match: after the
   * final `+` (a non-word char) followed by a space (also non-word) there is no
   * boundary. That silently made c++, c#, f# and .net unmatchable.
   *
   * `.` and `-` are deliberately excluded from both classes so that compounds
   * still credit their parts: "React-based" matches react, "node.js" matches
   * node. But "javascript" must not match java, and "preact" must not match
   * react, so alphanumerics and +#_ are excluded.
   */
  const LEFT = '(?<![a-z0-9+#_])';
  const RIGHT = '(?![a-z0-9+#_])';

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** Build a case-insensitive matcher for one literal surface form. */
  function surfacePattern(surface) {
    return new RegExp(LEFT + escapeRegex(surface) + RIGHT, 'i');
  }

  const SKILLS = [
    // ---- Languages ----
    { id: 'javascript', aliases: ['js', 'ecmascript'] },
    { id: 'typescript', aliases: ['ts'] },
    { id: 'python', aliases: ['python3'] },
    { id: 'java' },
    { id: 'c++', aliases: ['cpp'] },
    { id: 'c#', aliases: ['csharp'] },
    { id: 'f#', aliases: ['fsharp'] },
    {
      id: 'go',
      aliases: ['golang'],
      ambiguous: true,
      // Bare "go" is the single worst false-positive source in the old list.
      contextPatterns: [
        /\bgolang\b/i,
        /\bgo\s+(?:developer|engineer|programmer|programming|language|lang|routines?|modules?|services?|code)\b/i,
        /\b(?:in|using|with|written|write|writing|coded?|coding|built|build|building)\s+go\b/i,
      ],
    },
    { id: 'rust' },
    { id: 'ruby' },
    { id: 'php' },
    { id: 'swift' },
    { id: 'kotlin' },
    { id: 'scala' },
    {
      id: 'r',
      ambiguous: true,
      contextPatterns: [
        /\br\s+(?:programming|language|studio|scripts?)\b/i,
        /\b(?:in|using|with)\s+r\b(?!\s*&)/i,
      ],
    },
    { id: 'matlab' },
    { id: 'perl' },
    { id: 'haskell' },
    { id: 'elixir' },
    { id: 'clojure' },
    { id: 'dart' },
    { id: 'lua' },
    { id: 'objective-c' },
    { id: 'cobol' },
    { id: 'groovy' },
    { id: 'julia' },
    { id: 'bash', aliases: ['shell scripting'] },
    { id: 'powershell' },
    { id: 'sql' },

    // ---- Frontend ----
    { id: 'react', aliases: ['react.js', 'reactjs'] },
    { id: 'angular', aliases: ['angularjs'] },
    { id: 'vue', aliases: ['vue.js', 'vuejs'] },
    { id: 'svelte', aliases: ['sveltekit'] },
    { id: 'next.js', aliases: ['nextjs'] },
    { id: 'nuxt' },
    { id: 'html', aliases: ['html5'] },
    { id: 'css', aliases: ['css3'] },
    { id: 'sass', aliases: ['scss'] },
    { id: 'tailwind', aliases: ['tailwind css', 'tailwindcss'] },
    { id: 'bootstrap' },
    { id: 'webpack' },
    { id: 'vite' },
    { id: 'jquery' },
    { id: 'redux' },
    { id: 'accessibility', aliases: ['a11y', 'wcag'] },

    // ---- Backend ----
    { id: 'node.js', aliases: ['nodejs', 'node'] },
    { id: 'express', aliases: ['express.js'] },
    { id: 'django' },
    { id: 'flask' },
    { id: 'fastapi' },
    { id: 'spring', aliases: ['spring boot', 'spring-boot'] },
    { id: 'rails', aliases: ['ruby on rails'] },
    { id: 'laravel' },
    { id: 'asp.net' },
    { id: '.net', aliases: ['dotnet'] },
    { id: 'graphql' },
    {
      id: 'rest',
      ambiguous: true,
      // "the rest of the team" is not a skill.
      contextPatterns: [/\brest(?:ful)?\s*apis?\b/i, /\brest\s+services?\b/i],
    },
    { id: 'grpc' },
    { id: 'websocket', aliases: ['websockets'] },
    { id: 'microservices', aliases: ['microservice'] },

    // ---- Databases ----
    { id: 'postgresql', aliases: ['postgres', 'psql', 'postgis'] },
    { id: 'mysql' },
    { id: 'mongodb', aliases: ['mongo'] },
    { id: 'redis' },
    { id: 'elasticsearch', aliases: ['opensearch'] },
    { id: 'cassandra' },
    { id: 'dynamodb' },
    { id: 'firebase' },
    { id: 'sqlite' },
    { id: 'oracle' },
    { id: 'neo4j' },
    { id: 'snowflake' },
    { id: 'bigquery' },

    // ---- Cloud & infra ----
    { id: 'aws', aliases: ['amazon web services', 'ec2', 's3', 'eks', 'lambda'] },
    { id: 'azure' },
    { id: 'gcp', aliases: ['google cloud'] },
    { id: 'docker' },
    { id: 'kubernetes', aliases: ['k8s'] },
    { id: 'terraform' },
    { id: 'ansible' },
    { id: 'jenkins' },
    { id: 'github actions', aliases: ['github-actions'] },
    { id: 'gitlab ci', aliases: ['gitlab-ci'] },
    { id: 'circleci' },
    { id: 'argocd', aliases: ['argo cd'] },
    { id: 'ci/cd', aliases: ['cicd', 'continuous integration', 'continuous delivery'] },
    { id: 'nginx' },
    { id: 'linux', aliases: ['unix'] },
    { id: 'helm' },
    { id: 'istio' },
    { id: 'prometheus' },
    { id: 'grafana' },
    { id: 'datadog' },
    { id: 'splunk' },
    { id: 'opentelemetry', aliases: ['otel'] },
    { id: 'observability' },
    { id: 'vmware', aliases: ['vsphere'] },

    // ---- Data & ML ----
    { id: 'machine learning', aliases: ['machine-learning', 'ml'] },
    { id: 'deep learning', aliases: ['deep-learning'] },
    { id: 'tensorflow' },
    { id: 'pytorch' },
    { id: 'keras' },
    { id: 'scikit-learn', aliases: ['sklearn'] },
    { id: 'pandas' },
    { id: 'numpy' },
    { id: 'spark', aliases: ['pyspark', 'apache spark'] },
    { id: 'hadoop' },
    { id: 'airflow', aliases: ['apache airflow'] },
    { id: 'kafka', aliases: ['apache kafka'] },
    { id: 'flink', aliases: ['apache flink'] },
    { id: 'dbt' },
    { id: 'iceberg', aliases: ['apache iceberg'] },
    { id: 'parquet' },
    { id: 'delta lake' },
    { id: 'tableau' },
    { id: 'power bi', aliases: ['power-bi', 'powerbi'] },
    { id: 'looker' },
    { id: 'etl', aliases: ['elt'] },
    { id: 'nlp', aliases: ['natural language processing'] },
    { id: 'computer vision' },
    { id: 'embeddings' },
    { id: 'data engineering' },
    { id: 'data modelling', aliases: ['data modeling'] },

    // ---- Mobile ----
    { id: 'react native', aliases: ['react-native'] },
    { id: 'flutter' },
    { id: 'ios' },
    { id: 'android' },
    { id: 'swiftui' },
    { id: 'jetpack compose' },
    { id: 'core data' },
    { id: 'combine' },

    // ---- Testing ----
    { id: 'jest' },
    { id: 'mocha' },
    { id: 'cypress' },
    { id: 'selenium' },
    { id: 'playwright' },
    { id: 'pytest' },
    { id: 'junit' },
    { id: 'rspec' },
    { id: 'vitest' },
    { id: 'storybook' },
    { id: 'xctest' },
    { id: 'testcontainers' },
    { id: 'tdd', aliases: ['test driven development', 'test-driven development'] },
    { id: 'load testing', aliases: ['k6', 'jmeter'] },

    // ---- Practices & tools ----
    { id: 'git' },
    { id: 'github' },
    { id: 'gitlab' },
    { id: 'jira' },
    { id: 'agile' },
    { id: 'scrum' },
    { id: 'kanban' },
    { id: 'system design' },
    { id: 'distributed systems' },
    { id: 'event-driven architecture', aliases: ['event driven', 'event-driven'] },
    { id: 'incident response', aliases: ['on-call', 'on call'] },
    { id: 'slo', aliases: ['sli', 'slos'] },
    { id: 'mentoring', aliases: ['mentorship', 'mentored'] },
    { id: 'code review' },

    // ---- Security & compliance ----
    { id: 'oauth', aliases: ['oauth2'] },
    { id: 'jwt' },
    { id: 'encryption' },
    { id: 'penetration testing', aliases: ['pentesting'] },
    { id: 'soc2', aliases: ['soc 2'] },
    { id: 'gdpr' },
    { id: 'hipaa' },
    { id: 'pci', aliases: ['pci-dss', 'pci dss'] },
    { id: 'active directory' },
  ];

  /**
   * Precompiled matchers, built once at module load.
   *
   * The old extractSkills built ~200 RegExp objects on every call, and was
   * itself called once per job plus once per job for the resume — so a 25-job
   * scan constructed ~10,000 regexes.
   */
  const COMPILED = SKILLS.map((skill) => {
    const surfaces = [skill.id, ...(skill.aliases || [])];
    return {
      id: skill.id,
      ambiguous: Boolean(skill.ambiguous),
      surfaces,
      patterns: skill.ambiguous
        ? skill.contextPatterns || []
        : surfaces.map(surfacePattern),
    };
  });

  /**
   * Every surface form as a lowercase set. Used by the tokenizer to avoid
   * stemming vocabulary terms ("kubernetes" must not become "kubernete",
   * "pandas" must not become "panda").
   */
  const SURFACE_TOKENS = new Set();
  for (const skill of COMPILED) {
    for (const surface of skill.surfaces) {
      for (const part of surface.split(/\s+/)) {
        if (part) SURFACE_TOKENS.add(part.toLowerCase());
      }
    }
  }

  /**
   * Multi-word vocabulary terms, so the tokenizer can emit them as single
   * hyphenated tokens ("machine learning" -> "machine-learning") instead of
   * two terms that each carry different meaning apart.
   */
  const MULTIWORD = COMPILED
    .flatMap((s) => s.surfaces)
    .filter((s) => /\s/.test(s))
    .sort((a, b) => b.length - a.length)
    .map((surface) => ({
      surface,
      pattern: new RegExp(LEFT + escapeRegex(surface) + RIGHT, 'gi'),
      token: surface.replace(/\s+/g, '-'),
    }));

  /** Extract canonical skill ids present in the text. */
  function extract(text) {
    const found = [];
    for (const skill of COMPILED) {
      for (const pattern of skill.patterns) {
        if (pattern.test(text)) {
          found.push(skill.id);
          break;
        }
      }
    }
    return found;
  }

  return {
    SKILLS,
    COMPILED,
    SURFACE_TOKENS,
    MULTIWORD,
    LEFT,
    RIGHT,
    escapeRegex,
    surfacePattern,
    extract,
    ids: () => COMPILED.map((s) => s.id),
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = SkillVocab;
}
