// Three dots that pulse in sequence while a turn is in flight. Kept inside
// the flyout's one `role="log"` live region (assistant-flyout.tsx) rather than
// carrying a live-region role of its own — a second live region nested in the
// first risks a double announcement, so the accessible name is a plain
// `sr-only` span the log's existing announcement already reads.
//
// Pure CSS: `animate-bounce` is a stock Tailwind utility, and the global
// `prefers-reduced-motion: reduce` kill switch (`packages/ui/src/styles/
// globals.css`) already floors every animation's duration, so a reduced-
// motion viewer sees three static dots with no extra handling here.
const DOTS = [0, 1, 2] as const;

export function AssistantThinkingDots({ label }: { label: string }) {
  return (
    <p
      data-testid="assistant-thinking"
      className="mt-3 flex items-center gap-1"
    >
      <span className="sr-only">{label}</span>
      {DOTS.map((i) => (
        <span
          key={i}
          aria-hidden="true"
          className="size-1.5 animate-bounce rounded-full bg-muted-foreground"
          style={{ animationDelay: `${String(i * 0.15)}s` }}
        />
      ))}
    </p>
  );
}
