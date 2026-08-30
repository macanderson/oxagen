import type { Metadata } from "next";
import { SchemaBuilder } from "@/components/knowledge/schema-builder/schema-builder";
import { getSession } from "@/lib/session";
import { resolveOrg, assertOrgMember, getOrgRole } from "@/lib/resolve-org";

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}

export const metadata: Metadata = { title: "Ontology — Knowledge" };

export default async function KnowledgeOntologyPage({ params }: PageProps) {
  const { orgSlug, workspaceSlug } = await params;

  // Schema mutation (creating/editing labels, properties, relationships) is an
  // admin-only action. Resolve the caller's real org role server-side and gate
  // isAdmin on it — owners/admins may edit, everyone else is read-only. This is
  // the same membership-role pattern used by the org settings pages
  // (e.g. settings/general/page.tsx). apps/app does NOT bootstrap kernel IAM,
  // so this call-site gate is what decides edit rights.
  //
  // Authentication itself is NOT decided here: [orgSlug]/layout.tsx already ran
  // getSessionOrRedirect() + assertOrgMember() for this route, so `getSession()`
  // is the softer read (no session ⇒ no role ⇒ read-only) rather than a second
  // redirect.
  const [org, session] = await Promise.all([resolveOrg(orgSlug), getSession()]);
  const viewerUserId = session?.user?.id ?? "";
  if (viewerUserId) {
    await assertOrgMember(org.id, viewerUserId);
  }
  const viewerRole = viewerUserId
    ? await getOrgRole(org.id, viewerUserId)
    : null;
  const isAdmin = ["owner", "admin"].includes(viewerRole ?? "");

  return (
    <div className="px-6 pb-10">
      <SchemaBuilder slugs={{ orgSlug, workspaceSlug }} isAdmin={isAdmin} />
    </div>
  );
}
