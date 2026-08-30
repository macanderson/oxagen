/**
 * card-grid.tsx — responsive grid wrapper for entity-card lists.
 *
 * Server-safe (no `"use client"`, no hooks) — pure layout, so it can wrap
 * cards rendered inside a Server Component. 1 column on mobile, 2 at `sm`,
 * 3 at `xl`. Pass `className` to override the column count or gap; a
 * caller-supplied `grid-cols-*`/`gap-*` wins over the default via `cn`'s
 * Tailwind-merge behavior.
 *
 *   <CardGrid>
 *     {controls.pageRows.map((agent) => <AgentCard key={agent.id} agent={agent} />)}
 *   </CardGrid>
 */

import * as React from "react";
import { cn } from "@/lib/utils";

export interface CardGridProps extends React.HTMLAttributes<HTMLDivElement> {
  children?: React.ReactNode;
}

export function CardGrid({ className, children, ...props }: CardGridProps) {
  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
