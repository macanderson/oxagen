"use client";
// The input schema one belt entry carries (spec §6.6): the JSON Schema the
// model is handed for that tool, its origin, and the digest that identifies
// it.
//
// Disclosure over a native `<details>`, so it is keyboard-complete and open
// before any script runs, and it sits in a row of its own beneath the tool so
// the JSON gets the table's full width rather than a column of it.
//
// The digest is the copyable identifier: a belt over the inline size cap
// carries the digest alone, and that is the value a person takes to the tool
// registry to read the schema in full. Nothing here invents a schema for a
// tool that records none.
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { Toolbelt } from "@/data/contracts/agents";
import { buttonSecondary, mono } from "@/ui/control-styles";

type BeltTool = Toolbelt["tools"][number];

/** Never throws: a refused or absent clipboard is reported, not swallowed. */
async function writeClipboard(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

function CopyButton({ label, value }: { label: string; value: string }) {
  const t = useTranslations("agents.detail.toolbelt.tools.schema");
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        data-testid="belt-schema-copy"
        data-state={state}
        className={`${buttonSecondary} text-xs`}
        onClick={() => {
          void writeClipboard(value).then((ok) => {
            setState(ok ? "copied" : "failed");
          });
        }}
      >
        {state === "copied" ? t("copied") : label}
      </button>
      <span role="status" className="text-xs text-muted-foreground">
        {state === "failed" ? t("copyFailed") : null}
      </span>
    </span>
  );
}

export function ToolSchema({ tool }: { tool: BeltTool }) {
  const t = useTranslations("agents.detail.toolbelt.tools.schema");
  // A digest is recorded for every schema the belt resolved, truncated or
  // not, so its absence is the one honest "nothing recorded" signal.
  if (tool.schemaDigest === null || tool.schemaOrigin === null) {
    return (
      <p
        data-testid="belt-schema-none"
        className="text-xs text-muted-foreground"
      >
        {t("none")}
      </p>
    );
  }
  return (
    <details data-testid="belt-schema" className="min-w-0">
      <summary className="cursor-pointer rounded-sm text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        {t("title")}
        <span className={`${mono} ml-2 text-muted-foreground`}>
          {tool.schemaDigest.slice(0, 12)}
        </span>
      </summary>
      <div className="mt-2 flex flex-col gap-2">
        <p className="text-xs text-muted-foreground">
          {t(`origin.${tool.schemaOrigin}`)}
        </p>
        <dl className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
          <dt className="text-muted-foreground">{t("digest")}</dt>
          <dd className={`${mono} min-w-0 break-all`}>{tool.schemaDigest}</dd>
        </dl>
        <div className="flex flex-wrap items-center gap-2">
          <CopyButton label={t("copyDigest")} value={tool.schemaDigest} />
          {tool.inputSchema === null ? null : (
            <CopyButton
              label={t("copySchema")}
              value={JSON.stringify(tool.inputSchema, null, 2)}
            />
          )}
        </div>
        {tool.inputSchema === null ? (
          <p data-testid="belt-schema-truncated" className="text-xs">
            {t(tool.schemaTruncated ? "truncated" : "none")}
          </p>
        ) : (
          <pre
            data-testid="belt-schema-json"
            className={`${mono} max-h-80 overflow-auto rounded-md border border-border bg-muted p-3 text-xs`}
          >
            {JSON.stringify(tool.inputSchema, null, 2)}
          </pre>
        )}
      </div>
    </details>
  );
}
