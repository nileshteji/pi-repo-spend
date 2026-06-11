# spend context

- `index.ts`: Pi extension entry point; scans Pi JSONL session logs, aggregates token usage and costs by cwd/repo/model (collapsing calls with the same provider/model), adds monthly and daily buckets for exact-cwd reports, estimates Ollama Cloud costs with hardcoded pricing for model-level reporting, and exposes `/spend`. The default renderer is the copyable Markdown report; `dashboard` mode renders a graphical Pi TUI dashboard. It intentionally does not keep a footer/status spend indicator.
- `package.json`: Pi package manifest that loads `index.ts` as the extension and describes the cwd/repo spend reporting package.
- `README.md`: Usage, install, pricing assumptions, screenshots, and command reference for the extension, including default text output, graphical dashboard mode, and exact-cwd monthly/daily behavior.
- `assets/screenshots/`: PNG screenshots embedded in the README to show actual `/spend` and `/spend all` output.
