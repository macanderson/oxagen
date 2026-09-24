import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getAuthUser } from "@/features/auth";
import { parseRepositoryView, Repositories } from "@/features/repositories";
import { requireViewer } from "@/server/viewer";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("repositories") };
}

// Repositories (mockups/pages/repositories.md; MC spec §10.1, §10.2; mockup
// route `repositories[/<tab>]`): the four tabs are path segments on this one
// route, `changes/<id>` is one Context PR, and a segment that names neither is
// a 404 rather than a page that guesses. The page reads on demand through its
// own server actions, which resolve the viewer again (§3.3).
//
// GitHub's install flow returns here with `?settings=repository`; the page
// then reopens the init wizard, whose first step carries the connection.
export default async function RepositoriesPage({
  params,
  searchParams,
}: PageProps<"/[org]/[ws]/repositories/[[...tab]]">) {
  const { org, ws, tab: segments } = await params;
  const view = parseRepositoryView(segments);
  if (view === null) notFound();
  const ctx = await requireViewer(org, ws);
  const user = await getAuthUser();
  const query = await searchParams;
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6"
    >
      <Repositories
        org={org}
        ws={ws}
        orgName={ctx.orgName}
        wsName={ctx.wsName}
        view={view}
        viewer={{
          // getAuthUser gives a missing name as "", so an empty one falls
          // through to the email, as the Agents route reads it.
          name: user === null ? ctx.userId : user.name || user.email,
          email: user?.email ?? "",
          role: `workspace.${ctx.wsRole}`,
        }}
        returning={query.settings === "repository"}
      />
    </main>
  );
}
