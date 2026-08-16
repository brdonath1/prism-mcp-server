// S208 PR-S2b — boot payload contract.
//
// Two changes, two pinned contracts:
//
//  MCP-6  Single masthead. `BOOT_MASTHEAD=html|svg|off` (default `html`)
//         populates exactly ONE graphical masthead field; the other ships
//         `null`. Before this release both rendered on every boot and the
//         client picked one, so ~2.7KB of the payload was a duplicate the
//         session never rendered. The legacy `BOOT_MASTHEAD_SVG=off` knob
//         stays honored as an alias for `off`.
//
//  GAP-5  Manifest compaction. `session_state_manifest.rules` gains a
//         deduplicated `topic_names` dictionary with per-row `topics` as
//         INDICES into it, caps titles at 40 chars (was 60), and emits the
//         tier tag ONLY for Tier-C rows (B is the default). The two pinned
//         gates below are SIZE and PARITY: compaction that loses a rule, a
//         tier, or a topic is a regression no byte count would catch.
//
// The kernel's R35 consumption text is shape-agnostic by construction
// (prism-framework `_templates/core-template-mcp.md`, merged 2ad598d:
// "topics (inline strings or indices into `rules.topic_names`)"), so this
// server-side change needs no template coupling.
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";

import { resolveBootMasthead, resolveBootMastheadSvg } from "../src/config.js";
import { buildSessionStateManifest, truncateTitle40 } from "../src/tools/bootstrap.js";
import type { StandingRule } from "../src/utils/standing-rules.js";

// ─── MCP-6: the single-masthead knob ────────────────────────────────────────

describe("S208 MCP-6 — BOOT_MASTHEAD resolver", () => {
  const env = (vars: Record<string, string>): NodeJS.ProcessEnv => vars as NodeJS.ProcessEnv;

  it("defaults to html when neither the new nor the legacy variable is set", () => {
    expect(resolveBootMasthead(env({}))).toBe("html");
  });

  it("selects the named mode: html | svg | off", () => {
    expect(resolveBootMasthead(env({ BOOT_MASTHEAD: "html" }))).toBe("html");
    expect(resolveBootMasthead(env({ BOOT_MASTHEAD: "svg" }))).toBe("svg");
    expect(resolveBootMasthead(env({ BOOT_MASTHEAD: "off" }))).toBe("off");
  });

  it("is case- and whitespace-insensitive, and accepts the falsy spellings of off", () => {
    expect(resolveBootMasthead(env({ BOOT_MASTHEAD: "  SVG  " }))).toBe("svg");
    expect(resolveBootMasthead(env({ BOOT_MASTHEAD: "HTML" }))).toBe("html");
    for (const spelling of ["off", "false", "0", "no", "OFF"]) {
      expect(resolveBootMasthead(env({ BOOT_MASTHEAD: spelling }))).toBe("off");
    }
  });

  it("honors the legacy BOOT_MASTHEAD_SVG=off as an alias for off", () => {
    expect(resolveBootMasthead(env({ BOOT_MASTHEAD_SVG: "off" }))).toBe("off");
    expect(resolveBootMasthead(env({ BOOT_MASTHEAD_SVG: "false" }))).toBe("off");
    expect(resolveBootMasthead(env({ BOOT_MASTHEAD_SVG: "0" }))).toBe("off");
    expect(resolveBootMasthead(env({ BOOT_MASTHEAD_SVG: "no" }))).toBe("off");
    // Legacy ON (or a legacy typo) is the new default, not the SVG mode: the
    // legacy knob never named WHICH masthead, only whether any rendered.
    expect(resolveBootMasthead(env({ BOOT_MASTHEAD_SVG: "on" }))).toBe("html");
    expect(resolveBootMasthead(env({ BOOT_MASTHEAD_SVG: "weird" }))).toBe("html");
  });

  it("precedence: a recognized BOOT_MASTHEAD overrides the legacy variable in both directions", () => {
    expect(resolveBootMasthead(env({ BOOT_MASTHEAD: "svg", BOOT_MASTHEAD_SVG: "off" }))).toBe("svg");
    expect(resolveBootMasthead(env({ BOOT_MASTHEAD: "html", BOOT_MASTHEAD_SVG: "off" }))).toBe("html");
    expect(resolveBootMasthead(env({ BOOT_MASTHEAD: "off", BOOT_MASTHEAD_SVG: "on" }))).toBe("off");
  });

  it("an unrecognized BOOT_MASTHEAD falls through to the legacy knob — a typo never re-enables a disabled masthead", () => {
    expect(resolveBootMasthead(env({ BOOT_MASTHEAD: "hmtl" }))).toBe("html"); // legacy unset -> default
    expect(resolveBootMasthead(env({ BOOT_MASTHEAD: "hmtl", BOOT_MASTHEAD_SVG: "off" }))).toBe("off");
  });

  it("resolveBootMastheadSvg keeps its own semantics unchanged (legacy callers/tests)", () => {
    expect(resolveBootMastheadSvg(env({}))).toBe(true);
    expect(resolveBootMastheadSvg(env({ BOOT_MASTHEAD_SVG: "off" }))).toBe(false);
    expect(resolveBootMastheadSvg(env({ BOOT_MASTHEAD_SVG: "weird" }))).toBe(true);
  });
});

// ─── GAP-5: manifest compaction ─────────────────────────────────────────────

function rule(id: string, tier: "A" | "B" | "C", title: string, topics: string[]): StandingRule {
  return { id, title, procedure: `procedure for ${id}`, tier, topics };
}

/**
 * Deterministic registry fixture shaped like the LIVE prism registry, which
 * is what makes the size gate mean anything (synthetic short titles would
 * measure the fixture, not the compaction). Measured on
 * `/Users/brdonath/development/prism/.prism/standing-rules.md`, as of prism
 * 7bb470e7: 115 rules / 106 indexed (90 B + 16 C), mean title 119 chars,
 * 2.45 topics per rule, 117 distinct topic strings averaging ~8 chars.
 *
 * `indexed` here is the count of B+C rows (the rows that actually cost bytes);
 * eight Tier-A rules ride along so `tier_counts` is exercised too.
 */
function makeRegistryFixture(indexed: number): { all: StandingRule[]; indexed: StandingRule[] } {
  const stems = [
    "boot", "auth", "docs", "rules", "synth", "banner", "github", "railway",
    "routing", "payload", "manifest", "coverage", "telemetry", "finalize", "transport",
  ];
  const topicPool = Array.from({ length: 105 }, (_, i) => {
    const group = Math.floor(i / stems.length);
    return group === 0 ? stems[i % stems.length] : `${stems[i % stems.length]}${group + 1}`;
  });
  const longTitle = (n: number): string =>
    `INS-${n} standing rule title of representative length describing the failure mode and the procedure it pins`;

  const indexedRules = Array.from({ length: indexed }, (_, i) => {
    // 2.4 topics per rule, drawn deterministically from the pool.
    const count = i % 5 < 2 ? 3 : 2;
    const topics = Array.from({ length: count }, (_, k) => topicPool[(i * 3 + k * 17) % topicPool.length]);
    // ~1 in 6.5 rules is Tier C, mirroring the live 16/101 split.
    const tier = i % 7 === 3 ? "C" : "B";
    return rule(`INS-${100 + i}`, tier, longTitle(100 + i), [...new Set(topics)]);
  });
  const tierA = Array.from({ length: 8 }, (_, i) =>
    rule(`INS-${i + 1}`, "A", longTitle(i + 1), ["boot"]),
  );
  return { all: [...tierA, ...indexedRules], indexed: indexedRules };
}

/** The pre-compaction row shape (S202 `title60` + inline topic strings +
 *  an always-present tier tag) — the baseline the compaction is measured and
 *  parity-checked against. */
function legacyIndexRows(rules: StandingRule[]): Array<Record<string, unknown>> {
  return rules.map(r => ({
    id: r.id,
    t: r.tier,
    topics: r.topics,
    title60: r.title.length > 60 ? `${r.title.slice(0, 60).trimEnd()}…` : r.title,
  }));
}

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf-8");

describe("S208 GAP-5 — title40 cap", () => {
  it("passes short titles through untouched and caps at 40 chars + ellipsis", () => {
    expect(truncateTitle40("short title")).toBe("short title");
    expect(truncateTitle40("y".repeat(40))).toBe("y".repeat(40)); // exactly 40 -> untouched
    const capped = truncateTitle40("x".repeat(120));
    expect(capped.endsWith("…")).toBe(true);
    expect([...capped].length).toBeLessThanOrEqual(41);
  });

  it("never emits trailing whitespace before the ellipsis", () => {
    expect(truncateTitle40(`${"a".repeat(39)} tail`)).toBe(`${"a".repeat(39)}…`);
  });
});

describe("S208 GAP-5 — topic dictionary + tier defaulting", () => {
  const rules = [
    rule("INS-2", "B", "Rule two", ["synthesis", "transport"]),
    rule("INS-3", "B", "Rule three", ["finalize", "synthesis"]),
    rule("INS-4", "C", "Rule four", ["history"]),
    rule("INS-5", "B", "Rule five", []),
  ];
  const manifest = buildSessionStateManifest({
    docs: [],
    allRules: [rule("INS-1", "A", "Rule one", []), ...rules],
    indexedRules: rules,
    briefSynthesizedSession: null,
    deliveredBrief: null,
  });

  it("topic_names is the deduplicated dictionary of every indexed topic, in first-seen order", () => {
    expect(manifest.rules.topic_names).toEqual(["synthesis", "transport", "finalize", "history"]);
  });

  it("per-row topics are INDICES into topic_names and resolve back to the originals", () => {
    const byId = new Map(manifest.rules.index.map(r => [r.id, r]));
    expect(byId.get("INS-2")!.topics).toEqual([0, 1]);
    expect(byId.get("INS-3")!.topics).toEqual([2, 0]);
    expect(byId.get("INS-4")!.topics).toEqual([3]);
    expect(byId.get("INS-5")!.topics).toEqual([]);
    for (const row of manifest.rules.index) {
      for (const idx of row.topics) {
        expect(manifest.rules.topic_names[idx]).toBeTypeOf("string");
      }
    }
  });

  it("the tier tag is emitted ONLY for Tier-C rows — B is the default", () => {
    const byId = new Map(manifest.rules.index.map(r => [r.id, r]));
    expect(byId.get("INS-4")!.t).toBe("C");
    expect("t" in byId.get("INS-2")!).toBe(false);
    expect("t" in byId.get("INS-3")!).toBe(false);
    expect("t" in byId.get("INS-5")!).toBe(false);
  });

  it("tier_counts still counts the WHOLE registry, Tier A included", () => {
    expect(manifest.rules.total).toBe(5);
    expect(manifest.rules.tier_counts).toEqual({ A: 1, B: 3, C: 1 });
  });

  it("stays pure: empty inputs produce an empty-but-shaped manifest (topic_names included)", () => {
    expect(
      buildSessionStateManifest({
        docs: [],
        allRules: [],
        indexedRules: [],
        briefSynthesizedSession: null,
        deliveredBrief: null,
      }),
    ).toEqual({
      docs: [],
      rules: { total: 0, tier_counts: { A: 0, B: 0, C: 0 }, topic_names: [], index: [] },
      brief: { synthesized_session: null, sections: [] },
    });
  });
});

// ─── PINNED GATE (a): SIZE ──────────────────────────────────────────────────

describe("S208 GAP-5 — PINNED size gate at a 103-rule registry fixture", () => {
  const { all, indexed } = makeRegistryFixture(103);
  const manifest = buildSessionStateManifest({
    docs: [],
    allRules: all,
    indexedRules: indexed,
    briefSynthesizedSession: null,
    deliveredBrief: null,
  });

  /**
   * DERIVED, not tuned. A compacted row is
   * `{"id":"INS-NNN","topics":[i,j],"title40":"<=41 chars>"}`:
   *   braces + separators                    ~2 B
   *   `"id":"INS-NNN",`                      ~15 B
   *   `"topics":[i,j],`                   ~15-19 B
   *   `"title40":"<41 chars incl. U+2026>"`  ~53 B
   * = ~87 B per row floor, x 103 rows = ~9.0KB, plus the one-time
   * `topic_names` dictionary (105 live-shaped topic strings, ~1.2KB).
   * Ceiling 11,000 B leaves ~3% headroom over that arithmetic and nothing
   * like enough to absorb an un-capped title or an inline topic string.
   *
   * DEVIATION FROM PLAN v6 (recorded): the plan pinned <= 6,000 B. That
   * number descends from the stale "compact manifest index ~= 4.5KB" note in
   * `src/config.ts` (written at S202 against a much smaller registry) and is
   * unreachable under the shape the SAME plan mandates: 6,000 B / 103 rows =
   * 58 B per row, less than the 53 B a capped title plus the 15 B an `id`
   * already cost. The gate is pinned at the arithmetic floor of the mandated
   * shape instead, and paired with the relative gate below so it still has
   * teeth.
   *
   * HONEST FRAMING: 11,000 B is a FIXTURE SHAPE GATE fixed at 103 synthetic
   * rows — it does NOT bound the live payload, and the live registry has
   * already grown past the row count the fixture pins. For reference, not as
   * a gate: as of prism 7bb470e7, the live `{topic_names, index}` object
   * (106 indexed rows) measures 11,090 B (index 9,740 B + the 1,325 B
   * `topic_names` dictionary) — pre-compaction it was 14,685 B. This gate
   * would need re-pinning to a live row count if it were meant to cap
   * delivered bytes; it isn't — there is no pinned live-payload ceiling.
   * `scripts/measure-boot-payload.mjs` against the real corpus is how the
   * live number gets re-measured; it reports, it does not gate.
   */
  const RULES_INDEX_CEILING_BYTES = 11_000;

  it(`serializes rules (topic_names + index) in <= ${RULES_INDEX_CEILING_BYTES} B at 103 indexed rules`, () => {
    const measured = bytes({ topic_names: manifest.rules.topic_names, index: manifest.rules.index });
    expect(measured).toBeLessThanOrEqual(RULES_INDEX_CEILING_BYTES);
  });

  it("is at least 20% smaller than the pre-compaction shape on the same fixture", () => {
    const before = bytes(legacyIndexRows(indexed));
    const after = bytes({ topic_names: manifest.rules.topic_names, index: manifest.rules.index });
    expect(after).toBeLessThanOrEqual(before * 0.8);
  });

  it("caps every title and never inlines a topic string", () => {
    for (const row of manifest.rules.index) {
      expect([...row.title40].length).toBeLessThanOrEqual(41);
      for (const idx of row.topics) expect(typeof idx).toBe("number");
    }
  });
});

// ─── PINNED GATE (b): PARITY ────────────────────────────────────────────────

describe("S208 GAP-5 — PINNED parity gate: nothing becomes unreachable", () => {
  const { all, indexed } = makeRegistryFixture(103);
  const manifest = buildSessionStateManifest({
    docs: [],
    allRules: all,
    indexedRules: indexed,
    briefSynthesizedSession: null,
    deliveredBrief: null,
  });

  /** Resolve a compacted row the way the kernel's R35 consumer does: tier
   *  defaults to B when the tag is absent; topics dereference topic_names. */
  function resolveRow(row: { id: string; t?: string; topics: number[] }): {
    id: string;
    tier: string;
    topics: string[];
  } {
    return {
      id: row.id,
      tier: row.t ?? "B",
      topics: row.topics.map(i => manifest.rules.topic_names[i]),
    };
  }

  it("id-set equality: every indexed rule appears exactly once, and nothing extra appears", () => {
    const before = indexed.map(r => r.id).sort();
    const after = manifest.rules.index.map(r => r.id).sort();
    expect(after).toEqual(before);
    expect(new Set(after).size).toBe(after.length);
  });

  it("every rule's tier is resolvable post-compaction, including the defaulted B rows", () => {
    const resolved = new Map(manifest.rules.index.map(r => [r.id, resolveRow(r).tier]));
    for (const r of indexed) expect(resolved.get(r.id)).toBe(r.tier);
    // The defaulting is doing real work: most rows carry no tag at all.
    const untagged = manifest.rules.index.filter(r => r.t === undefined);
    expect(untagged.length).toBeGreaterThan(0);
    expect(untagged.every(r => resolveRow(r).tier === "B")).toBe(true);
  });

  it("every rule's topics are resolvable post-compaction, in order, with no lost strings", () => {
    const resolved = new Map(manifest.rules.index.map(r => [r.id, resolveRow(r).topics]));
    for (const r of indexed) expect(resolved.get(r.id)).toEqual(r.topics);
    // Every topic reachable by name yesterday is reachable today.
    const beforeTopics = new Set(indexed.flatMap(r => r.topics));
    const afterTopics = new Set([...resolved.values()].flat());
    expect(afterTopics).toEqual(beforeTopics);
  });

  it("the dictionary is deduplicated — no topic string is stored twice", () => {
    expect(new Set(manifest.rules.topic_names).size).toBe(manifest.rules.topic_names.length);
    // And it stores only topics that are actually referenced.
    const referenced = new Set(manifest.rules.index.flatMap(r => r.topics));
    expect(referenced.size).toBe(manifest.rules.topic_names.length);
  });

  it("holds on the pathological fixture too: duplicate, empty, and unicode topic sets", () => {
    const odd = [
      rule("INS-A", "B", "dup topics", ["synthesis", "synthesis"]),
      rule("INS-B", "C", "no topics", []),
      rule("INS-C", "B", "unicode topic", ["résumé", "synthesis"]),
    ];
    const m = buildSessionStateManifest({
      docs: [],
      allRules: odd,
      indexedRules: odd,
      briefSynthesizedSession: null,
      deliveredBrief: null,
    });
    const byId = new Map(m.rules.index.map(r => [r.id, r]));
    const names = m.rules.topic_names;
    expect(byId.get("INS-A")!.topics.map(i => names[i])).toEqual(["synthesis", "synthesis"]);
    expect(byId.get("INS-B")!.topics).toEqual([]);
    expect(byId.get("INS-B")!.t).toBe("C");
    expect(byId.get("INS-C")!.topics.map(i => names[i])).toEqual(["résumé", "synthesis"]);
    expect(new Set(names).size).toBe(names.length);
  });
});
