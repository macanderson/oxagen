/**
 * PageHeader — standardised page-level header.
 *
 * Integration contract:
 *   import { PageHeader } from "@/components/ui/page-header"
 *   <PageHeader
 *     title="Billing"
 *     description="Manage your subscription and invoices."
 *     breadcrumb={<Breadcrumb items={...} />}
 *     actions={<Button>Upgrade</Button>}
 *     onAskAboutThis={() => openAskDrawer()}
 *   />
 *
 * Layout: breadcrumb (optional) above title row.
 * Title row: title + optional description on the left, actions + optional
 * "Ask about this" button on the right.
 */

"use client";

import * as React from "react";
import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

export interface PageHeaderProps {
  title: string;
  description?: string;
  /** Rendered above the title row — typically a <Breadcrumb /> */
  breadcrumb?: React.ReactNode;
  /** Rendered right-aligned beside the optional Ask button */
  actions?: React.ReactNode;
  /** When provided, an "Ask about this" button is shown */
  onAskAboutThis?: () => void;
  className?: string;
}

export function PageHeader({
  title,
  description,
  breadcrumb,
  actions,
  onAskAboutThis,
  className,
}: PageHeaderProps) {
  return (
    <div className={cn("flex flex-col gap-1.5 pb-4", className)}>
      {breadcrumb && <div className="mb-0.5">{breadcrumb}</div>}

      <div className="flex min-h-[2.5rem] flex-wrap items-center justify-between gap-3">
        {/* Left: title + optional description */}
        <div className="flex flex-col gap-0.5 min-w-0">
          <h1 className="text-xl font-semibold leading-tight tracking-tight text-foreground truncate">
            {title}
          </h1>
          {description && (
            <p className="text-sm text-muted-foreground leading-snug">
              {description}
            </p>
          )}
        </div>

        {/* Right: actions + ask button */}
        {(actions || onAskAboutThis) && (
          <div className="flex shrink-0 items-center gap-2">
            {actions}
            {onAskAboutThis && (
              <button
                type="button"
                onClick={onAskAboutThis}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-xl border border-border",
                  "bg-background px-3 py-1.5 text-xs font-medium text-muted-foreground",
                  "transition-colors hover:bg-accent hover:text-accent-foreground",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                )}
                aria-label="Ask about this page"
              >
                <Sparkles className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                Ask about this
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
