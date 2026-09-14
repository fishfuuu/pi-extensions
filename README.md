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

`pi-db` does **not** get database access from install alone. Add a project `.pi` config; credentials stay in your existing `.env`. See [pi-db](extensions/pi-db/).

Uninstall:

```bash
pi remove git:github.com/fishfuuu/pi-extensions
```

Do not edit files under `~/.pi/agent/extensions/` or `~/.pi/agent/npm/`. Change this repository, then reinstall.

## Optional (not installed by default)

| Extension | Why it is optional |
|-----------|-------------------|
| [pi-tool-presets](extensions/pi-tool-presets/) | Hides `workflow` / `subagent` / `db_query` / `web_search` unless you opt in. Most people should skip it. |
| [pi-tools-stats](extensions/pi-tools-stats/) | Read-only `/tools-stats` (usage / unused / errors). Does not hide tools. |

```powershell
# maintainer / local clone only
.\scripts\install.ps1 pi-tool-presets
.\scripts\install.ps1 pi-tools-stats
```

## Maintainer install (this machine)

Canonical source is this repo. Copy into `~/.pi/agent/extensions/` from **PowerShell** (not Git Bash):

```powershell
.\scripts\install.ps1 all          # pi-check, pi-quota, pi-db
.\scripts\install.ps1 pi-quota -Update
```

`all` does not include `pi-tool-presets` or `pi-tools-stats`. After copying: `/reload`.

## Development

1. Edit `extensions/<plugin>/`
2. Run that plugin's tests
3. `.\scripts\install.ps1 <plugin> -Update`
4. `/reload`

## License

MIT
