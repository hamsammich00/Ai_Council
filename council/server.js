const express = require('express');
const path = require('path');

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

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function extractModelText(body) {
  if (!body || typeof body !== 'object') {
    return '';
  }

  if (typeof body.content === 'string') return body.content;
  if (typeof body.completion === 'string') return body.completion;
  if (typeof body.response === 'string') return body.response;
  if (typeof body.text === 'string') return body.text;

  return '';
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

    return extractModelText(parsed).trim();
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
    const responseText = await postToModel(
      url,
      {
        prompt: `${personality}\n\nUser request:\n${prompt}`,
        n_predict: 400,
        temperature,
      },
      ROLE_TIMEOUT_MS
    );

    return responseText || 'Error: Empty response';
  } catch (error) {
    return `Error: ${error.message}`;
  }
}

async function callSingleRole({ url, personality, prompt, temperature, nPredict }) {
  try {
    const responseText = await postToModel(
      url,
      {
        prompt: `${personality}\n\nUser request:\n${prompt}`,
        n_predict: nPredict,
        temperature,
      },
      SINGLE_TIMEOUT_MS
    );

    return responseText || 'Error: Empty response';
  } catch (error) {
    return `Error: ${error.message}`;
  }
}

function buildJudgePrompt(userPrompt, engineer, architect, security) {
  return `${judgePersonality}\n\nUser request:\n${userPrompt}\n\nEngineer response:\n${engineer}\n\nArchitect response:\n${architect}\n\nSecurity response:\n${security}\n\nAs Judge, analyze the responses and produce the best final answer.`;
}

async function callJudge(prompt) {
  try {
    const responseText = await postToModel(
      JUDGE_URL,
      {
        prompt,
        n_predict: 400,
        temperature: 0.15,
      },
      JUDGE_TIMEOUT_MS
    );

    return responseText || 'Error: Empty response';
  } catch (error) {
    return `Error: ${error.message}`;
  }
}

app.post('/ask', async (req, res) => {
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';

  if (!prompt) {
    return res.status(400).json({ error: 'prompt is required' });
  }

  const [engineer, architect, security] = await Promise.all([
    callCouncilRole({
      url: ENGINEER_URL,
      personality: engineerPersonality,
      prompt,
      temperature: 0.2,
    }),
    callCouncilRole({
      url: ARCHITECT_URL,
      personality: architectPersonality,
      prompt,
      temperature: 0.3,
    }),
    callCouncilRole({
      url: SECURITY_URL,
      personality: securityPersonality,
      prompt,
      temperature: 0.25,
    }),
  ]);

  const judgePrompt = buildJudgePrompt(prompt, engineer, architect, security);
  const final = await callJudge(judgePrompt);

  return res.json({
    engineer,
    architect,
    security,
    final,
  });
});

app.post('/ask-single', async (req, res) => {
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

  const response = await callSingleRole({
    url: selected.url,
    personality: selected.personality,
    prompt,
    temperature: selected.temperature,
    nPredict: selected.nPredict,
  });

  return res.json({ role, response });
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Council server running at http://localhost:${PORT}`);
});
