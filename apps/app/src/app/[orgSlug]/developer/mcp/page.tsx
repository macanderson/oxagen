import { PlugZap, Terminal, Copy, ExternalLink } from "lucide-react";
import { Card, CardPanel, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface McpEntry {
  client: string;
  configKey: string;
  snippet: string;
}

const MCP_ENTRIES: McpEntry[] = [
  {
    client: "Claude Code",
    configKey: "claude_code_config",
    snippet: `claude mcp add oxagen \\
  --transport http \\
  --url https://oxagen-v2-mcp.vercel.app/mcp \\
  --header "Authorization: Bearer $OXAGEN_API_KEY"`,
  },
  {
    client: "Claude Desktop",
    configKey: "claude_desktop_config",
    snippet: `{
  "mcpServers": {
    "oxagen": {
      "command": "npx",
      "args": ["-y", "@oxagen/mcp-client"],
      "env": {
        "OXAGEN_API_KEY": "<your-api-key>"
      }
    }
  }
}`,
  },
  {
    client: "Cursor",
    configKey: "cursor_config",
    snippet: `{
  "mcp": {
    "servers": [
      {
        "name": "oxagen",
        "transport": "http",
        "url": "https://oxagen-v2-mcp.vercel.app/mcp",
        "headers": {
          "Authorization": "Bearer $OXAGEN_API_KEY"
        }
      }
    ]
  }
}`,
  },
];

export default function DeveloperMcpPage() {
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-border/60 bg-muted/60">
              <PlugZap className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            </span>
            <div>
              <CardTitle>MCP server</CardTitle>
              <CardDescription>
                Connect any MCP-compatible agent client to your Oxagen workspace.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardPanel className="flex flex-col gap-6">
          <div className="flex items-start gap-2 rounded-xl border border-border/40 bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
            <ExternalLink className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
              The MCP endpoint is live at{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
                https://oxagen-v2-mcp.vercel.app/mcp
              </code>
              . Generate an API token on the Tokens tab, then follow the
              install instructions for your client below.
            </span>
          </div>

          <div className="flex flex-col gap-4">
            {MCP_ENTRIES.map((entry) => (
              <div key={entry.configKey} className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <Terminal className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <p className="text-sm font-medium text-foreground">{entry.client}</p>
                  <Badge variant="outline" className="ml-auto text-xs">
                    <Copy className="mr-1 h-3 w-3" aria-hidden="true" />
                    Copy
                  </Badge>
                </div>
                <pre
                  aria-label={`${entry.client} configuration snippet`}
                  className="overflow-x-auto rounded-xl border border-border/40 bg-muted/50 px-4 py-3 font-mono text-xs text-foreground"
                >
                  {entry.snippet}
                </pre>
              </div>
            ))}
          </div>
        </CardPanel>
      </Card>
    </div>
  );
}
