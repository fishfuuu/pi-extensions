# pi-quota

Token usage and quota monitoring for Pi coding agent sessions.

## Features

- **Real-time tracking**: Monitor token usage across multiple providers (OpenAI, Anthropic, etc.)
- **Visual dashboard**: Live TUI widget showing current usage and limits
- **Multi-provider support**: Tracks quotas separately per provider
- **Navigation**: Quick links to provider settings and billing pages

## Installation

```bash
pi install git:github.com/fishfuuu/pi-extensions
```

Then `/reload`. `/quota` only lists providers that already have credentials (DeepSeek, Codex, xAI, Ollama Cloud, Z.AI / 智谱 CN).

## Usage

### View current usage

```
/quota
```

Displays:
- Current session token usage
- Provider-specific quotas and limits
- Usage percentages
- Quick navigation links

### Widget

`pi-quota` automatically registers a TUI widget visible in the Pi interface showing:
- Total tokens used this session
- Per-provider breakdown
- Warning indicators when approaching limits

## How it works

- Intercepts provider requests to track token usage
- Normalizes provider-specific quota formats
- Calculates usage percentages and trends
- Updates the dashboard widget in real-time

## Testing

```bash
node extensions/pi-quota/tests/core.test.mjs
```

Expected output: `10/10 pi-quota tests passed`

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
