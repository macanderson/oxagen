"use client";

/**
 * auth-scheme-picker.tsx — Auth scheme selector for connector install forms.
 *
 * Renders radio buttons for available auth.schemes (oauth2 vs api_key etc.)
 * When a scheme is selected, renders that scheme's fields via FieldRenderer.
 * Shows OAuth scopes for oauth2 flows.
 */

import * as React from "react";
import { RadioGroup, Radio } from "@/components/ui/radio-group";
import { Badge } from "@/components/ui/badge";
import { ShieldCheck } from "lucide-react";
import { FieldRenderer } from "./field-renderer";
import { useConnectorSchema } from "./connector-schema-provider";
import { cn } from "@oxagen/ui";

const AUTH_KIND_LABELS: Record<string, string> = {
  oauth2_authorization_code: "OAuth 2.0",
  oauth2_client_credentials: "OAuth 2.0 (Client Credentials)",
  api_key: "API Key",
  basic: "Basic Auth",
  none: "No authentication",
};

export function AuthSchemePicker() {
  const { schema, selectedAuthSchemeId, selectAuthScheme } =
    useConnectorSchema();

  const schemes = schema?.auth?.schemes;
  if (!schemes || schemes.length === 0) return null;

  // If only one scheme, don't show radio picker — just render its fields
  if (schemes.length === 1) {
    const singleScheme = schemes[0];
    if (!singleScheme) return null;
    return (
      <div className="flex flex-col gap-4">
        <SchemeFields schemeId={singleScheme.id} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-sm font-medium text-foreground mb-2">
          Authentication method
        </p>
        <RadioGroup
          value={selectedAuthSchemeId ?? undefined}
          onValueChange={(v) => {
            if (typeof v === "string") selectAuthScheme(v);
          }}
          className="gap-2"
        >
          {schemes.map((scheme) => (
            <label
              key={scheme.id}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors",
                selectedAuthSchemeId === scheme.id
                  ? "border-primary bg-primary/5"
                  : "border-border/60 hover:border-border hover:bg-muted/30",
              )}
            >
              <Radio value={scheme.id} className="mt-0.5 shrink-0" />
              <div className="flex flex-col gap-0.5 min-w-0">
                <span className="text-sm font-medium text-foreground">
                  {scheme.label ?? AUTH_KIND_LABELS[scheme.kind] ?? scheme.kind}
                </span>
                <span className="text-xs text-muted-foreground">
                  {AUTH_KIND_LABELS[scheme.kind] ?? scheme.kind}
                </span>
              </div>
            </label>
          ))}
        </RadioGroup>
      </div>

      {selectedAuthSchemeId && <SchemeFields schemeId={selectedAuthSchemeId} />}
    </div>
  );
}

interface SchemeFieldsProps {
  schemeId: string;
}

function SchemeFields({ schemeId }: SchemeFieldsProps) {
  const { schema } = useConnectorSchema();
  const scheme = schema?.auth?.schemes.find((s) => s.id === schemeId);
  if (!scheme) return null;

  const isOAuth =
    scheme.kind === "oauth2_authorization_code" ||
    scheme.kind === "oauth2_client_credentials";

  return (
    <div className="flex flex-col gap-4">
      {/* OAuth: show scopes, no form fields (redirect handled elsewhere) */}
      {isOAuth && scheme.scopes && scheme.scopes.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5">
            <ShieldCheck
              className="h-3.5 w-3.5 text-muted-foreground"
              aria-hidden="true"
            />
            <p className="text-xs font-medium text-muted-foreground">
              Permissions requested
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {scheme.scopes.map((scope) => (
              <Badge key={scope} variant="outline" className="text-xs">
                {scope}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {/* API key / basic auth: render fields */}
      {!isOAuth && scheme.fields && scheme.fields.length > 0 && (
        <div className="flex flex-col gap-4">
          {scheme.fields.map((field) => (
            <FieldRenderer key={field.key} field={field} namespace="auth" />
          ))}
        </div>
      )}
    </div>
  );
}

// Re-export for convenience
export { SchemeFields };
