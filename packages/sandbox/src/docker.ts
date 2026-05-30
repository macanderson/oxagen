import Dockerode from "dockerode";
import { PassThrough } from "node:stream";
import { Buffer } from "node:buffer";
import * as tar from "tar-stream";
import { IMAGES, type ImageSpec } from "./images.js";
import type {
  SandboxDriver,
  SandboxLanguage,
  SandboxRequest,
  SandboxResult,
  SandboxStreamChunk,
} from "./types.js";

// 0.5 CPU equivalent in NanoCPUs (1e9 = 1 full CPU).
const NANOCPUS = 500_000_000;
const NOBODY = "65534:65534";

function envArray(env: Record<string, string> | undefined): string[] {
  if (!env) return [];
  return Object.entries(env).map(([k, v]) => `${k}=${v}`);
}

function hostConfigFor(req: SandboxRequest, spec: ImageSpec): Dockerode.HostConfig {
  return {
    AutoRemove: true,
    Memory: req.memoryMb * 1024 * 1024,
    MemorySwap: req.memoryMb * 1024 * 1024,
    NanoCpus: NANOCPUS,
    PidsLimit: 128,
    NetworkMode: req.network === "deny" ? "none" : "bridge",
    ReadonlyRootfs: true,
    Tmpfs: {
      "/work": `rw,size=${spec.tmpfsBytes}`,
      "/tmp": `rw,size=${spec.tmpfsBytes}`,
    },
    CapDrop: ["ALL"],
    SecurityOpt: ["no-new-privileges"],
  };
}

// Packs the user's code as a single-file tar so we can `putArchive` it
// into the read-only container's tmpfs `/work` mount before start.
function packCodeTar(spec: ImageSpec, code: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pack = tar.pack();
    const fileName = spec.codePath.replace(/^\/work\//, "");
    pack.entry({ name: fileName, mode: 0o755 }, code, (err) => {
      if (err) reject(err);
      else pack.finalize();
    });
    const chunks: Buffer[] = [];
    pack.on("data", (c: Buffer) => chunks.push(c));
    pack.on("end", () => resolve(Buffer.concat(chunks)));
    pack.on("error", reject);
  });
}

// Docker multiplexed stream framing: 8-byte header per frame; byte[0] is
// the stream (1=stdout, 2=stderr); bytes[4..8] big-endian payload length.
function demux(buf: Buffer): { stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  let i = 0;
  while (i + 8 <= buf.length) {
    const channel = buf[i];
    const len = buf.readUInt32BE(i + 4);
    const start = i + 8;
    const end = start + len;
    if (end > buf.length) break;
    const payload = buf.subarray(start, end).toString("utf8");
    if (channel === 2) stderr += payload;
    else stdout += payload;
    i = end;
  }
  return { stdout, stderr };
}

async function ensureImage(docker: Dockerode, image: string): Promise<void> {
  const imgs = await docker.listImages({ filters: { reference: [image] } });
  if (imgs.length > 0) return;
  await new Promise<void>((resolve, reject) => {
    docker.pull(image, {}, (err, stream) => {
      if (err || !stream) return reject(err ?? new Error("pull returned no stream"));
      docker.modem.followProgress(stream, (e) => (e ? reject(e) : resolve()));
    });
  });
}

interface CreatedContainer {
  container: Dockerode.Container;
  spec: ImageSpec;
}

async function createAndLoad(
  docker: Dockerode,
  req: SandboxRequest,
): Promise<CreatedContainer> {
  const spec = IMAGES[req.language];
  await ensureImage(docker, spec.image);
  const container = await docker.createContainer({
    Image: spec.image,
    Cmd: [...spec.entrypoint],
    Env: envArray(req.env),
    WorkingDir: "/work",
    AttachStdin: Boolean(req.stdin),
    AttachStdout: true,
    AttachStderr: true,
    OpenStdin: Boolean(req.stdin),
    StdinOnce: Boolean(req.stdin),
    Tty: false,
    User: NOBODY,
    HostConfig: hostConfigFor(req, spec),
    Labels: {
      "oxagen.org": req.orgId,
      "oxagen.workspace": req.workspaceId,
    },
  });
  const archive = await packCodeTar(spec, req.code);
  await container.putArchive(archive, { path: "/work" });
  return { container, spec };
}

export function createDockerSandbox(): SandboxDriver {
  const docker = new Dockerode();

  async function run(req: SandboxRequest): Promise<SandboxResult> {
    const start = Date.now();
    const { container } = await createAndLoad(docker, req);

    const stream = await container.attach({
      stream: true,
      stdout: true,
      stderr: true,
      stdin: Boolean(req.stdin),
    });

    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));

    await container.start();
    if (req.stdin) {
      stream.write(req.stdin);
      stream.end();
    }

    let timedOut = false;
    const wait = container.wait();
    const timer = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), req.timeoutMs),
    );
    const outcome = await Promise.race([wait, timer]);
    if (outcome === "timeout") {
      timedOut = true;
      // Best-effort kill; AutoRemove tears the container down once stopped.
      try {
        await container.kill({ signal: "SIGKILL" });
      } catch {
        // Container may already be gone if it raced past the timeout.
      }
    }
    await new Promise<void>((resolve) => stream.on("end", () => resolve()));

    let exitCode = 0;
    let oomKilled = false;
    if (!timedOut && typeof outcome === "object" && outcome !== null && "StatusCode" in outcome) {
      exitCode = Number((outcome as { StatusCode: number }).StatusCode);
    } else if (timedOut) {
      exitCode = 137;
    }
    try {
      const info = await container.inspect();
      oomKilled = Boolean(info.State?.OOMKilled);
    } catch {
      // Container removed before we could inspect.
    }

    const merged = Buffer.concat(chunks);
    const { stdout, stderr } = demux(merged);
    return {
      exitCode,
      stdout,
      stderr,
      durationMs: Date.now() - start,
      timedOut,
      oomKilled,
    };
  }

  async function* stream(req: SandboxRequest): AsyncIterable<SandboxStreamChunk> {
    const { container } = await createAndLoad(docker, req);
    const attached = await container.attach({
      stream: true,
      stdout: true,
      stderr: true,
      stdin: Boolean(req.stdin),
    });

    const stdoutPipe = new PassThrough();
    const stderrPipe = new PassThrough();
    // demuxStream is provided by dockerode-modem; split frames by channel.
    docker.modem.demuxStream(attached, stdoutPipe, stderrPipe);

    await container.start();
    if (req.stdin) {
      attached.write(req.stdin);
      attached.end();
    }

    const queue: SandboxStreamChunk[] = [];
    let done = false;
    let resolveNext: (() => void) | null = null;
    const notify = () => {
      if (resolveNext) {
        resolveNext();
        resolveNext = null;
      }
    };
    stdoutPipe.on("data", (c: Buffer) => {
      queue.push({ channel: "stdout", data: c.toString("utf8"), at: Date.now() });
      notify();
    });
    stderrPipe.on("data", (c: Buffer) => {
      queue.push({ channel: "stderr", data: c.toString("utf8"), at: Date.now() });
      notify();
    });

    const timer = setTimeout(() => {
      container.kill({ signal: "SIGKILL" }).catch(() => undefined);
    }, req.timeoutMs);

    container
      .wait()
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timer);
        done = true;
        notify();
      });

    while (true) {
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      if (done) return;
      await new Promise<void>((r) => (resolveNext = r));
    }
  }

  async function warmup(): Promise<void> {
    const langs: SandboxLanguage[] = ["node", "python", "shell"];
    await Promise.all(langs.map((l) => ensureImage(docker, IMAGES[l].image)));
  }

  return { run, stream, warmup, name: "docker" };
}
