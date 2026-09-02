# Pi Extensions

A small collection of Pi Coding Agent extensions.

| Extension | Purpose | Status |
|-----------|---------|--------|
| [pi-check](extensions/pi-check/) | Automatic lint/typecheck feedback | Stable |
| [pi-quota](extensions/pi-quota/) | Provider quota/usage visibility | Stable |
| [pi-db](extensions/pi-db/) | Read-only MySQL/MariaDB and PostgreSQL agent queries | Stable |
| [pi-tool-presets](extensions/pi-tool-presets/) | Lightweight tool preset management | Beta |

## About

Each extension is independent with its own configuration and documentation. See each extension's README for usage and installation details.

`pi-db` remains read-only and project-authorized. PostgreSQL real-database canary is not claimed here.

## Installation Methods

Two installation paths exist:

1. **PowerShell installer** (canonical copy into `~/.pi/agent/extensions/`): `scripts/install.ps1`
2. **Native Pi package**: `pi install <path-to-this-repo>` using the root `package.json` `pi.extensions` manifest

The installer path is the verified way to update the live auto-discovery copies. The native package path installs via Pi package settings (`private: true`, no npm publish). After installer updates, run `/reload` in an interactive Pi session.

## Source-of-Truth Model

This repository is the **canonical source** for all four extensions:

```
Repository source
    → scripts/install.ps1
    → ~/.pi/agent/extensions/
    → Pi /reload
```

**Important:** Do not edit installed copies directly. Make changes in this repository, test them, then reinstall/update.

## Installation

**Note:** Run the install script from PowerShell (not Git Bash or WSL).

```powershell
# Install individual extension
.\scripts\install.ps1 pi-check
.\scripts\install.ps1 pi-quota
.\scripts\install.ps1 pi-db
.\scripts\install.ps1 pi-tool-presets

# Install all extensions
.\scripts\install.ps1 all

# Update existing installation
.\scripts\install.ps1 pi-db -Update
.\scripts\install.ps1 all -Update
```

Default installation target: `~/.pi/agent/extensions/<plugin>`

Native package install (does not use `install.ps1`):

```bash
pi install /absolute/path/to/pi-extensions
```

Root runtime dependencies are `mysql2` and `pg`. The package is `"private": true`.

## Tool presets

`pi-tool-presets` applies a light **core** set on the first `before_agent_start` of each session.

Core keeps base editing tools plus `todo`, `symbol_search`, and `pi_tool_presets`. Managed specialist tools such as `db_query`, `web_search`, `subagent`, and `workflow` are not in the default core set. Unknown third-party tools are preserved.

Load more tools additively:

```
/tools-preset status
/tools-preset database
/tools-preset code
/tools-preset all
/tools-preset core
```

The LLM tool `pi_tool_presets` accepts the same actions. `all` restores every registered runtime tool; `core` returns to the light set.

## Development Workflow

1. Make changes in `extensions/<plugin>/`
2. Run tests
3. Install/update: `.\scripts\install.ps1 <plugin> -Update`
4. Reload Pi: `/reload`
5. Test in Pi

## License

MIT
