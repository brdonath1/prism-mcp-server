#!/usr/bin/env node
/**
 * doppler-run.mjs: Railway start wrapper for the Doppler migration (same wrapper as PlatformForge v2 and the
 * Mac Studio scanner).
 *
 * Usage: node scripts/doppler-run.mjs <command> [args...]
 *
 * Railway keeps one sealed, read-only DOPPLER_TOKEN per service (scoped to that service's Doppler config,
 * prism-mcp/prd_prism_mcp). This wrapper fetches the config once at startup and runs the
 * command with it layered over the platform environment. Doppler wins, except that PORT and RAILWAY_* always come
 * from Railway. DOPPLER_TOKEN itself is never passed to the app.
 *
 * - Off Railway without DOPPLER_TOKEN: pass-through, the command runs with the environment unchanged.
 * - On Railway (RAILWAY_ENVIRONMENT_NAME set) without DOPPLER_TOKEN: refuse to start (misconfiguration).
 * - DOPPLER_TOKEN set but the fetch fails: refuse to start instead of running with a partial environment.
 *
 * Plain ESM with no dependencies, so it runs in the built image without a Doppler CLI. Node >= 18:
 * AbortSignal.any is used when present (Node 20.3+); otherwise a signal during the fetch is noticed when the current
 * attempt ends (at most 10 s), well inside Railway's stop grace period.
 * Logs carry only fixed text and HTTP statuses, never response bodies or values.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { setDefaultResultOrder } from "node:dns";
import { constants } from "node:os";
import { pathToFileURL } from "node:url";

export const DOPPLER_DOWNLOAD_URL = "https://api.doppler.com/v3/configs/config/secrets/download?format=json";
const ATTEMPTS = 3;
const TIMEOUT_MS = 10_000;
const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];
// Doppler secret names are upper-case; this also refuses prototype keys such as __proto__.
const NAME = /^[A-Z_][A-Z0-9_]*$/;

export class DopplerUnavailable extends Error {}

const retryable = (status) => status === 429 || status >= 500;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Railway injects RAILWAY_* (service, project, environment, domains, git, volume ...), which always win. Operator-
// supplied API tokens share the prefix but are not injected, so Doppler must be able to provide them (the watchdog
// reads RAILWAY_API_TOKEN).
const OPERATOR_RAILWAY = new Set(["RAILWAY_API_TOKEN", "RAILWAY_TOKEN"]);
const platformOwned = (name) => name === "PORT" || (name.startsWith("RAILWAY_") && !OPERATOR_RAILWAY.has(name));
const signalCode = (signal) => 128 + (constants.signals[signal] ?? 0);

/** Fetch the token's config as a flat name -> value map, minus Doppler's own DOPPLER_* metadata. */
export async function fetchDopplerSecrets(token, { fetchImpl = fetch, sleep = pause, signal } = {}) {
  let failure = "unreachable";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    if (signal?.aborted) throw new DopplerUnavailable("interrupted");
    if (attempt > 1) await sleep(1000 * (attempt - 1));
    let status;
    let text;
    try {
      const timeout = AbortSignal.timeout(TIMEOUT_MS);
      const response = await fetchImpl(DOPPLER_DOWNLOAD_URL, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        redirect: "error",
        signal: signal && AbortSignal.any ? AbortSignal.any([timeout, signal]) : timeout,
      });
      status = response.status;
      if (response.ok) text = await response.text();
    } catch {
      failure = "unreachable";
      continue;
    }
    if (text === undefined) {
      failure = `HTTP ${status}`;
      if (retryable(status)) continue;
      break;
    }
    return parseSecrets(text);
  }
  throw new DopplerUnavailable(failure);
}

function parseSecrets(text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    // Fixed text only: a JSON parse error message quotes part of the body.
    throw new DopplerUnavailable("response is not JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new DopplerUnavailable("response is not an object");
  const secrets = Object.create(null);
  for (const [name, value] of Object.entries(body)) {
    if (!NAME.test(name)) throw new DopplerUnavailable("response has an invalid name");
    if (typeof value !== "string" || value.includes("\0")) throw new DopplerUnavailable("response has an invalid value");
    if (!name.startsWith("DOPPLER_")) secrets[name] = value;
  }
  return secrets;
}

/** Doppler values over the platform environment, except PORT and RAILWAY_*; the token never reaches the app. */
export function layerEnv(platform, secrets) {
  const env = { ...platform };
  for (const [name, value] of Object.entries(secrets)) if (!platformOwned(name)) env[name] = value;
  delete env.DOPPLER_TOKEN;
  return env;
}

/** Resolve to the child's exit code (128 + signal number when it, or the wrapper before spawning, got a signal). */
export async function run(argv, { env = process.env, fetchImpl = fetch, sleep = pause, spawn = nodeSpawn, proc = process } = {}) {
  const [command, ...args] = argv;
  if (!command) {
    console.error("doppler-run: usage: node scripts/doppler-run.mjs <command> [args...]");
    return 2;
  }
  let child;
  let received;
  const abort = new AbortController();
  const forward = (signal) => {
    if (child) child.kill(signal);
    else {
      received ??= signal;
      abort.abort();
    }
  };
  for (const signal of SIGNALS) proc.on(signal, forward);
  const stopForwarding = () => {
    for (const signal of SIGNALS) proc.off(signal, forward);
  };

  let childEnv = env;
  if (env.DOPPLER_TOKEN) {
    try {
      childEnv = layerEnv(env, await fetchDopplerSecrets(env.DOPPLER_TOKEN, { fetchImpl, sleep, signal: abort.signal }));
    } catch (error) {
      stopForwarding();
      if (received) return signalCode(received);
      const reason = error instanceof DopplerUnavailable ? error.message : "unexpected error";
      console.error(`doppler-run: Doppler settings unavailable (${reason}); not starting`);
      return 1;
    }
  } else if (env.RAILWAY_ENVIRONMENT_NAME) {
    stopForwarding();
    console.error("doppler-run: DOPPLER_TOKEN is not set on this Railway service; not starting");
    return 1;
  }
  if (received) {
    stopForwarding();
    return signalCode(received);
  }

  try {
    child = spawn(command, args, { env: childEnv, stdio: "inherit" });
  } catch {
    stopForwarding();
    console.error(`doppler-run: could not start ${command}`);
    return 1;
  }
  return new Promise((resolve) => {
    const done = (code) => {
      stopForwarding();
      resolve(code);
    };
    child.on("error", () => {
      // After a successful spawn, "error" only means a failed kill(); the "exit" event still settles the run.
      if (child.pid !== undefined) return;
      console.error(`doppler-run: could not start ${command}`);
      done(127);
    });
    child.on("exit", (code, signal) => done(code ?? signalCode(signal)));
  });
}

/* v8 ignore next 10 -- direct execution only */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // NODE_OPTIONS=--dns-result-order=ipv4first now arrives from Doppler for the child only; datacenter transport
  // needs it (docs/CONTEXT.md), so the wrapper's own Doppler request sets it too.
  setDefaultResultOrder("ipv4first");
  run(process.argv.slice(2)).then(
    (code) => process.exit(code),
    () => {
      console.error("doppler-run: failed to start");
      process.exit(1);
    },
  );
}
