// Three dots that pulse in sequence while a turn is in flight. Kept inside
// the flyout's one `role="log"` live region (assistant-flyout.tsx) rather than
// carrying a live-region role of its own. A second live region nested in the
// first risks a double announcement, so the accessible name is a plain
// `sr-only` span the log's existing announcement already reads.
//
// Pure CSS: `animate-bounce` is a stock Tailwind utility. The global
// `prefers-reduced-motion: reduce` kill switch (`packages/ui/src/styles/
// globals.css`) only shortens `animation-duration`, and an infinite animation
// at 0.01ms still cycles and jitters between keyframes, so the dots opt out
// explicitly with `motion-reduce:animate-none` and sit still.
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
          className="size-1.5 animate-bounce rounded-full bg-muted-foreground motion-reduce:animate-none"
          style={{ animationDelay: `${String(i * 0.15)}s` }}
        />
      ))}
    </p>
  );
}
