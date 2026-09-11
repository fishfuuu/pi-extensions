# pi-bash-guard

Confirmation gate for dangerous `bash` commands in Pi coding agent.

**Status: canary / opt-in.** This extension is intentionally **not** part of the root
`pi.extensions` manifest yet. It is installed by local path while false positives and
false negatives are evaluated. Promote it into `package.json`, `tests/package-contract.test.mjs`
and `scripts/install.ps1` only after that evaluation.

## What it does

Every `bash` tool call is matched against a conservative rule set **before execution**.
On a match, the command runs only after an explicit confirmation:

- **approved** → the command runs unchanged
- **denied / dismissed / timed out** → blocked
- **no dialog-capable UI** (`ctx.hasUI === false`, e.g. `print`/`json` mode) → blocked
- **dialog error** → blocked

Blocked commands return a reason to the model so it can ask the user or pick a safer
approach instead of retrying blindly. The guard never rewrites or executes anything itself.

Fail-closed is the point: anything that is not an explicit "yes" blocks.

## Rules

| Rule id | Flags |
|---|---|
| `rm-recursive` | `rm -r`, `rm -rf`, `rm -fr`, `rm --recursive` (any target) |
| `windows-recursive-delete` | `del /s`, `rd /s`, `rmdir /s` |
| `powershell-recursive-force` | `Remove-Item -Recurse -Force` |
| `dd-write` | `dd ... of=` |
| `disk-partition` | `diskpart`, `mkfs*`, `format X:` |
| `registry-delete` | `reg delete` |
| `scheduled-task-delete` | `schtasks ... /delete` |
| `git-force-push` | `git push --force`, `git push -f` (`--force-with-lease` is allowed) |
| `git-reset-hard` | `git reset --hard` |
| `git-clean-force` | `git clean -f...` |
| `git-checkout-discard` | `git checkout .`, `git checkout -- .` |
| `git-branch-delete-force` | `git branch -D` (case-sensitive; `-d` is allowed) |
| `git-stash-destroy` | `git stash drop`, `git stash clear` |
| `publish` | `npm publish`, `twine upload` (`--dry-run` is allowed) |
| `pipe-to-shell` | `curl`/`wget`/`iwr` piped into `sh`/`bash`/`zsh`/`ksh` |
| `credential-file-write` | write-ish operations touching `.env`, `auth.json`, `models.json`, `credentials`, `id_rsa`, `id_ed25519`, `.npmrc`, `*.pem` |

Matching runs on a normalized copy of the command (quotes stripped, whitespace collapsed,
lowercased) so trivial quoting/case/spacing variants still match. Reads of credential files
(`cat .env`, `grep` into `.env`) are deliberately **not** flagged.

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
{"at":"...","rule":"git-force-push","why":"force push ...","outcome":"denied","mode":"tui","hasUI":true,"elapsedMs":812,"timedOut":false,"commandSha256":"3f9c1a7e42b0d8e1","commandLength":16}
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
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Where the audit log is written |

## Limits

This is a **guardrail, not a security boundary.** It forces a human decision for common
destructive patterns; obfuscated commands can still evade it. It is deliberately
conservative: `rm -rf node_modules` prompts, and the intent is to measure that noise
before deciding whether to add benign-target allowlists.

## Tests

```bash
node extensions/pi-bash-guard/tests/core.test.mjs
```
