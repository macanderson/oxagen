import { schema, withSystemDb } from "@oxagen/database";
import { eq } from "drizzle-orm";

export function user(userId: string) {
  return withSystemDb((tx) =>
    tx.select().from(schema.users).where(eq(schema.users.id, userId)),
  );
}
