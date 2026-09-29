// Test support for components that show a toast: the root layout mounts the
// app's one toaster (ADR-221), and a toast raised while no toaster is mounted
// is dropped. A test mounts it in its own root before the write, then reads
// the lines from the `toasts` region, which renders in a portal on the body.
import { render } from "@testing-library/react";
import { Toaster } from "@/ui/toast";
import { IntlProvider } from "./intl";

/** Mounts the app's toaster in a root of its own. */
export function renderToaster() {
  return render(
    <IntlProvider>
      <Toaster />
    </IntlProvider>,
  );
}
