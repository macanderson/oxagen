// The stella spinner while a turn is in flight. Kept inside the flyout's one
// `role="log"` live region (assistant-flyout.tsx) rather than carrying a
// live-region role of its own. A second live region nested in the first risks
// a double announcement, so the accessible name is a plain `sr-only` span the
// log's existing announcement already reads, and the spinner itself is hidden.
//
// It replaced three bouncing dots. The spinner is the kit's
// (`oxagen-brand/spinners/stella-spinner.svg`), drawn by `StellaSpinner`, and
// its motion stops under reduced motion (`app/globals.css`).
import { StellaSpinner } from "@/ui/stella-mark";

export function AssistantThinking({ label }: { label: string }) {
  return (
    <p data-testid="assistant-thinking" className="mt-3 flex items-center">
      <span className="sr-only">{label}</span>
      <StellaSpinner
        className="size-6"
        data-testid="assistant-thinking-spinner"
      />
    </p>
  );
}
