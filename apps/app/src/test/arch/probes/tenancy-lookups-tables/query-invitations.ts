import { withSystemDb } from "@oxagen/database";

export function invitation(token: string) {
  return withSystemDb((tx) =>
    tx.query.invitations.findFirst({
      where: (i, { eq }) => eq(i.publicId, token),
    }),
  );
}
