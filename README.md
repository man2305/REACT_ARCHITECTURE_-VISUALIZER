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

The client runs on `http://localhost:5173` and the API runs on `http://localhost:4000`.

Paste a public GitHub repository URL such as `https://github.com/owner/repo` into the sidebar to scan it without cloning.

## Roadmap

1. GitHub repository scanning.
2. PNG/SVG/PDF exports.
3. Commit-to-commit architecture comparison.
4. AI explanations and refactoring suggestions.
5. Dependency heatmap and architecture quality trends.
