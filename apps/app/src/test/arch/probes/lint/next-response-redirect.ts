import { NextResponse } from "next/server";

export function go(request: Request): NextResponse {
  return NextResponse.redirect(new URL("/anywhere", request.url));
}
