// The Billing skeleton: four tile blocks and a panel of seven rows under the
// shell while the page's reads resolve (pages/billing.md, loading). No figure
// and no zero renders until a read answers. The landmark is busy and carries
// no `id`, because React holds the resolved page hidden beside it.
import { BillingSkeleton } from "@/features/billing";

export default function BillingLoading() {
  return (
    <main
      aria-busy="true"
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-10"
    >
      <BillingSkeleton />
    </main>
  );
}
