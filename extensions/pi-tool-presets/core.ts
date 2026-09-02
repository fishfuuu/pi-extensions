/**
 * Pure helper functions for pi-tool-presets
 * 
 * Tool preset management logic extracted for testing without Pi runtime dependencies.
 */

/**
 * Known specialist tools that are deactivated in core preset.
 * Unknown tools are always preserved.
 */
export const MANAGED_SPECIALIST_TOOLS = [
  "symbol_search",
  "project_report",
  "module_report",
  "read_symbol",
  "read_enclosing",
  "pi_lens_activate_tools",
  "lens_diagnostics",
  "lsp_diagnostics",
  "lens_diagnostic_mark",
  "web_search",
  "source_check",
  "fetch_content",
  "get_search_content",
  "mcp",
  "mcpScript",
  "db_query",
  "subagent",
  "subagent_supervisor",
  "workflow",
  "workflow_control",
  "bg_wait",
];

/**
 * Core preset: base editing + todo + symbol_search + pi_tool_presets itself.
 * All other managed specialist tools are deactivated.
 */
export const CORE_TOOLS = new Set(["read", "bash", "powershell", "edit", "write", "todo", "symbol_search", "pi_tool_presets"]);

/**
 * Essential core tools that are always added even if not present in input.
 * These are the minimum required for core preset functionality.
 */
const ESSENTIAL_CORE_TOOLS = ["pi_tool_presets", "symbol_search", "todo"];

/**
 * Capability groups that can be added to core preset.
 */
export const CAPABILITY_GROUPS: Record<string, string[]> = {
  code: ["project_report", "module_report", "read_symbol", "read_enclosing", "lens_diagnostics", "lsp_diagnostics"],
  ast: ["pi_lens_activate_tools", "lens_diagnostic_mark"],
  research: ["web_search", "source_check", "fetch_content", "get_search_content"],
  orchestration: ["subagent", "subagent_supervisor", "workflow", "workflow_control", "bg_wait"],
  mcp: ["mcp", "mcpScript"],
  database: ["db_query"],
};

/**
 * Apply core preset to a list of available tools.
 * Keeps tools that are in CORE_TOOLS or unknown (not managed).
 * Always adds essential core tools (pi_tool_presets, symbol_search, todo).
 * 
 * @param availableTools - Current list of tool names
 * @returns New list with core tools + unknown tools
 */
export function applyCorePreset(availableTools: string[]): string[] {
  const managedSet = new Set(MANAGED_SPECIALIST_TOOLS);
  const result = new Set(ESSENTIAL_CORE_TOOLS);
  
  // Keep tools that are either in CORE_TOOLS or unknown (not managed)
  for (const tool of availableTools) {
    if (CORE_TOOLS.has(tool) || !managedSet.has(tool)) {
      result.add(tool);
    }
  }
  
  return Array.from(result);
}

/**
 * Add capability group tools to current tool list.
 * 
 * @param currentTools - Current list of tool names
 * @param capability - Capability group name or "all"
 * @param allAvailableTools - For "all" capability, the complete runtime tool list
 * @returns New list with capability tools added (deduplicated)
 */
export function applyCapability(currentTools: string[], capability: string, allAvailableTools?: string[]): string[] {
  if (capability === "all") {
    // "all" restores every tool supplied by the runtime
    return allAvailableTools ?? currentTools;
  }
  
  const group = CAPABILITY_GROUPS[capability];
  if (!group) return currentTools;
  
  const result = new Set(currentTools);
  for (const tool of group) result.add(tool);
  return Array.from(result);
}

/**
 * Get tools for a specific capability group.
 * 
 * @param capability - Capability group name
 * @returns List of tools in the capability group, or empty array if unknown
 */
export function toolsForCapability(capability: string): string[] {
  return CAPABILITY_GROUPS[capability] ?? [];
}

/**
 * Get all managed specialist tools (for "all" preset restoration).
 * 
 * @returns Complete list of managed specialist tools
 */
export function getAllManagedTools(): string[] {
  return [...MANAGED_SPECIALIST_TOOLS];
}

/**
 * Get available capability group names.
 * 
 * @returns List of valid capability names
 */
export function getCapabilityNames(): string[] {
  return Object.keys(CAPABILITY_GROUPS);
}

/**
 * Check if a tool is managed by presets.
 * 
 * @param toolName - Tool name to check
 * @returns True if tool is managed by preset system
 */
export function isManagedTool(toolName: string): boolean {
  return MANAGED_SPECIALIST_TOOLS.includes(toolName);
}
