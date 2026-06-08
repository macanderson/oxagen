import { Command } from "commander";
import { apiRequest, requireAuth , ApiError } from "../lib/api-client.js";

interface Plugin {
  id?: string;
  pluginId?: string;
  name?: string;
  enabled?: boolean;
}

interface PluginsResponse {
  plugins?: Plugin[];
  data?: Plugin[];
}

export const pluginListCommand = new Command("list")
  .description("List installed plugins")
  .option("--org <slug>", "Organization slug")
  .action(async (options: { org?: string }) => {
    requireAuth();
    try {
      const qs = options.org ? `?org=${options.org}` : "";
      const data = await apiRequest<PluginsResponse>(`/plugins${qs}`);
      const plugins = data.plugins ?? data.data ?? [];
      if (plugins.length === 0) {
        console.log("No plugins installed.");
        return;
      }
      console.log("Plugins:");
      for (const p of plugins) {
        const status = p.enabled ? "enabled" : "disabled";
        console.log(`  - ${p.pluginId ?? p.id ?? "unknown"} [${status}]`);
      }
    } catch (err) {
      const _msg = err instanceof ApiError ? err.message : String(err); console.error(`Error: ${_msg}`);
      process.exit(1);
    }
  });
