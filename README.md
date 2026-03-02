# Distributed AI Council Controller

Minimal web orchestration server for a multi-role local AI council (Engineer, Architect, Security, Judge) backed by `llama.cpp` HTTP servers. Created with the assistance of CHATGPT and Codex by OpenAI.

## What It Does

- Runs Engineer, Architect, and Security in parallel.
- Feeds their outputs into Judge for a final integrated answer.
- Supports:
  - `Council` mode (all roles + Judge)
  - `Single role` mode (run one role only)
- Shows timing + token metrics in the web UI.
- Uses no database, no auth, no streaming, no websockets.

## Stack

- Node.js 18+
- Express
- Native `fetch` (server-side, Node runtime)
- Vanilla HTML/CSS/JS frontend

## Project Layout

```text
council/
  server.js
  package.json
  public/
    index.html
    style.css
    app.js
  personalities/
    engineer.js
    architect.js
    security.js
    judge.js
```

## Quick Start

```bash
cd council
npm install
node server.js
```

Server listens on `http://localhost:3000`.

## Configure Model Endpoints

Edit constants at the top of `council/server.js`:

- `ENGINEER_*_URL`
- `ARCHITECT_*_URL`
- `SECURITY_*_URL`
- `JUDGE_*_URL`

This project currently uses both `/chat/completions` and `/completion` (fallback paths).

## API

### 1) Council (sync)

`POST /ask`

Request:

```json
{ "prompt": "your prompt" }
```

Response:

```json
{
  "engineer": "string",
  "architect": "string",
  "security": "string",
  "final": "string",
  "timings": {},
  "metrics": {}
}
```

### 2) Council (job-based incremental UI path)

- `POST /ask-start` -> returns `{ "jobId": "..." }`
- `GET /ask-status/:jobId` -> returns stage + partial/final role outputs + timings/metrics

### 3) Single Role

`POST /ask-single`

Request:

```json
{ "prompt": "your prompt", "role": "engineer|architect|security|judge" }
```

Response:

```json
{
  "role": "judge",
  "response": "string",
  "timing_ms": 1234,
  "total_ms": 2345,
  "metrics": {}
}
```

## Frontend

Open `http://<host>:3000`:

- Prompt box
- Mode dropdown (Council / single role)
- Run button
- 4 output panels (Engineer, Security, Architect, Judge)
- Dark mode toggle
- Timing + token stats per panel

## Operational Notes

- Default role timeout: `ROLE_TIMEOUT_MS` in `server.js`
- Judge timeout: `JUDGE_TIMEOUT_MS` in `server.js`
- Judge input compaction: `JUDGE_MAX_INPUT_CHARS_PER_ROLE`
- Council jobs are kept in memory (TTL cleanup), no persistence.

## Security Notice

This is an MVP with **no authentication** and **no authorization**.

- Do not expose directly to the public internet without a reverse proxy + auth layer.
- Restrict network access to trusted hosts.
