# pi-clawd-subagents

Make **headless (print/json) pi processes visible** in the [Clawd on Desk](https://github.com/rullerzhou-afk/clawd-on-desk) session HUD.

## Why this exists

Clawd on Desk ships its own first-party pi extension at `~/.pi/agent/extensions/clawd-on-desk/`. It reports session state to `http://127.0.0.1:23333/state` (`agent_id: "pi"`, `hook_source: "pi-extension"`, session key `pi:<sessionId>`).

That extension gates everything on `ctx.hasUI`:

| pi mode | `hasUI` | vendor extension reports |
| --- | --- | --- |
| interactive (TUI) | `true` | yes |
| `--mode rpc` | `true` | yes |
| `-p` / `--print` | `false` | **no** |
| `--mode json` | `false` | **no** |

So every delegated investigation, background job, or workflow worker started as `pi -p` runs completely invisible to the pet, even though it is a real running pi process. This extension reports exactly those runs and nothing else.

## What it does

- Reports **only** in print/json modes, so it can never double-report a TUI or RPC session the vendor extension already owns.
- Reports **only** when `PI_CLAWD_SUBAGENTS` is truthy — opt-in, so stray one-shot runs do not become HUD entries.
- Exports `PI_CLAWD_SUBAGENTS=1` from **any** loaded session, so processes spawned later by tools (bash, background tasks, workflows) inherit the opt-in automatically. An explicit `PI_CLAWD_SUBAGENTS=0` is never overwritten.
- Reuses the vendor's payload shape and event mapping, so the app renders these sessions like any other pi session.

Event mapping (same as the vendor extension):

| pi event | Clawd event | state |
| --- | --- | --- |
| `session_start` | `SessionStart` | `idle` |
| `before_agent_start` | `UserPromptSubmit` | `thinking` |
| `tool_call` | `PreToolUse` | `working` |
| `tool_result` | `PostToolUse` / `PostToolUseFailure` | `working` / `error` |
| `session_before_compact` | `PreCompact` | `sweeping` |
| `session_compact` | `PostCompact` | `attention` |
| `agent_end` | `Stop` | `attention` |
| `session_shutdown` | `SessionEnd` | `sleeping` |

## Deliberately omitted payload fields

- **`headless`** — the app's session HUD filters headless sessions out (`isHudSession()` requires `!session.headless`), which is the opposite of the goal. Do not send it.
- **`subagentId` / `subagentType`** — real app fields, but their semantics are undocumented and they add nothing to visibility.

## Usage

```bash
# A child process from a pi session (flag inherited automatically):
pi -p "summarize this file"

# A child process from a plain shell (set the flag explicitly):
PI_CLAWD_SUBAGENTS=1 pi -p "say ok"

# Opt out inside a session:
PI_CLAWD_SUBAGENTS=0 pi -p "..."
```

## Requirements

- Clawd on Desk running (state server on `127.0.0.1:23333`, ports 23333–23337 probed).
- The vendor pi extension installed. Check integration state in `%APPDATA%\clawd-on-desk\clawd-prefs.json` → `agents.pi.enabled` must be `true`, otherwise the app accepts requests but silently drops them.

## Verification

1. `pi -p "say ok"` with no flag → no new session in `%APPDATA%\clawd-on-desk\session-debug.log`.
2. `PI_CLAWD_SUBAGENTS=1 pi -p "say ok"` → a new `sid=…` line with `agent=pi … source=pi-extension` and `headless=0`.
3. The session appears in the pet's session HUD, and two concurrent sessions make the pet juggle.
