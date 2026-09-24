// The Billing skeleton: four tile blocks and a panel of seven rows under the
// shell while the page's reads resolve (pages/billing.md, loading). No figure
// and no zero renders until a read answers. The wrapper is a div, not the
// page's `main#main`: while the page streams in, React can hold this fallback
// and the page in the DOM together, and two `main#main` landmarks break the
// page-load spec's strict locator and the one-main rule.
import { BillingSkeleton } from "@/features/billing";

export default function BillingLoading() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-10">
      <BillingSkeleton />
    </div>
  );
}
