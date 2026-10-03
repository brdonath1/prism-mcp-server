/**
 * D-FINALIZE-SPLIT F0 contract helpers.
 *
 * Source-text pins on the finalize tool must keep guarding the code after it
 * moves out of src/tools/finalize.ts into src/tools/finalize/*.ts. These
 * helpers return the concatenation of the facade plus every extracted module
 * (sorted), and provide guarded slicing so a moved or renamed anchor fails
 * loudly instead of silently slicing the wrong text (indexOf === -1).
 */
import { readFileSync, readdirSync } from "fs";
import { expect } from "vitest";

const FINALIZE_FILE = "src/tools/finalize.ts";
const FINALIZE_DIR = "src/tools/finalize";

/** finalize.ts + every src/tools/finalize/*.ts (sorted), concatenated. */
export function readFinalizeSources(): string {
  const parts = [readFileSync(FINALIZE_FILE, "utf-8")];
  const modules = readdirSync(FINALIZE_DIR)
    .filter((f) => f.endsWith(".ts"))
    .sort();
  for (const f of modules) {
    parts.push(readFileSync(`${FINALIZE_DIR}/${f}`, "utf-8"));
  }
  return parts.join("\n");
}

/** Slice [start, end) with both anchors required to exist and be ordered. */
export function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  expect(start, `anchor not found: ${startMarker}`).toBeGreaterThan(-1);
  const end = source.indexOf(endMarker, start + 1);
  expect(end, `anchor not found after start: ${endMarker}`).toBeGreaterThan(-1);
  return source.slice(start, end);
}

/** One top-level function: from its signature to its column-0 closing brace. */
export function functionSection(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `function not found: ${signature}`).toBeGreaterThan(-1);
  const close = source.indexOf("\n}\n", start);
  expect(close, `no closing brace after: ${signature}`).toBeGreaterThan(-1);
  return source.slice(start, close + 3);
}
