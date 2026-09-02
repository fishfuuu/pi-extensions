/**
 * pi-tool-presets — capability-based tool visibility for Pi.
 *
 * Uses the official ExtensionAPI. Core preset is applied on the first
 * before_agent_start of each session, after session_start handlers have run.
 */

import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  applyCapability,
  applyCorePreset,
  getCapabilityNames,
} from "./core.ts";

const LOADER_NAME = "pi_tool_presets";

export default function (pi: ExtensionAPI): void {
  let appliedCoreThisSession = false;
  let ownsLoader = false;
  let runtimeAllNames: string[] = [];

  function allNames(): string[] {
    return pi.getAllTools().map((tool) => tool.name);
  }

  function formatStatus(): string {
    const active = [...pi.getActiveTools()].sort();
    const registered = allNames();
    const deactivated = registered.filter((name) => !active.includes(name)).sort();
    return [
      `preset_applied=${appliedCoreThisSession}`,
      `owns_loader=${ownsLoader}`,
      `active (${active.length}): ${active.join(", ") || "(none)"}`,
      `deactivated (${deactivated.length}): ${deactivated.join(", ") || "(none)"}`,
      `capabilities: ${getCapabilityNames().join(", ")}`,
    ].join("\n");
  }

  function applyPreset(preset: string): { ok: boolean; message: string } {
    const trimmed = preset.trim().toLowerCase();
    if (!trimmed || trimmed === "status") {
      return { ok: true, message: formatStatus() };
    }

    if (trimmed === "core") {
      const next = applyCorePreset(allNames());
      pi.setActiveTools(next);
      return { ok: true, message: `core applied (${pi.getActiveTools().length} active)` };
    }

    if (trimmed === "all") {
      const restore = runtimeAllNames.length > 0 ? runtimeAllNames : allNames();
      pi.setActiveTools(restore);
      return { ok: true, message: `all restored (${pi.getActiveTools().length} active)` };
    }

    const current = pi.getActiveTools();
    const next = applyCapability(current, trimmed, allNames());
    if (next.length === current.length && next.every((name) => current.includes(name))) {
      return {
        ok: false,
        message: `unknown capability '${trimmed}'. use: core | status | all | ${getCapabilityNames().join(" | ")}`,
      };
    }
    pi.setActiveTools(next);
    return { ok: true, message: `${trimmed} added (${pi.getActiveTools().length} active)` };
  }

  function registerLoader(): void {
    pi.registerTool({
      name: LOADER_NAME,
      label: "Tool Presets",
      description:
        "Manage Pi tool visibility. action=status shows the current set; core applies the light default; all restores every registered tool; capability additively loads code, ast, research, orchestration, mcp, or database.",
      parameters: Type.Object({
        action: Type.String({
          description: "core | status | all | capability name (code, ast, research, orchestration, mcp, database)",
        }),
      }),
      async execute(_toolCallId, params) {
        const result = applyPreset(String(params.action ?? "status"));
        return {
          content: [{ type: "text", text: result.message }],
          details: {
            ok: result.ok,
            active: [...pi.getActiveTools()].sort(),
            capabilities: getCapabilityNames(),
          },
        };
      },
    });
    ownsLoader = true;
  }

  pi.on("session_start", () => {
    appliedCoreThisSession = false;
    runtimeAllNames = [];
    ownsLoader = false;

    const existing = allNames();
    if (existing.includes(LOADER_NAME)) {
      console.warn(
        "[pi-tool-presets] pi_tool_presets already registered; preserving the existing tool and keeping /tools-preset",
      );
    } else {
      registerLoader();
    }
  });

  pi.on("before_agent_start", () => {
    if (appliedCoreThisSession) return;
    runtimeAllNames = allNames();
    const next = applyCorePreset(runtimeAllNames);
    pi.setActiveTools(next);
    appliedCoreThisSession = true;
  });

  pi.registerCommand("tools-preset", {
    description: "Manage tool visibility: /tools-preset core | status | all | <capability>",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const result = applyPreset(args || "status");
      ctx.ui.notify(`[pi-tool-presets] ${result.message}`, result.ok ? "info" : "warning");
    },
  });
}
