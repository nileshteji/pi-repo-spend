# pi-repo-spend

Pi extension that shows how much you have spent in the current repo, broken down by provider/model and token type.

## Extension name

`pi-repo-spend`

## Command

```text
/repo-spend
```

By default this scans Pi session logs whose recorded `cwd` is the current git repo root or any directory under it.

Extra modes:

```text
/repo-spend all   # scan every Pi session under ~/.pi/agent/sessions
/repo-spend cwd   # only sessions whose cwd exactly matches the current cwd
```

## Run once

```bash
pi -e /Users/nileshteji/aibot/pi-repo-spend
```

## Install as a local Pi package

```bash
pi install /Users/nileshteji/aibot/pi-repo-spend
```

Then restart Pi or run `/reload`.

## Cost logic

- Uses Pi's recorded `usage.cost.total` when present.
- For Ollama Cloud rows, Pi often records `$0`; this extension estimates cost from hardcoded per-token prices for equivalent provider APIs.
- Ollama estimates are explicitly separated as `Estimated Ollama Cloud cost`.

## Hardcoded Ollama estimate rates

| Ollama model | Input / 1M | Output / 1M | Cache read / 1M |
|---|---:|---:|---:|
| `deepseek-v4-pro:cloud` | `$0.435` | `$0.87` | `$0.003625` |
| `glm-5.1:cloud` | `$1.40` | `$4.40` | `$0.26` |
| `kimi-k2.6:cloud` | `$0.95` | `$4.00` | `$0.16` |
| `minimax-m3:cloud` | `$0.30` | `$1.20` | `$0.06` |
| `qwen3.5:cloud` | `$0.60` | `$3.60` | `$0.60` |
| `nemotron-3-ultra:cloud` | `$0.60` | `$3.60` | `$0.20` |

Ollama Cloud itself bills by plan/cloud usage, primarily GPU time, not fixed token prices. Treat these as practical estimates, not your Ollama invoice.
