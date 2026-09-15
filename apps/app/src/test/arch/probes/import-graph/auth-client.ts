export async function client() {
  const { authClient } = await import("@oxagen/auth/client");
  return authClient;
}
