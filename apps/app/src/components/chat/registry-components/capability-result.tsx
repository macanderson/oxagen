"use client";
import * as React from "react";
import { ExternalLink, ArrowUpRight, Check, Minus } from "lucide-react";
import { cn, truncate } from "@/lib/utils";
import { safeHref } from "@/lib/safe-url";
import { TruncatedText } from "@/components/ui/truncated-text";

/**
 * capability-result — the GENERIC chat renderer for any capability output that
 * has no bespoke component. It turns a validated output object into a typed
 * key/value card, never raw JSON, and deep-links record ids to their detail
 * pages using the pre-resolved `links` envelope from
 * @oxagen/oxagen/capability-meta (resolveRenderDirective).
 *
 * componentId: "capability-result"
 *
 * Props are the uniform render envelope shared by every synthesized component:
 *   { capability, output, links, title?, hideFields?, orgSlug?, workspaceSlug? }
 */

export interface ResultRecordLink {
  field: string;
  recordType: string;
  id: string;
  href: string | null;
  label: string;
}

export interface CapabilityResultProps {
  capability?: string;
  output?: unknown;
  links?: ResultRecordLink[];
  title?: string;
  hideFields?: string[];
  orgSlug?: string;
  workspaceSlug?: string;
}

const MAX_ARRAY_ITEMS = 8;
const MAX_DEPTH = 2;

/** "graph.node.get" → "Graph node get"; "web.search" → "Web search". */
export function humanizeCapability(name: string): string {
  const words = name.replace(/[._]/g, " ").trim();
  if (words.length === 0) return "Result";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "displayName" → "Display name"; "node_id" → "Node id". */
export function humanizeKey(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._]/g, " ")
    .trim();
  if (spaced.length === 0) return key;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** External (new-tab) link for http(s) urls; same-tab for internal app routes. */
function SmartLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}): React.ReactElement {
  // Validate the scheme before rendering: `href` originates from capability
  // output (an opaque, model-influenced string), so a `javascript:`/`data:`
  // value must never reach the DOM. Unsafe → render plain text, not a link.
  const safe = safeHref(href);
  if (!safe) {
    return <span className="font-medium text-foreground">{children}</span>;
  }
  const external = isHttpUrl(safe);
  return (
    <a
      href={safe}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      className={cn(
        "inline-flex items-center gap-0.5 font-medium text-primary underline-offset-2",
        "hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      {children}
      <ArrowUpRight className="size-3 shrink-0 opacity-70" aria-hidden="true" />
    </a>
  );
}

function ScalarValue({ value }: { value: unknown }): React.ReactElement {
  if (value === null || value === undefined) {
    return (
      <Minus className="size-3.5 text-muted-foreground" aria-label="empty" />
    );
  }
  if (typeof value === "boolean") {
    return value ? (
      <span className="inline-flex items-center gap-1 text-success">
        <Check className="size-3.5" aria-hidden="true" /> Yes
      </span>
    ) : (
      <span className="text-muted-foreground">No</span>
    );
  }
  if (typeof value === "number") {
    return <span className="tabular-nums">{value.toLocaleString()}</span>;
  }
  const str = String(value);
  if (isHttpUrl(str)) {
    return (
      <a
        href={str}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-0.5 break-all text-primary hover:underline"
      >
        {truncate(str, 80)}
        <ExternalLink
          className="size-3 shrink-0 opacity-70"
          aria-hidden="true"
        />
      </a>
    );
  }
  // Genuine free text (not a url) — clamp to a few lines with a click-to-reveal
  // popover for the full, formatted content instead of a hard character cut.
  return <TruncatedText text={str} lines={3} />;
}

function ValueView({
  value,
  fieldPath,
  linkByField,
  depth,
}: {
  value: unknown;
  fieldPath: string;
  linkByField: Map<string, ResultRecordLink>;
  depth: number;
}): React.ReactElement {
  // A pre-resolved record link for this exact field wins — render as a deep link.
  const link = linkByField.get(fieldPath);
  if (link && link.href && typeof value === "string") {
    return <SmartLink href={link.href}>{link.label || value}</SmartLink>;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span className="text-xs text-muted-foreground">(none)</span>;
    }
    const shown = value.slice(0, MAX_ARRAY_ITEMS);
    const allScalar = shown.every(
      (v) => !isPlainRecord(v) && !Array.isArray(v),
    );
    if (allScalar) {
      return (
        <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
          {shown.map((v, i) => (
            <span key={i} className="text-xs text-foreground">
              {truncate(String(v), 60)}
              {i < shown.length - 1 ? (
                <span className="text-muted-foreground">,</span>
              ) : null}
            </span>
          ))}
          {value.length > MAX_ARRAY_ITEMS ? (
            <span className="text-xs text-muted-foreground">
              +{value.length - MAX_ARRAY_ITEMS} more
            </span>
          ) : null}
        </div>
      );
    }
    return (
      <div className="space-y-1.5">
        {shown.map((v, i) => (
          <div
            key={i}
            className="rounded-lg border border-border/60 bg-muted/30 px-2.5 py-1.5"
          >
            <ValueView
              value={v}
              fieldPath={`${fieldPath}[]`}
              linkByField={linkByField}
              depth={depth + 1}
            />
          </div>
        ))}
        {value.length > MAX_ARRAY_ITEMS ? (
          <p className="text-xs text-muted-foreground">
            +{value.length - MAX_ARRAY_ITEMS} more
          </p>
        ) : null}
      </div>
    );
  }

  if (isPlainRecord(value)) {
    if (depth >= MAX_DEPTH) {
      return (
        <span className="text-xs text-muted-foreground">
          {Object.keys(value).length} field
          {Object.keys(value).length === 1 ? "" : "s"}
        </span>
      );
    }
    return (
      <FieldList
        record={value}
        parentPath={fieldPath}
        linkByField={linkByField}
        depth={depth + 1}
      />
    );
  }

  return <ScalarValue value={value} />;
}

function FieldList({
  record,
  parentPath,
  linkByField,
  depth,
  hideFields,
}: {
  record: Record<string, unknown>;
  parentPath: string;
  linkByField: Map<string, ResultRecordLink>;
  depth: number;
  hideFields?: string[];
}): React.ReactElement {
  const hidden = new Set(["render", "links", ...(hideFields ?? [])]);
  const entries = Object.entries(record).filter(([k]) => !hidden.has(k));
  if (entries.length === 0) {
    return <p className="text-xs text-muted-foreground">No details.</p>;
  }
  return (
    <dl className="grid gap-x-4 gap-y-1.5 sm:grid-cols-[minmax(7rem,auto)_1fr]">
      {entries.map(([key, value]) => {
        const path = parentPath ? `${parentPath}.${key}` : key;
        return (
          <React.Fragment key={path}>
            <dt className="text-xs font-medium text-muted-foreground sm:py-0.5">
              {humanizeKey(key)}
            </dt>
            <dd className="min-w-0 text-sm text-foreground">
              <ValueView
                value={value}
                fieldPath={path}
                linkByField={linkByField}
                depth={depth}
              />
            </dd>
          </React.Fragment>
        );
      })}
    </dl>
  );
}

export default function CapabilityResult(
  props: CapabilityResultProps,
): React.ReactElement {
  const { capability, output, links = [], title, hideFields } = props;

  const linkByField = React.useMemo(() => {
    const m = new Map<string, ResultRecordLink>();
    for (const l of links) m.set(l.field, l);
    return m;
  }, [links]);

  // Deep links that resolved to a real route → prominent "open" chips. Only
  // keep links whose href passes scheme validation (these come from capability
  // output, so a `javascript:`/`data:` value must never become a chip).
  const openLinks = links.flatMap((l) => {
    const href = safeHref(typeof l.href === "string" ? l.href : undefined);
    return href ? [{ ...l, href }] : [];
  });

  const heading =
    title ?? (capability ? humanizeCapability(capability) : "Result");

  return (
    <div
      className="my-2 overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-sm"
      data-component="capability-result"
      data-capability={capability}
    >
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5">
        <span
          className="truncate text-sm font-semibold text-foreground"
          title={heading}
        >
          {heading}
        </span>
        {capability ? (
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
            {capability}
          </span>
        ) : null}
      </div>

      {openLinks.length > 0 ? (
        <div className="flex flex-wrap gap-2 border-b border-border/60 bg-muted/20 px-4 py-2.5">
          {openLinks.map((l) => (
            <a
              key={`${l.field}:${l.id}`}
              href={l.href}
              {...(isHttpUrl(l.href)
                ? { target: "_blank", rel: "noopener noreferrer" }
                : {})}
              className={cn(
                "inline-flex items-center gap-1 rounded-md border border-border bg-card px-2.5 py-1 text-xs font-medium",
                "text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              )}
            >
              {l.label}
              <ArrowUpRight className="size-3 opacity-70" aria-hidden="true" />
            </a>
          ))}
        </div>
      ) : null}

      <div className="px-4 py-3">
        {isPlainRecord(output) ? (
          <FieldList
            record={output}
            parentPath=""
            linkByField={linkByField}
            depth={0}
            hideFields={hideFields}
          />
        ) : output === null || output === undefined ? (
          <p className="text-sm text-muted-foreground">No result.</p>
        ) : (
          <ScalarValue value={output} />
        )}
      </div>
    </div>
  );
}
