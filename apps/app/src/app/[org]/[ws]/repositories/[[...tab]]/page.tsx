import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { dataSource } from "@/data/source";
import { getAuthUser } from "@/features/auth";
import {
  InstructionFindings,
  parseRepositoryView,
  Repositories,
} from "@/features/repositories";
import { SteeringRepoSection } from "@/features/steering-repo";
import { requireViewer } from "@/server/viewer";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("repositories") };
}

// Repositories (mockups/pages/repositories.md; MC spec §10.1, §10.2; mockup
// route `repositories[/<tab>]`): the four tabs are path segments on this one
// route, `changes/<id>` is one steering PR, and a segment that names neither is
// a 404 rather than a page that guesses. The page reads on demand through its
// own server actions, which resolve the viewer again (§3.3).
//
// GitHub's install flow returns here with `?settings=repository`; the page
// then reopens the init wizard, whose first step carries the connection.
//
// The workspace's steering repo (#4518) sits under the page header, above the
// tabs. It reads at render through the DataSource (`get_steering_repo`), and
// streams in its own <Suspense>, so a slow read never holds the tabs. Until
// the repo is ready it is one line that opens the setup dialog, which
// `?setup=steering` opens on arrival (#4875).
// Instruction files that drifted in the code repositories sit below them, in
// their own <Suspense> for the same reason.
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
  const t = await getTranslations("repositories.steeringRepo");
  return (
    <>
      <Repositories
        steering={
          <Suspense
            fallback={
              <p role="status" className="text-sm text-muted-foreground">
                {t("loading")}
              </p>
            }
          >
            <SteeringRepoSection
              ctx={ctx}
              source={dataSource()}
              setupOpen={query.setup === "steering"}
            />
          </Suspense>
        }
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
      <Suspense fallback={null}>
        <InstructionFindings ctx={ctx} />
      </Suspense>
    </>
  );
}
