export function go(): Response {
  return Response.redirect("https://evil.example/", 302);
}
