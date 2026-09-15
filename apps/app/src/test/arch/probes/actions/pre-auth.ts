"use server";

export async function requestPasswordReset(input: {
  email: string;
}): Promise<{ ok: boolean }> {
  return { ok: input.email.length > 0 };
}
