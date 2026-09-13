import { notBacked } from "@/data/not-backed";
import { PageState } from "@/ui/page-state";
import { PlaceholderPage } from "@/ui/placeholder-page";

// Batch 0 skeleton; its Batch 2 page lane replaces it.
export default function ToolsPage() {
  return (
    <PlaceholderPage route="tools">
      <PageState page="tools" result={notBacked("M2", "G2")} />
    </PlaceholderPage>
  );
}
