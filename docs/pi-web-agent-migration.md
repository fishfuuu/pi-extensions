# Migrating a machine to Pi Web built-in agents

Runbook for retiring `pi-subagents` on another machine and replacing it with Pi Web's built-in
Agent plus the five canonical profiles in [`agents/`](../agents/).

Run the steps in order. **Any failed step stops the migration**: report `STOP_<step>_<reason>` and
do not continue. Do not proceed on an assumption — verify each item against the machine.

## Prohibitions

At every step: do not patch Pi Web or the embedded Pi; do not patch Dynamic Workflows or
`pi-worker-selector`; do not reinstall `pi-subagents` as a silent fallback; do not substitute a
different provider or model for a pinned one; do not hand-edit files under
`~/.pi/agent/extensions/` or `~/.pi/agent/npm/`.

## 1. Recon

Record from the machine itself, not from this document:

- Pi Web version and embedded Pi version;
- whether `pi-subagents` is installed, and its version;
- Dynamic Workflows version and `pi-worker-selector` presence;
- `pi-mcp-adapter` version and the MCP config path it actually reads;
- `builtInEnabled` in `~/.pi/agent/agents/settings.json`;
- the current contents of `~/.pi/agent/agents/`;
- `subagents.agentOverrides` in `~/.pi/agent/settings.json`.

Also record which MCP servers the QA profile is expected to reach.

## 2. Backup

Back up `~/.pi/agent/agents/`, the relevant Pi settings files, the MCP config, and any
`pi-subagents` configuration. Keep the backup until the migration is verified end to end.

## 3. Sync the canonical profiles

Copy the five profiles from this repository into `~/.pi/agent/agents/` using the command in
[`agents/README.md`](../agents/README.md) (PowerShell; it excludes `README.md`).

- Do not silently change a model pin.
- If the machine lacks a provider or model a profile pins, **STOP** — do not fall back to another
  model. Either make the pinned model available or have the owner decide.
- Then `/reload` or restart Pi Web.

## 4. Enable the Pi Web built-in Agent

Set `builtInEnabled: true` in `~/.pi/agent/agents/settings.json`. Keep `pi-subagents` installed for
now — it is the rollback path until step 8. Reload the session so the built-in Agent tools appear.

## 5. Verify the parsed profiles

Read the runtime profile list (for example `GET /api/subagents/profiles`) and confirm **5/5**
profiles parse exactly as the table in [`agents/README.md`](../agents/README.md): `prompt_mode`,
`inherit_context`, `load_skills`, `load_extensions`, `tools`, `model`, and `thinking`.

A profile that parses with an unexpected value is a schema mismatch: **STOP**.

## 6. Pre-uninstall canary

With `pi-subagents` still installed:

- run `independent-reviewer` on a real read-only review and confirm the pinned model, thinking
  level, read-only tools, and that it reports no parent-conversation context;
- run `browser-qa-agent` and confirm it makes a **real** MCP browser call (for example
  `playwright_browser_navigate`) and returns live page evidence.

Both must pass. Tool lists, server counts, and status output are not evidence of a real call.

## 7. Audit and remove dead `pi-subagents` configuration

Remove only what is provably dead: `agentOverrides` entries for agents that no longer exist, legacy
pi-subagents frontmatter left in profiles, and skills or tools with no remaining consumer. Do not
rewrite the settings file wholesale.

## 8. Uninstall `pi-subagents`

Use the official package removal path (`pi remove …`). Do not delete the package directory by hand.
Confirm that Dynamic Workflows, `pi-worker-selector`, and `pi-mcp-adapter` are still installed.

## 9. Full cold start

Stop Pi Web completely and start it the normal way. Do not set
`PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT`, do not apply any host-binding workaround, and do not
reinstall anything.

## 10. Post-uninstall regression

After the cold start, repeat step 6 for both agents, and confirm the managed worker channel still
works (Dynamic Workflows plus `pi-worker-selector`).

## 11. Cleanup

Remove leftover legacy tools, skills, and configuration. Delete the old `mcp.json` only once the
adapter's current config file is canonical and nothing else reads the old path. Remove temporary
canary artifacts and profiles. Correct any stale runtime-ownership wording in the machine's
`AGENTS.md`.

## 12. Final

Report `MIGRATION_COMPLETE`, or `STOP_<step>_<reason>` with the evidence that stopped it.
