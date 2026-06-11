# spend

A Pi extension that reports how much money and how many tokens you have spent per cwd, repo, model, month, and day.

It reads Pi's local JSONL session logs from `~/.pi/agent/sessions`, aggregates usage, and shows a copyable Markdown report or graphical dashboard inside Pi.

## Extension name

`spend`

## Slash command

```text
/spend
```

## What it shows

- Copyable Markdown report by default
- Optional graphical token composition dashboard inspired by `/context`
- Total token usage
- Total recorded cost from Pi logs
- Model-level estimated Ollama Cloud cost when Pi records Ollama as `$0`
- Cost by month and day for exact-cwd reports
- Cost by model
- Cost by repo/cwd when scanning all sessions
- Graphical dashboard via `dashboard` mode

## Screenshots

Example copyable text output for the current cwd/session:

![Actual /spend text output showing summary and model totals](assets/screenshots/spend-current-session.png)

Example graphical dashboard for the current cwd/session:

![Actual /spend dashboard output showing token composition, spend bars, and daily/monthly sections](assets/screenshots/spend-dashboard.png)

Example output for all Pi sessions grouped by repo/cwd:

![Actual /spend all output showing spend grouped by repo and cwd](assets/screenshots/spend-all-sessions.png)

## Commands

```text
/spend                 # copyable Markdown report for sessions whose cwd exactly matches the current cwd
/spend cwd             # same as /spend
/spend repo            # copyable Markdown report for the current git repo; no monthly/daily tables
/spend all             # copyable Markdown report for all Pi sessions, grouped by repo/cwd; no monthly/daily tables
/spend dashboard       # graphical dashboard for exact cwd
/spend all dashboard   # graphical dashboard for all Pi sessions
```

In exact-cwd mode (`/spend` or `/spend cwd`), the report includes monthly and daily tables like:

| Month | Calls | Tokens | Recorded | Total |
|---|---:|---:|---:|---:|
| 2026-06 | 20 | 333,194 | $0.82 | $0.82 |

| Day | Calls | Tokens | Recorded | Total |
|---|---:|---:|---:|---:|
| 2026-06-11 | 20 | 333,194 | $0.82 | $0.82 |

In `/spend all`, the report includes a table like:

| Repo / cwd | Sessions | Calls | Tokens | Recorded | Total | Top model |
|---|---:|---:|---:|---:|---:|---|
| `my-repo (/path/to/my-repo)` | 3 | 120 | 1,234,567 | `$4.20` | `$4.32` | `openai-codex/gpt-5.5` |

## Run once

```bash
pi -e /Users/nileshteji/aibot/pi-repo-spend
```

Then use:

```text
/spend
```

## Install as a local Pi package

```bash
pi install /Users/nileshteji/aibot/pi-repo-spend
```

Then restart Pi or run:

```text
/reload
```

## Cost logic

- For providers where Pi records `usage.cost.total`, this extension uses the recorded cost.
- For Ollama Cloud, Pi often records `$0`; this extension estimates the cost from a hardcoded pricing table.
- Ollama estimates are shown in the `Estimate` column of the model table only.

## Hardcoded Ollama Cloud estimate rates

Ollama Cloud itself bills by subscription/cloud usage, primarily GPU time, not fixed token prices. These estimates use equivalent provider API prices for the same or nearest public model.

| Ollama model | Input / 1M | Output / 1M | Cache read / 1M | Source basis |
|---|---:|---:|---:|---|
| `deepseek-v4-pro:cloud` | `$0.435` | `$0.87` | `$0.003625` | DeepSeek official API pricing |
| `glm-5.1:cloud` | `$1.40` | `$4.40` | `$0.26` | Z.AI official pricing |
| `kimi-k2.6:cloud` | `$0.95` | `$4.00` | `$0.16` | Kimi official pricing |
| `minimax-m3:cloud` | `$0.30` | `$1.20` | `$0.06` | MiniMax standard discounted tier, <=512k input |
| `qwen3.5:cloud` | `$0.60` | `$3.60` | `$0.60` | Qwen3.5 public API estimate |
| `nemotron-3-ultra:cloud` | `$0.60` | `$3.60` | `$0.20` | NVIDIA/Together route estimate |

Treat Ollama numbers as practical estimates, not your Ollama invoice.

## Files

| File | Purpose |
|---|---|
| `index.ts` | Pi extension entry point and scanner implementation |
| `package.json` | Pi package manifest |
| `README.md` | Project documentation |
| `context.md` | Short context for future agents |

## Notes

- The extension does not call external APIs at runtime.
- It only reads local Pi session logs.
- It respects `PI_CODING_AGENT_SESSION_DIR` and `PI_CODING_AGENT_DIR` when set.
