#!/usr/bin/env node
/**
 * measure-boot-payload.mjs - simulated-boot payload harness (S208 PR-S2a).
 *
 * WHAT IT MEASURES
 * The exact bytes `prism_bootstrap` hands the MCP client for a real project,
 * plus a per-field attribution of where those bytes went. It is the durable
 * artifact behind the "payload-byte-identical" claim: run it on two builds and
 * diff the totals.
 *
 * HOW (the S202 method, made repeatable)
 * 1. esbuild-bundles the SERVER'S OWN `registerBootstrap` - every parser,
 *    renderer, banner and manifest builder the real boot uses. Nothing is
 *    re-implemented here, so the harness cannot drift from the server.
 * 2. Replaces `globalThis.fetch` with a corpus-backed GitHub: reads are served
 *    from a real `.prism/` directory on disk (default: the live prism corpus),
 *    writes are acknowledged, everything else 404s. The corpus is what makes
 *    the number meaningful - synthetic fixtures measure fixtures.
 * 3. Freezes the clock and the timezone so the payload is byte-stable across
 *    runs. Without this, `session_timestamp` and the banner alone would make
 *    every run differ.
 * 4. Invokes the registered tool handler and measures the delivered text.
 *
 * USAGE
 *   node scripts/measure-boot-payload.mjs
 *   node scripts/measure-boot-payload.mjs --corpus /path/to/repo/.prism
 *   node scripts/measure-boot-payload.mjs --json            # machine-readable
 *   node scripts/measure-boot-payload.mjs --out report.json
 *
 * EXIT CODES: 0 measured, 1 harness failure (bundle, corpus, or boot error).
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Fixed instant for every simulated boot. Any date works; it must not move. */
const FROZEN_INSTANT_MS = Date.UTC(2026, 7, 16, 18, 0, 0);

/** Default corpus: the live prism living documents. */
const DEFAULT_CORPUS = "/Users/brdonath/development/prism/.prism";

/** Default source for the behavioral-rules template the boot delivers. */
const DEFAULT_TEMPLATE =
  "/Users/brdonath/development/prism-framework/_templates/core-template-mcp.md";

function parseArgs(argv) {
  const args = {
    corpus: DEFAULT_CORPUS,
    template: DEFAULT_TEMPLATE,
    slug: "prism",
    json: false,
    out: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") args.json = true;
    else if (arg === "--corpus") args.corpus = argv[++i];
    else if (arg === "--template") args.template = argv[++i];
    else if (arg === "--slug") args.slug = argv[++i];
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(readFileSync(fileURLToPath(import.meta.url), "utf-8").split("\n").slice(1, 32).join("\n") + "\n");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

/** Git blob sha, so the harness's shas are the same kind of thing GitHub returns. */
function blobSha(content) {
  const body = Buffer.from(content, "utf-8");
  return createHash("sha1")
    .update(`blob ${body.length}\0`)
    .update(body)
    .digest("hex");
}

/**
 * Bundle the server's bootstrap tool into a single ESM file. Bundling (rather
 * than running the TypeScript sources) is what lets this script stay a plain
 * `node` script with no loader flags, and it is how the S202 measurement was
 * originally taken.
 */
function bundleServer(outDir) {
  const entry = join(outDir, "entry.ts");
  // Absolute specifiers: the entry lives in a temp directory, so a relative
  // path would resolve against the wrong root. esbuild maps the `.js`
  // specifier back to the `.ts` source, exactly as tsc's NodeNext resolution
  // does for the real build.
  const bootstrapSrc = join(REPO_ROOT, "src", "tools", "bootstrap.js");
  const configSrc = join(REPO_ROOT, "src", "config.js");
  writeFileSync(
    entry,
    [
      `export { registerBootstrap } from ${JSON.stringify(bootstrapSrc)};`,
      `export { SERVER_VERSION } from ${JSON.stringify(configSrc)};`,
      "",
    ].join("\n"),
  );

  const bundle = join(outDir, "bundle.mjs");
  execFileSync(
    join(REPO_ROOT, "node_modules", ".bin", "esbuild"),
    [
      entry,
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--target=node20",
      "--log-level=error",
      `--outfile=${bundle}`,
    ],
    { cwd: REPO_ROOT, stdio: ["ignore", "ignore", "inherit"] },
  );
  return bundle;
}

/**
 * Corpus-backed GitHub. Serves `.prism/<doc>` from the corpus directory, the
 * behavioral-rules template from the framework clone, acknowledges the
 * boot-test PUT, and 404s everything else (which is exactly what the real
 * boot's optional reads expect when a document is absent).
 */
function installCorpusGitHub({ corpusDir, templatePath, owner, slug, frameworkRepo }) {
  const reads = [];
  const writes = [];
  const cache = new Map();

  const readCorpusFile = (repo, path) => {
    if (repo === frameworkRepo && path.endsWith("core-template-mcp.md")) {
      return existsSync(templatePath) ? readFileSync(templatePath, "utf-8") : null;
    }
    if (repo !== slug) return null;
    if (!path.startsWith(".prism/")) return null; // legacy root copies: absent
    const file = join(corpusDir, path.slice(".prism/".length));
    if (!existsSync(file)) return null;
    return readFileSync(file, "utf-8");
  };

  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    const method = (init.method ?? "GET").toUpperCase();
    const contents = href.match(
      new RegExp(`/repos/${owner}/([^/]+)/contents/([^?]+)`),
    );

    if (!contents) {
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    }

    const repo = contents[1];
    const path = decodeURIComponent(contents[2]);

    if (method === "PUT") {
      writes.push(`${repo}/${path}`);
      return new Response(
        JSON.stringify({ content: { sha: blobSha(`${repo}/${path}`) } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    const content = readCorpusFile(repo, path);
    if (content === null) {
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    }

    let entry = cache.get(`${repo}/${path}`);
    if (!entry) {
      entry = { sha: blobSha(content), etag: `"${blobSha(content).slice(0, 16)}"` };
      cache.set(`${repo}/${path}`, entry);
    }
    reads.push(`${repo}/${path}`);

    const headers = init.headers ?? {};
    if (headers["If-None-Match"] === entry.etag) {
      return new Response(null, { status: 304 });
    }

    return new Response(
      JSON.stringify({
        content: Buffer.from(content, "utf-8").toString("base64"),
        sha: entry.sha,
        size: Buffer.byteLength(content, "utf-8"),
        encoding: "base64",
      }),
      { status: 200, headers: { "content-type": "application/json", etag: entry.etag } },
    );
  };

  return { reads, writes };
}

/** Freeze wall-clock time so the measured payload is stable across runs. */
function freezeClock() {
  const RealDate = Date;
  class FrozenDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(FROZEN_INSTANT_MS);
      else super(...args);
    }
    static now() {
      return FROZEN_INSTANT_MS;
    }
  }
  globalThis.Date = FrozenDate;
}

/** Per-top-level-field delivered bytes, largest first. */
function attributeFields(payload) {
  const rows = Object.entries(payload).map(([field, value]) => ({
    field,
    bytes: Buffer.byteLength(JSON.stringify(value) ?? "null", "utf-8"),
  }));
  rows.sort((a, b) => b.bytes - a.bytes);
  return rows;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!existsSync(args.corpus)) {
    throw new Error(`Corpus directory not found: ${args.corpus}`);
  }

  // Deterministic, offline, quiet. Set BEFORE the bundle is imported: config.ts
  // reads the environment at module load.
  process.env.TZ = "America/Chicago";
  process.env.GITHUB_PAT = "measure-harness-dummy-pat";
  process.env.GITHUB_OWNER = "brdonath1";
  process.env.FRAMEWORK_REPO = "prism-framework";
  process.env.LOG_LEVEL = "error";
  delete process.env.RAILWAY_API_TOKEN;
  delete process.env.RAILWAY_ENVIRONMENT_ID;
  delete process.env.ANTHROPIC_API_KEY;
  process.env.TRIGGER_AUTO_ENROLL = "false";

  const workDir = mkdtempSync(join(tmpdir(), "prism-boot-payload-"));
  let result;
  try {
    const bundle = bundleServer(workDir);
    const io = installCorpusGitHub({
      corpusDir: resolve(args.corpus),
      templatePath: resolve(args.template),
      owner: process.env.GITHUB_OWNER,
      slug: args.slug,
      frameworkRepo: process.env.FRAMEWORK_REPO,
    });
    freezeClock();

    const { registerBootstrap, SERVER_VERSION } = await import(pathToFileURL(bundle).href);

    // Minimal McpServer stub: capture the registered handler and call it.
    const handlers = {};
    registerBootstrap({
      tool(name, _description, _schema, handler) {
        handlers[name] = handler;
      },
    });
    const handler = handlers.prism_bootstrap;
    if (!handler) throw new Error("prism_bootstrap was not registered by the bundle");

    const response = await handler(
      { project_slug: args.slug },
      { sendNotification: async () => {}, sendRequest: async () => {} },
    );
    const text = response.content[0].text;
    const payload = JSON.parse(text);

    if (payload.error) {
      throw new Error(`Simulated boot failed: ${payload.error}`);
    }

    result = {
      server_version: SERVER_VERSION,
      corpus: resolve(args.corpus),
      project_slug: args.slug,
      frozen_instant: new Date(FROZEN_INSTANT_MS).toISOString(),
      delivered_payload_bytes: Buffer.byteLength(text, "utf-8"),
      delivered_payload_sha256: createHash("sha256").update(text, "utf-8").digest("hex"),
      top_level_fields: Object.keys(payload).length,
      github_reads: io.reads.length,
      github_writes: io.writes.length,
      field_bytes: attributeFields(payload),
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  const json = JSON.stringify(result, null, 2);
  if (args.out) writeFileSync(args.out, json + "\n");

  if (args.json) {
    process.stdout.write(json + "\n");
    return;
  }

  const lines = [
    `PRISM boot payload measurement (server ${result.server_version})`,
    `  corpus:            ${result.corpus}`,
    `  delivered bytes:   ${result.delivered_payload_bytes.toLocaleString()}`,
    `  payload sha256:    ${result.delivered_payload_sha256}`,
    `  top-level fields:  ${result.top_level_fields}`,
    `  github reads:      ${result.github_reads}`,
    "",
    "  top fields by delivered bytes:",
    ...result.field_bytes
      .slice(0, 12)
      .map((row) => `    ${String(row.bytes).padStart(8)}  ${row.field}`),
    "",
  ];
  process.stdout.write(lines.join("\n"));
}

main().catch((error) => {
  process.stderr.write(`measure-boot-payload: ${error.message}\n`);
  process.exit(1);
});
