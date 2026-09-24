// The Billing skeleton: four tile blocks and a panel of seven rows under the
// shell while the page's reads resolve (pages/billing.md, loading). No figure
// and no zero renders until a read answers.
import { BillingSkeleton } from "@/features/billing";

export default function BillingLoading() {
  return (
    // No id="main", as Fleet's skeleton has none: while the page streams in,
    // Next.js holds the page's own <main id="main"> in the document beside
    // this fallback, and the skip link's target id must stay unique.
    <main
      aria-busy="true"
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-10"
    >
      <BillingSkeleton />
    </main>
  );
}
