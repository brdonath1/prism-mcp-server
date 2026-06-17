# PRISM Banner Specification — v4.1 (Unified Text + restored HTML/SVG widgets)

> **Banner-Spec-Version:** 4.1
> **Status:** SUPERSEDED as the authority (SRV-88). The live contract is owned
>   by the prism-framework templates (`_templates/banner-spec.md` +
>   `_templates/finalization-banner-spec.md`) and the server code
>   (`src/utils/banner.ts`, `BANNER_SPEC_VERSION`). This file is retained for
>   historical/reference context and kept version-aligned with the code.
> **Server:** prism-mcp-server (`src/utils/banner.ts` — `renderUnifiedBanner`,
>   `renderBootMastheadSvg`, `renderFinalizationBannerHtml`)
> **Consumers:** `core-template-mcp.md` (boot), `rules-session-end.md` (finalization)
> **Origin:** brief-439 / D-240 Phase B audit row R8 (unified text contract);
>   graphical HTML/SVG widgets restored in spec 4.0/4.1 (D-249, brief-447/448).

This document describes the PRISM banner contract: the line-by-line structure
of the boot and finalization banners, the `banner_spec_version` handshake, and
the null fallback. **Currency note (SRV-88):** the earlier 3.0 text claimed the
HTML widgets were permanently deprecated — that is no longer true. D-249
restored graphical widgets via NEW fields (`boot_masthead_svg`,
`finalization_banner_html`); the legacy always-null `banner_html` /
`synthesis_banner_html` fields were removed in brief-466 (SRV-114). `banner_text`
remains the universal text contract. The authoritative grammar now lives in the
framework templates + `src/utils/banner.ts`.

---

## 1. Design Principle — One Generator, One Format

Both banner surfaces are rendered by **one** server-side text generator
(`renderUnifiedBanner` in `src/utils/banner.ts`):

| Surface  | Tool                       | Response field |
|----------|----------------------------|----------------|
| boot     | `prism_bootstrap`          | `banner_text`  |
| finalize | `prism_finalize` (commit, full) | `banner_text`  |

Because both surfaces share a single code path, they are **byte-consistent
by construction**: line order, segment separators (`" | "`), the status icon
set (`✓` ok / `⚠` warn / `✗` critical), markdown stripping, the 200-char
resumption truncation, and blank-line placement cannot drift apart.
Surface-specific values (the `finalized` tag, the docs label, the list-block
label, the boot-only `[priority]` tag) are data routed through the same
grammar — never a second format.

`banner_text` is the universal text format every surface emits and the
`banner_data` structured fallback object is gone. Spec 4.0/4.1 additionally
restored OPTIONAL graphical widgets (D-249) as NEW, separate fields —
`boot_masthead_svg` (boot) and `finalization_banner_html` (finalize) — rendered
by `renderBootMastheadSvg` / `renderFinalizationBannerHtml`; `banner_text`
stays the guaranteed fallback when a widget render fails.

---

## 2. Unified Line Grammar

```
L1   PRISM v{templateVersion} | Session {N}[ finalized] | {MM-DD-YY HH:MM:SS} CST
L2   Handoff v{V} ({note}) | {D} decisions[ ({note})] | {C}/{T} docs {healthy|updated}
L3   {icon} {label}[ | {icon} {label}…]
L4?  Suggested: {display} — {rationale}
     (blank)
     Resumption: {text ≤200 chars, markdown stripped}
    [(blank)
     {Next:|Deliverables:}
     ▸ {item}[ [priority]]
     …]
    [(blank)
     ⚠ {warning}
     …]
```

Optional elements: the `Suggested:` line is omitted entirely (no blank
placeholder) when no recommendation exists; the list block is omitted when
there are no items; the warning block is omitted when there are no warnings.
Lines 1–3 are always present. Resumption text longer than 200 characters is
truncated to 197 + `...`.

### 2.1 Boot banner (surface `boot`)

| Element | Value |
|---------|-------|
| L1 session segment | `Session {N}` (no tag) |
| L1 templateVersion | live `core-template-mcp.md` version, falling back to the handoff's `Template Version`; `unknown` when unparseable |
| L2 handoff note | handoff size, e.g. `4.4KB` |
| L2 decision note | `{G} guardrails` (always present) |
| L2 docs label | `docs healthy` |
| L3 status row | tool checks: `bootstrap`, `push verified`/`push failed`, `template loaded`, `no scaling needed`/`scaling required` |
| L4 Suggested | from `recommended_session_settings` (brief-405 / D-191), position 4 — the line immediately after the status row |
| List block | `Next:` — handoff next steps; first item suffixed ` [priority]` |
| Warnings | bootstrap `warnings: string[]` verbatim, one `⚠ ` line each |

Example:

```
PRISM v2.19.1 | Session 29 | 04-04-26 07:47:30 CST
Handoff v33 (4.4KB) | 65 decisions (10 guardrails) | 10/10 docs healthy
✓ bootstrap | ✓ push verified | ✓ template loaded | ✓ no scaling needed
Suggested: Opus 4.7 · Adaptive off — Executional queue

Resumption: All S28 work complete. Verify IP allowlist deploy.

Next:
▸ Verify IP allowlist deploy (S28) [priority]
▸ Implement D-48 server-side (S26)
```

Rule 2 (core-template-mcp.md) consumes this field: lines 1–3 verbatim, the
client-computed Tool Surface line inserted as line 4, the `Suggested:` line
verbatim when present, and all remaining lines verbatim.

### 2.2 Finalization banner (surface `finalize`)

| Element | Value |
|---------|-------|
| L1 session segment | `Session {N} finalized` |
| L1 templateVersion | the `Template Version` declared by the committed handoff.md; `unknown` when absent/unparseable |
| L2 handoff note | `pushed` \| `push failed` \| `unverified` |
| L2 decision note | operator-supplied `banner_data.decisions_note`, omitted when absent |
| L2 docs label | `docs updated` — `{C}` = living documents successfully committed (both `.prism/` and legacy root layouts counted; domain decision files `decisions/{domain}.md` are NOT living documents and do not count), `{T}` = 10. The banner and the response's `confirmation` sentence share one counter, so they always agree and `{C} ≤ {T}` by construction. |
| L3 status row | phase steps: `audit`, `draft`, `commit`, `verified`. Defaults derive from the commit outcome; `banner_data.step_statuses` overrides win. The `full` action feeds its real audit/draft outcomes. |
| L4 Suggested | next-session recommendation classified from the committed handoff's `Next Steps` (brief-405 / D-191) |
| List block | `Deliverables:` — `banner_data.deliverables[].text`, or the default `{N} file(s) pushed`. No `[priority]` tag. Per-item `status` is accepted for backward compatibility but not rendered — push failures surface as warnings. |
| Warnings | one `⚠ Push failed: {path}` line per failed file |

Example:

```
PRISM v2.19.1 | Session 29 finalized | 04-04-26 18:30:00 CST
Handoff v34 (pushed) | 65 decisions | 6/10 docs updated
✓ audit | ✓ draft | ✓ commit | ✓ verified
Suggested: Sonnet 4.6 · Adaptive off — Mechanical queue

Resumption: All S29 work complete. Begin D-241 Phase C.

Deliverables:
▸ 6 files pushed
```

`prism_finalize` actions `commit` and `full` both return `banner_text`
(before brief-439 the `full` action returned no banner at all).

---

## 3. `banner_spec_version` Handshake

Drift between the server's banner output and the framework template that
renders it was previously undetectable. The handshake makes it visible:

1. **Server emits.** Every `prism_bootstrap` response and every
   `prism_finalize` response (audit, commit, full) carries
   `banner_spec_version` — the spec version of this document that the
   server's generator implements (currently `4.1`, the
   `BANNER_SPEC_VERSION` constant in `src/utils/banner.ts`).
2. **Template declares.** A framework template that consumes the banner
   declares the spec version it renders with a line of the form
   `Banner-Spec-Version: 4.1` (tolerated variants: bold/blockquote markup,
   space/underscore separators, optional `v` prefix). Placement: in the
   template header block, **after** the `Template Version:` line —
   `prism_bootstrap` prefers the explicit `Template Version` declaration,
   but keeping the order removes any ambiguity for older parsers.
3. **Server compares.** Where the server has template content in hand it
   parses the declaration and compares:
   - `prism_bootstrap` → `core-template-mcp.md` (the behavioral-rules
     template it already fetches; Rule 2 consumer),
   - `prism_finalize` audit → `rules-session-end.md` (Rule 11 Step 6
     consumer).
   The parsed value is returned as `template_banner_spec_version` (null
   when the template declares nothing).
4. **Mismatch ⇒ `BANNER_DRIFT`.** A declared version different from the
   server's adds a `BANNER_DRIFT` **warn** diagnostic to the response
   `diagnostics`. **Visibility only — never blocking.** Context carries
   `template_declared` and `server_emitted`.
5. **No declaration ⇒ no drift.** Templates that predate the handshake
   declare nothing; that is not drift and produces no diagnostic.

> Template-side adoption (declaring `Banner-Spec-Version` in
> `core-template-mcp.md` / `rules-session-end.md` and consuming the
> finalize `banner_text`) is a chat-side cross-repo follow-up to brief-439.
> The server side of the handshake is live regardless.

---

## 4. Null Fallback (single line)

When the unified renderer fails, the server does **not** return a null
`banner_text` (and never returns a structured `banner_data` object — that
pre-3.0 behavior contradicted the template's documented fallback). Instead
`banner_text` carries the Rule 2 single-line fallback, rendered by the same
module (`renderBannerFallback`):

```
PRISM | Session {N} | Handoff v{V} | {C}/{T} docs
```

- Boot: `{C}/{T}` = living-doc count (10/10).
- Finalize: `{C}` = successfully pushed file count (capped at `{T}` = 10).
- A `BANNER_RENDER_FALLBACK` warn diagnostic accompanies the boot fallback.

Client templates keep their own last-resort behavior for a genuinely null
field (Rule 2: construct the same single line from response fields; Rule 11
Step 6: minimal text confirmation) — but with the server-side fallback in
place, `banner_text: null` should not occur in practice.

---

## 5. Surface Status (current at spec 4.1)

| Field | Status | Behavior |
|-------|--------|----------|
| `banner_text` (boot + finalize) | **Live** | The universal text contract; always emitted. |
| `boot_masthead_svg` (bootstrap) | **Live** (D-249, brief-447) | SVG masthead for `visualize:show_widget`; `null` on render failure (then `banner_text` is the fallback). |
| `finalization_banner_html` (finalize commit/full) | **Live** (D-249, brief-447/448) | HTML widget for `visualize:show_widget`; `null` on render failure (then `banner_text` is the fallback). |
| `banner_html` (bootstrap) | **Removed** (brief-466 / SRV-114) | Was a permanently-`null` back-compat field; the live SVG widget uses `boot_masthead_svg`. |
| `synthesis_banner_html` (finalize commit) | **Removed** (brief-466 / SRV-114) | Was a permanently-`null` back-compat field. |
| `banner_data` (bootstrap) | **Removed** (brief-439) | The single-line fallback in `banner_text` replaces it. `project_display_name` is now a top-level bootstrap response field. |
| `banner_data` (finalize **input** param) | **Retained** | Optional banner customization input (`deliverables`, `decisions_note`, `step_statuses`) — still honored by the unified generator. Per-item deliverable `status` is accepted but not rendered. |

The text generator is the single source for `banner_text`; the graphical
widgets are produced by `renderBootMastheadSvg` / `renderFinalizationBannerHtml`
(restored in 4.0/4.1 after the brief-439 deletion described in §6).

---

## 6. Spec Version History

| Spec | Date | Change |
|------|------|--------|
| 1.0 | S? (D-35) | Server-rendered boot banner HTML for `visualize:show_widget`. |
| 2.0 | S? (D-46) | Finalization banner HTML added; banner-spec.md v2.0 referenced by `src/utils/banner.ts`. |
| 3.0 | 2026-06-04 (brief-439 / D-240 Phase B R8) | Unified text contract: one generator for boot + finalize `banner_text`; `banner_spec_version` handshake + `BANNER_DRIFT` diagnostic; HTML widgets deprecated (fields null); `banner_data` fallback removed; Rule 2 single-line fallback rendered server-side. |
| 4.0 | 2026-06-08 (brief-447 / D-249) | Graphical widgets RESTORED as new fields: `boot_masthead_svg` (boot) + `finalization_banner_html` (commit), rendered via `renderBootMastheadSvg` / `renderFinalizationBannerHtml` for `visualize:show_widget`. `banner_text` remains the guaranteed fallback. |
| 4.1 | 2026-06 (brief-448 + 4c242ed) | `finalization_banner_html` extended to the `action=full` surface (matching commit). Authority for the contract moved to the framework templates + `src/utils/banner.ts`. |

<!-- EOF: banner-spec.md -->
