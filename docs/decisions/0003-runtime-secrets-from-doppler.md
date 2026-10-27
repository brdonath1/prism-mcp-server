# Runtime settings come from Doppler

Date: 2026-10-27 (Doppler migration; repo temporarily unarchived for this change)

Decision: production starts through `scripts/doppler-run.mjs` (the same zero-dependency wrapper as PlatformForge v2 and the Mac Studio scanner), set as the Railway service start command `node scripts/doppler-run.mjs npm start`; `railway.json` and the Dockerfile `CMD` are unchanged, so a deploy before the cut-over behaves exactly as today. The wrapper reads Doppler `prism-mcp/prd_prism_mcp` with the service's sealed, read-only `DOPPLER_TOKEN`, runs the app with those values (Doppler wins; `PORT` and Railway-injected `RAILWAY_*` stay Railway's; the token never reaches the app), refuses to start on Railway without a token, and exits 1 without starting when Doppler is unreachable after 3 attempts. The Dockerfile's `COPY . .` puts `scripts/` in the image.

Why: Brian's Doppler migration: one secret store, as few credentials on each platform as possible. All 51 Railway values were copied hash-identical first (doppler-migration changelog, 2026-10-27).

Changing a setting: edit Doppler `prism-mcp/prd_prism_mcp`, then redeploy or restart the service.
