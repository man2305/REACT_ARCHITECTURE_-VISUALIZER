# Server

Express API for the React Architecture Visualizer. Serves the web client
(deployed separately, e.g. on Vercel).

## Endpoints

| Endpoint | Description |
|---|---|
| `GET /api/health` | Health check (`{ ok: true, ... }`). |
| `POST /api/analyze/files` | Analyze pasted/uploaded source files. Body: `{ files: [{ path, content }] }`. |
| `POST /api/analyze/github` | Analyze a public GitHub repo. Body: `{ repositoryUrl, ref? }`. |
| `POST /api/audit` | AI architecture audit. Body: `{ metadata }` (project audit metadata from `@rav/audit`). Returns `{ report }`. |

Analysis responses include `truncated`, `totalFiles`, and `filesSkipped`
when files were dropped by server caps — the graph is partial in that case.
All errors are JSON `{ error }` (plus `code: "audit_unavailable"` for the
audit endpoint when no key is configured).

## Limits

- `/api/analyze/files`: max 200 files, 500 KB per file, 15 MB total content.
- `/api/analyze/github`: max 120 files, 500 KB per file, 50 MB compressed
  archive, 200 MB decompressed. Test/story files (`*.test.*`, `*.spec.*`,
  `*.stories.*`) and build-output folders are excluded.
- Rate limits (per IP, per minute): 30 for `/api/analyze/*`, 5 for
  `/api/audit` (each audit triggers a paid OpenAI call).
- GitHub fetches time out after 30 s (API) / 120 s (archive download).

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `4000` | Listen port. Invalid values fall back to 4000. |
| `CLIENT_ORIGIN` | No | _(all origins)_ | Comma-separated CORS origins allowed to call the API. Set to the deployed client URL in production. |
| `GITHUB_TOKEN` | No | _(unauthenticated)_ | GitHub personal access token. Raises the API quota from 60 to 5,000 requests/hour. |
| `OPENAI_API_KEY` | For `/api/audit` | _(unset)_ | OpenAI API key. Without it, `/api/audit` returns 503 `audit_unavailable`. |
| `OPENAI_API_URL` | No | `https://api.openai.com/v1/chat/completions` | OpenAI-compatible chat completions endpoint. |
| `OPENAI_MODEL` | No | `gpt-4o-mini` | Model used for audits. |

## Development

```bash
npm run build -w @rav/shared && npm run build -w @rav/audit && npm run build -w @rav/parser
npm run dev -w server   # tsx watch on http://localhost:4000
```
