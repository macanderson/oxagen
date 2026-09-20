// Small pieces every Repositories tab shares: the load state of a record read
// on demand, the class recipes, and state as a dot and a word so it survives
// greyscale (the mockup's rule: gold is identity and never encodes state).
import type { ReactNode } from "react";
import type { RepositoriesFailure } from "./failure";

/** A record being read, refused, or in hand. The refusal is kept as a value so its sentence is formatted at render. */
export type Load<T> =
  | { kind: "loading" }
  | { kind: "failed"; failure: RepositoriesFailure }
  | { kind: "ready"; value: T };

export const sectionTitle = "text-sm font-semibold text-foreground";
export const prose = "text-sm leading-relaxed text-muted-foreground";
export const badge =
  "inline-flex flex-none rounded-sm border border-border px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground";
export const codeBlock =
  "mt-2 max-h-80 overflow-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed text-foreground";

export type Tone = "ok" | "warn" | "bad" | "idle";

const DOT: Record<Tone, string> = {
  ok: "bg-success",
  warn: "bg-warning",
  bad: "bg-destructive",
  idle: "bg-muted-foreground",
};

/** A state as a dot and a word. The hue sits on the dot only. */
export function Dot({
  tone,
  children,
  testId,
}: {
  tone: Tone;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <span
      data-tone={tone}
      data-testid={testId}
      className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-foreground"
    >
      <span aria-hidden="true" className={`size-2 rounded-full ${DOT[tone]}`} />
      {children}
    </span>
  );
}

/** A titled panel of explanation, the mockup's side panels under each table. */
export function Explainer({
  title,
  children,
  testId,
}: {
  title: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section
      data-testid={testId}
      className="rounded-lg border border-border bg-card p-4"
    >
      <h3 className={sectionTitle}>{title}</h3>
      <div className={`mt-2 flex flex-col gap-2 ${prose}`}>{children}</div>
    </section>
  );
}
