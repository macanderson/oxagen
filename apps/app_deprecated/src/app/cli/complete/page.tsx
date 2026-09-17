import type { Metadata } from "next";
import { OxagenWordmark } from "@/components/ui/brand";

/**
 * /cli/complete — where the browser lands once `oxagen login` holds its token.
 *
 * The CLI's loopback listener 302s here after the token exchange succeeds
 * (apps/cli/src/auth/loopback-login.ts). It used to serve this card itself
 * from 127.0.0.1, which left the user on a localhost address at the end of a
 * production sign-in — the address bar read as a misdirected redirect. A page
 * on the app origin is the honest ending. It needs no session (proxy.ts lists
 * it as public): the token is already in the terminal, and the browser that
 * finished the flow may not be the one holding the app cookie.
 */
export const metadata: Metadata = {
  title: "Login complete",
};

export default function CliLoginCompletePage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md rounded-xl border bg-card p-8 shadow-md space-y-6">
        <div className="flex justify-center">
          <OxagenWordmark className="h-8" />
        </div>
        <div className="space-y-2 text-center">
          <h1 className="text-xl font-semibold tracking-tight">
            Login complete
          </h1>
          <p className="text-sm text-muted-foreground">
            The Oxagen CLI has its token. You can close this tab and return to
            your terminal.
          </p>
        </div>
      </div>
    </div>
  );
}
