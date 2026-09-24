// An organization page that calls notFound() draws the shared not-found state
// in place of its body; the shell around it stays (audit-prompt check 22), and
// the one action goes back to the Organization page.
import { PageNotFound } from "@/ui/page-states";

export default function OrganizationNotFound() {
  return <PageNotFound scope="organization" />;
}
