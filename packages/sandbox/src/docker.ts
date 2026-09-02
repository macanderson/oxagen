// Type-only import: dockerode (→ docker-modem → ssh2, which ships native .node
// bindings) must NOT be pulled into the module-init path. @oxagen/sandbox is
// imported by the agent handlers that the serverless api/mcp bundles include
// (for isSandboxAvailable / getSandbox), and a static value import of dockerode
// drags the native modules into esbuild/rspack and breaks the bundle. The
// runtime ctor is loaded lazily inside createDockerSandbox() instead, and the
// serverless builds mark `dockerode` external.
import type Dockerode from "dockerode";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import { Buffer } from "node:buffer";
import * as tar from "tar-stream";
import { IMAGES, type ImageSpec } from "./images";
import type {
  SandboxDriver,
  SandboxLanguage,
  SandboxRequest,
  SandboxResult,
  SandboxStreamChunk,
} from "./types";

// 0.5 CPU equivalent in NanoCPUs (1e9 = 1 full CPU).
const NANOCPUS = 500_000_000;
const NOBODY = "65534:65534";

// Hard floor for the container memory limit. Docker treats `Memory: 0` as
// "unlimited", which would let untrusted code exhaust host RAM and defeat the
// core resource-isolation guarantee of the sandbox. applyPolicy only clamps
// the ceiling (and explicitly passes memoryMb=0 through), so we enforce a
// positive minimum here at the point where the HostConfig is built — the last
// trust boundary before the value reaches the Docker daemon.
const MIN_MEMORY_MB = 16;

// Maximum bytes accumulated from stdout+stderr across the Docker socket.
// Container memory (memoryMb) caps RAM inside the container; this caps
// host-side buffering of the multiplexed output stream.
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024; // 8 MB

// Maximum chunks allowed in the stream() queue before the container is
// killed. Prevents a fast-printing container from exhausting host memory
// when the async iterator consumer is slower than the output rate.
const MAX_QUEUE_ITEMS = 1000;

// Docker's built-in hardened seccomp policy (ships with every Docker Engine
// ≥ 1.10 and Docker Desktop). "seccomp=builtin" is the explicit name for
// what some docs call the "default" profile. Using the explicit name rather
// than relying on the daemon's implicit default means:
//   1. The policy is applied even if a future daemon changes its default.
//   2. The intent is visible in code review without consulting daemon config.
//   3. It composes correctly with no-new-privileges (both stay in the array).
//
// We do NOT use seccomp=unconfined — that would remove the kernel call filter
// entirely and contradict the zero-privilege posture of this sandbox.  If a
// language runtime requires a syscall blocked by builtin, add a targeted
// allow-rule via a custom JSON profile rather than lifting the whole profile.
const SECCOMP_BUILTIN = "seccomp=builtin";

function envArray(env: Record<string, string> | undefined): string[] {
  if (!env) return [];
  return Object.entries(env).map(([k, v]) => `${k}=${v}`);
}

// Ceiling on vCPU a template may request (mirrors the contract's
// sandboxResourcesSchema.vcpu max). A malformed larger value is clamped rather
// than handed straight to the daemon.
const MAX_VCPU = 4;

export function hostConfigFor(
  req: SandboxRequest,
  spec: ImageSpec,
): Dockerode.HostConfig {
  // Never allow a non-positive memory limit through to Docker (0 == unlimited).
  const memoryBytes = Math.max(req.memoryMb, MIN_MEMORY_MB) * 1024 * 1024;
  // A template's vcpu maps to NanoCpus (1 vCPU = 1e9); default is the 0.5-CPU
  // floor. A template's diskMb sizes the /work tmpfs (agent workspace); /tmp
  // keeps the image default so a large workspace request doesn't also inflate scratch.
  const nanoCpus =
    req.vcpu && req.vcpu > 0
      ? Math.min(req.vcpu, MAX_VCPU) * 1_000_000_000
      : NANOCPUS;
  const workBytes =
    req.diskMb && req.diskMb > 0 ? req.diskMb * 1024 * 1024 : spec.tmpfsBytes;
  return {
    AutoRemove: true,
    Memory: memoryBytes,
    MemorySwap: memoryBytes,
    NanoCpus: nanoCpus,
    PidsLimit: 128,
    NetworkMode: req.network === "deny" ? "none" : "bridge",
    ReadonlyRootfs: true,
    Tmpfs: {
      "/work": `rw,size=${workBytes}`,
      "/tmp": `rw,size=${spec.tmpfsBytes}`,
    },
    CapDrop: ["ALL"],
    SecurityOpt: ["no-new-privileges", SECCOMP_BUILTIN],
  };
}

// Collect the unique parent directories implied by a set of relative file
// paths (e.g. "src/lib/util.js" → ["src", "src/lib"]), nearest-root first, so
// we can emit explicit tar directory entries. Docker's untar does create
// missing parents, but emitting them keeps the archive self-describing and
// portable across daemon versions.
function parentDirsFor(paths: readonly string[]): string[] {
  const dirs = new Set<string>();
  for (const p of paths) {
    const parts = p.split("/");
    parts.pop(); // drop the file name
    let prefix = "";
    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part;
      dirs.add(prefix);
    }
  }
  return [...dirs].sort();
}

// Packs the user's entrypoint code plus any extra workspace `files` as a single
// tar so we can `putArchive` it into the read-only container's tmpfs `/work`
// mount before start. The extra files land workspace-relative to the entrypoint
// so language-relative imports resolve. Caller-supplied paths are already
// confined to the workspace root upstream (contract + handler validation via
// `@oxagen/sandbox/workspace`); the entry name strips any leading `/work/` and
// `tar-stream` itself never interprets `..` — the bytes are written verbatim.
function packWorkspaceTar(
  spec: ImageSpec,
  code: string,
  files: Record<string, string> | undefined,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pack = tar.pack();
    const codeName = spec.codePath.replace(/^\/work\//, "");
    const extra = Object.entries(files ?? {}).filter(
      ([name]) => name !== codeName,
    );

    // Sequence the async pack.entry() calls (the callback API does not queue).
    const dirEntries = parentDirsFor(extra.map(([name]) => name)).map(
      (name) => ({ kind: "dir" as const, name }),
    );
    const fileEntries = [
      { kind: "file" as const, name: codeName, content: code },
      ...extra.map(([name, content]) => ({
        kind: "file" as const,
        name,
        content,
      })),
    ];
    const queue: Array<
      | { kind: "dir"; name: string }
      | { kind: "file"; name: string; content: string }
    > = [...dirEntries, ...fileEntries];

    let i = 0;
    const next = (): void => {
      if (i >= queue.length) {
        pack.finalize();
        return;
      }
      const item = queue[i++]!;
      if (item.kind === "dir") {
        pack.entry(
          { name: item.name, type: "directory", mode: 0o755 },
          "",
          (err) => (err ? reject(err) : next()),
        );
      } else {
        pack.entry({ name: item.name, mode: 0o755 }, item.content, (err) =>
          err ? reject(err) : next(),
        );
      }
    };
    next();

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
      if (err || !stream)
        return reject(err ?? new Error("pull returned no stream"));
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
  // A template's custom image (digest-pinned) overrides the language default;
  // the entrypoint + codePath stay language-derived (the custom image is a
  // prewarmed superset of the base — e.g. node with a toolchain baked in).
  const image = req.imageRef ?? spec.image;
  await ensureImage(docker, image);
  const container = await docker.createContainer({
    Image: image,
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
  const archive = await packWorkspaceTar(spec, req.code, req.files);
  await container.putArchive(archive, { path: "/work" });
  return { container, spec };
}

export function createDockerSandbox(
  dockerFactory?: () => Dockerode,
): SandboxDriver {
  // Lazy runtime load of the dockerode value (see the type-only import note at
  // the top of the file). This require only executes when the docker driver is
  // actually selected — never in serverless prod, where SANDBOX_DRIVER is
  // vercel/modal — so the externalized `dockerode` is never resolved there.
  const require = createRequire(import.meta.url);
  const DockerodeCtor = require("dockerode") as typeof import("dockerode");
  const docker: Dockerode = dockerFactory
    ? dockerFactory()
    : new DockerodeCtor();

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
    let accumulatedBytes = 0;
    let outputTruncated = false;
    stream.on("data", (c: Buffer) => {
      if (accumulatedBytes + c.length > MAX_OUTPUT_BYTES) {
        // Kill the container once, on the chunk that trips the cap. A fast
        // printer keeps emitting frames until the SIGKILL lands, so guard on
        // outputTruncated — without it every subsequent frame fires another
        // HTTP kill request at the Docker daemon.
        if (!outputTruncated) {
          outputTruncated = true;
          container.kill({ signal: "SIGKILL" }).catch(() => undefined);
        }
        return;
      }
      chunks.push(c);
      accumulatedBytes += c.length;
    });

    // Capture stream EOF BEFORE the wait/timeout race. Container exit and
    // attach-stream EOF are concurrent in the Docker API: the multiplexed
    // stream can emit "end" before (or at the same time as) container.wait()
    // resolves. Node EventEmitters do not replay past events, so registering
    // the listener after the race could miss "end" entirely and hang run()
    // forever on the happy path. `once` + a readableEnded guard makes this
    // robust regardless of ordering.
    const streamEnded = new Promise<void>((resolve) => {
      // @types/dockerode types attach() as NodeJS.ReadWriteStream, which omits
      // the readableEnded flag present on the concrete Readable at runtime.
      if ((stream as unknown as { readableEnded?: boolean }).readableEnded)
        resolve();
      else stream.once("end", () => resolve());
    });

    await container.start();
    if (req.stdin) {
      stream.write(req.stdin);
      stream.end();
    }

    let timedOut = false;
    const wait = container.wait();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timer = new Promise<"timeout">((resolve) => {
      timeoutHandle = setTimeout(() => resolve("timeout"), req.timeoutMs);
    });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- @types/dockerode types container.wait() as Promise<any>; outcome is only compared against "timeout" string, never accessed.
    const outcome = await Promise.race([wait, timer]);
    // Always clear the timer so a fast-completing container does not keep the
    // event loop (and serverless billing clock) alive for the full timeout.
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (outcome === "timeout") {
      timedOut = true;
      // Best-effort kill; AutoRemove tears the container down once stopped.
      try {
        await container.kill({ signal: "SIGKILL" });
      } catch {
        // Container may already be gone if it raced past the timeout.
      }
    }
    await streamEnded;

    let exitCode = 0;
    let oomKilled = false;
    if (
      !timedOut &&
      typeof outcome === "object" &&
      outcome !== null &&
      "StatusCode" in outcome
    ) {
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
    const result: SandboxResult = {
      exitCode,
      stdout: outputTruncated
        ? stdout + "\n[output truncated: exceeded 8 MB limit]"
        : stdout,
      stderr,
      durationMs: Date.now() - start,
      timedOut,
      oomKilled,
    };
    return result;
  }

  async function* stream(
    req: SandboxRequest,
  ): AsyncIterable<SandboxStreamChunk> {
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
    // Kill the container once when the backlog cap is hit. The container keeps
    // emitting frames until the SIGKILL lands, so without this guard every
    // frame past the cap fires another HTTP kill request at the Docker daemon.
    let killedForOverflow = false;
    const killOnce = () => {
      if (killedForOverflow) return;
      killedForOverflow = true;
      container.kill({ signal: "SIGKILL" }).catch(() => undefined);
    };
    const notify = () => {
      if (resolveNext) {
        resolveNext();
        resolveNext = null;
      }
    };
    const push = (channel: "stdout" | "stderr", c: Buffer) => {
      if (queue.length >= MAX_QUEUE_ITEMS) {
        killOnce();
        return;
      }
      queue.push({ channel, data: c.toString("utf8"), at: Date.now() });
      notify();
    };
    stdoutPipe.on("data", (c: Buffer) => push("stdout", c));
    stderrPipe.on("data", (c: Buffer) => push("stderr", c));

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

    try {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (done) return;
        await new Promise<void>((r) => (resolveNext = r));
      }
    } finally {
      // A consumer that `break`s (or throws) out of `for await` closes the
      // generator here while the container is still running. Without this the
      // container survives until the timeout fires — burning the caller's CPU,
      // memory, and (with network=allow) egress for no reader. Both calls are
      // idempotent: on the normal path the container has already exited and the
      // timer is already cleared.
      clearTimeout(timer);
      container.kill({ signal: "SIGKILL" }).catch(() => undefined);
    }
  }

  async function warmup(): Promise<void> {
    const langs: SandboxLanguage[] = ["node", "python", "shell"];
    await Promise.all(langs.map((l) => ensureImage(docker, IMAGES[l].image)));
  }

  return { run, stream, warmup, name: "docker" };
}
