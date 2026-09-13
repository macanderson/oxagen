/**
 * panel-unavailable.tsx — the partial state.
 *
 * One read failing must not blank the page or, worse, render zeros. A billing
 * surface that shows "0 actions" because a query timed out is making a claim
 * about the customer's account that nobody verified. This says what could not
 * be read and what the number is NOT.
 */

import { Panel } from "@/components/ui/panel";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";

export interface PanelUnavailableProps {
  /** Panel heading — the same one the loaded state would carry. */
  title: string;
  /** What the panel would have shown, in plain words. */
  what: string;
  /** Optional message from the failed read, for support to quote. */
  detail?: string;
}

export function PanelUnavailable({
  title,
  what,
  detail,
}: PanelUnavailableProps) {
  return (
    <Panel title={title}>
      <Alert variant="warning">
        <AlertTitle>Couldn&rsquo;t read this right now</AlertTitle>
        <AlertDescription>
          <span className="block">
            {what} could not be loaded. Nothing is shown here rather than a zero
            — a zero would be a claim about your account that this page cannot
            currently verify. Reload to try again; if it persists, the same
            figures are available from the API and the CLI.
          </span>
          {detail ? (
            <span className="mt-2 block font-mono text-xs text-muted-foreground">
              {detail}
            </span>
          ) : null}
        </AlertDescription>
      </Alert>
    </Panel>
  );
}
