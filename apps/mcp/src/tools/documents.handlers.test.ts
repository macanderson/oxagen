// documents.handlers.test.ts — handler invocation tests for document/media/asset
// tools: archive.create, asset.upload, brandkit.apply, documents.generate,
// documents.pdf.create, image.generate, svg.generate, video.generate, form.fill.
//
// Pattern: vi.mock the kernel `invoke` and context seam `buildContext`.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  buildContext: vi.fn(),
  headers: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../context", () => ({ buildContext: mocks.buildContext }));
vi.mock("xmcp/headers", () => ({ headers: mocks.headers }));

const fakeCtx = {
  orgId: "org_test",
  workspaceId: "ws_test",
  userId: null,
  apiKeyId: "key_test",
  requestId: "req_test",
  surface: "mcp" as const,
  messageId: null,
  clientIp: null,
};

const fakeExtra = {} as Parameters<typeof import("./archive.create")["default"]>[1];

beforeEach(() => {
  vi.resetAllMocks();
  mocks.buildContext.mockResolvedValue(fakeCtx);
  mocks.headers.mockReturnValue({ authorization: "Bearer test_key" });
});

// ── archive.create ────────────────────────────────────────────────────────────

import handler_archiveCreate, {
  schema as archiveCreateSchema,
  metadata as archiveCreateMetadata,
} from "./archive.create";

describe("archive.create handler", () => {
  it("exports schema and metadata", () => {
    expect(archiveCreateSchema).toBeDefined();
    expect(archiveCreateMetadata.name).toBe("archive.create");
  });

  it("calls buildContext then invoke with correct args", async () => {
    const fakeOutput = { assetId: "gen_1", url: "https://blob.example.com/archive.zip" };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = {
      archiveName: "my-archive",
      entries: [{ name: "readme.txt", text: "Hello" }],
    };
    const result = await handler_archiveCreate(args, fakeExtra);

    expect(mocks.buildContext).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith(
      "archive.create",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
    expect(result).toMatchObject({ assetId: "gen_1" });
  });

  it("propagates invoke errors", async () => {
    mocks.invoke.mockRejectedValue(new Error("archive failed"));
    await expect(
      handler_archiveCreate({ archiveName: "x", entries: [{ name: "f.txt", text: "t" }] }, fakeExtra),
    ).rejects.toThrow("archive failed");
  });
});

// ── asset.upload ──────────────────────────────────────────────────────────────

import handler_assetUpload, {
  schema as assetUploadSchema,
  metadata as assetUploadMetadata,
} from "./asset.upload";

describe("asset.upload handler", () => {
  it("exports schema and metadata", () => {
    expect(assetUploadSchema).toBeDefined();
    expect(assetUploadMetadata.name).toBe("asset.upload");
  });

  it("calls invoke with upload args", async () => {
    const fakeOutput = { url: "https://cdn.example.com/img.png", storageKey: "image/org/uuid.png" };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = { sourceUrl: "https://example.com/image.png", kind: "image" as const };
    await handler_assetUpload(args, fakeExtra);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "asset.upload",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });
});

// ── brandkit.apply ────────────────────────────────────────────────────────────

import handler_brandkitApply, {
  schema as brandkitApplySchema,
  metadata as brandkitApplyMetadata,
} from "./brandkit.apply";

describe("brandkit.apply handler", () => {
  it("exports schema and metadata", () => {
    expect(brandkitApplySchema).toBeDefined();
    expect(brandkitApplyMetadata.name).toBe("brandkit.apply");
  });

  it("calls invoke with brandkit args", async () => {
    const fakeOutput = { stub: true, applied: false };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = {
      workspaceId: "ws_test",
      brandKitId: "bk_1",
      targetFileId: "file_1",
    };
    await handler_brandkitApply(args, fakeExtra);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "brandkit.apply",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });
});

// ── documents.generate ────────────────────────────────────────────────────────

import handler_documentsGenerate, {
  schema as documentsGenerateSchema,
  metadata as documentsGenerateMetadata,
} from "./documents.generate";

describe("documents.generate handler", () => {
  it("exports schema and metadata", () => {
    expect(documentsGenerateSchema).toBeDefined();
    expect(documentsGenerateMetadata.name).toBe("documents.generate");
  });

  it("calls invoke with document generation args", async () => {
    const fakeOutput = { stub: true, assetId: null };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = {
      kind: "document" as const,
      title: "My Report",
      content: {
        sections: [{ heading: "Intro", paragraphs: ["Hello world."] }],
      },
    };
    await handler_documentsGenerate(args, fakeExtra);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "documents.generate",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });
});

// ── documents.pdf.create ──────────────────────────────────────────────────────

import handler_documentsPdfCreate, {
  schema as documentsPdfCreateSchema,
  metadata as documentsPdfCreateMetadata,
} from "./documents.pdf.create";

describe("documents.pdf.create handler", () => {
  it("exports schema and metadata", () => {
    expect(documentsPdfCreateSchema).toBeDefined();
    expect(documentsPdfCreateMetadata.name).toBe("documents.pdf.create");
  });

  it("calls invoke with PDF creation args", async () => {
    const fakeOutput = { stub: true, assetId: null };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = {
      title: "My PDF",
      content: {
        sections: [{ heading: "Intro", paragraphs: ["Content here."] }],
      },
    };
    await handler_documentsPdfCreate(args, fakeExtra);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "documents.pdf.create",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });
});

// ── image.generate ────────────────────────────────────────────────────────────

import handler_imageGenerate, {
  schema as imageGenerateSchema,
  metadata as imageGenerateMetadata,
} from "./image.generate";

describe("image.generate handler", () => {
  it("exports schema and metadata", () => {
    expect(imageGenerateSchema).toBeDefined();
    expect(imageGenerateMetadata.name).toBe("image.generate");
  });

  it("calls invoke with image generation args", async () => {
    const fakeOutput = { assetId: "gen_img_1", url: "https://cdn.example.com/img.png", alt: null };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = { prompt: "A red fox in snow", size: "1024x1024" as const };
    const result = await handler_imageGenerate(args, fakeExtra);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "image.generate",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
    expect(result).toMatchObject({ assetId: "gen_img_1" });
  });
});

// ── svg.generate ──────────────────────────────────────────────────────────────

import handler_svgGenerate, {
  schema as svgGenerateSchema,
  metadata as svgGenerateMetadata,
} from "./svg.generate";

describe("svg.generate handler", () => {
  it("exports schema and metadata", () => {
    expect(svgGenerateSchema).toBeDefined();
    expect(svgGenerateMetadata.name).toBe("svg.generate");
  });

  it("calls invoke with svg generation args", async () => {
    const fakeOutput = { assetId: "gen_svg_1", url: "https://cdn.example.com/icon.svg", svg: "<svg/>" };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = { prompt: "A simple house icon", width: 400, height: 400 };
    await handler_svgGenerate(args, fakeExtra);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "svg.generate",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });
});

// ── video.generate ────────────────────────────────────────────────────────────

import handler_videoGenerate, {
  schema as videoGenerateSchema,
  metadata as videoGenerateMetadata,
} from "./video.generate";

describe("video.generate handler", () => {
  it("exports schema and metadata", () => {
    expect(videoGenerateSchema).toBeDefined();
    expect(videoGenerateMetadata.name).toBe("video.generate");
  });

  it("calls invoke with video generation args", async () => {
    const fakeOutput = { taskId: "task_vid_1", status: "pending" };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = { prompt: "A sunset over mountains", durationSeconds: 5 };
    await handler_videoGenerate(args, fakeExtra);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "video.generate",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });
});

// ── form.fill ─────────────────────────────────────────────────────────────────

import handler_formFill, {
  schema as formFillSchema,
  metadata as formFillMetadata,
} from "./form.fill";

describe("form.fill handler", () => {
  it("exports schema and metadata", () => {
    expect(formFillSchema).toBeDefined();
    expect(formFillMetadata.name).toBe("form.fill");
  });

  it("calls invoke with form fill args", async () => {
    const fakeOutput = { fields: [{ name: "project_name", value: "Acme" }] };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = {
      route: "/admin/projects/new",
      instruction: "Set project name to Acme",
      fields: [
        { name: "project_name", label: "Project Name", type: "text" as const, current: "", required: true },
      ],
    };
    await handler_formFill(args, fakeExtra);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "form.fill",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });
});
