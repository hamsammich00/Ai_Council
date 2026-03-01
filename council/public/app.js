const promptEl = document.getElementById('prompt');
const runBtn = document.getElementById('runBtn');
const loadingEl = document.getElementById('loading');
const runModeEl = document.getElementById('runMode');
const themeToggleEl = document.getElementById('themeToggle');

const engineerEl = document.getElementById('engineer');
const architectEl = document.getElementById('architect');
const securityEl = document.getElementById('security');
const finalEl = document.getElementById('final');
const engineerMetaEl = document.getElementById('engineerMeta');
const architectMetaEl = document.getElementById('architectMeta');
const securityMetaEl = document.getElementById('securityMeta');
const finalMetaEl = document.getElementById('finalMeta');
const THEME_STORAGE_KEY = 'council_theme';
const POLL_INTERVAL_MS = 1000;

function setLoading(isLoading) {
  runBtn.disabled = isLoading;
  loadingEl.classList.toggle('hidden', !isLoading);
}

function setRunButtonLabel() {
  runBtn.textContent = runModeEl.value === 'council' ? 'Run Council' : 'Run Role';
}

function applyTheme(theme) {
  const normalized = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', normalized);
  themeToggleEl.textContent = normalized === 'dark' ? 'Light Mode' : 'Dark Mode';
  localStorage.setItem(THEME_STORAGE_KEY, normalized);
}

function formatMs(ms) {
  if (typeof ms !== 'number' || Number.isNaN(ms)) {
    return '';
  }
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatInt(value) {
  return Number.isFinite(value) ? Math.round(value).toString() : '';
}

function formatTps(value) {
  return Number.isFinite(value) ? value.toFixed(1) : '';
}

function buildRoleMeta({ timeMs, metrics, fallbackLabel }) {
  const parts = [];
  if (Number.isFinite(timeMs)) {
    parts.push(`Time: ${formatMs(timeMs)}`);
  } else if (fallbackLabel) {
    parts.push(fallbackLabel);
  }

  if (metrics && Number.isFinite(metrics.total_tokens)) {
    parts.push(`Tok: ${formatInt(metrics.total_tokens)}`);
  }

  if (metrics && Number.isFinite(metrics.tokens_per_second)) {
    parts.push(`Tok/s: ${formatTps(metrics.tokens_per_second)}`);
  }

  return parts.join(' | ');
}

function setPanelMeta({ engineer = '', architect = '', security = '', final = '' }) {
  engineerMetaEl.textContent = engineer;
  architectMetaEl.textContent = architect;
  securityMetaEl.textContent = security;
  finalMetaEl.textContent = final;
}

function setResults({ engineer, architect, security, final }) {
  engineerEl.textContent = engineer || '';
  architectEl.textContent = architect || '';
  securityEl.textContent = security || '';
  finalEl.textContent = final || '';
}

function setSingleResult(role, response) {
  setResults({
    engineer: role === 'engineer' ? response : 'Not requested in single mode.',
    architect: role === 'architect' ? response : 'Not requested in single mode.',
    security: role === 'security' ? response : 'Not requested in single mode.',
    final: role === 'judge' ? response : 'Not requested in single mode.',
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function renderCouncilStatus(payload) {
  const timings = payload.timings || {};
  const metrics = payload.metrics || {};
  const stage = payload.stage || 'roles';
  const done = Boolean(payload.done);

  setResults({
    engineer: payload.engineer || 'Waiting for Engineer...',
    architect: payload.architect || 'Waiting for Architect...',
    security: payload.security || 'Waiting for Security...',
    final: payload.final || (stage === 'judge' ? 'Judge is deliberating...' : 'Waiting for role responses...'),
  });

  setPanelMeta({
    engineer: buildRoleMeta({
      timeMs: timings.engineer_ms,
      metrics: metrics.engineer,
      fallbackLabel: 'Running...',
    }),
    architect: buildRoleMeta({
      timeMs: timings.architect_ms,
      metrics: metrics.architect,
      fallbackLabel: 'Running...',
    }),
    security: buildRoleMeta({
      timeMs: timings.security_ms,
      metrics: metrics.security,
      fallbackLabel: 'Running...',
    }),
    final: done
      ? `Judge: ${formatMs(timings.judge_ms)} | Total: ${formatMs(timings.total_ms)}${
        Number.isFinite(metrics.judge?.tokens_per_second) ? ` | Tok/s: ${formatTps(metrics.judge.tokens_per_second)}` : ''
      }`
      : stage === 'judge'
        ? `Judge running... | Elapsed: ${formatMs(payload.elapsed_ms)}`
        : `Elapsed: ${formatMs(payload.elapsed_ms)}`,
  });
}

async function runSingleRequest(prompt, role) {
  const response = await fetch('/ask-single', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, role }),
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || `Request failed (${response.status})`);
  }

  setSingleResult(payload.role, payload.response || 'Error: Empty response');
  const singleTime = buildRoleMeta({
    timeMs: payload.timing_ms,
    metrics: payload.metrics,
    fallbackLabel: '',
  });
  const singleMeta = `${singleTime}${singleTime ? ' | ' : ''}Total: ${formatMs(payload.total_ms)}`;
  setPanelMeta({
    engineer: payload.role === 'engineer' ? singleMeta : '',
    architect: payload.role === 'architect' ? singleMeta : '',
    security: payload.role === 'security' ? singleMeta : '',
    final: payload.role === 'judge' ? singleMeta : '',
  });
}

async function runCouncilRequest(prompt) {
  const startResponse = await fetch('/ask-start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });
  const startPayload = await startResponse.json().catch(() => ({}));

  if (!startResponse.ok) {
    throw new Error(startPayload.error || `Request failed (${startResponse.status})`);
  }

  const jobId = startPayload.jobId;
  if (!jobId) {
    throw new Error('Missing job id');
  }

  while (true) {
    const statusResponse = await fetch(`/ask-status/${encodeURIComponent(jobId)}`, { cache: 'no-store' });
    const statusPayload = await statusResponse.json().catch(() => ({}));

    if (!statusResponse.ok) {
      throw new Error(statusPayload.error || `Status request failed (${statusResponse.status})`);
    }

    renderCouncilStatus(statusPayload);
    if (statusPayload.done) {
      return;
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

runModeEl.addEventListener('change', () => {
  setRunButtonLabel();
});

setRunButtonLabel();

const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
applyTheme(savedTheme || 'light');

themeToggleEl.addEventListener('click', () => {
  const currentTheme = document.documentElement.getAttribute('data-theme');
  applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
});

runBtn.addEventListener('click', async () => {
  const prompt = promptEl.value.trim();
  if (!prompt) {
    alert('Please enter a prompt.');
    return;
  }

  const selected = runModeEl.value;
  const isCouncil = selected === 'council';

  setLoading(true);
  if (!isCouncil) {
    setSingleResult(selected, 'Working...');
    setPanelMeta({
      engineer: selected === 'engineer' ? 'Running...' : '',
      architect: selected === 'architect' ? 'Running...' : '',
      security: selected === 'security' ? 'Running...' : '',
      final: selected === 'judge' ? 'Running...' : '',
    });
  } else {
    setResults({
      engineer: 'Working...',
      architect: 'Working...',
      security: 'Working...',
      final: 'Waiting for role responses...',
    });
    setPanelMeta({
      engineer: 'Running...',
      architect: 'Running...',
      security: 'Running...',
      final: 'Waiting for role outputs...',
    });
  }

  try {
    if (!isCouncil) {
      await runSingleRequest(prompt, selected);
    } else {
      await runCouncilRequest(prompt);
    }
  } catch (error) {
    const message = error && error.message ? error.message : 'Network error';
    if (!isCouncil) {
      setSingleResult(selected, `Error: ${message}`);
      setPanelMeta({
        engineer: selected === 'engineer' ? 'Network error' : '',
        architect: selected === 'architect' ? 'Network error' : '',
        security: selected === 'security' ? 'Network error' : '',
        final: selected === 'judge' ? 'Network error' : '',
      });
    } else {
      setResults({
        engineer: `Error: ${message}`,
        architect: `Error: ${message}`,
        security: `Error: ${message}`,
        final: `Error: ${message}`,
      });
      setPanelMeta({
        engineer: 'Network error',
        architect: 'Network error',
        security: 'Network error',
        final: 'Network error',
      });
    }
  } finally {
    setLoading(false);
  }
});
