import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ migrate: vi.fn(async () => undefined) }));
vi.mock("./migrate", () => ({ migrate: mocks.migrate }));
vi.mock("./client", () => ({
  driver: () => ({ session: () => ({ run: vi.fn(), close: vi.fn() }) }),
}));

import {
  CREATE_ORG_DATABASE_CYPHER,
  createAuraProvisioner,
  createCypherProvisioner,
  createPooledProvisioner,
  OrgGraphProvisionError,
  OrgGraphProvisionerNotConfigured,
  provisionOrgGraph,
  selectOrgGraphProvisioner,
} from "./provision";
import { OrgGraphNameError } from "./org-graph";

const SUBJECT = {
  orgId: "00000000-0000-0000-0000-0000000000a1",
  namespace: "acme",
};

function fakeSystem(
  run: (cypher: string, params: unknown) => Promise<unknown>,
) {
  const close = vi.fn(async () => undefined);
  const runFn = vi.fn(run);
  return { open: () => ({ run: runFn, close }) as never, run: runFn, close };
}

afterEach(() => {
  mocks.migrate.mockClear();
  delete process.env["NEO4J_ORG_PROVISIONER"];
});

describe("pooled provisioner", () => {
  it("creates nothing and places the organisation in the pool", async () => {
    const p = createPooledProvisioner();
    expect(p.kind).toBe("pooled");
    await expect(p.provision(SUBJECT)).resolves.toEqual({ mode: "pooled" });
  });
});

describe("cypher provisioner", () => {
  it("runs the exact idempotent statement against system, with the name as a parameter", async () => {
    const sys = fakeSystem(async () => ({ records: [] }));
    const migrateDatabase = vi.fn(async () => undefined);
    const p = createCypherProvisioner({
      openSystemSession: sys.open,
      migrateDatabase,
    });

    await expect(p.provision(SUBJECT)).resolves.toEqual({
      mode: "database",
      database: "org-acme",
    });
    expect(CREATE_ORG_DATABASE_CYPHER).toBe(
      "CREATE DATABASE $name IF NOT EXISTS WAIT",
    );
    expect(sys.run).toHaveBeenCalledWith(CREATE_ORG_DATABASE_CYPHER, {
      name: "org-acme",
    });
    expect(sys.close).toHaveBeenCalledTimes(1);
    expect(migrateDatabase).toHaveBeenCalledWith("org-acme");
  });

  it("is safe to repeat: the same statement, the same placement", async () => {
    const sys = fakeSystem(async () => ({ records: [] }));
    const p = createCypherProvisioner({
      openSystemSession: sys.open,
      migrateDatabase: async () => undefined,
    });
    const first = await p.provision(SUBJECT);
    const second = await p.provision(SUBJECT);
    expect(second).toEqual(first);
    expect(sys.run.mock.calls[0]).toEqual(sys.run.mock.calls[1]);
  });

  it("sanitises the namespace to Neo4j's name grammar (lowercase)", async () => {
    const sys = fakeSystem(async () => ({ records: [] }));
    const p = createCypherProvisioner({
      openSystemSession: sys.open,
      migrateDatabase: async () => undefined,
    });
    await p.provision({ ...SUBJECT, namespace: "AcMe" });
    expect(sys.run).toHaveBeenCalledWith(CREATE_ORG_DATABASE_CYPHER, {
      name: "org-acme",
    });
  });

  it("refuses an invalid namespace before opening any session", async () => {
    const open = vi.fn();
    const p = createCypherProvisioner({ openSystemSession: open });
    await expect(
      p.provision({ ...SUBJECT, namespace: "x`; DROP DATABASE neo4j" }),
    ).rejects.toThrow(OrgGraphNameError);
    expect(open).not.toHaveBeenCalled();
  });

  it("wraps an engine failure in a typed error and still closes the session", async () => {
    const sys = fakeSystem(async () => {
      throw new Error("Unsupported administration command");
    });
    const migrateDatabase = vi.fn(async () => undefined);
    const p = createCypherProvisioner({
      openSystemSession: sys.open,
      migrateDatabase,
    });
    const err = await p.provision(SUBJECT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrgGraphProvisionError);
    expect((err as OrgGraphProvisionError).code).toBe(
      "org_graph_provision_failed",
    );
    expect((err as OrgGraphProvisionError).database).toBe("org-acme");
    expect((err as OrgGraphProvisionError).orgId).toBe(SUBJECT.orgId);
    expect((err as Error).message).toMatch(
      /Unsupported administration command/,
    );
    expect(sys.close).toHaveBeenCalledTimes(1);
    expect(migrateDatabase).not.toHaveBeenCalled();
  });

  it("wraps a schema failure on the new database", async () => {
    const sys = fakeSystem(async () => ({ records: [] }));
    const p = createCypherProvisioner({
      openSystemSession: sys.open,
      migrateDatabase: async () => {
        throw "constraint failed";
      },
    });
    await expect(p.provision(SUBJECT)).rejects.toThrow(
      /org-acme.*constraint failed/,
    );
  });

  it("defaults the schema step to migrate()", async () => {
    const sys = fakeSystem(async () => ({ records: [] }));
    await createCypherProvisioner({ openSystemSession: sys.open }).provision(
      SUBJECT,
    );
    expect(mocks.migrate).toHaveBeenCalledWith("org-acme");
  });
});

describe("aura provisioner", () => {
  it("refuses with a typed not-configured error", async () => {
    const err = await createAuraProvisioner()
      .provision(SUBJECT)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrgGraphProvisionerNotConfigured);
    expect((err as OrgGraphProvisionerNotConfigured).code).toBe(
      "org_graph_provisioner_not_configured",
    );
    expect((err as OrgGraphProvisionerNotConfigured).provisioner).toBe("aura");
  });
});

describe("selectOrgGraphProvisioner", () => {
  it.each(["free", "trial"])(
    "pools a %s organisation whatever the deployment runs",
    (planType) => {
      expect(
        selectOrgGraphProvisioner({ planType, configured: "cypher" }).kind,
      ).toBe("pooled");
      expect(
        selectOrgGraphProvisioner({ planType, configured: "aura" }).kind,
      ).toBe("pooled");
    },
  );

  it("defaults a paid organisation to pooled when nothing is configured", () => {
    expect(selectOrgGraphProvisioner({ planType: "team" }).kind).toBe("pooled");
  });

  it.each(["pooled", "cypher", "aura"] as const)(
    "honours %s for a paid plan",
    (configured) => {
      expect(
        selectOrgGraphProvisioner({ planType: "enterprise", configured }).kind,
      ).toBe(configured);
    },
  );

  it("refuses an unknown provisioner rather than defaulting", () => {
    expect(() =>
      selectOrgGraphProvisioner({
        planType: "enterprise",
        configured: "auradb",
      }),
    ).toThrow(OrgGraphProvisionerNotConfigured);
  });
});

describe("provisionOrgGraph", () => {
  it("pools a free organisation", async () => {
    process.env["NEO4J_ORG_PROVISIONER"] = "cypher";
    await expect(
      provisionOrgGraph({ ...SUBJECT, planType: "free" }),
    ).resolves.toEqual({
      mode: "pooled",
    });
  });

  it("reads the deployment's provisioner from the environment", async () => {
    process.env["NEO4J_ORG_PROVISIONER"] = "aura";
    await expect(
      provisionOrgGraph({ ...SUBJECT, planType: "enterprise" }),
    ).rejects.toThrow(OrgGraphProvisionerNotConfigured);
  });
});
