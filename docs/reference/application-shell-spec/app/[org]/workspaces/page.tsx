import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowRight, Plus } from "lucide-react"
import { getOrg } from "@/lib/mock-data"
import { PageHeader } from "@/components/shell/page-header"
import { Button } from "@/components/ui/button"

export default async function WorkspacesPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params
  const orgData = getOrg(org)
  if (!orgData) notFound()

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Workspaces"
        description={`Pick a workspace in ${orgData.name} to enter workspace mode.`}
        crumbs={[
          { label: orgData.name, href: `/${org}` },
          { label: "Workspaces", href: `/${org}/workspaces` },
        ]}
        askEntity={`Workspaces in ${orgData.name}`}
        actions={
          <Button size="sm" className="gap-1.5">
            <Plus className="size-4" aria-hidden="true" />
            New workspace
          </Button>
        }
      />
      <div className="grid gap-4 p-4 sm:grid-cols-2 sm:p-6 lg:grid-cols-3">
        {orgData.workspaces.map((ws) => (
          <Link
            key={ws.slug}
            href={`/${org}/${ws.slug}`}
            className="group flex flex-col rounded-lg border border-border bg-card p-4 transition-colors hover:border-brand/50 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <div className="flex items-center justify-between">
              <span className="grid size-9 place-items-center rounded-md bg-brand/10 text-sm font-semibold text-brand">
                {ws.name.charAt(0)}
              </span>
              <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </div>
            <h2 className="mt-3 text-sm font-semibold">{ws.name}</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">{ws.description}</p>
          </Link>
        ))}
      </div>
    </div>
  )
}
