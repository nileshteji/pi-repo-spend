# pi-repo-spend context

- `index.ts`: Pi extension entry point; scans Pi JSONL session logs, aggregates repo-level token usage and costs, estimates Ollama Cloud costs with hardcoded pricing, and exposes `/repo-spend`. It renders results as a message only and intentionally does not keep a footer/status spend indicator.
- `package.json`: Pi package manifest that loads `index.ts` as the extension.
- `README.md`: Usage, install, pricing assumptions, screenshots, and command reference for the extension.
- `assets/screenshots/`: PNG screenshots embedded in the README to show actual `/repo-spend` and `/repo-spend all` output.
