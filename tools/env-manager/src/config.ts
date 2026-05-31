import type { ServiceName } from "./types.js";
import { SERVICE_NAMES } from "./types.js";

// Defaults discovered from the Vercel team. Override any of these with
// VERCEL_PROJECT_<SERVICE> env vars (e.g. VERCEL_PROJECT_ADMIN=prj_...).
const DEFAULT_PROJECTS: Record<ServiceName, string> = {
  api: "prj_byoXN4BufyWoVoAxsMXiFp5Sr2m4", // oxagen-v2-api
  app: "prj_i68xfa3ZjEtCzNfqWvHfEsgtjZud", // oxagen-v2-app
  website: "prj_wNAmlrwkJxpfeIVcO2LaZAibHJDA", // oxagen-v2-website
  mcp: "prj_0AQJiFXku3YUAi4TnQoR6KCvps2r", // oxagen-v2-mcp
  admin: "prj_8FzVACqAogrA24srokBWKxaDn1JQ", // oxagen-admin (confirm if v2)
  docs: "prj_dhqanD0vewekv46HT5HlbnrfngmO", // oxagen-docs (confirm if v2)
};

const DEFAULT_TEAM_ID = "team_DiMizWNDHKFFU5ajKe2ZVKl9";

// Env values pasted into a dashboard arrive double-quoted; strip one balanced pair.
function deQuote(v: string | undefined): string | undefined {
  if (!v) return v;
  return v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v;
}

export interface Config {
  vercelToken: string;
  teamId: string;
  projects: Record<ServiceName, string>;
  port: number;
}

export function loadConfig(): Config {
  const projects = { ...DEFAULT_PROJECTS };
  for (const svc of SERVICE_NAMES) {
    const override = deQuote(process.env[`VERCEL_PROJECT_${svc.toUpperCase()}`]);
    if (override) projects[svc] = override;
  }
  return {
    vercelToken: deQuote(process.env.VERCEL_TOKEN) ?? "",
    teamId: deQuote(process.env.VERCEL_TEAM_ID) ?? DEFAULT_TEAM_ID,
    projects,
    port: Number(process.env.ENV_MANAGER_PORT ?? 7799),
  };
}
