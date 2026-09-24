# pi-worker-selector

Process-level worker model policy for Pi Dynamic Workflows ≥ 3.11.0.

Registers one `setPreSpawnModelResolver` (same `globalThis` slot as DW). It runs **after** DW resolves `model` / `tier` / phase intent and **before** `createAgentSession`. Parent session model is never changed.

This extension does **not** register an LLM tool. Worker routing is a process-level runtime policy rather than a Parent reminder, and it governs the spawns for which it is the effective resolver (see [Resolver precedence](#resolver-precedence)).

## Adapters

One frozen selector policy, two adapters:

| Adapter | Applies to |
|---|---|
| DW pre-spawn adapter — `resolve.ts` + `index.ts` | Dynamic Workflows worker spawns, through the process-level `setPreSpawnModelResolver`. |
| pi-subagents adapter — `subagents.ts` | Structured delegations **started explicitly through this adapter**. |

The pi-subagents adapter is an **explicit adapter path only**:

```text
delegation started through subagents.ts → the selector decides the worker model
native subagent(...)                   → untouched; pi-subagents resolves the model itself
```

There is no transparent interception of the native `subagent` tool.

Responsibilities stay split. `pi-worker-selector` decides the worker model, quota
eligibility, same-tier fallback and STOP. `pi-subagents` owns agent discovery, the
prompt/system role, tools/MCP, fresh/fork, the child session, execution, usage and
the resume/steer/stop lifecycle.

Neither adapter modifies the Parent session model.

### Delegation lifecycle constraint

The structured delegation API requires an active extension context. Emitting during
`session_start` can race the host's context capture and be answered with
`unavailable_context`; emitting from `before_agent_start`, or a later supported event
callback, is what a verified canary used to complete a real delegation.

## Resolver precedence

`pi-worker-selector` registers a **process-level** Dynamic Workflows `preSpawnModel` resolver.

DW resolves pre-spawn model policy in this order (highest wins):

1. per-run resolver — `AgentRunOptions.preSpawnModel`
2. `WorkflowAgent` instance resolver — `WorkflowAgentOptions.preSpawnModel`
3. process-level resolver — `setPreSpawnModelResolver`

A workflow or agent instance that supplies a higher-priority resolver **intentionally overrides** `pi-worker-selector` for that run or spawn. `pi-worker-selector` is the default process-wide worker routing policy — **not an unbypassable security boundary**.

The quota, capability, fallback, fail-closed and Parent-invariance contracts documented below apply to a spawn **when the process-level selector is the effective resolver** for it.

## Decisions

| DW `modelSource` | Policy |
|---|---|
| `explicit` | Validate the pinned `provider/id`. Low/ineligible → `reject`. No substitution. |
| `phase` | Same as explicit (phase pinned a model). |
| `tier` | `small`/`medium`/`big`: capability floor + quota fallback. Other names: only if `model-tiers.json` has that key, pin the **file** mapping (quota as explicit, no substitution). Typo or missing key → `reject` (never Parent/`mainModel`). |
| `default` | Implicit medium-tier selection (quota + capability). |
| `session` | Must not inherit Parent. Routed as medium-tier. Always `use` or `reject`, never `unchanged`. |

Quota query failure and stale-healthy snapshots are **UNKNOWN / fail-open**. Stale previously-low stays ineligible. Selector internal errors **reject** (never fall back to Parent).

Quota pool id = Pi `providerId`. `ollama/...` and `ollama2/...` are separate pools. Bare model names are rejected.

## Configuration

Extend `~/.pi/workflows/model-tiers.json` with `workerPool`:

```json
{
  "tiers": {
    "small": "ollama/glm-5.3-flash",
    "medium": "ollama/deepseek-v4.1-flash",
    "big": "xai/grok-4.6"
  },
  "workerPool": [
    { "model": "ollama/glm-5.3-flash", "capability": ["small"], "costTier": "cheap" },
    { "model": "ollama2/glm-5.3-flash", "capability": ["small"], "costTier": "cheap" },
    { "model": "ollama/deepseek-v4.1-flash", "capability": ["medium"], "costTier": "cheap" },
    { "model": "ollama2/deepseek-v4.1-flash", "capability": ["medium"], "costTier": "cheap" },
    { "model": "xai/grok-4.6", "capability": ["big"], "costTier": "cheap" },
    { "model": "ollama/glm-5.3", "capability": ["big"], "costTier": "normal" },
    { "model": "ollama2/glm-5.3", "capability": ["big"], "costTier": "normal" }
  ],
  "quotaPolicy": { "thresholdPct": 10 }
}
```

Tier-bound routing uses **exclusive** `capability` lists. A model listed only as `small` cannot win `medium` or `big`. `ollama` and `ollama2` are separate quota pools. Within a tier, `costTier` then model name picks primary vs same-tier fallback (grok before glm-5.3 on `big`). Parent session model is never a worker fallback.

If `workerPool` is absent, a minimal pool is derived from `tiers`.

## Install

Opt-in (not in the default git package):

```powershell
.\scripts\install.ps1 pi-worker-selector
```

Requires `@quintinshaw/pi-dynamic-workflows` ≥ 3.11.0 **and pi-quota**: the resolver imports pi-quota's snapshot module (`../pi-quota/snapshot.ts`) at runtime, so a selector install without that file fails to load. `install.ps1` handles that dependency: if pi-quota is missing it is installed first; if pi-quota is already installed (and has `snapshot.ts`) it is left untouched — installing or updating pi-worker-selector (even with `-Update`) never updates pi-quota. A pi-quota directory that predates `snapshot.ts` is refused, not auto-updated: the installer exits non-zero and tells you to run `.\scripts\install.ps1 pi-quota -Update`, then reinstall pi-worker-selector. If the queued pi-quota install itself fails, pi-worker-selector is skipped and the installer exits non-zero.

Then `/reload`.

## Testing

```bash
node extensions/pi-worker-selector/tests/selector.test.mjs
node extensions/pi-worker-selector/tests/resolve.test.mjs
node extensions/pi-worker-selector/tests/subagents.test.mjs
```

## License

MIT
