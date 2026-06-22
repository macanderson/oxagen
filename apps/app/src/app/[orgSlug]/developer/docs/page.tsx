import {
  BookOpen,
  Code2,
  ExternalLink,
  Layers,
  Sparkles,
  Terminal,
  Zap,
} from "lucide-react";
import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";

// ---------------------------------------------------------------------------
// Static mock — no DB dependency (pure presentational; OXA-XXXX to wire)
// ---------------------------------------------------------------------------

interface ApiEndpointEntry {
  method: "GET" | "POST" | "DELETE" | "PATCH";
  path: string;
  summary: string;
  tags: string[];
}

const API_ENDPOINTS: ApiEndpointEntry[] = [
  { method: "POST", path: "/v1/chat/stream", summary: "Stream a conversational turn", tags: ["Chat"] },
  { method: "GET",  path: "/v1/workspaces",  summary: "List workspaces in the org", tags: ["Workspaces"] },
  { method: "POST", path: "/v1/workspaces",  summary: "Create a new workspace", tags: ["Workspaces"] },
  { method: "GET",  path: "/v1/knowledge/sources", summary: "List knowledge sources", tags: ["Knowledge"] },
  { method: "POST", path: "/v1/knowledge/sources", summary: "Add a knowledge source", tags: ["Knowledge"] },
  { method: "GET",  path: "/v1/automation/agents", summary: "List automation agents", tags: ["Automation"] },
  { method: "POST", path: "/v1/automation/agents", summary: "Create an automation agent", tags: ["Automation"] },
  { method: "GET",  path: "/v1/members",     summary: "List org members", tags: ["Members"] },
  { method: "POST", path: "/v1/members/invite", summary: "Invite a new member", tags: ["Members"] },
  { method: "DELETE", path: "/v1/members/:userId", summary: "Remove a member", tags: ["Members"] },
  { method: "GET",  path: "/v1/tokens",      summary: "List API tokens", tags: ["Tokens"] },
  { method: "POST", path: "/v1/tokens",      summary: "Create an API token", tags: ["Tokens"] },
  { method: "DELETE", path: "/v1/tokens/:tokenId", summary: "Revoke an API token", tags: ["Tokens"] },
];

const METHOD_COLORS: Record<ApiEndpointEntry["method"], string> = {
  GET:    "text-success",
  POST:   "text-info",
  DELETE: "text-error",
  PATCH:  "text-warning",
};

interface DocSection {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  href: string;
}

const SECTIONS: DocSection[] = [
  {
    icon: Terminal,
    title: "Quickstart",
    description: "Stream your first chat response in under 5 minutes.",
    href: "https://docs.oxagen.sh/docs/quickstart",
  },
  {
    icon: Code2,
    title: "REST API reference",
    description: "Full OpenAPI spec for all v1 endpoints, schemas, and error codes.",
    href: "https://docs.oxagen.sh/docs/api",
  },
  {
    icon: Zap,
    title: "MCP server",
    description: "Connect any MCP-compatible agent client to your Oxagen workspace.",
    href: "https://docs.oxagen.sh/docs/mcp",
  },
  {
    icon: Layers,
    title: "SDK & client libraries",
    description: "TypeScript and Python SDKs with type-safe wrappers around the REST API.",
    href: "https://docs.oxagen.sh/docs/sdk",
  },
  {
    icon: Sparkles,
    title: "Agent authoring guide",
    description: "Build, schedule, and observe multi-step agents with Oxagen Automation.",
    href: "https://docs.oxagen.sh/docs/agents",
  },
  {
    icon: BookOpen,
    title: "Webhooks",
    description: "Receive real-time event payloads for completed runs, member changes, and more.",
    href: "https://docs.oxagen.sh/docs/webhooks",
  },
];

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function DeveloperDocsPage() {
  return (
    <div className="flex flex-col gap-6">
      {/* Preview pill */}
      <div className="inline-flex w-fit items-center gap-1.5 rounded-full border border-border/40 bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground">
        <div className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50" />
        Preview · not yet wired to live data
      </div>

      {/* Doc sections grid */}
      <Panel title="Documentation">
        <p className="mb-4 text-sm text-muted-foreground">
          Guides, API reference, and SDK docs for integrating with Oxagen.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
            {SECTIONS.map((section) => {
              const Icon = section.icon;
              return (
                <a
                  key={section.title}
                  href={section.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group flex items-start gap-3 rounded-xl border border-border/60 bg-muted/20 px-4 py-3.5 transition-colors hover:bg-muted/40 hover:border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-background">
                    <Icon className="h-3.5 w-3.5 text-muted-foreground group-hover:text-foreground transition-colors" aria-hidden="true" />
                  </span>
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="flex items-center gap-1 text-sm font-medium text-foreground">
                      {section.title}
                      <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" aria-hidden="true" />
                    </span>
                    <span className="text-xs text-muted-foreground leading-snug">
                      {section.description}
                    </span>
                  </div>
                </a>
              );
            })}
          </div>
      </Panel>

      {/* API quick reference */}
      <Panel title="REST API — v1 endpoints">
        <p className="mb-4 text-sm text-muted-foreground">
          Base URL:{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
            https://api.oxagen.sh
          </code>
        </p>
        <div className="flex flex-col divide-y divide-border/60">
            {API_ENDPOINTS.map((ep, i) => (
              <div
                key={i}
                className="flex flex-col gap-1 py-2.5 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:gap-4"
              >
                <span
                  className={`w-14 shrink-0 font-mono text-xs font-semibold ${METHOD_COLORS[ep.method]}`}
                  aria-label={ep.method}
                >
                  {ep.method}
                </span>
                <span className="flex-1 font-mono text-xs text-foreground">{ep.path}</span>
                <span className="text-xs text-muted-foreground sm:text-right sm:max-w-[14rem] truncate">
                  {ep.summary}
                </span>
                <div className="flex shrink-0 flex-wrap gap-1">
                  {ep.tags.map((t) => (
                    <Badge key={t} variant="outline" className="text-xs">
                      {t}
                    </Badge>
                  ))}
                </div>
              </div>
            ))}
          </div>
      </Panel>
    </div>
  );
}
