# pi-repo-spend context

- `index.ts`: Pi extension entry point; scans Pi JSONL session logs, aggregates repo-level token usage and costs, estimates Ollama Cloud costs with hardcoded pricing, and exposes `/repo-spend`.
- `package.json`: Pi package manifest that loads `index.ts` as the extension.
- `README.md`: Usage, install, pricing assumptions, and command reference for the extension.
