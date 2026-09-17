import { schema, withSystemDb } from "@oxagen/database";
import { eq } from "drizzle-orm";

export function email(userId: string) {
  return withSystemDb((tx) =>
    tx
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, userId)),
  );
}
