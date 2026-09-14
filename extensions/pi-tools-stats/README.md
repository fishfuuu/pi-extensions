# pi-tools-stats

Read-only usage and health for Pi tools. Helps you decide what to uninstall. **Never hides or disables tools.**

## Install (opt-in)

Not part of `pi install git:github.com/fishfuuu/pi-extensions`.

```powershell
.\scripts\install.ps1 pi-tools-stats
```

Then `/reload`.

## Commands

```
/tools-stats           last 7 days, all catalogued tools
/tools-stats unused    zero calls
/tools-stats errors    at least one failure
```

Advice:

- under 7 days since first seen → `观察中`
- 7+ days, 0 calls, currently **active** → `从未用 · 可考虑卸`
- 7+ days, 0 calls, currently **inactive** (e.g. hidden by a preset) → `从未用 · 当前未启用`
- any calls → `常用`

## Data

```
~/.pi/agent/tools-stats/
  catalog.json    registered tools (name, short source, firstSeen, lastSeen)
  events.jsonl    completed calls only
```

Events store tool name, short owner, ok, durationMs, timestamp. No arguments, results, paths, SQL, or secrets.

## Notes

- Catalog snapshot runs on `session_start` (not at extension load).
- Tool source comes from `getAllTools().sourceInfo`, not from `tool_call`.
- `tool_call` only remembers start time by `toolCallId`; `tool_result` writes the event.
