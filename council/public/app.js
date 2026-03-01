const promptEl = document.getElementById('prompt');
const runBtn = document.getElementById('runBtn');
const loadingEl = document.getElementById('loading');
const modeEl = document.getElementById('mode');
const singleRoleEl = document.getElementById('singleRole');

const engineerEl = document.getElementById('engineer');
const architectEl = document.getElementById('architect');
const securityEl = document.getElementById('security');
const finalEl = document.getElementById('final');

function setLoading(isLoading) {
  runBtn.disabled = isLoading;
  loadingEl.classList.toggle('hidden', !isLoading);
}

function setRunButtonLabel() {
  runBtn.textContent = modeEl.value === 'single' ? 'Run Single' : 'Run Council';
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

modeEl.addEventListener('change', () => {
  setRunButtonLabel();
});

setRunButtonLabel();

runBtn.addEventListener('click', async () => {
  const prompt = promptEl.value.trim();
  if (!prompt) {
    alert('Please enter a prompt.');
    return;
  }

  const mode = modeEl.value;
  const singleRole = singleRoleEl.value;

  setLoading(true);
  if (mode === 'single') {
    setSingleResult(singleRole, 'Working...');
  } else {
    setResults({
      engineer: 'Working...',
      architect: 'Working...',
      security: 'Working...',
      final: 'Waiting for role responses...',
    });
  }

  try {
    const response = await fetch(mode === 'single' ? '/ask-single' : '/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        mode === 'single'
          ? { prompt, role: singleRole }
          : { prompt }
      ),
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message = payload.error || `Request failed (${response.status})`;
      if (mode === 'single') {
        setSingleResult(singleRole, `Error: ${message}`);
      } else {
        setResults({
          engineer: `Error: ${message}`,
          architect: `Error: ${message}`,
          security: `Error: ${message}`,
          final: `Error: ${message}`,
        });
      }
      return;
    }

    if (mode === 'single') {
      setSingleResult(payload.role, payload.response || 'Error: Empty response');
    } else {
      setResults(payload);
    }
  } catch (error) {
    const message = error && error.message ? error.message : 'Network error';
    if (mode === 'single') {
      setSingleResult(singleRole, `Error: ${message}`);
    } else {
      setResults({
        engineer: `Error: ${message}`,
        architect: `Error: ${message}`,
        security: `Error: ${message}`,
        final: `Error: ${message}`,
      });
    }
  } finally {
    setLoading(false);
  }
});
