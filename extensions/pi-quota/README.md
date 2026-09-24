# pi-quota

On-demand quota snapshots for the providers configured in your Pi model registry.

## Features

- **On-demand**: `/quota` fetches a snapshot when you ask. There is **no background polling** and nothing is tracked between queries.
- **Multi-provider support**: One card per configured provider with a supported quota adapter (Codex, xAI, Ollama Cloud, DeepSeek official, 智谱 CN / Z.AI 国际 Coding Plan).
- **Compact widget**: after `/quota` runs, a widget shows the tightest remaining window per provider; it refreshes only when you run `/quota` again.
- **Expandable model mix**: for providers that report per-model usage, the panel can break a window down by request share.

## Installation

```bash
pi install git:github.com/fishfuuu/pi-extensions
```

Then `/reload`. `/quota` only lists providers that already have credentials (DeepSeek, Codex, xAI, Ollama Cloud, Z.AI / 智谱 CN).

## Usage

### View current quota

```
/quota            # all configured providers
/quota <provider> # one provider, e.g. /quota codex
```

Each card shows provider-specific quota windows (e.g. 5h / weekly) with remaining percentage and reset time, plus balances for balance-based providers. It is a snapshot of the provider's quota endpoint at query time — not session token usage and not a live feed.

### Widget

Running `/quota` sets a compact `pi-quota` widget (below the editor) with one line per provider: tightest remaining window and reset time, or the query error. The widget stays until the session ends and only changes when `/quota` is run again.

## How it works

- On each `/quota`, queries the provider's quota endpoint with the credential already stored by Pi (read-only; no secret is written or logged)
- Normalizes provider-specific response formats into windows/percentages
- Renders the panel and updates the widget from that single fetch
- `pi-worker-selector` reuses the same snapshot layer for its quota eligibility check

## Testing

```bash
node extensions/pi-quota/tests/core.test.mjs
node extensions/pi-quota/tests/snapshot.test.mjs
```

Expected output: `9/9 pi-quota tests passed` and `19/19 snapshot tests passed`

## Provider Support

Currently tracks:
- OpenAI Codex (`chatgpt.com`)
- xAI (`api.x.ai`)
- Ollama Cloud (`ollama.com`)
- DeepSeek official (`api.deepseek.com`)
- 智谱 CN Coding Plan (`open.bigmodel.cn`)
- Z.AI / 智谱国际 Coding Plan (`api.z.ai`)

## License

MIT
