import { permanentRedirect } from "next/navigation";

export function go(): never {
  permanentRedirect("/anywhere");
}
