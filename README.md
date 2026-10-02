# Pi Extensions

A small collection of [Pi](https://github.com/earendil-works/pi) extensions.

## Install (everyone)

```bash
pi install git:github.com/fishfuuu/pi-extensions
```

Then **restart Pi** or run `/reload`.

This loads:

| Extension | Command / behavior |
|-----------|-------------------|
| [pi-check](extensions/pi-check/) | Lint/typecheck after edits (`/check`) |
| [pi-quota](extensions/pi-quota/) | `/quota` for configured providers |
| [pi-db](extensions/pi-db/) | Read-only `db_query` (off until the project opts in) |
| [pi-usage-dashboard](extensions/pi-usage-dashboard/) | `/usage-dashboard` — offline token-usage dashboard built from local sessions |

`pi-db` does **not** get database access from install alone. Add a project `.pi` config; credentials stay in your existing `.env`. See [pi-db](extensions/pi-db/).

Uninstall:

```bash
pi remove git:github.com/fishfuuu/pi-extensions
```

Do not edit files under `~/.pi/agent/extensions/` or `~/.pi/agent/npm/`. Change this repository, then reinstall.

## Optional (not installed by default)

| Extension | Why it is optional |
|-----------|-------------------|
| [pi-ollama-cloud-copy](extensions/pi-ollama-cloud-copy/) | Second Ollama Cloud subscription (`ollama-copy`). Needs `pi install npm:pi-ollama-cloud` first. |
| [pi-bash-guard](extensions/pi-bash-guard/) | Dangerous-bash confirm gate. Canary; not in the default git package. |
| [pi-clawd-subagents](extensions/pi-clawd-subagents/) | Reports headless (`pi -p`) runs to a running Clawd on Desk pet. Desktop-pet integration; no-op without it. |
| [pi-side-panel](extensions/pi-side-panel/) | `/side` — keep a read-only side thread open in a panel with its own input box (a rpiv-btw fork). |

```powershell
# maintainer / local clone only
.\scripts\install.ps1 pi-ollama-cloud-copy
.\scripts\install.ps1 pi-bash-guard
.\scripts\install.ps1 pi-clawd-subagents
.\scripts\install.ps1 pi-side-panel
```

## Agent profiles (not installed by the package)

[`agents/`](agents/) holds canonical Pi Web **built-in Agent** profiles for specialized child work
(reviewers, execution verifier, browser QA). They are not part of the `pi` package install above;
copy them from PowerShell:

```powershell
Get-ChildItem .\agents\*.md |
    Where-Object Name -ne 'README.md' |
    Copy-Item -Destination "$HOME\.pi\agent\agents\" -Force
```

See [agents/](agents/) for the runtime contract and
[docs/pi-web-agent-migration.md](docs/pi-web-agent-migration.md) for migrating another machine.

## Maintainer install (this machine)

Canonical source is this repo. Copy into `~/.pi/agent/extensions/` from **PowerShell** (not Git Bash):

```powershell
.\scripts\install.ps1 all          # pi-check, pi-quota, pi-db
.\scripts\install.ps1 pi-quota -Update
```

`all` installs the default set (`pi-check`, `pi-quota`, `pi-db`, `pi-usage-dashboard`) and nothing else. After copying: `/reload`.

## Development

1. Edit `extensions/<plugin>/`
2. Run that plugin's tests
3. `.\scripts\install.ps1 <plugin> -Update`
4. `/reload`

## License

MIT
