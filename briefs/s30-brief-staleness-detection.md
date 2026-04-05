# S30 Brief: Brief Staleness Detection

> **Target repo:** `prism-mcp-server`
> **Priority:** Low -- quality-of-life improvement
> **Scope:** `src/tools/bootstrap.ts` only
> **Estimated impact:** No tool surface changes to input schema. Adds two optional fields to bootstrap response. INS-11 reconnect NOT required.

---

## Pre-Flight

```bash
cd ~/repos/prism-mcp-server && git pull origin main
```

---

## Changes

### Single change to `src/tools/bootstrap.ts`

The intelligence brief (`intelligence-brief.md`) is already fetched during bootstrap. Its header contains a line like:

```
> Last synthesized: S26 (04-01-26 22:36:39)
```

**Add these steps after the intelligence brief is loaded:**

1. **Parse the brief's session number.** Extract the session number from the "Last synthesized" line using a regex like `/Last synthesized:\s*S(\d+)/`. If the line isn't found or doesn't parse, set `briefSession` to `null`.

2. **Calculate age.** `brief_age_sessions = sessionCount - briefSession`. If `briefSession` is null, set `brief_age_sessions` to null.

3. **Add to bootstrap response object.** Add a new field:
   ```typescript
   brief_age_sessions: briefAgeResult,  // number | null
   ```
   Place it near the existing `intelligence_brief` field.

4. **Add warning if stale.** If `brief_age_sessions` is not null and > 2, push a warning to the existing `warnings` array:
   ```typescript
   `Intelligence brief is ${briefAge} sessions old (last synthesized S${briefSession}). Consider running prism_synthesize to refresh.`
   ```

**That's it.** No other files need changes. The `warnings` array already exists in the bootstrap response and is rendered in the boot banner.

---

## Verification

```bash
# 1. Build succeeds
npm run build

# 2. All existing tests pass
npx vitest run

# 3. Verify the new field exists in the response type
grep -n 'brief_age_sessions' src/tools/bootstrap.ts
# Expected: at least 2 matches (calculation + response object)

# 4. Verify the warning condition exists
grep -n 'sessions old' src/tools/bootstrap.ts
# Expected: 1 match (warning message)
```

---

## Post-Flight

```bash
git add -A
git commit -m "fix: add brief_age_sessions staleness detection to bootstrap (S30)"
git push origin main
```

Railway auto-deploys. No connector reconnect needed (INS-11 -- output-only additive change).

---

## Data source pinning (INS-13)

- `briefSession` is parsed from the `intelligence-brief.md` file content, which is already fetched by bootstrap. Do NOT add a separate fetch call.
- `sessionCount` comes from the handoff's session count, already parsed during bootstrap. Use the same variable.
- The `warnings` array already exists in the bootstrap response construction. Append to it, do not create a new one.

<!-- EOF: s30-brief-staleness-detection.md -->
