#!/usr/bin/env node
// `pnpm dev` for the site: build dist/, serve it on :5500 with production's
// clean-URL rules, and rebuild whenever content/, assets/ or a page changes.
// No dependencies beyond node: the site is static and so is this.

import { watch } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { build, DIST, ROOT } from "./build.mjs";
import { candidatesFor, contentTypeFor, shouldRebuild } from "./lib/serve.mjs";

const PORT = Number(process.env.WEB_PORT ?? 5500);

let building = Promise.resolve();
let queued = false;

function rebuild(reason) {
  if (queued) return;
  queued = true;
  building = building.then(async () => {
    // coalesce a burst of writes (an editor saving several files) into one build
    await new Promise((r) => setTimeout(r, 150));
    queued = false;
    try {
      await build({ log: (line) => console.log(`[web] ${reason}: ${line}`) });
    } catch (err) {
      console.error(`[web] build failed (${reason}): ${err?.message ?? err}`);
    }
  });
}

async function serve(req, res) {
  await building;
  const url = new URL(req.url ?? "/", "http://localhost");
  for (const rel of candidatesFor(url.pathname)) {
    const file = path.join(DIST, rel);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) continue;
    res.writeHead(200, {
      "content-type": contentTypeFor(file),
      "cache-control": "no-store",
    });
    res.end(await readFile(file));
    return;
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end(`404 ${url.pathname}`);
}

await build({ log: (line) => console.log(`[web] ${line}`) });

watch(ROOT, { recursive: true }, (_event, filename) => {
  if (!filename || !shouldRebuild(String(filename))) return;
  rebuild(String(filename));
});

http
  .createServer((req, res) => {
    serve(req, res).catch((err) => {
      console.error(`[web] ${req.url}: ${err?.message ?? err}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  })
  .listen(PORT, () => {
    console.log(
      `[web] oxagen.sh preview on http://localhost:${PORT} (watching for changes)`,
    );
  });
