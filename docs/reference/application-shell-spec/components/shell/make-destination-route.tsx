import { notFound, redirect } from "next/navigation"
import { getDestination } from "@/lib/destinations"
import { getOrg, getWorkspace } from "@/lib/mock-data"
import { DestinationPage } from "./destination-page"
import type { Crumb } from "./page-header"

type RouteParams = { org: string; ws?: string; tab?: string[] }

export function makeDestinationRoute(id: string) {
  return async function DestinationRoute({
    params,
  }: {
    params: Promise<RouteParams>
  }) {
    const dest = getDestination(id)
    if (!dest) notFound()

    const { org, ws, tab } = await params

    const basePath = dest.scope === "workspace" ? `/${org}/${ws}/${id}` : `/${org}/${id}`

    const activeSlug = tab?.[0]
    if (!activeSlug) {
      redirect(`${basePath}/${dest.tabs[0].slug}`)
    }

    const active = dest.tabs.find((t) => t.slug === activeSlug)
    if (!active) notFound()

    let crumbs: Crumb[]
    if (dest.scope === "workspace" && ws) {
      const wsData = getWorkspace(org, ws)
      crumbs = [
        { label: wsData?.name ?? ws, href: `/${org}/${ws}/ask` },
        { label: dest.label, href: basePath },
      ]
    } else {
      const orgData = getOrg(org)
      crumbs = [
        { label: orgData?.name ?? org, href: `/${org}` },
        { label: dest.label, href: basePath },
      ]
    }

    return (
      <DestinationPage dest={dest} basePath={basePath} activeSlug={activeSlug} crumbs={crumbs} />
    )
  }
}
