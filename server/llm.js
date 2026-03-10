const OLLAMA_BASE = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.1:8b';
const REQUEST_TIMEOUT_MS = 60000;
const MAX_TEXT_LENGTH = 2000;

function buildPrompt(resumeText, job) {
  const resume = resumeText.slice(0, MAX_TEXT_LENGTH);
  const desc = (job.description || '').slice(0, MAX_TEXT_LENGTH);

  return [
    {
      role: 'system',
      content:
        'You are a job matching expert. You analyze resumes against job postings and return a structured JSON score. Always respond with ONLY valid JSON, no markdown, no explanation outside the JSON.',
    },
    {
      role: 'user',
      content: `Score how well this resume matches the job posting on a scale of 0-100.

RESUME:
${resume}

JOB:
Title: ${job.title || 'N/A'}
Company: ${job.company || 'N/A'}
Location: ${job.location || 'N/A'}
Description:
${desc}

Respond with ONLY this JSON structure (no other text):
{"score": <number 0-100>, "rationale": "<1-2 sentence explanation>", "keyStrengths": ["<strength1>", "<strength2>"], "gaps": ["<gap1>", "<gap2>"]}`,
    },
  ];
}

function parseResponse(text) {
  const trimmed = text.trim();

  // Try direct parse
  try {
    return validateResponse(JSON.parse(trimmed));
  } catch {}

  // Extract JSON from markdown code blocks or surrounding text
  const jsonMatch = trimmed.match(/\{[\s\S]*?\}/);
  if (jsonMatch) {
    try {
      return validateResponse(JSON.parse(jsonMatch[0]));
    } catch {}
  }

  return null;
}

function validateResponse(obj) {
  if (typeof obj.score !== 'number' || obj.score < 0 || obj.score > 100) {
    obj.score = Math.max(0, Math.min(100, Number(obj.score) || 0));
  }
  obj.score = Math.round(obj.score * 100) / 100;
  obj.rationale = String(obj.rationale || '').slice(0, 500);
  obj.keyStrengths = Array.isArray(obj.keyStrengths)
    ? obj.keyStrengths.map(String).slice(0, 5)
    : [];
  obj.gaps = Array.isArray(obj.gaps) ? obj.gaps.map(String).slice(0, 5) : [];
  return obj;
}

async function scoreWithLLM(resumeText, job) {
  const messages = buildPrompt(resumeText, job);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages,
        stream: false,
        options: {
          temperature: 0.1,
          num_predict: 300,
        },
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Ollama returned ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = await res.json();
    const content = data.message?.content || '';
    const parsed = parseResponse(content);

    if (!parsed) {
      throw new Error(`Failed to parse LLM response: ${content.slice(0, 200)}`);
    }

    return {
      ...parsed,
      model: OLLAMA_MODEL,
      totalDurationMs: data.total_duration ? Math.round(data.total_duration / 1e6) : null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function checkOllamaHealth() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(`${OLLAMA_BASE}/api/tags`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return { available: false, error: `HTTP ${res.status}` };

    const data = await res.json();
    const models = (data.models || []).map((m) => m.name);
    const hasModel = models.some(
      (name) => name === OLLAMA_MODEL || name.startsWith(OLLAMA_MODEL.split(':')[0])
    );

    return {
      available: true,
      models,
      configuredModel: OLLAMA_MODEL,
      modelReady: hasModel,
      hint: hasModel ? null : `Run "ollama pull ${OLLAMA_MODEL}" to download the model`,
    };
  } catch (err) {
    return {
      available: false,
      error: err.name === 'AbortError' ? 'Timeout connecting to Ollama' : err.message,
      hint: 'Make sure Ollama is running: https://ollama.com',
    };
  }
}

module.exports = { scoreWithLLM, checkOllamaHealth, OLLAMA_MODEL };
