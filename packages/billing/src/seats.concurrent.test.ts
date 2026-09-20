import { describe, expect, it, vi } from "vitest";
import { schema, type Tx } from "@oxagen/database";
import { assertSeatAvailable, SeatLimitError } from "./seats";

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withOrgDb: vi.fn(() => {
      throw new Error("Seat reads must use the invitation transaction");
    }),
    withTenantDb: vi.fn(() => {
      throw new Error("Seat reads must use the invitation transaction");
    }),
  };
});

describe("seat reservation transaction", () => {
  it.each([
    { seatCount: 2, members: 1 },
    { seatCount: undefined, members: 0 },
  ])(
    "allows only one concurrent invitation for the final seat: %j",
    async ({ seatCount, members }) => {
      let invitations = 0;
      let tail = Promise.resolve();
      const invite = async () => {
        let release: (() => void) | undefined;
        let locked = false;
        const tx = {
          select: () => ({
            from: (table: unknown) => ({
              where: () => {
                if (table === schema.orgUsers)
                  return Promise.resolve([{ total: members }]);
                if (table === schema.invitations)
                  return Promise.resolve([{ total: invitations }]);
                return {
                  for: async () => {
                    if (table !== schema.organizations) return [];
                    const previous = tail;
                    tail = new Promise<void>((resolve) => {
                      release = resolve;
                    });
                    await previous;
                    locked = true;
                    return [{ id: "org-a" }];
                  },
                  limit: async () =>
                    seatCount === undefined ? [] : [{ seatCount }],
                };
              },
            }),
          }),
        } as unknown as Tx;
        try {
          await assertSeatAvailable("org-a", tx);
          expect(locked).toBe(true);
          invitations += 1;
        } finally {
          release?.();
        }
      };
      const results = await Promise.allSettled([invite(), invite()]);
      expect(invitations).toBe(1);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected");
      expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(
        SeatLimitError,
      );
    },
  );
});
