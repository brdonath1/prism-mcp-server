import { createHash } from "node:crypto";

export type SupabaseMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
export type SupabaseService = "rest" | "auth" | "storage" | "functions";
export interface SupabaseMultipartPart {
  name: string;
  value?: string;
  base64?: string;
  filename?: string;
  contentType?: string;
}
export interface SupabaseManagementRequest {
  projectRef: string;
  method: SupabaseMethod;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  textBody?: string;
  base64Body?: string;
  multipart?: SupabaseMultipartPart[];
  contentType?: string;
  headers?: Record<string, string>;
  revealSecrets?: boolean;
}
export interface SupabaseProjectRequest extends SupabaseManagementRequest {
  service: SupabaseService;
}
export interface SupabaseResponse {
  status: number;
  data?: unknown;
  text?: string;
  base64?: string;
  contentType: string;
  headers: Record<string, string>;
}
export interface SupabaseReadiness {
  ready: boolean;
  managementReady: boolean;
  projectApiReady: boolean;
  authConfigured: boolean;
  tokenConfigured: boolean;
  projectRefs: string[];
  projectCredentialRefs: string[];
  issues: string[];
}

export const SUPABASE_TIMEOUT_MS = 45_000;
export const SUPABASE_MAX_REQUEST_BYTES = 4 * 1024 * 1024;
export const SUPABASE_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const PROJECT_REF = /^[a-z0-9]{20}$/;
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
const SERVICES = new Set(["rest", "auth", "storage", "functions"]);
const REQUEST_HEADERS = new Set([
  "prefer",
  "range",
  "content-range",
  "if-match",
  "if-none-match",
  "x-upsert",
  "cache-control",
  "accept",
  "accept-profile",
  "content-profile",
]);
const RESPONSE_HEADERS = new Set([
  "content-range",
  "range",
  "etag",
  "last-modified",
  "cache-control",
  "retry-after",
  "x-request-id",
  "sb-request-id",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
]);
const REDACTED = "[REDACTED]";

/** Errors never include upstream bodies, URL query values, tokens or source text. */
export class SupabaseRequestError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly ambiguousMutation = false,
    public readonly requestHash?: string,
    public readonly sourceHash?: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "SupabaseRequestError";
  }
}

function invalid(message: string): never {
  throw new SupabaseRequestError(message, "INVALID_REQUEST");
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validSecret(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 16_384 &&
    !/\s|\p{Cc}/u.test(value)
  );
}
function configuration(env: NodeJS.ProcessEnv): {
  readiness: SupabaseReadiness;
  token: string;
  credentials: Map<string, string>;
  secrets: string[];
} {
  const issues: string[] = [];
  const tokenConfigured = validSecret(env.SUPABASE_ACCESS_TOKEN);
  const authConfigured = validSecret(env.MCP_AUTH_TOKEN);
  if (!tokenConfigured) issues.push("SUPABASE_ACCESS_TOKEN is missing or invalid.");
  if (!authConfigured) issues.push("MCP_AUTH_TOKEN is missing or invalid.");
  const rawRefs = env.SUPABASE_PROJECT_REFS;
  const refs =
    typeof rawRefs === "string" && rawRefs.length <= 4096
      ? rawRefs.split(",").map((ref) => ref.trim())
      : [];
  const validRefs =
    refs.length > 0 &&
    refs.every((ref) => PROJECT_REF.test(ref)) &&
    new Set(refs).size === refs.length;
  if (!validRefs)
    issues.push("SUPABASE_PROJECT_REFS must contain unique hosted project references.");
  const projectRefs = validRefs ? refs : [];
  const credentials = new Map<string, string>();
  const rawCredentials = env.SUPABASE_PROJECT_CREDENTIALS_JSON;
  if (rawCredentials !== undefined) {
    try {
      if (!rawCredentials || rawCredentials.length > 1024 * 1024) throw new Error();
      const parsed: unknown = JSON.parse(rawCredentials);
      if (!record(parsed)) throw new Error();
      for (const [ref, value] of Object.entries(parsed)) {
        if (
          !projectRefs.includes(ref) ||
          !record(value) ||
          Object.keys(value).length !== 1 ||
          !validSecret(value.serviceRoleKey)
        )
          throw new Error();
        credentials.set(ref, value.serviceRoleKey);
      }
    } catch {
      credentials.clear();
      issues.push(
        "SUPABASE_PROJECT_CREDENTIALS_JSON is malformed or contains unsupported project credentials.",
      );
    }
  }
  const ready = issues.length === 0;
  return {
    readiness: {
      ready,
      managementReady: ready,
      projectApiReady: ready && projectRefs.every((ref) => credentials.has(ref)),
      authConfigured,
      tokenConfigured,
      projectRefs,
      projectCredentialRefs: [...credentials.keys()],
      issues,
    },
    token: tokenConfigured ? env.SUPABASE_ACCESS_TOKEN! : "",
    credentials,
    secrets: [env.SUPABASE_ACCESS_TOKEN, env.MCP_AUTH_TOKEN, ...credentials.values()].filter(
      (value): value is string => !!value,
    ),
  };
}

/** Only configuration presence, valid project IDs and static diagnostics leave this function. */
export function getSupabaseReadiness(env: NodeJS.ProcessEnv = process.env): SupabaseReadiness {
  return configuration(env).readiness;
}

function pathWithinProject(path: unknown): string {
  if (typeof path !== "string" || path.length > 4096)
    invalid("A bounded relative Supabase path is required.");
  if (path === "") return "";
  let decoded = path;
  for (let pass = 0; pass < 8; pass++) {
    if (
      /[\\?#\p{Cc}]/u.test(decoded) ||
      decoded.startsWith("//") ||
      /^[a-z][a-z0-9+.-]*:/i.test(decoded)
    )
      invalid("Supabase path must remain within the selected project.");
    if (decoded.split("/").some((part) => part === "." || part === ".."))
      invalid("Supabase path traversal is not allowed.");
    if (/%(?:2f|5c)/i.test(decoded)) invalid("Encoded Supabase path separators are not allowed.");
    if (!decoded.includes("%")) return path.startsWith("/") ? path : `/${path}`;
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      invalid("Supabase path encoding is invalid.");
    }
  }
  invalid("Supabase path encoding is invalid.");
}

function headerValue(value: unknown): value is string {
  return typeof value === "string" && value.length <= 8192 && !/[\r\n\0]/.test(value);
}
function mimeType(value: unknown): string {
  if (!headerValue(value) || !/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+(?:[; ][^\r\n]*)?$/.test(value))
    invalid("Supabase content type is invalid.");
  return value;
}
function decodeBase64(value: unknown): Buffer {
  if (
    typeof value !== "string" ||
    value.length > Math.ceil(SUPABASE_MAX_REQUEST_BYTES / 3) * 4 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  )
    invalid("Supabase binary body must be bounded canonical base64.");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value)
    invalid("Supabase binary body must be bounded canonical base64.");
  return bytes;
}
function boundedText(value: string): Buffer {
  if (Buffer.byteLength(value) > SUPABASE_MAX_REQUEST_BYTES)
    invalid("Supabase request body exceeds the byte limit.");
  return Buffer.from(value);
}
function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
function multipartToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1024 &&
    !/["\\\p{Cc}]/u.test(value)
  );
}
function bodyFor(input: SupabaseManagementRequest): { bytes?: Buffer; contentType?: string } {
  const bodies = [input.body, input.textBody, input.base64Body, input.multipart].filter(
    (value) => value !== undefined,
  );
  if (bodies.length > 1) invalid("Choose exactly one Supabase request body format.");
  if (bodies.length && (input.method === "GET" || input.method === "HEAD"))
    invalid("GET and HEAD requests cannot include a body.");
  let bytes: Buffer | undefined;
  let contentType = input.contentType === undefined ? undefined : mimeType(input.contentType);
  if (input.body !== undefined) {
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(input.body);
    } catch {
      invalid("Supabase JSON body is not serializable.");
    }
    if (serialized === undefined) invalid("Supabase JSON body is not serializable.");
    bytes = boundedText(serialized);
    contentType ??= "application/json";
  } else if (input.textBody !== undefined) {
    if (typeof input.textBody !== "string") invalid("Supabase text body must be a string.");
    bytes = boundedText(input.textBody);
    contentType ??= "text/plain; charset=utf-8";
  } else if (input.base64Body !== undefined) {
    bytes = decodeBase64(input.base64Body);
    contentType ??= "application/octet-stream";
  } else if (input.multipart !== undefined) {
    if (
      !Array.isArray(input.multipart) ||
      input.multipart.length === 0 ||
      input.multipart.length > 100 ||
      input.contentType !== undefined
    )
      invalid("Supabase multipart body or content type is invalid.");
    let normalizedBytes = 0;
    const normalized = input.multipart.map((part) => {
      if (
        !record(part) ||
        Object.keys(part).some(
          (key) => !["name", "value", "base64", "filename", "contentType"].includes(key),
        ) ||
        !multipartToken(part.name) ||
        (part.filename !== undefined && !multipartToken(part.filename)) ||
        (part.value === undefined) === (part.base64 === undefined)
      )
        invalid("Supabase multipart part is invalid.");
      if (part.value !== undefined && typeof part.value !== "string")
        invalid("Supabase multipart value must be a string.");
      const value =
        part.base64 === undefined ? boundedText(part.value!) : decodeBase64(part.base64);
      normalizedBytes += value.length;
      if (normalizedBytes > SUPABASE_MAX_REQUEST_BYTES)
        invalid("Supabase request body exceeds the byte limit.");
      const type =
        part.contentType === undefined
          ? part.base64 === undefined
            ? "text/plain; charset=utf-8"
            : "application/octet-stream"
          : mimeType(part.contentType);
      return { name: part.name, filename: part.filename, value, type };
    });
    // Bind a deterministic boundary to validated bytes without serializing caller-controlled objects.
    const boundary = `prism-${hash(JSON.stringify(normalized.map((part) => ({ name: part.name, filename: part.filename, type: part.type, hash: hash(part.value) })))).slice(0, 40)}`;
    const parts: Buffer[] = [];
    let total = 0;
    const append = (value: string | Buffer) => {
      const length = typeof value === "string" ? Buffer.byteLength(value) : value.length;
      total += length;
      if (total > SUPABASE_MAX_REQUEST_BYTES)
        invalid("Supabase request body exceeds the byte limit.");
      parts.push(typeof value === "string" ? Buffer.from(value) : value);
    };
    for (const part of normalized) {
      append(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${part.filename === undefined ? "" : `; filename="${part.filename}"`}\r\nContent-Type: ${part.type}\r\n\r\n`,
      );
      append(part.value);
      append("\r\n");
    }
    append(`--${boundary}--\r\n`);
    bytes = Buffer.concat(parts);
    contentType = `multipart/form-data; boundary=${boundary}`;
  }
  if (bytes && bytes.length > SUPABASE_MAX_REQUEST_BYTES)
    invalid("Supabase request body exceeds the byte limit.");
  return { bytes, contentType };
}

function credentialField(key: string): boolean {
  const normalized = key.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
  return (
    /(?:^|_)(?:password|passwd|pass|secret|token|credential|credentials|authorization|apikey)(?:_|$)/.test(
      normalized,
    ) ||
    /(?:^|_)(?:api|private|service_role|signing|encryption)_?key(?:s)?(?:_|$)/.test(normalized) ||
    ["key", "jwt", "connection_string", "database_url"].includes(normalized)
  );
}
function scrubText(value: string, secrets: string[], reveal: boolean): string {
  let output = value;
  for (const secret of secrets) {
    for (const variant of new Set([
      secret,
      encodeURIComponent(secret),
      Buffer.from(secret).toString("base64"),
    ])) {
      if (variant) output = output.split(variant).join(REDACTED);
    }
  }
  if (!reveal) {
    output = output
      .replace(/\b(?:sbp_[A-Za-z0-9_-]+|sb_secret_[A-Za-z0-9_-]+)\b/g, REDACTED)
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
      .replace(/\bBearer\s+[^\s"'<>]+/gi, `Bearer ${REDACTED}`)
      .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, `$1${REDACTED}@`);
  }
  return output;
}
function redact(value: unknown, secrets: string[], reveal: boolean, depth = 0): unknown {
  if (depth > 80) return "[REDACTED: nesting limit]";
  if (typeof value === "string") return scrubText(value, secrets, reveal);
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets, reveal, depth + 1));
  if (record(value)) {
    const secretValue = typeof value.name === "string" && credentialField(value.name);
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        scrubText(key, secrets, reveal),
        !reveal && (credentialField(key) || (key === "value" && secretValue))
          ? REDACTED
          : redact(item, secrets, reveal, depth + 1),
      ]),
    );
  }
  return value;
}

/** Fixed-host transport. It neither discovers credentials nor retries requests. */
export class SupabaseClient {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  managementRequest(input: SupabaseManagementRequest): Promise<SupabaseResponse> {
    return this.request(input);
  }

  async projectRequest(input: SupabaseProjectRequest): Promise<SupabaseResponse> {
    if (!input || !SERVICES.has(input.service))
      invalid("Supabase project service is not supported.");
    return this.request(input, input.service);
  }

  private async request(
    input: SupabaseManagementRequest,
    service?: SupabaseService,
  ): Promise<SupabaseResponse> {
    const config = configuration(this.env);
    if (!config.readiness.ready)
      throw new SupabaseRequestError(
        "Supabase administration is not configured. Check readiness diagnostics.",
        "NOT_CONFIGURED",
      );
    if (!input || !config.readiness.projectRefs.includes(input.projectRef))
      invalid("Supabase project is not allowlisted.");
    if (!METHODS.has(input.method)) invalid("Supabase HTTP method is not supported.");
    if (service !== undefined && !SERVICES.has(service))
      invalid("Supabase project service is not supported.");
    const projectKey = service === undefined ? undefined : config.credentials.get(input.projectRef);
    if (service !== undefined && !projectKey)
      throw new SupabaseRequestError(
        "No project API credential is configured for the selected project.",
        "PROJECT_CREDENTIAL_MISSING",
      );
    const prefix =
      service === undefined
        ? `https://api.supabase.com/v1/projects/${input.projectRef}`
        : `https://${input.projectRef}.supabase.co/${service}/v1`;
    const path = pathWithinProject(input.path);
    const url = new URL(prefix + path);
    if (input.query !== undefined) {
      if (!record(input.query) || Object.keys(input.query).length > 100)
        invalid("Supabase query parameters are invalid.");
      for (const [key, value] of Object.entries(input.query)) {
        if (typeof value !== "string") invalid("Supabase query parameters must be strings.");
        url.searchParams.append(key, value);
      }
    }
    if (
      url.href.length > 65_536 ||
      (url.href !== prefix &&
        !url.href.startsWith(prefix + "/") &&
        !url.href.startsWith(prefix + "?"))
    )
      invalid("Supabase URL exceeds its allowed scope or length.");
    const headers: Record<string, string> = {};
    if (service === undefined) headers.Authorization = `Bearer ${config.token}`;
    if (projectKey) {
      headers.apikey = projectKey;
      // Modern secret keys are not JWTs; Supabase requires them on apikey only.
      if (!projectKey.startsWith("sb_secret_")) headers.Authorization = `Bearer ${projectKey}`;
    }
    if (input.headers !== undefined) {
      if (!record(input.headers) || Object.keys(input.headers).length > REQUEST_HEADERS.size)
        invalid("Supabase request headers are invalid.");
      const seen = new Set<string>();
      for (const [key, value] of Object.entries(input.headers)) {
        const name = key.toLowerCase();
        if (!REQUEST_HEADERS.has(name) || seen.has(name) || !headerValue(value))
          invalid("Supabase request header is not allowed.");
        seen.add(name);
        headers[name] = value;
      }
    }
    const { bytes, contentType } = bodyFor(input);
    if (contentType) headers["Content-Type"] = contentType;
    const sourceHash = hash(bytes ?? Buffer.alloc(0));
    const semanticHeaders = Object.entries(headers)
      .filter(([name]) => name.toLowerCase() !== "authorization" && name.toLowerCase() !== "apikey")
      .map(([name, value]) => [name.toLowerCase(), value])
      .sort(([a], [b]) => a!.localeCompare(b!));
    const requestHash = hash(
      JSON.stringify({ method: input.method, url: url.href, headers: semanticHeaders, sourceHash }),
    );
    const mutation = input.method !== "GET" && input.method !== "HEAD";
    const failure = (code: string, label: string, ambiguous = false, status?: number) =>
      new SupabaseRequestError(
        `${label} No automatic retry was attempted.${ambiguous ? " Mutation outcome is unknown; reconcile using requestHash and sourceHash before retrying." : ""}`,
        code,
        ambiguous,
        requestHash,
        sourceHash,
        status,
      );
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(failure("TIMEOUT", "Supabase request timed out.", mutation));
      }, SUPABASE_TIMEOUT_MS);
    });
    const perform = async (): Promise<SupabaseResponse> => {
      let response: Response;
      try {
        response = await fetch(url, {
          method: input.method,
          headers,
          body: bytes === undefined ? undefined : new Uint8Array(bytes).buffer,
          redirect: "error",
          signal: controller.signal,
        });
      } catch {
        throw failure(
          controller.signal.aborted ? "TIMEOUT" : "NETWORK_ERROR",
          controller.signal.aborted
            ? "Supabase request timed out."
            : "Supabase network request failed.",
          mutation,
        );
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw failure(
          "HTTP_ERROR",
          `Supabase API returned HTTP ${response.status}.`,
          mutation,
          response.status,
        );
      }
      const declaredSize = response.headers.get("content-length");
      if (
        declaredSize !== null &&
        (!/^\d+$/.test(declaredSize) || Number(declaredSize) > SUPABASE_MAX_RESPONSE_BYTES)
      ) {
        void response.body?.cancel().catch(() => undefined);
        throw failure(
          "RESPONSE_TOO_LARGE",
          "Supabase response exceeds the byte limit.",
          mutation,
          response.status,
        );
      }
      let payload: Buffer;
      try {
        const reader = response.body?.getReader();
        const chunks: Buffer[] = [];
        let total = 0;
        if (reader) {
          const cancelRead = () => {
            void reader.cancel().catch(() => undefined);
          };
          controller.signal.addEventListener("abort", cancelRead, { once: true });
          try {
            while (true) {
              const part = await reader.read();
              if (part.done) break;
              total += part.value.byteLength;
              if (total > SUPABASE_MAX_RESPONSE_BYTES) {
                void reader.cancel().catch(() => undefined);
                throw failure(
                  "RESPONSE_TOO_LARGE",
                  "Supabase response exceeds the byte limit.",
                  mutation,
                  response.status,
                );
              }
              chunks.push(Buffer.from(part.value));
            }
          } finally {
            controller.signal.removeEventListener("abort", cancelRead);
            reader.releaseLock();
          }
        }
        payload = Buffer.concat(chunks);
      } catch (error) {
        if (error instanceof SupabaseRequestError) throw error;
        throw failure(
          "RESPONSE_ERROR",
          "Supabase response could not be read.",
          mutation,
          response.status,
        );
      }
      const reveal = input.revealSecrets === true;
      const rawContentType = response.headers.get("content-type") ?? "application/octet-stream";
      const output: SupabaseResponse = {
        status: response.status,
        contentType: scrubText(rawContentType, config.secrets, false),
        headers: {},
      };
      for (const [key, value] of response.headers) {
        if (RESPONSE_HEADERS.has(key))
          output.headers[key] = scrubText(value, config.secrets, false);
      }
      if (!payload.length || input.method === "HEAD") return output;
      if (/\bjson\b|\+json\b/i.test(rawContentType)) {
        try {
          output.data = redact(JSON.parse(payload.toString("utf8")), config.secrets, reveal);
        } catch {
          throw failure(
            "INVALID_RESPONSE",
            "Supabase returned invalid JSON.",
            mutation,
            response.status,
          );
        }
      } else if (/^text\/|javascript|xml|x-www-form-urlencoded/i.test(rawContentType)) {
        const text = payload.toString("utf8");
        try {
          output.text = JSON.stringify(redact(JSON.parse(text), config.secrets, reveal));
        } catch {
          output.text = scrubText(text, config.secrets, reveal);
        }
      } else {
        // latin1 is reversible for every byte; redact any reflected bridge credentials before encoding.
        output.base64 = Buffer.from(
          scrubText(payload.toString("latin1"), config.secrets, reveal),
          "latin1",
        ).toString("base64");
      }
      return output;
    };
    try {
      return await Promise.race([perform(), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
