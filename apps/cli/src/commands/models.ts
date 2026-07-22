/**
 * `oxagen models` — inspect and manage the model runtime (Group 1, deliverable 4).
 *
 *   oxagen models list           Registry + capability scores + what fits this device.
 *   oxagen models active         The current coordinator and its kind (on-device|cloud).
 *   oxagen models pull           Download + cache the resolved on-device weights.
 *   oxagen models status         Cache location, size, checksum state, device fit.
 *   oxagen models use <id>       Choose the coordinator (on-device is always allowed).
 *   oxagen models capabilities   The provider capability posture matrix (cache, reasoning,
 *                                structured output, attachments) — full or filtered to one
 *                                vendor/model.
 *
 * Add --json to list/active/status/capabilities for machine-readable output.
 */
import { statSync } from "node:fs";
import {
  bestFittingQuant,
  cloudModel,
  cloudModelIds,
  detectDevice,
  estimateModelRamGB,
  getCacheDir,
  getCoordinator,
  getOnDeviceModelId,
  getQuantizationPreference,
  isCached,
  isOptionalDepInstalled,
  memoryBudgetGB,
  OnDeviceProvider,
  ON_DEVICE_ID,
  OPTIONAL_DEP,
  readManifest,
  resolveBestOnDeviceModel,
  roles,
  setCoordinator,
  verifyIntegrity,
  type DeviceProfile,
} from "../runtime/index.js";
import { capabilityTable } from "../runtime/registry.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";
import { gatewayModels, vendorLabels, type Vendor } from "@oxagen/ai/catalog";
import {
  allPostures,
  posturesFor,
  postureForModel,
  type AttachmentPosture,
  type CachePosture,
  type ReasoningPosture,
  type StructuredOutputPosture,
  type VendorPosture,
} from "@oxagen/ai/posture";

export interface ModelsOptions {
  json?: boolean;
}

// ── models list ──────────────────────────────────────────────────────────────

export async function handleModelsList(
  opts: ModelsOptions = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = writer.write;
  const device = detectDevice();
  const quantPref = getQuantizationPreference();
  const table = capabilityTable();
  const resolution = resolveBestOnDeviceModel(
    device,
    quantPref,
    getOnDeviceModelId(),
  );
  const coordinator = getCoordinator();

  const rows = table.map((row) => {
    const quant = bestFittingQuant(device, row, quantPref);
    return {
      modelId: row.modelId,
      codeScore: row.codeScore,
      params: row.params,
      contextWindow: row.contextWindow,
      license: row.license,
      fits: quant !== undefined,
      bestQuant: quant ?? null,
      estRamGB: quant ? estimateModelRamGB(row.params, quant) : null,
      resolved: resolution.row?.modelId === row.modelId,
    };
  });

  const cloud = cloudModelIds().map((id) => {
    const entry = cloudModel(id)!;
    return {
      id,
      slug: entry.slug,
      vendor: entry.vendor,
      contextWindow: entry.contextWindow,
    };
  });

  if (opts.json) {
    out(
      JSON.stringify(
        {
          device,
          coordinator,
          resolved: resolution,
          onDevice: rows,
          cloud,
          roles: roles(),
        },
        null,
        2,
      ),
    );
    return;
  }

  out(deviceLine(device));
  out(`Coordinator: ${coordinator}`);
  out("");
  out("On-device code models (highest codeScore first):");
  for (const r of rows) {
    const mark = r.resolved ? "→" : r.fits ? " " : "✗";
    const fit = r.fits
      ? `fits @ ${r.bestQuant} (~${r.estRamGB} GB)`
      : "does not fit this device";
    out(
      `  ${mark} ${r.modelId.padEnd(34)} score ${r.codeScore.toFixed(2)}  ${r.params.padEnd(9)} ${fit}`,
    );
  }
  out("");
  out("Cloud models:");
  for (const c of cloud) {
    out(`    ${c.id.padEnd(34)} ${c.slug}  (${c.vendor})`);
  }
  out("");
  out(
    `Resolved on-device pick: ${resolution.row ? resolution.row.modelId : "none"} — ${resolution.rationale}`,
  );
}

// ── models active ────────────────────────────────────────────────────────────

export async function handleModelsActive(
  opts: ModelsOptions = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = writer.write;
  const coordinator = getCoordinator();

  if (coordinator === ON_DEVICE_ID) {
    const provider = new OnDeviceProvider();
    const depInstalled = await isOptionalDepInstalled();
    const available = await provider.isAvailable();
    const info = {
      coordinator,
      kind: "on-device" as const,
      resolvedModel: provider.resolvedRow?.modelId ?? null,
      quant: provider.resolvedQuant,
      rationale: provider.rationale,
      optionalDepInstalled: depInstalled,
      cached: provider.resolvedRow
        ? isCached(
            getCacheDir(),
            provider.resolvedRow.modelId,
            provider.resolvedQuant!,
          ).cached
        : false,
      ready: available,
    };
    if (opts.json) return out(JSON.stringify(info, null, 2));
    out(`Coordinator: ${coordinator} (on-device)`);
    out(
      `  Resolved model: ${info.resolvedModel ?? "none — nothing fits this device"}`,
    );
    if (info.resolvedModel) out(`  Quantization:   ${info.quant}`);
    out(`  Rationale:      ${info.rationale}`);
    out(
      `  Optional dep:   ${depInstalled ? "installed" : `not installed (npm install ${OPTIONAL_DEP})`}`,
    );
    out(`  Weights cached: ${info.cached ? "yes" : "no"}`);
    out(
      `  Ready to run:   ${available ? "yes" : "no — run `oxagen models pull`"}`,
    );
    return;
  }

  const entry = cloudModel(coordinator);
  const info = {
    coordinator,
    kind: "cloud" as const,
    slug: entry?.slug ?? null,
    vendor: entry?.vendor ?? null,
  };
  if (opts.json) return out(JSON.stringify(info, null, 2));
  out(`Coordinator: ${coordinator} (cloud)`);
  out(`  Gateway slug: ${info.slug ?? "unknown model id"}`);
  if (info.vendor) out(`  Vendor:       ${info.vendor}`);
}

// ── models pull ──────────────────────────────────────────────────────────────

export async function handleModelsPull(
  opts: ModelsOptions = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = writer.write;
  // In capture mode (REPL inline execution) we never emit the incremental
  // `\r  NN%` progress line — that's a raw terminal redraw trick that only
  // makes sense against a real TTY, and it would just clutter the assistant
  // message. Capture mode still gets a start line and the final result.
  const isCapturing = writer !== stdoutWriter;
  const provider = new OnDeviceProvider();
  if (!provider.resolvedRow || !provider.resolvedQuant) {
    out(`No on-device model fits this device: ${provider.rationale}`);
    out(`Choose a cloud coordinator with \`oxagen models use haiku\`.`);
    process.exitCode = 1;
    return;
  }

  const human = !opts.json;
  const depInstalled = await isOptionalDepInstalled();
  if (human && !depInstalled) {
    out(
      `Note: the optional runtime is not installed. Weights will be cached, but`,
    );
    out(`running them needs \`npm install ${OPTIONAL_DEP}\`.`);
    out("");
  }

  if (human)
    out(
      `Pulling ${provider.resolvedRow.modelId} @ ${provider.resolvedQuant} …`,
    );
  let lastPct = -1;
  const result = await provider.pull((received, total) => {
    if (!total || isCapturing) return;
    const pct = Math.floor((received / total) * 100);
    if (human && pct !== lastPct && pct % 5 === 0) {
      lastPct = pct;
      process.stderr.write(
        `\r  ${pct}%  (${fmtBytes(received)} / ${fmtBytes(total)})   `,
      );
    }
  });
  if (human && !isCapturing) process.stderr.write("\n");

  if (opts.json) {
    out(
      JSON.stringify(
        {
          ...result,
          modelId: provider.resolvedRow.modelId,
          quant: provider.resolvedQuant,
        },
        null,
        2,
      ),
    );
    return;
  }
  out(
    result.fromCache
      ? `Already cached: ${result.path}`
      : `Downloaded and cached: ${result.path}`,
  );
}

// ── models status ────────────────────────────────────────────────────────────

export async function handleModelsStatus(
  opts: ModelsOptions = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = writer.write;
  const device = detectDevice();
  const dir = getCacheDir();
  const quantPref = getQuantizationPreference();
  const manifest = readManifest(dir);

  const entries = Object.values(manifest.entries).map((e) => {
    const status = isCached(dir, e.modelId, e.quant);
    const integrity = status.cached
      ? verifyIntegrity(dir, e.modelId, e.quant)
      : { ok: false, reason: status.reason };
    let sizeBytes = 0;
    try {
      if (status.cached) sizeBytes = statSync(status.path).size;
    } catch {
      /* file vanished between manifest read and stat */
    }
    return {
      modelId: e.modelId,
      quant: e.quant,
      path: status.path,
      present: status.cached,
      sizeBytes,
      checksum: integrity.ok ? "verified" : `invalid (${integrity.reason})`,
    };
  });

  if (opts.json) {
    return out(JSON.stringify({ cacheDir: dir, device, entries }, null, 2));
  }

  out(deviceLine(device));
  out(`Cache dir: ${dir}`);
  out("");
  if (entries.length === 0) {
    out(
      "No models cached. Run `oxagen models pull` to download the resolved model.",
    );
  } else {
    out("Cached weights:");
    for (const e of entries) {
      out(`  ${e.modelId} @ ${e.quant}`);
      out(
        `    present:  ${e.present ? "yes" : "no"}  size: ${fmtBytes(e.sizeBytes)}`,
      );
      out(`    checksum: ${e.checksum}`);
    }
  }
  out("");
  out("Device fit (best quant per model):");
  for (const row of capabilityTable()) {
    const quant = bestFittingQuant(device, row, quantPref);
    out(
      `  ${row.modelId.padEnd(34)} ${quant ? `${quant} ~${estimateModelRamGB(row.params, quant)} GB` : "does not fit"}`,
    );
  }
}

// ── models use ───────────────────────────────────────────────────────────────

export async function handleModelsUse(
  id: string,
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = writer.write;
  const known = [ON_DEVICE_ID, ...cloudModelIds()];
  if (!known.includes(id)) {
    out(`Unknown model id "${id}". Choose one of: ${known.join(", ")}.`);
    process.exitCode = 1;
    return;
  }
  setCoordinator(id);
  out(`Coordinator set to "${id}".`);
  if (id === ON_DEVICE_ID) {
    const provider = new OnDeviceProvider();
    if (!(await provider.isAvailable())) {
      out(
        `Run \`oxagen models pull\` to download the on-device weights before your first turn.`,
      );
    }
  }
}

// ── models capabilities ──────────────────────────────────────────────────────

export interface ModelsCapabilitiesOptions extends ModelsOptions {
  vendor?: string;
  model?: string;
}

/** The JSON/table row shape — mirrors `list_model_capabilities`'s output row so
 * `--json` here matches the API/MCP response shape exactly. */
interface CapabilityRow {
  vendor: Vendor;
  label: string;
  models: string[];
  cache: CachePosture;
  reasoning: ReasoningPosture;
  structuredOutput: StructuredOutputPosture;
  attachments: AttachmentPosture;
}

function modelsForVendor(vendor: Vendor): string[] {
  return gatewayModels.filter((m) => m.vendor === vendor).map((m) => m.id);
}

/** Display-only abbreviation for human output; JSON always carries the raw
 * `kind` value ("not-applicable") so it round-trips with the contract. */
function displayKind(kind: string): string {
  return kind === "not-applicable" ? "n/a" : kind;
}

function toCapabilityRow(posture: VendorPosture): CapabilityRow {
  return {
    vendor: posture.vendor,
    label: vendorLabels[posture.vendor],
    models: modelsForVendor(posture.vendor),
    cache: posture.cache,
    reasoning: posture.reasoning,
    structuredOutput: posture.structuredOutput,
    attachments: posture.attachments,
  };
}

export async function handleModelsCapabilities(
  opts: ModelsCapabilitiesOptions = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = writer.write;

  // `model` takes precedence over `vendor` — same resolution order as the
  // underlying `list_model_capabilities` capability.
  if (opts.model) {
    const posture = postureForModel(opts.model);
    if (!posture) {
      out(`No posture declared for "${opts.model}" — unknown provider.`);
      process.exitCode = 1;
      return;
    }
    printCapabilityDetail(posture, opts.json ?? false, out);
    return;
  }

  if (opts.vendor) {
    const posture = posturesFor(opts.vendor);
    if (!posture) {
      out(`No posture declared for "${opts.vendor}" — unknown provider.`);
      process.exitCode = 1;
      return;
    }
    printCapabilityDetail(posture, opts.json ?? false, out);
    return;
  }

  printCapabilityMatrix(opts.json ?? false, out);
}

function printCapabilityMatrix(
  json: boolean,
  out: (line: string) => void,
): void {
  const rows = allPostures().map(toCapabilityRow);

  if (json) {
    out(JSON.stringify({ vendors: rows, unknownFilter: null }, null, 2));
    return;
  }

  out(
    "Provider capability posture matrix (cache, reasoning, structured output, attachments):",
  );
  out("");
  out(
    `  ${"Vendor".padEnd(11)} ${"Cache".padEnd(11)} ${"Reasoning".padEnd(13)} ${"Structured".padEnd(11)} Attachments`,
  );
  for (const row of rows) {
    out(
      `  ${row.vendor.padEnd(11)} ${displayKind(row.cache.kind).padEnd(11)} ${displayKind(row.reasoning.kind).padEnd(13)} ${displayKind(row.structuredOutput.kind).padEnd(11)} ${displayKind(row.attachments.kind)}`,
    );
  }
  out("");
  out(
    "Run `oxagen models capabilities --vendor <vendor>` (or --model <gateway-id>) for the mechanism/witness detail behind each cell.",
  );
}

/** One axis's kind plus the mechanism/telemetry/note/reason prose behind it,
 * and the witness test title when the posture carries one. */
interface AxisDetail {
  kind: string;
  detail: string;
  witness?: string;
}

function cacheAxisDetail(p: CachePosture): AxisDetail {
  if (p.kind === "opt-in")
    return { kind: p.kind, detail: p.mechanism, witness: p.witness };
  if (p.kind === "implicit")
    return { kind: p.kind, detail: p.telemetry, witness: p.witness };
  return { kind: p.kind, detail: p.reason };
}

function reasoningAxisDetail(p: ReasoningPosture): AxisDetail {
  if (p.kind === "controllable")
    return { kind: p.kind, detail: p.mechanism, witness: p.witness };
  if (p.kind === "not-applicable") return { kind: p.kind, detail: p.reason };
  return { kind: p.kind, detail: p.note };
}

function structuredOutputAxisDetail(p: StructuredOutputPosture): AxisDetail {
  if (p.kind === "not-applicable") return { kind: p.kind, detail: p.reason };
  return { kind: p.kind, detail: p.mechanism, witness: p.witness };
}

function attachmentsAxisDetail(p: AttachmentPosture): AxisDetail {
  if (p.kind === "supported") {
    return {
      kind: p.kind,
      detail: `${p.mechanism} (accepts: ${p.kinds.join(", ")})`,
      witness: p.witness,
    };
  }
  if (p.kind === "text-only") return { kind: p.kind, detail: p.note };
  return { kind: p.kind, detail: p.reason };
}

function printCapabilityDetail(
  posture: VendorPosture,
  json: boolean,
  out: (line: string) => void,
): void {
  const row = toCapabilityRow(posture);

  if (json) {
    out(JSON.stringify({ vendors: [row], unknownFilter: null }, null, 2));
    return;
  }

  out(`${row.label} (${row.vendor})`);
  out(
    `  Models: ${row.models.length > 0 ? row.models.join(", ") : "none in the catalog"}`,
  );
  out("");
  printAxisDetail(out, "Cache", cacheAxisDetail(posture.cache));
  printAxisDetail(out, "Reasoning", reasoningAxisDetail(posture.reasoning));
  printAxisDetail(
    out,
    "Structured output",
    structuredOutputAxisDetail(posture.structuredOutput),
  );
  printAxisDetail(
    out,
    "Attachments",
    attachmentsAxisDetail(posture.attachments),
  );
}

function printAxisDetail(
  out: (line: string) => void,
  label: string,
  axis: AxisDetail,
): void {
  out(`${label}: ${displayKind(axis.kind)}`);
  out(`  ${axis.detail}`);
  if (axis.witness) out(`  Witness: "${axis.witness}"`);
  out("");
}

// ── shared formatting ────────────────────────────────────────────────────────

function deviceLine(device: DeviceProfile): string {
  const gpu = device.gpu
    ? `${device.gpu}${device.unifiedMemory ? " (unified)" : ""}, ~${device.vramGB} GB VRAM`
    : "CPU only";
  return `Device: ${device.ramGB} GB RAM, ${device.cpuCores} cores, ${gpu} — ~${round1(memoryBudgetGB(device))} GB usable for models`;
}

function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
