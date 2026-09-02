# pi-quota

Token usage and quota monitoring for Pi coding agent sessions.

## Features

- **Real-time tracking**: Monitor token usage across multiple providers (OpenAI, Anthropic, etc.)
- **Visual dashboard**: Live TUI widget showing current usage and limits
- **Multi-provider support**: Tracks quotas separately per provider
- **Navigation**: Quick links to provider settings and billing pages

## Installation

Install via the canonical repository installer:

```powershell
# From E:\pi-extensions
.\scripts\install.ps1
```

Or as a Pi package (requires Pi runtime with package support):

```bash
npm install -g @fishfuuu/pi-extensions
```

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
- OpenAI (GPT models)
- Anthropic (Claude models)
- Other providers via generic adapters

## License

MIT
