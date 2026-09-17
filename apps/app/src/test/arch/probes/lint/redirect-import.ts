import { redirect } from "next/navigation";

export function go(): never {
  redirect("/anywhere");
}
