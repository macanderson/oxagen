// The pieces every sign-in card is built from (mockups engine.css `.ob-panel`,
// `.ob-err`, `.ob-or`, `.ob-foot`, `.ob-tags`). The page header sits above the
// card; the footer and the tags sit below it.
import { TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

/** `.ob-panel { border-radius:14px; padding:20px 22px; gap:16px }` on the house panel tokens. */
const authPanel =
  "flex min-w-0 flex-col gap-4 rounded-[14px] border border-border bg-card px-[22px] py-5 text-card-foreground";

export function AuthPanel({
  children,
  testId,
}: {
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div data-testid={testId} className={authPanel}>
      {children}
    </div>
  );
}

/**
 * Split a catalog message at its first sentence: the design sets what happened
 * in bold and what to do after it (`obErr('<b>…</b> …')`).
 */
function splitLead(message: string): [string, string] {
  const at = message.search(/[.?]\s/);
  if (at === -1) return [message, ""];
  return [message.slice(0, at + 1), message.slice(at + 2)];
}

/** The inline error at the top of a card: announced, the first sentence in bold. */
export function AuthAlert({
  message,
  testId,
}: {
  message: string;
  testId?: string;
}) {
  const [lead, rest] = splitLead(message);
  return (
    <div
      role="alert"
      data-testid={testId}
      className="flex items-start gap-2 rounded-[9px] border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-[12.5px] leading-[1.45] text-error-ink"
    >
      <TriangleAlert aria-hidden className="mt-px size-3.5 flex-none" />
      <span>
        <b className="font-semibold text-foreground">{lead}</b>
        {rest ? ` ${rest}` : null}
      </span>
    </div>
  );
}

/** The rule between the provider buttons and the form. */
export function AuthOr({ label }: { label: string }) {
  return (
    <div
      aria-hidden
      className="flex items-center gap-3 text-[11.5px] uppercase tracking-[0.1em] text-dim before:h-px before:flex-1 before:bg-border before:content-[''] after:h-px after:flex-1 after:bg-border after:content-['']"
    >
      {label}
    </div>
  );
}

/** A row of plain tags under the footer; they wrap onto more rows on a phone. */
export function AuthTags({
  label,
  tags,
}: {
  label: string;
  tags: readonly string[];
}) {
  return (
    <ul aria-label={label} className="flex flex-wrap justify-center gap-2 pt-1">
      {tags.map((tag) => (
        <li
          key={tag}
          className="rounded-md border border-border bg-muted px-2 py-0.5 text-[11px] font-semibold tracking-[0.02em] text-muted-foreground"
        >
          {tag}
        </li>
      ))}
    </ul>
  );
}

/** `.ob-link`: a button that reads as a link, for an action that stays on the page. */
export const authLinkButton =
  "rounded-sm bg-transparent p-0 font-medium text-link underline-offset-4 hover:text-link-hover hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
