// A workspace page that calls notFound() (a run, an agent or a record that
// does not exist) draws the shared not-found state in place of its body; the
// sidebar, the breadcrumbs and the search stay (audit-prompt check 22), and
// the one action goes back to Fleet.
import { PageNotFound } from "@/ui/page-states";

export default function WorkspaceNotFound() {
  return <PageNotFound scope="workspace" />;
}
