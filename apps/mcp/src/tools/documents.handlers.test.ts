// documents.handlers.test.ts — handler invocation tests for document/media/asset
// tools: archive.create, asset.upload, documents.generate,
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
    expect(archiveCreateMetadata.name).toBe("create_archive");
  });

  it("calls buildContext then invoke with correct args", async () => {
    const fakeOutput = {
      assetId: "gen_1",
      publicId: "gen_pub_1",
      kind: "archive" as const,
      mimeType: "application/zip",
      sizeBytes: 1024,
      url: "https://blob.example.com/archive.zip",
      serveUrl: "https://app.example.com/api/v1/assets/gen_pub_1",
      render: {
        componentId: "file-attachment",
        props: {
          url: "https://blob.example.com/archive.zip",
          name: "my-archive.zip",
          kind: "archive",
          mimeType: "application/zip",
          sizeBytes: 1024,
        },
      },
    };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = {
      archiveName: "my-archive",
      entries: [{ name: "readme.txt", text: "Hello" }],
    };
    const result = await handler_archiveCreate(args);

    expect(mocks.buildContext).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith("create_archive", args, fakeCtx, {
      surface: "mcp",
    });
    expect(result).toMatchObject({ assetId: "gen_1" });
  });

  it("propagates invoke errors", async () => {
    mocks.invoke.mockRejectedValue(new Error("archive failed"));
    await expect(
      handler_archiveCreate({
        archiveName: "x",
        entries: [{ name: "f.txt", text: "t" }],
      }),
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
    expect(assetUploadMetadata.name).toBe("upload_asset");
  });

  it("calls invoke with upload args", async () => {
    const fakeOutput = {
      url: "https://cdn.example.com/img.png",
      key: "image/org/uuid.png",
      contentType: "image/png",
      bytes: 512,
      publicId: null,
    };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = {
      sourceUrl: "https://example.com/image.png",
      kind: "image" as const,
      filename: undefined,
      source: undefined,
      conversationId: undefined,
    };
    await handler_assetUpload(args);

    expect(mocks.invoke).toHaveBeenCalledWith("upload_asset", args, fakeCtx, {
      surface: "mcp",
    });
  });
});

// ── documents.generate ────────────────────────────────────────────────────────

import handler_documentsGenerate, {
  schema as documentsGenerateSchema,
  metadata as documentsGenerateMetadata,
} from "./document.generate";

describe("documents.generate handler", () => {
  it("exports schema and metadata", () => {
    expect(documentsGenerateSchema).toBeDefined();
    expect(documentsGenerateMetadata.name).toBe("generate_document");
  });

  it("calls invoke with document generation args", async () => {
    const fakeOutput = {
      assetId: "gen_doc_1",
      publicId: "gen_pub_doc_1",
      kind: "document" as const,
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sizeBytes: 2048,
      url: "https://blob.example.com/report.docx",
      serveUrl: "https://app.example.com/api/v1/assets/gen_pub_doc_1",
      render: {
        componentId: "file-attachment",
        props: {
          url: "https://blob.example.com/report.docx",
          name: "My Report.docx",
          kind: "document",
          mimeType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          sizeBytes: 2048,
        },
      },
    };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = {
      kind: "document" as const,
      title: "My Report",
      content: {
        sections: [
          {
            heading: "Intro" as string | undefined,
            paragraphs: ["Hello world."],
          },
        ],
        headers: undefined,
        rows: undefined,
        slides: undefined,
      },
      brandColors: undefined,
    };
    await handler_documentsGenerate(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "generate_document",
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
} from "./document.pdf.create";

describe("documents.pdf.create handler", () => {
  it("exports schema and metadata", () => {
    expect(documentsPdfCreateSchema).toBeDefined();
    expect(documentsPdfCreateMetadata.name).toBe("create_pdf");
  });

  it("calls invoke with PDF creation args", async () => {
    const fakeOutput = {
      assetId: "gen_pdf_1",
      publicId: "gen_pub_pdf_1",
      kind: "pdf" as const,
      mimeType: "application/pdf",
      sizeBytes: 3072,
      url: "https://blob.example.com/my-pdf.pdf",
      serveUrl: "https://app.example.com/api/v1/assets/gen_pub_pdf_1",
      render: {
        componentId: "file-attachment",
        props: {
          url: "https://blob.example.com/my-pdf.pdf",
          name: "My PDF.pdf",
          kind: "pdf",
          mimeType: "application/pdf",
          sizeBytes: 3072,
        },
      },
    };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = {
      title: "My PDF",
      content: {
        sections: [
          {
            heading: "Intro" as string | undefined,
            paragraphs: ["Content here."],
          },
        ],
      },
      brandColors: undefined,
    };
    await handler_documentsPdfCreate(args);

    expect(mocks.invoke).toHaveBeenCalledWith("create_pdf", args, fakeCtx, {
      surface: "mcp",
    });
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
    expect(imageGenerateMetadata.name).toBe("generate_image");
  });

  it("calls invoke with image generation args", async () => {
    const fakeOutput = {
      alt: "A red fox in snow",
      placeholder: false,
      render: {
        componentId: "image-preview",
        props: { alt: "A red fox in snow" },
      },
    };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = {
      prompt: "A red fox in snow",
      alt: undefined,
      size: "1024x1024" as "1024x1024" | "1792x1024" | "1024x1792" | undefined,
    };
    const result = await handler_imageGenerate(args);

    expect(mocks.invoke).toHaveBeenCalledWith("generate_image", args, fakeCtx, {
      surface: "mcp",
    });
    expect(result).toMatchObject({
      alt: "A red fox in snow",
      placeholder: false,
    });
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
    expect(svgGenerateMetadata.name).toBe("generate_svg");
  });

  it("calls invoke with svg generation args", async () => {
    const fakeOutput = {
      svg: "<svg><rect width='100' height='100'/></svg>",
      title: "A simple house icon",
      render: {
        componentId: "svg-preview",
        props: { title: "A simple house icon" },
      },
    };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = {
      prompt: "A simple house icon",
      title: undefined,
      width: 400 as number | undefined,
      height: 400 as number | undefined,
    };
    await handler_svgGenerate(args);

    expect(mocks.invoke).toHaveBeenCalledWith("generate_svg", args, fakeCtx, {
      surface: "mcp",
    });
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
    expect(videoGenerateMetadata.name).toBe("generate_video");
  });

  it("calls invoke with video generation args", async () => {
    const fakeOutput = {
      status: "queued" as const,
      jobId: "job_vid_1",
      serveUrl: "https://app.example.com/api/v1/assets/vid_1",
      render: {
        componentId: "video-result" as const,
        props: {
          url: "https://app.example.com/api/v1/assets/vid_1",
          prompt: "A sunset over mountains",
        },
      },
    };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = {
      prompt: "A sunset over mountains",
      durationSeconds: 5 as number | undefined,
      aspectRatio: undefined,
      style: undefined,
      model: undefined,
    };
    await handler_videoGenerate(args);

    expect(mocks.invoke).toHaveBeenCalledWith("generate_video", args, fakeCtx, {
      surface: "mcp",
    });
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
    expect(formFillMetadata.name).toBe("fill_form");
  });

  it("calls invoke with form fill args", async () => {
    const fakeOutput = {
      fields: [
        { name: "project_name", current: "", proposed: "Acme", changed: true },
      ],
    };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = {
      route: "/admin/projects/new",
      entitySummary: undefined,
      instruction: "Set project name to Acme",
      fields: [
        {
          name: "project_name",
          label: "Project Name",
          type: "text" as const,
          current: "",
          options: undefined,
          required: true as boolean | undefined,
        },
      ],
    };
    await handler_formFill(args);

    expect(mocks.invoke).toHaveBeenCalledWith("fill_form", args, fakeCtx, {
      surface: "mcp",
    });
  });
});
