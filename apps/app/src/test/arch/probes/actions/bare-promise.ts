"use server";
import { requireViewer } from "@/server/viewer";

export async function touch(form: FormData): Promise<void> {
  await requireViewer(String(form.get("org_slug")));
}
