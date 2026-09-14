# pi-worker-selector

Process-level worker model policy for Pi Dynamic Workflows ≥ 3.11.0.

Registers one `setPreSpawnModelResolver` (same `globalThis` slot as DW). It runs **after** DW resolves `model` / `tier` / phase intent and **before** `createAgentSession`. Parent session model is never changed.

This extension does **not** register an LLM tool. Worker routing is runtime enforcement, not a Parent reminder.

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

Requires `@quintinshaw/pi-dynamic-workflows` ≥ 3.11.0. Then `/reload`.

## Testing

```bash
node extensions/pi-worker-selector/tests/selector.test.mjs
node extensions/pi-worker-selector/tests/resolve.test.mjs
```

## License

MIT
