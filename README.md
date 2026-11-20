# React Architecture Visualizer

React Architecture Visualizer scans a React codebase and turns component relationships, imports, routes, hooks, API calls, and warnings into an interactive graph.

## MVP Features

- Load a public GitHub repository URL.
- Parse JavaScript, TypeScript, JSX, and TSX files with Babel.
- Detect components, JSX child relationships, imports, React Router routes, hooks, provider usage, API calls, dead components, circular imports, and large files.
- Visualize the architecture with React Flow.
- Inspect metrics and warnings in a compact dashboard.

## Tech Stack

- React + TypeScript + Vite
- React Flow via `@xyflow/react`
- Tailwind CSS
- Express + TypeScript
- `@babel/parser` and `@babel/traverse`

## Getting Started

```bash
npm install
npm run dev
```

`npm run dev` first builds the shared workspace packages (`@rav/shared`, `@rav/audit`, `@rav/ui`,
`@rav/parser`) via the `predev` script — the server and client import those packages from their
`dist/` output, so on a fresh clone run `npm run build` once if you ever start the workspaces
individually (e.g. `npm run dev -w server` on its own).

The client runs on `http://localhost:5173` and the API runs on `http://localhost:4000`.

Paste a public GitHub repository URL such as `https://github.com/owner/repo` into the sidebar to scan it without cloning.

## Configuration

See `.env.example` (repo root) and `client/.env.example` for every variable.

| Variable | Where | Purpose |
| --- | --- | --- |
| `VITE_API_URL` | Client (Vite) | Base URL of the deployed API server. Leave empty locally (same-origin API). **Required on Vercel** — without it, analysis requests 404 because the static host has no `/api` routes. |
| `PORT` | Server | API listen port (default `4000`). |
| `OPENAI_API_KEY` | Server only | Enables the AI audit (`POST /api/audit`). Never put this in a `VITE_*` variable — Vite inlines those into the browser bundle. When unset, audits fall back to a local rule-based summary, labeled as such in the UI. |
| `GITHUB_TOKEN` | Server (optional) | GitHub token to raise the API quota from 60 to 5,000 req/hour. |
| `CLIENT_ORIGIN` | Server (optional) | Restricts CORS to the deployed client origin. |

Deployment wiring: deploy the API (e.g. Render, `render.yaml`) with `OPENAI_API_KEY` set, then set
`VITE_API_URL` on the client host (e.g. Vercel) to the API's public URL. If `VITE_API_URL` is missing
in a production build, the app shows a warning banner in the sidebar instead of failing silently.

## Roadmap

1. GitHub repository scanning.
2. PNG/SVG/PDF exports.
3. Commit-to-commit architecture comparison.
4. AI explanations and refactoring suggestions.
5. Dependency heatmap and architecture quality trends.
