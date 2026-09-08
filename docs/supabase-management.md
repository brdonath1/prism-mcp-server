# Direct Supabase administration through PRISM

PRISM 4.15 adds five infrastructure tools for authorized Supabase project work. They use HTTPS APIs directly; no browser SQL editor, database password, model provider, synthesis, or dispatch is involved. This capability does not authorize unrelated business actions or override the requesting project's existing data and deployment boundaries.

## Configuration

Set these server-side variables on the Railway PRISM service:

| Variable | Purpose |
| --- | --- |
| `MCP_AUTH_TOKEN` | Required transport credential. Any configured Supabase credential makes exact Bearer authentication mandatory across the service, protecting both new tools and existing environment access. Health checks remain public. |
| `AUTH_REQUIRE_BEARER` | Set `true` before adding credentials. Supabase credential presence independently enforces this protection, even with malformed configuration or this flag off. |
| `SUPABASE_ACCESS_TOKEN` | Supabase Management API personal access token. Prefer a scoped token covering the approved projects and required read/write permissions when available for the account. |
| `SUPABASE_PROJECT_REFS` | Comma-separated explicit project references. No wildcard or inferred projects. |
| `SUPABASE_PROJECT_CREDENTIALS_JSON` | Optional server-only JSON mapping each allowed reference to `{ "serviceRoleKey": "..." }` for Data API, Auth Admin, Storage and compatible Edge Function invocation. The value may be a legacy service-role JWT or modern secret API key. Management and SQL use the PAT separately. |

Missing or invalid required configuration leaves the category disabled. A configured capability is not proof that the supplied token has every upstream permission. Supabase roles, token scope, expiry and platform availability still apply. Project credentials are excluded from legacy subprocess environments; never put them in Git, tool examples, browser code or logs.

Issue tokens at [Supabase Access Tokens](https://supabase.com/dashboard/account/tokens). Scoped tokens are gradually available; classic tokens inherit the account's access, so PRISM's explicit project scope remains necessary. [Supabase token documentation](https://supabase.com/docs/guides/platform/personal-access-tokens)

## Tools

- `supabase_status`: report configured project references and capability readiness without credentials or customer records.
- `supabase_management_request`: call a Management API path relative to `/v1/projects/{project_ref}`. Supports JSON, text, binary and multipart bodies, including Edge Function deployment files. Project configuration, functions, secrets, database settings and other project Management endpoints remain available according to the token's permissions.
- `supabase_project_request`: call a project API under `rest/v1`, `auth/v1`, `storage/v1` or `functions/v1`. Supports bounded uploads and downloads; credentials are applied internally.
- `supabase_execute_sql`: send the complete SQL batch, optional parameters and read-only flag to the query endpoint. It does not rewrite SQL or automatically create a migration journal row.
- `supabase_apply_migration`: use Supabase's managed migration endpoint, which owns its journal entry and generated version.

For multiple configured projects, callers must select a project explicitly. A single configured project may be used as the default. Use an empty `path` for the exact project API root. These tools provide project-scoped API administration; organization/account operations, new project creation and endpoints outside the project prefix (such as branch deletion) are outside this surface. GraphQL, Realtime connections, TUS resumable uploads and S3 upload protocols are not exposed by these tools.

Upstream origins, project prefixes and request headers are controlled by the server. Callers cannot override authorization, follow redirects with credentials, or escape through an absolute URL or path traversal. The client limits bodies to 4 MiB, responses to 8 MiB and requests to 45 seconds; the MCP JSON envelope allows 8 MiB to accommodate base64 uploads. Credential-like response fields are masked unless intentional secret retrieval is explicitly requested; bridge credentials remain protected even then.

Edge Function deployment uses the Management API. Invocation uses the configured project credential; functions that require a particular user's JWT or a custom signature still require their own authenticated invocation path. This bridge does not impersonate users or override a function's authorization policy.

## SQL and migration operations

The [query endpoint](https://supabase.com/docs/reference/api/v1-run-a-query) supports SQL and parameters. The [migration endpoint](https://supabase.com/docs/reference/api/v1-apply-a-migration) accepts a query, optional name and rollback, but has no documented caller-specified migration version.

Porch Pop Collective's reviewed SQL release batches already manage exact migration versions, source hashes, transactions and history. Send those complete batches through `supabase_execute_sql`; do not feed them into `supabase_apply_migration`, which would add its own journal behavior. Preserve rollback preflight, statement/lock timeouts, retention assertions and read-only verification. Never replay an already-applied migration as a connectivity test.

Mutations are never automatically retried. A timeout, interrupted response or uncertain server error can mean the operation committed despite the missing receipt. Use the returned request/source hash and inspect current state before deciding whether a retry is safe. Parallelize preparation and review, while sequencing dependent production mutations.

## Required permissions and verification

Read-only SQL requires Database Read; mutating SQL requires Database Read-write. Managed migrations require Migrations Read-write. Auth configuration writes require both Auth Config and Project Settings write permission. Edge Function code and Edge Function Secrets are separate permission groups. Storage configuration is separate from bucket/object operations, which use the project's Storage API and its separately configured credential. [Permission matrix](https://supabase.com/docs/guides/platform/personal-access-tokens#permission-scopes)

After deployment, verify the exact source/version and authenticated tool list. Start with a project metadata request and `SELECT 1` in read-only mode. A rollback-only temporary-table probe can verify SQL write access without persistent application changes. Check migration history without adding a test migration. Probe the required Auth/Storage/configuration routes without retrieving customer records. Record which capabilities are verified versus merely configured; no read-only probe proves every possible write permission.

Run the repository tests, lint, typecheck and build before release. Integration tests must mock upstream APIs and provider modules. Do not use real credentials or create orders, users, payments, messages or persistent test data to validate the connector.
