const promptEl = document.getElementById('prompt');
const runBtn = document.getElementById('runBtn');
const loadingEl = document.getElementById('loading');

const engineerEl = document.getElementById('engineer');
const architectEl = document.getElementById('architect');
const securityEl = document.getElementById('security');
const finalEl = document.getElementById('final');

function setLoading(isLoading) {
  runBtn.disabled = isLoading;
  loadingEl.classList.toggle('hidden', !isLoading);
}

function setResults({ engineer, architect, security, final }) {
  engineerEl.textContent = engineer || '';
  architectEl.textContent = architect || '';
  securityEl.textContent = security || '';
  finalEl.textContent = final || '';
}

runBtn.addEventListener('click', async () => {
  const prompt = promptEl.value.trim();
  if (!prompt) {
    alert('Please enter a prompt.');
    return;
  }

  setLoading(true);
  setResults({
    engineer: 'Working...',
    architect: 'Working...',
    security: 'Working...',
    final: 'Waiting for role responses...',
  });

  try {
    const response = await fetch('/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message = payload.error || `Request failed (${response.status})`;
      setResults({
        engineer: `Error: ${message}`,
        architect: `Error: ${message}`,
        security: `Error: ${message}`,
        final: `Error: ${message}`,
      });
      return;
    }

    setResults(payload);
  } catch (error) {
    const message = error && error.message ? error.message : 'Network error';
    setResults({
      engineer: `Error: ${message}`,
      architect: `Error: ${message}`,
      security: `Error: ${message}`,
      final: `Error: ${message}`,
    });
  } finally {
    setLoading(false);
  }
});
