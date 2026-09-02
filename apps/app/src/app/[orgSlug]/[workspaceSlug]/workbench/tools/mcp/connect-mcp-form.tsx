"use client";
/**
 * connect-mcp-form.tsx — "Connect a custom MCP server" form.
 *
 * Installs an arbitrary MCP endpoint into the workspace via
 * plugin.org.install (mcp_server, custom endpoint) — see mcp-actions.ts.
 */
import * as React from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { RadioGroup, Radio } from "@/components/ui/radio-group";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { Plug } from "lucide-react";
import { AuthenticateDialog } from "./authenticate-dialog";
import { SecretDialog } from "./secret-dialog";

type TransportValue = "streamable-http" | "sse" | "stdio";
type AuthKindValue = "oauth" | "secret" | "none";

const TRANSPORTS: Array<{ value: TransportValue; label: string }> = [
  { value: "streamable-http", label: "Streamable HTTP" },
  { value: "sse", label: "SSE" },
  { value: "stdio", label: "stdio" },
];

const AUTH_KINDS: Array<{
  value: AuthKindValue;
  label: string;
  description: string;
}> = [
  {
    value: "none",
    label: "No authentication",
    description: "Public endpoint, no credentials required.",
  },
  {
    value: "secret",
    label: "Secret / API key",
    description:
      "A static bearer token or API key you'll enter after connecting.",
  },
  {
    value: "oauth",
    label: "OAuth",
    description: "The server authenticates via an OAuth flow.",
  },
];

interface ConnectMcpFormProps {
  orgSlug: string;
  workspaceSlug: string;
  connectAction: (input: {
    orgSlug: string;
    workspaceSlug: string;
    name: string;
    endpointUrl: string;
    transport: TransportValue;
    authKind: AuthKindValue;
  }) => Promise<{
    ok: boolean;
    orgListingId?: string;
    authKind?: AuthKindValue;
    error?: string;
  }>;
  /** Stores an API key for a secret-auth server (post-install prompt). */
  saveSecretAction: (input: {
    orgSlug: string;
    workspaceSlug: string;
    orgListingId: string;
    secret: string;
  }) => Promise<{ ok: boolean; error?: string }>;
}

export function ConnectMcpForm({
  orgSlug,
  workspaceSlug,
  connectAction,
  saveSecretAction,
}: ConnectMcpFormProps) {
  const toast = useToast();
  const router = useRouter();
  const [name, setName] = React.useState("");
  const [endpointUrl, setEndpointUrl] = React.useState("");
  const [transport, setTransport] =
    React.useState<TransportValue>("streamable-http");
  const [authKind, setAuthKind] = React.useState<AuthKindValue>("none");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [authPrompt, setAuthPrompt] = React.useState<{
    orgListingId: string;
    serverTitle: string;
  } | null>(null);
  const [secretPrompt, setSecretPrompt] = React.useState<{
    orgListingId: string;
    serverTitle: string;
  } | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !endpointUrl.trim()) {
      setError("Server name and endpoint URL are required.");
      return;
    }
    setPending(true);
    setError(null);
    const result = await connectAction({
      orgSlug,
      workspaceSlug,
      name: name.trim(),
      endpointUrl: endpointUrl.trim(),
      transport,
      authKind,
    });
    setPending(false);
    if (!result.ok) {
      setError(result.error ?? "Connect failed");
      toast.add({
        title: "Connect failed",
        description: result.error ?? "Could not connect the MCP server.",
        type: "error",
      });
      return;
    }
    // The install probe may have upgraded the effective auth kind (a server
    // the user marked "none" that is actually OAuth-protected).
    const effectiveAuthKind = result.authKind ?? authKind;
    const serverTitle = name.trim();
    toast.add({
      title: `${serverTitle} installed`,
      description:
        effectiveAuthKind === "oauth"
          ? "One more step: authenticate to activate it."
          : effectiveAuthKind === "secret"
            ? "One more step: add its API key to activate it."
            : "The MCP server is now installed for this workspace.",
      type: "success",
    });
    if (effectiveAuthKind === "oauth" && result.orgListingId) {
      setAuthPrompt({ orgListingId: result.orgListingId, serverTitle });
    } else if (effectiveAuthKind === "secret" && result.orgListingId) {
      setSecretPrompt({ orgListingId: result.orgListingId, serverTitle });
    }
    setName("");
    setEndpointUrl("");
    setTransport("streamable-http");
    setAuthKind("none");
    router.refresh();
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-4"
      data-testid="connect-mcp-form"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="mcp-server-name" className="text-xs">
            Server name
          </Label>
          <Input
            id="mcp-server-name"
            type="text"
            placeholder="My MCP Server"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={pending}
            data-testid="mcp-server-name-input"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="mcp-server-endpoint" className="text-xs">
            Endpoint URL
          </Label>
          <Input
            id="mcp-server-endpoint"
            type="url"
            placeholder="https://example.com/mcp"
            value={endpointUrl}
            onChange={(e) => setEndpointUrl(e.target.value)}
            disabled={pending}
            data-testid="mcp-server-endpoint-input"
          />
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor="mcp-server-transport" className="text-xs">
          Transport
        </Label>
        <Select
          value={transport}
          onValueChange={(v) => setTransport(v as TransportValue)}
        >
          <SelectTrigger
            id="mcp-server-transport"
            size="sm"
            className="w-full sm:w-64"
            disabled={pending}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {TRANSPORTS.map((t) => (
              <SelectItem key={t.value} value={t.value}>
                {t.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>

      <div className="flex flex-col gap-2">
        <Label className="text-xs">Authentication</Label>
        <RadioGroup
          value={authKind}
          onValueChange={(v) => {
            if (typeof v === "string") setAuthKind(v as AuthKindValue);
          }}
          className="gap-2"
        >
          {AUTH_KINDS.map((k) => (
            <label
              key={k.value}
              className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm transition-colors ${
                authKind === k.value
                  ? "border-primary bg-primary/5"
                  : "border-border/60 hover:border-border hover:bg-muted/30"
              }`}
            >
              <Radio value={k.value} disabled={pending} className="mt-0.5" />
              <span>
                <span className="font-medium text-foreground">{k.label}</span>
                <span className="block text-xs text-muted-foreground">
                  {k.description}
                </span>
              </span>
            </label>
          ))}
        </RadioGroup>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      <div>
        <Button
          type="submit"
          disabled={pending}
          data-testid="connect-mcp-submit-btn"
        >
          <Plug className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          {pending ? "Connecting…" : "Connect server"}
        </Button>
      </div>

      {authPrompt ? (
        <AuthenticateDialog
          open
          onOpenChange={(open) => {
            if (!open) setAuthPrompt(null);
          }}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          orgListingId={authPrompt.orgListingId}
          serverTitle={authPrompt.serverTitle}
          returnTo={`/${orgSlug}/${workspaceSlug}/workbench/tools/mcp`}
        />
      ) : null}

      {secretPrompt ? (
        <SecretDialog
          open
          onOpenChange={(open) => {
            if (!open) setSecretPrompt(null);
          }}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          orgListingId={secretPrompt.orgListingId}
          serverTitle={secretPrompt.serverTitle}
          saveAction={saveSecretAction}
          onSaved={() => {
            setSecretPrompt(null);
            router.refresh();
          }}
        />
      ) : null}
    </form>
  );
}
