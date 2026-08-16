// S208 PR-S1 - finalize + banner reliability, unit level.
//
// Covers the pure/near-pure halves of MCP-3 (no fabricated Session/Handoff
// numbers on error exits), MCP-2 (network-safe decision count with an
// "(unverified)" render), GAP-9 (missing session-log warning), and the
// widget_channel compose/condensation exemptions.
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/utils/doc-resolver.js", () => ({
  resolveDocPath: vi.fn(),
}));

import { resolveDocPath } from "../src/utils/doc-resolver.js";
import {
  renderBannerFallback,
  renderUnifiedBanner,
  renderBootMastheadSvg,
  renderBootMastheadHtml,
  renderFinalizationBannerHtml,
  type UnifiedBannerInput,
  type FinalizationBannerHtmlInput,
} from "../src/utils/banner.js";
import {
  assembleFinalizeErrorBannerFields,
  assembleFinalizeBanner,
} from "../src/tools/finalize/banner.js";
import { assembleBootErrorBannerFields } from "../src/tools/bootstrap.js";
import { composeDraftFiles } from "../src/tools/finalize.js";
import { condenseToMaxItems } from "../src/tools/scale.js";
import { DiagnosticsCollector } from "../src/utils/diagnostics.js";

const mockResolveDocPath = vi.mocked(resolveDocPath);

const HANDOFF = [
  "## Meta",
  "- Handoff Version: 34",
  "- Session Count: 29",
  "- Template Version: v2.29.0",
  "- Status: Active",
  "",
  "## Critical Context",
  "1. First critical item",
  "",
  "## Where We Are",
  "Banner reliability work.",
  "",
  "## Next Steps",
  "1. Ship PR-S1",
  "",
  "<!-- EOF: handoff.md -->",
].join("\n");

const DECISION_INDEX = [
  "| ID | Title | Status | Session |",
  "|----|-------|--------|---------|",
  "| D-1 | One | Active | 1 |",
  "| D-2 | Two | Active | 2 |",
  "| D-3 | Three | Active | 3 |",
  "",
].join("\n");

function baseBootInput(overrides: Partial<UnifiedBannerInput> = {}): UnifiedBannerInput {
  return {
    surface: "boot",
    templateVersion: "3.2.0",
    sessionNumber: 30,
    timestamp: "08-16-26 12:00:00",
    handoffVersion: 34,
    handoffNote: "4.4KB",
    decisionCount: 65,
    decisionNote: "10 guardrails",
    docCount: 10,
    docTotal: 10,
    statusRow: [{ label: "bootstrap", status: "ok" }],
    resumption: "Resume here.",
    listItems: ["Do the thing"],
    warnings: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.FINALIZE_BANNER;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("MCP-3 - renderBannerFallback never fabricates a session or handoff number", () => {
  it("renders 'Session ?' when the session number is unknown", () => {
    const line = renderBannerFallback({
      sessionNumber: null,
      handoffVersion: 5,
      docCount: null,
      docTotal: 10,
    });
    expect(line).toBe("PRISM | Session ? | Handoff v5 | ?/10 docs (unverified)");
  });

  it("renders 'Handoff v?' (capital H) when the handoff version is unknown", () => {
    const line = renderBannerFallback({
      sessionNumber: 25,
      handoffVersion: null,
      docCount: null,
      docTotal: 10,
    });
    expect(line).toBe("PRISM | Session 25 | Handoff v? | ?/10 docs (unverified)");
  });

  it("both unknown renders both placeholders", () => {
    expect(
      renderBannerFallback({
        sessionNumber: null,
        handoffVersion: null,
        docCount: null,
        docTotal: 10,
      }),
    ).toBe("PRISM | Session ? | Handoff v? | ?/10 docs (unverified)");
  });

  it("known values render exactly as before (no regression)", () => {
    expect(
      renderBannerFallback({
        sessionNumber: 25,
        handoffVersion: 5,
        docCount: 7,
        docTotal: 10,
      }),
    ).toBe("PRISM | Session 25 | Handoff v5 | 7/10 docs");
  });
});

describe("MCP-3 - assembleFinalizeErrorBannerFields accepts a null handoff version", () => {
  it("null handoff version renders 'Handoff v?', not a fabricated v1", () => {
    const fields = assembleFinalizeErrorBannerFields(25, null);
    expect(fields.banner_text).toBe("PRISM | Session 25 | Handoff v? | ?/10 docs (unverified)");
    expect(fields.banner_text).not.toContain("Handoff v1");
    expect(fields.finalization_banner_html).toBeNull();
  });
});

describe("MCP-3 - assembleBootErrorBannerFields (the boot mirror)", () => {
  it("emits a banner on a pre-resolution exit with no session or handoff facts", () => {
    const fields = assembleBootErrorBannerFields({ sessionNumber: null, handoffVersion: null });
    expect(fields.banner_text).toBe("PRISM | Session ? | Handoff v? | ?/10 docs (unverified)");
    expect(fields.banner_spec_version).toBe("4.3");
    expect(fields.boot_masthead_svg).toBeNull();
    expect(fields.boot_masthead_html).toBeNull();
  });

  it("carries whatever the boot DID resolve", () => {
    const fields = assembleBootErrorBannerFields({ sessionNumber: 31, handoffVersion: 34 });
    expect(fields.banner_text).toBe("PRISM | Session 31 | Handoff v34 | ?/10 docs (unverified)");
  });

  it("emits no session-name fence (the template omits rather than name wrongly)", () => {
    const fields = assembleBootErrorBannerFields({ sessionNumber: null, handoffVersion: null });
    expect(Object.keys(fields).sort()).toEqual([
      "banner_spec_version",
      "banner_text",
      "boot_masthead_html",
      "boot_masthead_svg",
    ]);
  });
});

describe("MCP-2/MCP-13 - an unverified count renders '?', never a confident zero", () => {
  it("renderUnifiedBanner renders '? decisions (unverified)'", () => {
    const text = renderUnifiedBanner(baseBootInput({ decisionCount: null, decisionNote: null }));
    expect(text).toContain("? decisions (unverified)");
    expect(text).not.toContain("0 decisions");
  });

  it("renderUnifiedBanner keeps an operator note alongside the unverified marker", () => {
    const text = renderUnifiedBanner(
      baseBootInput({ surface: "finalize", decisionCount: null, decisionNote: "2 new" }),
    );
    expect(text).toContain("? decisions (unverified; 2 new)");
  });

  it("renderUnifiedBanner renders '?/10 docs (unverified)' for a null doc count", () => {
    const text = renderUnifiedBanner(baseBootInput({ docCount: null }));
    expect(text).toContain("?/10 docs (unverified)");
    expect(text).not.toContain("10/10 docs healthy");
  });

  it("renderBootMastheadSvg renders the unverified chips", () => {
    const svg = renderBootMastheadSvg(
      baseBootInput({ decisionCount: null, decisionNote: null, docCount: null }),
    );
    expect(svg).toContain("? decisions (unverified)");
    expect(svg).toContain("?/10 docs (unverified)");
  });

  it("renderBootMastheadHtml renders the unverified chips", () => {
    const html = renderBootMastheadHtml(
      baseBootInput({ decisionCount: null, decisionNote: null, docCount: null }),
    );
    expect(html).toContain("? decisions (unverified)");
    expect(html).toContain("?/10 docs (unverified)");
  });

  it("renderFinalizationBannerHtml renders '? decisions (unverified)'", () => {
    const input: FinalizationBannerHtmlInput = {
      templateVersion: "3.2.0",
      sessionNumber: 29,
      timestamp: "08-16-26 12:00:00",
      handoffFromVersion: 33,
      handoffToVersion: 34,
      handoffStatus: "pushed",
      decisionCount: null,
      decisionDelta: null,
      docCount: 10,
      docTotal: 10,
      statusRow: [{ label: "commit", status: "ok" }],
      deliverables: ["1 file pushed"],
    };
    const html = renderFinalizationBannerHtml(input);
    expect(html).toContain("? decisions (unverified)");
    expect(html).not.toContain("0 decisions");
  });

  it("numeric counts render exactly as before (no regression)", () => {
    const text = renderUnifiedBanner(baseBootInput());
    expect(text).toContain("65 decisions (10 guardrails)");
    expect(text).toContain("10/10 docs healthy");
  });
});

describe("MCP-2 - assembleFinalizeBanner is network-safe", () => {
  const results = [
    { path: "handoff.md", success: true, verified: true },
    { path: "session-log.md", success: true, verified: true },
  ];
  const files = [
    { path: "handoff.md", content: HANDOFF },
    { path: "session-log.md", content: "# Session Log\n" },
  ];

  it("prefers a files[] decision index and never touches the network", async () => {
    mockResolveDocPath.mockImplementation(() => new Promise(() => {}));
    const withIndex = [...files, { path: "decisions/_INDEX.md", content: DECISION_INDEX }];
    const { text } = await assembleFinalizeBanner(
      "test-project",
      29,
      34,
      withIndex,
      [...results, { path: "decisions/_INDEX.md", success: true, verified: true }],
      true,
    );
    expect(text).toContain("3 decisions");
    expect(mockResolveDocPath).not.toHaveBeenCalled();
  });

  it("uses the audit's already-computed count when one is supplied", async () => {
    mockResolveDocPath.mockImplementation(() => new Promise(() => {}));
    const { text } = await assembleFinalizeBanner(
      "test-project",
      29,
      34,
      files,
      results,
      true,
      undefined,
      undefined,
      41,
    );
    expect(text).toContain("41 decisions");
    expect(mockResolveDocPath).not.toHaveBeenCalled();
  });

  it("a hung decision-index read loses the 3s race and renders '(unverified)'", async () => {
    vi.useFakeTimers();
    mockResolveDocPath.mockImplementation(() => new Promise(() => {}));
    const promise = assembleFinalizeBanner("test-project", 29, 34, files, results, true);
    await vi.advanceTimersByTimeAsync(3_100);
    const { text } = await promise;
    expect(text).toContain("? decisions (unverified)");
    expect(text).not.toContain("0 decisions");
  });

  it("a fast decision-index read still reports the real count", async () => {
    mockResolveDocPath.mockResolvedValue({
      content: DECISION_INDEX,
      sha: "s",
      path: ".prism/decisions/_INDEX.md",
    } as never);
    const { text } = await assembleFinalizeBanner("test-project", 29, 34, files, results, true);
    expect(text).toContain("3 decisions");
  });

  it("a rejected read with no files[] fallback renders '(unverified)'", async () => {
    mockResolveDocPath.mockRejectedValue(new Error("Not found"));
    const { text } = await assembleFinalizeBanner("test-project", 29, 34, files, results, true);
    expect(text).toContain("? decisions (unverified)");
  });
});

describe("GAP-9 - FINALIZE_MISSING_SESSION_LOG", () => {
  beforeEach(() => {
    mockResolveDocPath.mockRejectedValue(new Error("Not found"));
  });

  it("warns when handoff.md committed without session-log.md", async () => {
    const diagnostics = new DiagnosticsCollector();
    const { text } = await assembleFinalizeBanner(
      "test-project",
      29,
      34,
      [{ path: "handoff.md", content: HANDOFF }],
      [{ path: "handoff.md", success: true, verified: true }],
      true,
      undefined,
      diagnostics,
    );
    const entry = diagnostics.list().find((d) => d.code === "FINALIZE_MISSING_SESSION_LOG");
    expect(entry).toBeDefined();
    expect(entry!.level).toBe("warn");
    expect(text).toContain("session-log.md was not committed");
  });

  it("stays silent when session-log.md rode along", async () => {
    const diagnostics = new DiagnosticsCollector();
    await assembleFinalizeBanner(
      "test-project",
      29,
      34,
      [
        { path: "handoff.md", content: HANDOFF },
        { path: "session-log.md", content: "# Session Log\n" },
      ],
      [
        { path: "handoff.md", success: true, verified: true },
        { path: "session-log.md", success: true, verified: true },
      ],
      true,
      undefined,
      diagnostics,
    );
    expect(
      diagnostics.list().some((d) => d.code === "FINALIZE_MISSING_SESSION_LOG"),
    ).toBe(false);
  });

  it("stays silent when handoff.md itself failed to push", async () => {
    const diagnostics = new DiagnosticsCollector();
    await assembleFinalizeBanner(
      "test-project",
      29,
      34,
      [{ path: "handoff.md", content: HANDOFF }],
      [{ path: "handoff.md", success: false, verified: false }],
      false,
      undefined,
      diagnostics,
    );
    expect(
      diagnostics.list().some((d) => d.code === "FINALIZE_MISSING_SESSION_LOG"),
    ).toBe(false);
  });
});

describe("widget_channel - the compose gate exempts the flag item", () => {
  function handoffWithItems(items: string[]): string {
    return [
      "## Meta",
      "- Handoff Version: 34",
      "- Session Count: 29",
      "- Template Version: v2.29.0",
      "- Status: Active",
      "",
      "## Critical Context",
      ...items.map((t, i) => `${i + 1}. ${t}`),
      "",
      "## Where We Are",
      "Compose gate check.",
      "",
      "<!-- EOF: handoff.md -->",
    ].join("\n");
  }

  it("6 items whose 6th is the widget_channel flag PASSES the 5-item cap", () => {
    const items = [
      "Item one",
      "Item two",
      "Item three",
      "Item four",
      "Item five",
      "widget_channel: down - skip show_widget this session",
    ];
    const outcome = composeDraftFiles({ handoff_md: handoffWithItems(items) }, {});
    expect(outcome.ok).toBe(true);
  });

  it("6 substantive items still FAIL the cap", () => {
    const items = [
      "Item one",
      "Item two",
      "Item three",
      "Item four",
      "Item five",
      "Item six",
    ];
    const outcome = composeDraftFiles({ handoff_md: handoffWithItems(items) }, {});
    expect(outcome.ok).toBe(false);
    if (outcome.ok === false) {
      const handoffFailure = outcome.gate_failures?.find((f) => f.path === "handoff.md");
      expect(handoffFailure?.errors.join(" ")).toContain("Critical Context");
    }
  });
});

describe("widget_channel - condensation preserves the flag", () => {
  const body = [
    "1. Item one",
    "2. Item two",
    "3. Item three",
    "4. Item four",
    "5. Item five",
    "6. widget_channel: down - skip show_widget this session",
  ].join("\n");

  it("condenseToMaxItems(5) keeps the flag as a 6th survivor", () => {
    const out = condenseToMaxItems(body, 5);
    expect(out).toContain("widget_channel: down");
    expect(out).toContain("Item five");
  });

  it("condenseToMaxItems still drops substantive overflow", () => {
    const overflow = [body, "7. Item seven"].join("\n");
    const out = condenseToMaxItems(overflow, 5);
    expect(out).toContain("widget_channel: down");
    expect(out).not.toContain("Item seven");
  });
});
