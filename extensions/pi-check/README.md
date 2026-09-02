# pi-check

Framework-agnostic code quality checks for Pi coding agent.

## Features

- **Lifecycle integration**: Runs checks automatically at key points (after edits, before commits)
- **Multi-language support**: Works with `.py`, `.ts`, `.tsx`, and other source files
- **Configurable rules**: File extension matching, scope filters, numeric bounds
- **Commands**: `/check` for manual checks, `/simplify` for readability analysis

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

### Automatic checks

`pi-check` runs automatically:
- After file edits (lifecycle hook: `after_edit`)
- Before Git commits (lifecycle hook: `before_commit`)

### Manual checks

```
/check <file-or-directory>
```

### Simplify analysis

```
/simplify <file>
```

Analyzes code readability and suggests improvements.

## Configuration

No configuration file required. Checks are applied based on:
- File extensions (`.py`, `.ts`, `.tsx`)
- Code patterns (imports, exports, function definitions)
- Numeric bounds (line counts, complexity thresholds)

## Stack Compatibility

See [STACK_COMPATIBILITY.md](./STACK_COMPATIBILITY.md) for framework-specific guidance.

## Testing

```bash
node extensions/pi-check/tests/core.test.mjs
```

Expected output: `6/6 pi-check tests passed`

## License

MIT
