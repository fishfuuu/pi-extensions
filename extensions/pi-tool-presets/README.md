# pi-tool-presets

Dynamic tool management for Pi coding agent to reduce default working context.

## Features

- **Core preset**: Minimal editing tools + navigation + planning (`read`, `bash`, `powershell`, `edit`, `write`, `todo`, `symbol_search`, `pi_tool_presets`)
- **Capability groups**: Additive tool sets for specific tasks (see table below)
- **Rollback**: `/tools-preset all` restores every registered runtime tool
- **Unknown tool preservation**: Tools not in the managed set (e.g. `ast_grep_*`, `find`, `grep`, `ls`, third-party extensions) are never deactivated by core

## Installation

**Not included** in `pi install git:github.com/fishfuuu/pi-extensions`. Only install this if you want a reduced default tool set (it hides `workflow` / `subagent` until `/tools-preset all`).

```powershell
.\scripts\install.ps1 pi-tool-presets
```

Then `/reload`.

## Usage

### Core preset (applied automatically on first agent request)

Core is applied on the first `before_agent_start` of each session. To manually reapply:

```
/tools-preset core
```

### Check current status

```
/tools-preset status
```

Reports active tool count, deactivated tool count, and available capability names.

### Add a capability

```
/tools-preset database
```

Adds `db_query` to the current active set. Existing active tools are kept.

### Restore all tools

```
/tools-preset all
```

Reactivates every tool registered in the runtime. Does not claim ownership of unknown tools — it simply passes the full registered list back to `setActiveTools`.

## Capability Groups

Each capability is **additive**: it adds the listed tools to whatever is currently active; it does not replace the current set.

| Capability | Managed tools added |
|------------|---------------------|
| `code` | `project_report`, `module_report`, `read_symbol`, `read_enclosing`, `lens_diagnostics`, `lsp_diagnostics` |
| `ast` | `pi_lens_activate_tools`, `lens_diagnostic_mark` |
| `research` | `web_search`, `source_check`, `fetch_content`, `get_search_content` |
| `orchestration` | `subagent`, `subagent_supervisor`, `workflow`, `workflow_control`, `bg_wait` |
| `mcp` | `mcp`, `mcpScript` |
| `database` | `db_query` |

Note: `ast_grep_search`, `ast_grep_replace`, `ast_grep_outline`, `ast_grep_dump` are **not** in the managed set. They are unknown/preserved tools that remain active regardless of preset.

## Design

- **Additive model**: Capabilities add tools; they do not replace the current set
- **Unknown tool preservation**: Any tool whose name is not in `MANAGED_SPECIALIST_TOOLS` survives every preset switch, including core
- **Session-scoped**: Core is applied once per session on the first agent request; manual commands can adjust at any time
- **Conflict-safe**: If `pi_tool_presets` is already registered at startup, the extension keeps the existing tool and still registers `/tools-preset`

## Database connectivity

The `database` capability exposes `db_query`. Whether a query succeeds depends on the project's `.pi/pi-db.json` authorization and the network environment. `pi-tool-presets` does not affect connection behaviour; DB connectivity is independently environment-dependent.

## Testing

```bash
node extensions/pi-tool-presets/tests/core.test.mjs
```

Expected output: `6/6 pi-tool-presets tests passed`

Runtime integration tests (require Pi runtime):
```bash
node extensions/pi-tool-presets/tests/runtime-initialization.test.mjs
```

## License

MIT
