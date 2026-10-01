/**
 * Second Ollama Cloud subscription for Pi.
 *
 * Registers two providers that point at the same Ollama Cloud API
 * (https://ollama.com/v1) as the pi-ollama-cloud plugin, so two Pro
 * subscriptions can be used simultaneously:
 *
 *   provider id     auth.json credential      subscription
 *   "ollama"        "ollama"                  #1
 *   "ollama-copy"   "ollama-copy"             #2
 *
 * The model catalog (baked-in fallback, live refresh, thinking-level maps,
 * context windows, pricing) is reused from the installed pi-ollama-cloud npm
 * package instead of being duplicated here. Requires:
 *   pi install npm:pi-ollama-cloud
 *
 * This extension never sees or handles the API keys itself: pi resolves each
 * provider's credential through its normal auth chain (auth.json entry named
 * after the provider id, then the env var in `apiKey`).
 */
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

const TAG = "[pi-ollama-cloud-copy]";
const PLUGIN_DIR = join(getAgentDir(), "npm", "node_modules", "pi-ollama-cloud");

export default async function (pi: ExtensionAPI) {
  let modelsMod: any;
  let generatedMod: any;
  try {
    [modelsMod, generatedMod] = await Promise.all([
      import(join(PLUGIN_DIR, "models.ts")),
      import(join(PLUGIN_DIR, "models.generated.ts")),
    ]);
  } catch (err) {
    console.error(
      `${TAG} pi-ollama-cloud not found at ${PLUGIN_DIR}; install it with ` +
        `\`pi install npm:pi-ollama-cloud\`. Second Ollama Cloud providers were ` +
        `not registered. (${err instanceof Error ? err.message : String(err)})`,
    );
    return;
  }

  const shared = {
    baseUrl: `${modelsMod.OLLAMA_BASE}/v1`,
    api: "openai-completions" as const,
    models: generatedMod.GENERATED_MODELS,
    refreshModels: modelsMod.refreshOllamaCatalog,
  };

  pi.registerProvider("ollama", {
    name: "Ollama Cloud",
    apiKey: "$OLLAMA_API_KEY",
    ...shared,
  });
  pi.registerProvider("ollama-copy", {
    name: "Ollama Cloud 2",
    apiKey: "$OLLAMA_COPY_API_KEY",
    ...shared,
  });
}
