const express = require('express');
const path = require('path');
const crypto = require('crypto');

const engineerPersonality = require('./personalities/engineer');
const architectPersonality = require('./personalities/architect');
const securityPersonality = require('./personalities/security');
const judgePersonality = require('./personalities/judge');

const ENGINEER_COMPLETION_URL = 'http://ENGINEER_IP:8081/completion';
const ARCHITECT_COMPLETION_URL = 'http://ARCHITECT_IP:8082/completion';
const ENGINEER_CHAT_URL = 'http://ENGINEER_IP:8081/chat/completions';
const ARCHITECT_CHAT_URL = 'http://ARCHITECT_IP:8082/chat/completions';
const SECURITY_CHAT_URL = 'http://SECURITY_IP:8083/chat/completions';
const JUDGE_COMPLETION_URL = 'http://JUDGE_IP:8084/completion';
const JUDGE_CHAT_URL = 'http://JUDGE_IP:8084/chat/completions';
const ENGINEER_URL = ENGINEER_COMPLETION_URL;
const ARCHITECT_URL = ARCHITECT_COMPLETION_URL;
const SECURITY_URL = 'http://SECURITY_IP:8083/completion';
const JUDGE_URL = JUDGE_COMPLETION_URL;
const ROLE_TIMEOUT_MS = 60000;
const JUDGE_TIMEOUT_MS = 200000;
const SINGLE_TIMEOUT_MS = 120000;
const EMPTY_RESPONSE_RETRY_DELAY_MS = 250;
const JOB_TTL_MS = 10 * 60 * 1000;
const JOB_CLEANUP_INTERVAL_MS = 60 * 1000;
const JUDGE_MAX_INPUT_CHARS_PER_ROLE = 1200;
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
  const numeric = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(numeric) ? numeric : null;
}

function extractModelStats(body, extractedText = '') {
  if (!body || typeof body !== 'object') {
    return null;
  }

  const timings = body.timings && typeof body.timings === 'object' ? body.timings : {};
  let completionTokens = toFiniteNumber(
    body.tokens_predicted ??
    body.completion_tokens ??
    body.n_tokens_predicted ??
    timings.predicted_n ??
    timings.generated_n
  );
  const promptTokens = toFiniteNumber(
    body.tokens_evaluated ??
    body.prompt_tokens ??
    body.n_tokens_evaluated ??
    timings.prompt_n
  );
  const cachedTokens = toFiniteNumber(body.tokens_cached ?? body.cached_tokens ?? timings.cached_n);
  if (completionTokens === null && Array.isArray(body.tokens)) {
    completionTokens = body.tokens.length;
  }
  if (completionTokens === null && typeof extractedText === 'string' && extractedText.trim()) {
    completionTokens = extractedText.trim().split(/\s+/).length;
  }
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
      stats: extractModelStats(parsed, extracted),
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

async function callCouncilRole({
  roleKey,
  url,
  personality,
  prompt,
  temperature,
  apiStyle = 'completion',
  fallbackCompletionUrl = null,
}) {
  const runAttempt = async () => {
    const taskId = crypto.randomUUID();
    const payload = apiStyle === 'chat'
      ? buildChatPayload({
        messages: buildRoleMessages(personality, prompt, taskId),
        nPredict: 400,
        temperature,
      })
      : buildModelPayload({
        prompt: buildRolePrompt(personality, prompt, taskId),
        nPredict: 400,
        temperature,
      });

    return postToModel(
      url,
      payload,
      ROLE_TIMEOUT_MS
    );
  };

  const runCompletionFallbackAttempt = async () => {
    if (!fallbackCompletionUrl) {
      throw new Error('No completion fallback URL configured');
    }
    const taskId = crypto.randomUUID();
    return postToModel(
      fallbackCompletionUrl,
      buildModelPayload({
        prompt: buildRolePrompt(personality, prompt, taskId),
        nPredict: 400,
        temperature,
      }),
      ROLE_TIMEOUT_MS
    );
  };

  const runEngineerFallbackAttempt = async () => {
    const taskId = crypto.randomUUID();
    return postToModel(
      fallbackCompletionUrl || ENGINEER_COMPLETION_URL,
      buildModelPayload({
        prompt: buildEngineerFallbackPrompt(prompt, taskId),
        nPredict: 220,
        temperature: 0.2,
      }),
      ROLE_TIMEOUT_MS
    );
  };

  try {
    return await runAttempt();
  } catch (error) {
    if (isRetryableEmptyError(error)) {
      await sleep(EMPTY_RESPONSE_RETRY_DELAY_MS);
      try {
        return await runAttempt();
      } catch (retryError) {
        if (roleKey === 'engineer' && isRetryableEmptyError(retryError)) {
          await sleep(EMPTY_RESPONSE_RETRY_DELAY_MS);
          try {
            return await runEngineerFallbackAttempt();
          } catch (fallbackError) {
            return {
              text: `Error: ${fallbackError.message}`,
              stats: null,
            };
          }
        }

        if (apiStyle === 'chat' && fallbackCompletionUrl) {
          try {
            return await runCompletionFallbackAttempt();
          } catch (fallbackError) {
            return {
              text: `Error: ${fallbackError.message}`,
              stats: null,
            };
          }
        }

        return {
          text: `Error: ${retryError.message}`,
          stats: null,
        };
      }
    }

    if (apiStyle === 'chat' && fallbackCompletionUrl) {
      try {
        return await runCompletionFallbackAttempt();
      } catch (fallbackError) {
        return {
          text: `Error: ${fallbackError.message}`,
          stats: null,
        };
      }
    }

    return {
      text: `Error: ${error.message}`,
      stats: null,
    };
  }
}

async function callSingleRole({
  roleKey,
  url,
  personality,
  prompt,
  temperature,
  nPredict,
  apiStyle = 'completion',
  fallbackCompletionUrl = null,
}) {
  const runAttempt = async () => {
    const taskId = crypto.randomUUID();
    const payload = apiStyle === 'chat'
      ? buildChatPayload({
        messages: buildRoleMessages(personality, prompt, taskId),
        nPredict,
        temperature,
      })
      : buildModelPayload({
        prompt: buildRolePrompt(personality, prompt, taskId),
        nPredict,
        temperature,
      });

    return postToModel(url, payload, SINGLE_TIMEOUT_MS);
  };

  const runCompletionFallbackAttempt = async () => {
    if (!fallbackCompletionUrl) {
      throw new Error('No completion fallback URL configured');
    }
    const taskId = crypto.randomUUID();
    return postToModel(
      fallbackCompletionUrl,
      buildModelPayload({
        prompt: buildRolePrompt(personality, prompt, taskId),
        nPredict,
        temperature,
      }),
      SINGLE_TIMEOUT_MS
    );
  };

  const runEngineerFallbackAttempt = async () => {
    const taskId = crypto.randomUUID();
    return postToModel(
      fallbackCompletionUrl || ENGINEER_COMPLETION_URL,
      buildModelPayload({
        prompt: buildEngineerFallbackPrompt(prompt, taskId),
        nPredict: Math.min(nPredict, 260),
        temperature: 0.2,
      }),
      SINGLE_TIMEOUT_MS
    );
  };

  try {
    return await runAttempt();
  } catch (error) {
    if (isRetryableEmptyError(error)) {
      await sleep(EMPTY_RESPONSE_RETRY_DELAY_MS);
      try {
        return await runAttempt();
      } catch (retryError) {
        if (roleKey === 'engineer' && isRetryableEmptyError(retryError)) {
          await sleep(EMPTY_RESPONSE_RETRY_DELAY_MS);
          try {
            return await runEngineerFallbackAttempt();
          } catch (fallbackError) {
            return {
              text: `Error: ${fallbackError.message}`,
              stats: null,
            };
          }
        }

        if (apiStyle === 'chat' && fallbackCompletionUrl) {
          try {
            return await runCompletionFallbackAttempt();
          } catch (fallbackError) {
            return {
              text: `Error: ${fallbackError.message}`,
              stats: null,
            };
          }
        }

        return {
          text: `Error: ${retryError.message}`,
          stats: null,
        };
      }
    }

    if (apiStyle === 'chat' && fallbackCompletionUrl) {
      try {
        return await runCompletionFallbackAttempt();
      } catch (fallbackError) {
        return {
          text: `Error: ${fallbackError.message}`,
          stats: null,
        };
      }
    }

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

function buildModelPayload({ prompt, nPredict, temperature, sampling = {} }) {
  return {
    prompt,
    n_predict: nPredict,
    temperature,
    cache_prompt: false,
    n_keep: 0,
    ...sampling,
  };
}

function buildChatPayload({ messages, nPredict, temperature, sampling = {} }) {
  return {
    messages,
    n_predict: nPredict,
    temperature,
    cache_prompt: false,
    n_keep: 0,
    ...sampling,
  };
}

function buildJudgeMessages(prompt, taskId) {
  return [
    {
      role: 'system',
      content: `${judgePersonality}

Hard format rules:
- Exception: if user explicitly requests a fixed short format (for example "1 sentence"), follow it and skip section template.
- Use exactly these headers, once each, in order: Summary, Recommended Approach, Key Tradeoffs.
- If code is requested, add a fourth section after Key Tradeoffs titled: Code.
- For non-code lines, every non-empty line must start with "- ".
- Use bullets by default. If code is required, include a code block and keep non-code text as bullets.
- If role inputs are limited, still satisfy minimum bullet counts with best-judgment synthesis.
- Follow the output requirements exactly.`,
    },
    {
      role: 'user',
      content: `${prompt}\n\nTask ID: ${taskId}`,
    },
  ];
}

function compactForJudge(text, maxChars = JUDGE_MAX_INPUT_CHARS_PER_ROLE) {
  if (typeof text !== 'string') return '';
  const normalized = text.trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}\n...[truncated for judge input]`;
}

function buildRolePrompt(personality, prompt, taskId) {
  return `${personality}\n\nTask:\n${prompt}\n\nOutput requirement:\n- Return at least one non-empty sentence.\n- Do not return blank output.\n\nTask ID: ${taskId}`;
}

function buildRoleMessages(personality, prompt, taskId) {
  return [
    {
      role: 'system',
      content: `${personality}\n\nOutput requirement:\n- Return at least one non-empty sentence.\n- Do not return blank output.`,
    },
    {
      role: 'user',
      content: `Task:\n${prompt}\n\nTask ID: ${taskId}`,
    },
  ];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableEmptyError(error) {
  const message = error && error.message ? error.message : '';
  return message.includes('Empty model text');
}

function buildEngineerFallbackPrompt(prompt, taskId) {
  return [
    'You are an engineering assistant.',
    '',
    'Task:',
    prompt,
    '',
    'Instructions:',
    '- Return a non-empty answer.',
    '- If coding is requested, provide runnable code.',
    '- If coding is not requested, respond in 1-2 plain sentences.',
    '',
    `Task ID: ${taskId}`,
  ].join('\n');
}

function shouldRequireJudgeCodeSection(userPrompt, engineer, architect, security) {
  const request = typeof userPrompt === 'string' ? userPrompt.toLowerCase() : '';
  const codeKeywords = [
    'code',
    'script',
    'powershell',
    'bash',
    'shell',
    'python',
    'javascript',
    'node',
    'ansible',
    'playbook',
    'yaml',
    'json',
    'dockerfile',
    'config',
    'command',
  ];
  const requestAsksForCode = codeKeywords.some((keyword) => request.includes(keyword));

  const roleText = [engineer, architect, security]
    .filter((value) => typeof value === 'string')
    .join('\n');
  const roleHasCode =
    roleText.includes('```') ||
    /(^|\n)\s*(Get-|Set-|Install-|New-|sudo |apt |yum |dnf |systemctl |kubectl |docker )/i.test(roleText);

  return requestAsksForCode || roleHasCode;
}

function buildJudgePrompt(userPrompt, engineer, architect, security) {
  const codeRequired = shouldRequireJudgeCodeSection(userPrompt, engineer, architect, security);
  const codeInstruction = codeRequired
    ? '\n\nCode requirement:\n- REQUIRED: include a section titled "Code" after "Key Tradeoffs".\n- Include exactly one fenced code block in that section.\n- Do not omit the Code section.'
    : '';

  return `User request:\n${userPrompt}

Engineer response:
${compactForJudge(engineer)}

Architect response:
${compactForJudge(architect)}

Security response:
${compactForJudge(security)}

As Judge, analyze the responses and produce one integrated final answer. If one role failed, continue with available role outputs.${codeInstruction}`;
}

function trimRepeatedJudgeSections(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return text;
  }

  const sectionPattern = /^(\*{0,2})\s*(summary|recommended approach|key tradeoffs)\s*\1\s*:?$/i;
  const lines = text.split('\n');
  const sectionCounts = {
    summary: 0,
    'recommended approach': 0,
    'key tradeoffs': 0,
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    const match = line.match(sectionPattern);
    if (!match) {
      continue;
    }

    const section = match[2].toLowerCase();
    sectionCounts[section] += 1;
    const hasFullFirstCycle =
      sectionCounts.summary >= 1 &&
      sectionCounts['recommended approach'] >= 1 &&
      sectionCounts['key tradeoffs'] >= 1;
    const startsSecondCycle =
      hasFullFirstCycle &&
      (sectionCounts.summary > 1 ||
      sectionCounts['recommended approach'] > 1 ||
      sectionCounts['key tradeoffs'] > 1);

    if (startsSecondCycle) {
      return lines.slice(0, i).join('\n').trim();
    }
  }

  const hasFullFirstCycle =
    sectionCounts.summary >= 1 &&
    sectionCounts['recommended approach'] >= 1 &&
    sectionCounts['key tradeoffs'] >= 1;
  if (!hasFullFirstCycle) {
    return text.trim();
  }

  const answerIndices = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim().toLowerCase() === 'answer:') {
      answerIndices.push(i);
    }
  }
  if (answerIndices.length >= 2) {
    return lines.slice(0, answerIndices[1]).join('\n').trim();
  }

  return text.trim();
}

async function callJudge(prompt) {
  const runAttempt = async () => {
    const taskId = crypto.randomUUID();
    const result = await postToModel(
      JUDGE_CHAT_URL,
      buildChatPayload({
        messages: buildJudgeMessages(prompt, taskId),
        nPredict: 1000,
        temperature: 0.1,
        sampling: {
          top_p: 0.9,
          repeat_penalty: 1.06,
          repeat_last_n: 256,
        },
      }),
      JUDGE_TIMEOUT_MS
    );
    return {
      ...result,
      text: trimRepeatedJudgeSections(result.text),
    };
  };

  const runCompletionFallbackAttempt = async () => {
    const taskId = crypto.randomUUID();
    const result = await postToModel(
      JUDGE_COMPLETION_URL,
      buildModelPayload({
        prompt: `${judgePersonality}\n\nHard format rules:\n- Exception: if user explicitly requests a fixed short format (for example "1 sentence"), follow it and skip section template.\n- Use exactly these headers, once each, in order: Summary, Recommended Approach, Key Tradeoffs.\n- If code is requested, add a fourth section after Key Tradeoffs titled: Code.\n- For non-code lines, every non-empty line must start with "- ".\n- Use bullets by default. If code is required, include a code block and keep non-code text as bullets.\n- If role inputs are limited, still satisfy minimum bullet counts with best-judgment synthesis.\n\n${prompt}\n\nFollow the output requirements exactly.\n\nTask ID: ${taskId}`,
        nPredict: 1000,
        temperature: 0.1,
        sampling: {
          top_p: 0.9,
          repeat_penalty: 1.06,
          repeat_last_n: 256,
        },
      }),
      JUDGE_TIMEOUT_MS
    );
    return {
      ...result,
      text: trimRepeatedJudgeSections(result.text),
    };
  };

  try {
    return await runAttempt();
  } catch (error) {
    if (isRetryableEmptyError(error)) {
      await sleep(EMPTY_RESPONSE_RETRY_DELAY_MS);
      try {
        return await runAttempt();
      } catch (retryError) {
        try {
          return await runCompletionFallbackAttempt();
        } catch (fallbackError) {
          return {
            text: `Error: ${fallbackError.message}`,
            stats: null,
          };
        }
      }
    }

    try {
      return await runCompletionFallbackAttempt();
    } catch (fallbackError) {
      return {
        text: `Error: ${fallbackError.message}`,
        stats: null,
      };
    }
  }
}

async function runCouncilJob(job) {
  try {
    const rolesStartedAt = Date.now();
    const roleTasks = [
      timeCall(() => callCouncilRole({
        roleKey: 'engineer',
        url: ENGINEER_CHAT_URL,
        personality: engineerPersonality,
        prompt: job.prompt,
        temperature: 0.2,
        apiStyle: 'chat',
        fallbackCompletionUrl: ENGINEER_COMPLETION_URL,
      })).then((timed) => {
        job.responses.engineer = timed.value.text;
        job.timings.engineer_ms = timed.durationMs;
        job.metrics.engineer = timed.value.stats;
        job.updatedAt = Date.now();
      }),
      timeCall(() => callCouncilRole({
        roleKey: 'architect',
        url: ARCHITECT_CHAT_URL,
        personality: architectPersonality,
        prompt: job.prompt,
        temperature: 0.3,
        apiStyle: 'chat',
        fallbackCompletionUrl: ARCHITECT_COMPLETION_URL,
      })).then((timed) => {
        job.responses.architect = timed.value.text;
        job.timings.architect_ms = timed.durationMs;
        job.metrics.architect = timed.value.stats;
        job.updatedAt = Date.now();
      }),
      timeCall(() => callCouncilRole({
        roleKey: 'security',
        url: SECURITY_CHAT_URL,
        personality: securityPersonality,
        prompt: job.prompt,
        temperature: 0.25,
        apiStyle: 'chat',
        fallbackCompletionUrl: SECURITY_URL,
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
      roleKey: 'engineer',
      url: ENGINEER_CHAT_URL,
      personality: engineerPersonality,
      prompt,
      temperature: 0.2,
      apiStyle: 'chat',
      fallbackCompletionUrl: ENGINEER_COMPLETION_URL,
    })),
    timeCall(() => callCouncilRole({
      roleKey: 'architect',
      url: ARCHITECT_CHAT_URL,
      personality: architectPersonality,
      prompt,
      temperature: 0.3,
      apiStyle: 'chat',
      fallbackCompletionUrl: ARCHITECT_COMPLETION_URL,
    })),
    timeCall(() => callCouncilRole({
      roleKey: 'security',
      url: SECURITY_CHAT_URL,
      personality: securityPersonality,
      prompt,
      temperature: 0.25,
      apiStyle: 'chat',
      fallbackCompletionUrl: SECURITY_URL,
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
      roleKey: 'engineer',
      url: ENGINEER_CHAT_URL,
      personality: engineerPersonality,
      temperature: 0.2,
      nPredict: 500,
      apiStyle: 'chat',
      fallbackCompletionUrl: ENGINEER_COMPLETION_URL,
    },
    architect: {
      roleKey: 'architect',
      url: ARCHITECT_CHAT_URL,
      personality: architectPersonality,
      temperature: 0.3,
      nPredict: 350,
      apiStyle: 'chat',
      fallbackCompletionUrl: ARCHITECT_COMPLETION_URL,
    },
    security: {
      roleKey: 'security',
      url: SECURITY_CHAT_URL,
      personality: securityPersonality,
      temperature: 0.25,
      nPredict: 350,
      apiStyle: 'chat',
      fallbackCompletionUrl: SECURITY_URL,
    },
    judge: {
      roleKey: 'judge',
      url: JUDGE_CHAT_URL,
      personality: judgePersonality,
      temperature: 0.1,
      nPredict: 1000,
      apiStyle: 'chat',
      fallbackCompletionUrl: JUDGE_COMPLETION_URL,
    },
  };

  const selected = roleConfig[role];
  if (!selected) {
    return res.status(400).json({ error: 'role must be one of: engineer, architect, security, judge' });
  }

  const timed = await timeCall(() => callSingleRole({
    roleKey: selected.roleKey,
    url: selected.url,
    personality: selected.personality,
    prompt,
    temperature: selected.temperature,
    nPredict: selected.nPredict,
    apiStyle: selected.apiStyle,
    fallbackCompletionUrl: selected.fallbackCompletionUrl,
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
