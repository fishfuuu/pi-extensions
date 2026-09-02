# Pi Extensions

A small collection of Pi Coding Agent extensions.

| Extension | Purpose | Status |
|-----------|---------|--------|
| [pi-check](extensions/pi-check/) | Automatic lint/typecheck feedback | Stable |
| [pi-quota](extensions/pi-quota/) | Provider quota/usage visibility | Stable |
| [pi-db](extensions/pi-db/) | Read-only MySQL/MariaDB agent queries | Stable |

## About

Each extension is independent with its own configuration and documentation. See each extension's README for usage and installation details.

## Source-of-Truth Model

This repository contains the **canonical source** for all three extensions:

```
Repository source (E:\pi-extensions)
    → install.ps1
    → ~/.pi/agent/extensions/
    → Pi /reload
```

**Important:** Do not edit installed copies directly. Make changes in this canonical repository, test them, then reinstall/update.

## Installation

**Note:** Run the install script from PowerShell (not Git Bash or WSL).

Use the provided install script:

```powershell
# Install individual extension
.\scripts\install.ps1 pi-check
.\scripts\install.ps1 pi-quota
.\scripts\install.ps1 pi-db

# Install all extensions
.\scripts\install.ps1 all

# Update existing installation
.\scripts\install.ps1 pi-db -Update
```

Default installation target: `~/.pi/agent/extensions/<plugin>`

## Development Workflow

1. Make changes in `E:\pi-extensions\extensions\<plugin>\`
2. Run tests (if available)
3. Install/update: `.\scripts\install.ps1 <plugin> -Update`
4. Reload Pi: `/reload` command
5. Test in Pi environment

## License

MIT
