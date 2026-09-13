import { notBacked } from "@/data/not-backed";
import { PageState } from "@/ui/page-state";
import { PlaceholderPage } from "@/ui/placeholder-page";

// Batch 0 skeleton; its Batch 2 page lane replaces it.
export default function AuditPage() {
  return (
    <PlaceholderPage route="audit">
      <PageState page="audit" result={notBacked("M5", "G8")} />
    </PlaceholderPage>
  );
}
