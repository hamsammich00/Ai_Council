const express = require('express');
const path = require('path');
const crypto = require('crypto');

const engineerPersonality = require('./personalities/engineer');
const architectPersonality = require('./personalities/architect');
const securityPersonality = require('./personalities/security');
const judgePersonality = require('./personalities/judge');

const ENGINEER_URL = 'http://192.168.8.120:8081/completion';
const ARCHITECT_URL = 'http://192.168.8.183:8082/completion';
const SECURITY_URL = 'http://192.168.8.229:8083/completion';
const JUDGE_URL = 'http://192.168.8.206:8084/completion';
const ROLE_TIMEOUT_MS = 60000;
const JUDGE_TIMEOUT_MS = 180000;
const SINGLE_TIMEOUT_MS = 120000;
const JOB_TTL_MS = 10 * 60 * 1000;
const JOB_CLEANUP_INTERVAL_MS = 60 * 1000;

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
const councilJobs = new Map();

function extractModelText(body) {
  if (!body) {
    return '';
  }

  if (typeof body === 'string') return body;
  if (Array.isArray(body)) {
    return body.length > 0 ? extractModelText(body[0]) : '';
  }
  if (typeof body !== 'object') {
    return '';
  }

  if (Array.isArray(body.content)) {
    const joined = body.content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
          if (typeof item.text === 'string') return item.text;
          if (typeof item.content === 'string') return item.content;
        }
        return '';
      })
      .join('');
    if (joined) return joined;
  }

  if (body.content && typeof body.content === 'object') {
    const nestedContent = extractModelText(body.content);
    if (nestedContent) return nestedContent;
  }

  const directKeys = ['content', 'completion', 'response', 'text', 'generated_text', 'output', 'answer'];
  for (const key of directKeys) {
    if (typeof body[key] === 'string') return body[key];
  }

  if (body.message && typeof body.message.content === 'string') {
    return body.message.content;
  }

  if (Array.isArray(body.choices) && body.choices.length > 0) {
    const firstChoice = body.choices[0];
    if (typeof firstChoice === 'string') return firstChoice;
    if (firstChoice && typeof firstChoice === 'object') {
      if (typeof firstChoice.text === 'string') return firstChoice.text;
      if (typeof firstChoice.content === 'string') return firstChoice.content;
      if (firstChoice.message && typeof firstChoice.message.content === 'string') {
        return firstChoice.message.content;
      }
    }
  }

  if (body.data && typeof body.data === 'object') {
    return extractModelText(body.data);
  }

  return '';
}

function toFiniteNumber(value) {
  return Number.isFinite(value) ? value : null;
}

function extractModelStats(body) {
  if (!body || typeof body !== 'object') {
    return null;
  }

  const timings = body.timings && typeof body.timings === 'object' ? body.timings : {};
  const completionTokens = toFiniteNumber(body.tokens_predicted);
  const promptTokens = toFiniteNumber(body.tokens_evaluated);
  const cachedTokens = toFiniteNumber(body.tokens_cached);
  const predictedMs = toFiniteNumber(
    timings.predicted_ms ?? timings.prediction_ms ?? timings.decode_ms ?? timings.generation_ms
  );
  const predictedPerSecond = toFiniteNumber(
    timings.predicted_per_second ??
    timings.predicted_tokens_per_second ??
    timings.tokens_per_second ??
    timings.tok_per_sec
  );

  let tokensPerSecond = predictedPerSecond;
  if (!tokensPerSecond && completionTokens && predictedMs && predictedMs > 0) {
    tokensPerSecond = completionTokens / (predictedMs / 1000);
  }

  let totalTokens = null;
  if (completionTokens !== null && promptTokens !== null) {
    totalTokens = completionTokens + promptTokens;
  } else if (completionTokens !== null) {
    totalTokens = completionTokens;
  } else if (promptTokens !== null) {
    totalTokens = promptTokens;
  }

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    cached_tokens: cachedTokens,
    total_tokens: totalTokens,
    tokens_per_second: tokensPerSecond,
    stop_type: typeof body.stop_type === 'string' ? body.stop_type : null,
    truncated: typeof body.truncated === 'boolean' ? body.truncated : null,
  };
}

async function postToModel(url, payload, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const rawText = await response.text();
    let parsed;

    try {
      parsed = rawText ? JSON.parse(rawText) : {};
    } catch (_error) {
      parsed = { content: rawText };
    }

    if (!response.ok) {
      const detail = extractModelText(parsed) || rawText || `HTTP ${response.status}`;
      throw new Error(`HTTP ${response.status}: ${detail}`);
    }

    const extractedRaw = extractModelText(parsed);
    const extracted = extractedRaw.trim();
    if (!extracted) {
      const stopType = typeof parsed?.stop_type === 'string' ? parsed.stop_type : 'unknown';
      const tokensPredicted = Number.isFinite(parsed?.tokens_predicted) ? parsed.tokens_predicted : 'unknown';
      const truncated = typeof parsed?.truncated === 'boolean' ? parsed.truncated : 'unknown';
      const keys = parsed && typeof parsed === 'object'
        ? Object.keys(parsed).join(', ')
        : '';
      throw new Error(
        `Empty model text (stop_type=${stopType}, tokens_predicted=${tokensPredicted}, truncated=${truncated}, response keys: ${keys || 'none'})`
      );
    }

    return {
      text: extracted,
      stats: extractModelStats(parsed),
    };
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new Error(`Timeout after ${timeoutMs}ms`);
    }

    throw new Error(error && error.message ? error.message : 'Model request failed');
  } finally {
    clearTimeout(timeoutId);
  }
}

async function callCouncilRole({ url, personality, prompt, temperature }) {
  try {
    const taskId = crypto.randomUUID();
    const modelResult = await postToModel(
      url,
      buildModelPayload({
        prompt: `${personality}\n\nTask:\n${prompt}\n\nTask ID: ${taskId}`,
        nPredict: 400,
        temperature,
      }),
      ROLE_TIMEOUT_MS
    );

    return modelResult;
  } catch (error) {
    return {
      text: `Error: ${error.message}`,
      stats: null,
    };
  }
}

async function callSingleRole({ url, personality, prompt, temperature, nPredict }) {
  try {
    const taskId = crypto.randomUUID();
    const modelResult = await postToModel(
      url,
      buildModelPayload({
        prompt: `${personality}\n\nTask:\n${prompt}\n\nTask ID: ${taskId}`,
        nPredict,
        temperature,
      }),
      SINGLE_TIMEOUT_MS
    );

    return modelResult;
  } catch (error) {
    return {
      text: `Error: ${error.message}`,
      stats: null,
    };
  }
}

async function timeCall(fn) {
  const startedAt = Date.now();
  const value = await fn();
  return {
    value,
    durationMs: Date.now() - startedAt,
  };
}

function createCouncilJob(prompt) {
  const id = crypto.randomUUID();
  const now = Date.now();
  const job = {
    id,
    prompt,
    stage: 'roles',
    done: false,
    error: null,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    responses: {
      engineer: null,
      architect: null,
      security: null,
      final: null,
    },
    timings: {
      engineer_ms: null,
      architect_ms: null,
      security_ms: null,
      roles_stage_ms: null,
      judge_ms: null,
      total_ms: null,
    },
    metrics: {
      engineer: null,
      architect: null,
      security: null,
      judge: null,
    },
  };

  councilJobs.set(id, job);
  return job;
}

function getCouncilJobStatus(job) {
  return {
    jobId: job.id,
    stage: job.stage,
    done: job.done,
    error: job.error,
    engineer: job.responses.engineer,
    architect: job.responses.architect,
    security: job.responses.security,
    final: job.responses.final,
    timings: job.timings,
    metrics: job.metrics,
    elapsed_ms: Date.now() - job.startedAt,
  };
}

function cleanupOldJobs() {
  const now = Date.now();
  for (const [id, job] of councilJobs.entries()) {
    if (now - job.updatedAt > JOB_TTL_MS) {
      councilJobs.delete(id);
    }
  }
}

setInterval(cleanupOldJobs, JOB_CLEANUP_INTERVAL_MS).unref();

function buildModelPayload({ prompt, nPredict, temperature }) {
  return {
    prompt,
    n_predict: nPredict,
    temperature,
    cache_prompt: false,
    n_keep: 0,
  };
}

function buildJudgePrompt(userPrompt, engineer, architect, security) {
  return `${judgePersonality}\n\nTask:\n${userPrompt}\n\nEngineer response:\n${engineer}\n\nArchitect response:\n${architect}\n\nSecurity response:\n${security}\n\nAs Judge, analyze the responses and produce the best final answer.`;
}

async function callJudge(prompt) {
  try {
    const taskId = crypto.randomUUID();
    const modelResult = await postToModel(
      JUDGE_URL,
      buildModelPayload({
        prompt: `${prompt}\n\nTask ID: ${taskId}`,
        nPredict: 400,
        temperature: 0.15,
      }),
      JUDGE_TIMEOUT_MS
    );

    return modelResult;
  } catch (error) {
    return {
      text: `Error: ${error.message}`,
      stats: null,
    };
  }
}

async function runCouncilJob(job) {
  try {
    const rolesStartedAt = Date.now();
    const roleTasks = [
      timeCall(() => callCouncilRole({
        url: ENGINEER_URL,
        personality: engineerPersonality,
        prompt: job.prompt,
        temperature: 0.2,
      })).then((timed) => {
        job.responses.engineer = timed.value.text;
        job.timings.engineer_ms = timed.durationMs;
        job.metrics.engineer = timed.value.stats;
        job.updatedAt = Date.now();
      }),
      timeCall(() => callCouncilRole({
        url: ARCHITECT_URL,
        personality: architectPersonality,
        prompt: job.prompt,
        temperature: 0.3,
      })).then((timed) => {
        job.responses.architect = timed.value.text;
        job.timings.architect_ms = timed.durationMs;
        job.metrics.architect = timed.value.stats;
        job.updatedAt = Date.now();
      }),
      timeCall(() => callCouncilRole({
        url: SECURITY_URL,
        personality: securityPersonality,
        prompt: job.prompt,
        temperature: 0.25,
      })).then((timed) => {
        job.responses.security = timed.value.text;
        job.timings.security_ms = timed.durationMs;
        job.metrics.security = timed.value.stats;
        job.updatedAt = Date.now();
      }),
    ];
    await Promise.all(roleTasks);

    job.timings.roles_stage_ms = Date.now() - rolesStartedAt;
    job.stage = 'judge';
    job.updatedAt = Date.now();

    const judgePrompt = buildJudgePrompt(
      job.prompt,
      job.responses.engineer,
      job.responses.architect,
      job.responses.security
    );
    const judgeTimed = await timeCall(() => callJudge(judgePrompt));

    job.responses.final = judgeTimed.value.text;
    job.timings.judge_ms = judgeTimed.durationMs;
    job.metrics.judge = judgeTimed.value.stats;
    job.timings.total_ms = Date.now() - job.startedAt;
    job.stage = 'done';
    job.done = true;
    job.updatedAt = Date.now();
  } catch (error) {
    job.error = error && error.message ? error.message : 'Council job failed';
    job.responses.final = `Error: ${job.error}`;
    job.timings.total_ms = Date.now() - job.startedAt;
    job.stage = 'error';
    job.done = true;
    job.updatedAt = Date.now();
  }
}

app.post('/ask', async (req, res) => {
  const requestStartedAt = Date.now();
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';

  if (!prompt) {
    return res.status(400).json({ error: 'prompt is required' });
  }

  const rolesStartedAt = Date.now();
  const [engineerTimed, architectTimed, securityTimed] = await Promise.all([
    timeCall(() => callCouncilRole({
      url: ENGINEER_URL,
      personality: engineerPersonality,
      prompt,
      temperature: 0.2,
    })),
    timeCall(() => callCouncilRole({
      url: ARCHITECT_URL,
      personality: architectPersonality,
      prompt,
      temperature: 0.3,
    })),
    timeCall(() => callCouncilRole({
      url: SECURITY_URL,
      personality: securityPersonality,
      prompt,
      temperature: 0.25,
    })),
  ]);
  const rolesStageMs = Date.now() - rolesStartedAt;

  const judgePrompt = buildJudgePrompt(
    prompt,
    engineerTimed.value.text,
    architectTimed.value.text,
    securityTimed.value.text
  );
  const judgeTimed = await timeCall(() => callJudge(judgePrompt));
  const totalMs = Date.now() - requestStartedAt;

  return res.json({
    engineer: engineerTimed.value.text,
    architect: architectTimed.value.text,
    security: securityTimed.value.text,
    final: judgeTimed.value.text,
    timings: {
      engineer_ms: engineerTimed.durationMs,
      architect_ms: architectTimed.durationMs,
      security_ms: securityTimed.durationMs,
      roles_stage_ms: rolesStageMs,
      judge_ms: judgeTimed.durationMs,
      total_ms: totalMs,
    },
    metrics: {
      engineer: engineerTimed.value.stats,
      architect: architectTimed.value.stats,
      security: securityTimed.value.stats,
      judge: judgeTimed.value.stats,
    },
  });
});

app.post('/ask-start', (req, res) => {
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';

  if (!prompt) {
    return res.status(400).json({ error: 'prompt is required' });
  }

  const job = createCouncilJob(prompt);
  runCouncilJob(job);

  return res.status(202).json({ jobId: job.id });
});

app.get('/ask-status/:jobId', (req, res) => {
  const job = councilJobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'job not found' });
  }

  return res.json(getCouncilJobStatus(job));
});

app.post('/ask-single', async (req, res) => {
  const requestStartedAt = Date.now();
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
  const role = typeof req.body?.role === 'string' ? req.body.role.trim().toLowerCase() : '';

  if (!prompt) {
    return res.status(400).json({ error: 'prompt is required' });
  }

  const roleConfig = {
    engineer: {
      url: ENGINEER_URL,
      personality: engineerPersonality,
      temperature: 0.2,
      nPredict: 500,
    },
    architect: {
      url: ARCHITECT_URL,
      personality: architectPersonality,
      temperature: 0.3,
      nPredict: 350,
    },
    security: {
      url: SECURITY_URL,
      personality: securityPersonality,
      temperature: 0.25,
      nPredict: 350,
    },
    judge: {
      url: JUDGE_URL,
      personality: judgePersonality,
      temperature: 0.15,
      nPredict: 450,
    },
  };

  const selected = roleConfig[role];
  if (!selected) {
    return res.status(400).json({ error: 'role must be one of: engineer, architect, security, judge' });
  }

  const timed = await timeCall(() => callSingleRole({
    url: selected.url,
    personality: selected.personality,
    prompt,
    temperature: selected.temperature,
    nPredict: selected.nPredict,
  }));

  return res.json({
    role,
    response: timed.value.text,
    timing_ms: timed.durationMs,
    total_ms: Date.now() - requestStartedAt,
    metrics: timed.value.stats,
  });
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Council server running at http://localhost:${PORT}`);
});
