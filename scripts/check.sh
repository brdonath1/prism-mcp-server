#!/usr/bin/env bash
# scripts/check.sh - CI parity for the `build-and-test` job (.github/workflows/ci.yml).
# Runs the exact job steps on the pinned runtime (mise.toml = .node-version; npm = packageManager):
# npm ci (lockfile must not change), lint, typecheck, npm audit (advisory, as CI continue-on-error; locally only with CHECK_AUDIT=1),
# build, vitest with the same placeholder env CI sets.
# Local: `mise trust && mise install` once per clone, then `scripts/check.sh` (it re-execs itself under
# `mise exec` when the Node on PATH is not the pin). CI calls this same script after setup-node.
# Green: writes .claude/check-ok (gitignored), which the commit-gate hook requires before `git commit`.
set -euo pipefail
cd "$(dirname "$0")/.."

want_node=$(tr -d ' \n' < .node-version)
want_npm=$(sed -nE 's/.*"packageManager": *"npm@([^"]+)".*/\1/p' package.json)
have_node=$(node --version 2>/dev/null | sed 's/^v//' || true)
if [ "$have_node" != "$want_node" ] && [ -z "${CHECK_SH_REEXEC:-}" ] && command -v mise >/dev/null 2>&1; then
  CHECK_SH_REEXEC=1 exec mise exec -- bash "$0" "$@"
fi
have_npm=$(npm --version 2>/dev/null || true)
echo "check.sh: node ${have_node:-missing} (pin $want_node), npm ${have_npm:-missing} (pin $want_npm)"
if [ "$have_node" != "$want_node" ]; then
  echo "check.sh: node on PATH is '${have_node:-missing}', the pin is $want_node. Run 'mise install' (mise.toml); never install a runtime by hand." >&2
  exit 1
fi
if [ "$have_npm" != "$want_npm" ]; then
  echo "check.sh: npm on PATH is '${have_npm:-missing}', packageManager pins npm@$want_npm (the npm bundled with Node $want_node). Use the pinned Node; never install npm globally." >&2
  exit 1
fi

# Placeholder values the CI test step sets; vitest never reaches GitHub with them.
export GITHUB_PAT="${GITHUB_PAT:-test-pat-not-real}"
export GITHUB_OWNER="${GITHUB_OWNER:-test-owner}"
export FRAMEWORK_REPO="${FRAMEWORK_REPO:-prism-framework}"

echo "== npm ci"
npm ci
git diff --quiet -- package-lock.json || { echo "check.sh: package-lock.json changed during npm ci; regenerate it in its own commit" >&2; exit 1; }
echo "== npm run lint"
npm run lint
echo "== npm run typecheck"
npm run typecheck
# npm audit never gates (CI runs it with continue-on-error) and takes minutes against the advisory
# endpoint from this host, so locally it runs only on request; CI always runs it.
if [ -n "${CI:-}" ] || [ -n "${CHECK_AUDIT:-}" ]; then
  echo "== npm audit --audit-level=high (advisory)"
  npm audit --audit-level=high || echo "check.sh: npm audit reported advisories; advisory only, as in CI (continue-on-error)"
else
  echo "== npm audit skipped locally (advisory in CI; CHECK_AUDIT=1 runs it)"
fi
echo "== npm run build"
npm run build
echo "== npm test"
npm test

mkdir -p .claude && date +%s > .claude/check-ok
echo "check.sh: green (node $have_node, npm $have_npm)"
