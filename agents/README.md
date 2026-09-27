# Pi Web Custom Agent Profiles

Canonical Pi Web built-in Agent profiles for specialized child work.

## Runtime ownership

| Runtime | Owns |
|---------|------|
| Pi Web built-in Agent | specialized / native child: reviewers, execution verifier, browser QA |
| Dynamic Workflows + `pi-worker-selector` | managed worker: parallel / fan-out / chain / pipeline |

`pi-subagents` is retired on the machine that uses these profiles. No profile here depends on it.

## Profiles

| Profile | `tools` | `model` | `thinking` | `load_extensions` |
|---------|---------|---------|------------|-------------------|
| `independent-reviewer` | read, grep, find | `openai-codex/gpt-5.6-sol` | high | false |
| `code-reviewer` | read, grep, find, bash | `ollama/deepseek-v4.1-flash` | high | false |
| `change-architecture-reviewer` | read, grep, find, bash | `ollama/deepseek-v4.1-flash` | high | false |
| `execution-verifier` | read, grep, find, bash | `ollama/deepseek-v4.1-flash` | high | false |
| `browser-qa-agent` | read, grep, find | `ollama/glm-5.3-flash` | high | **true** |

All five set `prompt_mode: replace`, `inherit_context: false`, and `load_skills: false`. The model
pins are deliberate: reviewers must not be silently re-routed by quota-aware fallback.

## Two semantics that matter

- **`prompt_mode: replace` is a full replacement.** Pi Web's composer sets `exactSystemPrompt`, and
  the profile body becomes the provider's entire system prompt. Pi's default preamble, the
  cwd/environment section, the tool text instructions, rules/docs, and the structured sections
  never reach the provider. What remains is the profile body, the provider's tool declarations,
  and the delegated task. **Any rule these agents must obey has to live in the profile body**, or
  be read by the child explicitly.
- **`inherit_context: false` means no parent conversation.** The child receives the delegated task
  and its own tool surface. It does not receive the parent session's conversation, the
  implementer's reasoning, or unrelated history.

## Project instructions are not auto-loaded

Pi Web creates a subagent child with `noContextFiles: true`, so `AGENTS.md` and `CLAUDE.md` are
**not** injected — neither from the repository nor from the operator directory. Each profile
therefore instructs the child to read the applicable instruction files explicitly, in this order:

1. the operator-level `~/.pi/agent/AGENTS.md`, when present;
2. the repository's `AGENTS.md` and `CLAUDE.md`, when present;
3. nested or path-specific instruction files that apply to the paths under review.

## Install

Copy the profiles into the Pi agent directory from **PowerShell** (not Git Bash), matching the rest
of this repository:

```powershell
Get-ChildItem .\agents\*.md |
    Where-Object Name -ne 'README.md' |
    Copy-Item -Destination "$HOME\.pi\agent\agents\" -Force
```

Then `/reload` or restart Pi Web.

Do not copy `README.md` into that directory: Pi Web treats every `*.md` file there as a profile, so
it would register a bogus `README` agent. Edit this repository and re-copy rather than editing the
installed copies.

These are Pi Web **built-in Agent** profiles and require `builtInEnabled: true` in
`~/.pi/agent/agents/settings.json`.

## Validation

```bash
node tests/agent-profiles.test.mjs
```

## Migrating another machine

See [docs/pi-web-agent-migration.md](../docs/pi-web-agent-migration.md).
