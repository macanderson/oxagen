import { redirect } from "next/navigation"
import { defaultOrg, defaultWorkspace } from "@/lib/mock-data"

export default function Home() {
  redirect(`/${defaultOrg.slug}/${defaultWorkspace.slug}/ask`)
}
