# Runtime pins: Node 22.23.3, npm 10.9.9, one CI job on the pin file

Date: 2026-10-21 (wave-3 runtime-pin session; merged as PR #159, d63233e)

Decision: Node is pinned to 22.23.3 in `mise.toml` and `.node-version`, npm to the bundled 10.9.9 in package.json `packageManager`, and the Dockerfile base to `node:22.23.3-slim` by digest; `engines.node` stays `>=18.0.0` as documentation. `ci.yml` replaces the `[18, 20]` matrix (two majors production never ran) with one `build-and-test` job on `node-version-file: .node-version` that runs `scripts/check.sh`; `model-freshness.yml` reads the same pin file. `scripts/check.sh` refuses a Node or npm that differs from the pins (re-executing under `mise exec` locally), runs the exact job steps and stamps `.claude/check-ok`.

Why: what production runs is the only defensible pin. Railway production deployment c56f305d (main c892850, 2026-10-02) was built from the Dockerfile with `node:22-slim`, whose image config says NODE_VERSION=22.23.3; CI had been testing 18 and 20 instead. Local sessions discovered the runtime by trial.

Consequences: the required contexts were renamed from `build-and-test (18)`/`(20)` to `build-and-test` in branch protection on 2026-10-21 (Brian). Still open: the `ANTHROPIC_API_KEY` Actions secret has returned HTTP 401 to every weekly Model Freshness run since 2026-08-24 and needs rotation. The repository was unarchived for these two pull requests and is re-archived afterwards by decision. Codex's uncommitted work on `codex/004-checkpoint-publication` edits the same ci.yml and model-freshness.yml lines and will conflict when rebased; keep the `node-version-file` lines.

Source: wave-3 hand-over note (claude-environment-hygiene side-session notes, `wave3-runtime-pins.md`); `railway deployment` build log for c56f305d; `.github/workflows/ci.yml`, `scripts/check.sh`.
