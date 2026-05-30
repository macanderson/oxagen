import { NextResponse } from "next/server";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";

// Deep-link target: navigating here from anywhere kicks the checkout
// session creation in api/stripe/checkout and redirects the browser to
// Stripe. Keeping the redirect on the server avoids exposing the secret
// key to the client.
export async function GET(req: Request) {
  const session = await getSession();
  if (!session?.user) redirect("/login");
  const url = new URL(req.url);
  const planSlug = url.searchParams.get("plan");
  const interval = (url.searchParams.get("interval") ?? "month") as "month" | "year";
  const orgSlug = url.pathname.split("/").filter(Boolean)[0] ?? "";
  if (!planSlug) return NextResponse.json({ error: "Missing plan" }, { status: 400 });

  const res = await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/stripe/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orgSlug, planSlug, interval }),
  });
  if (!res.ok) return NextResponse.json({ error: "Stripe checkout failed" }, { status: 502 });
  const { url: checkoutUrl } = (await res.json()) as { url: string };
  return NextResponse.redirect(checkoutUrl, { status: 303 });
}
