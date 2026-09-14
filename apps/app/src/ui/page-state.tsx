// The non-loaded states of a page, driven by a port's `Read<T>` result
// (plan §4.8): pass the failed read, never invent a zero. Each state renders
// with data-testid `page-state-<state>` for the e2e state walk. A read that
// names no code or permission falls back to the page's row in
// src/data/page-states.ts, the one table of §2.1 failures.
import type { ReactNode } from "react";
import type { ReadFailure } from "@/data/not-backed";
import { PAGE_FAILURES, type PageKey } from "@/data/page-states";
import { DeniedState } from "./denied-state";
import { EmptyState } from "./empty-state";
import { ErrorState } from "./error-state";
import { NotRecordedYet } from "./not-recorded-yet";
import { PageSkeleton, type SkeletonLayout } from "./page-skeleton";

export type PageStateProps = { page: PageKey } & (
  | { result: ReadFailure }
  | { empty: true; title?: string; body?: ReactNode; actions?: ReactNode }
  | { loading: true; layout?: SkeletonLayout }
);

export function PageState(props: PageStateProps) {
  if ("loading" in props)
    return <PageSkeleton layout={props.layout ?? "table"} />;
  if ("empty" in props)
    return (
      <EmptyState
        {...(props.title !== undefined ? { title: props.title } : {})}
        body={props.body}
        actions={props.actions}
      />
    );
  const r = props.result;
  const fallback = PAGE_FAILURES[props.page];
  switch (r.reason) {
    case "not_backed":
      return <NotRecordedYet milestone={r.milestone} gap={r.gap} />;
    case "denied":
      return <DeniedState permission={r.permission || fallback.permission} />;
    case "error":
      return (
        <ErrorState
          code={r.code || fallback.error.code}
          status={r.status || fallback.error.status}
        />
      );
  }
}
