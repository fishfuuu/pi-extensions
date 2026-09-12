# pi-bash-guard

Confirmation gate for dangerous `bash` commands in Pi coding agent.

**Status: canary / opt-in.** This extension is intentionally **not** part of the root
`pi.extensions` manifest yet. It is installed by local path while false positives and
false negatives are evaluated. Promote it into `package.json`, `tests/package-contract.test.mjs`
and `scripts/install.ps1` only after that evaluation.

## What it does

Every `bash` tool call is matched against a conservative rule set **before execution**.
Matched rules resolve to one of five **categories**, and each category has a policy:

| Category | Rules | Built-in policy |
|---|---|---|
| `recursive-delete` | rm -r/-rf, del /s, rd /s, Remove-Item -Recurse -Force | confirm |
| `destructive-git` | push --force, reset --hard, clean -f, checkout ., branch -D, stash drop/clear | confirm |
| `credential-write` | writes touching .env / auth.json / models.json / credentials / id_rsa / *.pem / .npmrc | confirm |
| `system-destructive` | dd of=, diskpart, mkfs, format X:, reg delete, schtasks /delete, curl\|sh | **block** |
| `publish` | npm publish, twine upload | confirm |

Actions:

- `allow` → run, no dialog
- `confirm` → dialog when dialog-capable UI is available; **block** when it is not
- `block` → always reject, no dialog

Blocked commands return a reason to the model so it can ask the user or pick a safer
approach instead of retrying blindly. The guard never rewrites or executes anything itself.

Fail-closed is the point: anything that is not an explicit "yes" blocks.

## Policy config (user scope only)

`~/.pi/agent/pi-bash-guard.json` (or `$PI_CODING_AGENT_DIR/pi-bash-guard.json`):

```json
{
  "enabled": true,
  "default": {
    "recursive-delete": "confirm",
    "destructive-git": "confirm",
    "credential-write": "confirm",
    "system-destructive": "block",
    "publish": "confirm"
  },
  "projects": {
    "D:\\wealth-lab": { "publish": "block" },
    "E:\\pi-extensions": { "recursive-delete": "allow" }
  }
}
```

- Project roots match by normalized (lowercase, forward-slash) prefix, so subdirectories
  inherit the project policy.
- A project only overrides the categories it lists; the rest inherit `default`.
- **Project repos cannot weaken the guard**: only this user-level file is read, and a
  missing/corrupt/invalid config falls back to the built-in defaults (guard stays enabled).
- The command text is never written to the audit log (commands can carry secrets).

## Commands

```text
/bash-guard status    show the effective policy for the current directory
/bash-guard on        enable the guard (writes enabled: true to the user config)
/bash-guard off       disable the guard (writes enabled: false)
```

## Install (canary, local path)

```bash
pi install /absolute/path/to/pi-extensions/extensions/pi-bash-guard
```

Then `/reload`. Do not copy this folder into `~/.pi/agent/extensions/` by hand.

## Audit log (how to evaluate the canary)

Every match is appended as one JSON line to:

```
~/.pi/agent/pi-bash-guard.log      # or $PI_CODING_AGENT_DIR/pi-bash-guard.log
```

```json
{"at":"...","rule":"git-force-push","category":"destructive-git","why":"force push ...","outcome":"denied","mode":"tui","hasUI":true,"elapsedMs":812,"timedOut":false,"commandSha256":"3f9c1a7e42b0d8e1","commandLength":16}
```

**The command text is never stored.** Commands can carry tokens, connection strings and
other secrets, so each entry keeps a truncated SHA-256 fingerprint plus the command length
instead. To inspect a specific case, match the fingerprint against the session transcript.

Review the log for:

- **false positives** — legitimate commands that prompted (tune or drop the rule)
- **timeouts** — `timedOut: true` means the dialog expired rather than a real decision
- **`outcome: "no-ui"`** — the guard blocked in a non-interactive run

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PI_BASH_GUARD_TIMEOUT_MS` | `120000` | Confirmation dialog timeout; expiry blocks (fail-closed) |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Where the audit log and policy config are read/written |

## Known limitation

In Pi Web, a pending guard confirmation may be cancelled when the active turn is
stopped/replaced.

Observed error:

```
Extension UI cancelled by Stop
```

Guard behavior: **fail-closed**; the affected tool call is blocked.

No confirmed evidence of blocked-command replay.

## Limits

This is a **guardrail, not a security boundary.** It forces a human decision for common
destructive patterns; obfuscated commands can still evade it. It is deliberately
conservative: `rm -rf node_modules` prompts, and the intent is to measure that noise
before deciding whether to add benign-target allowlists.

## Tests

```bash
node extensions/pi-bash-guard/tests/core.test.mjs     # rule matching + FP guards
node extensions/pi-bash-guard/tests/policy.test.mjs   # config loading, overrides, fail-safe
node extensions/pi-bash-guard/tests/guard.test.mjs    # wiring: confirm/allow/block/fail-closed
```
