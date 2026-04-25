/**
 * Diagnostic surfacing — Phase 0b of the Framework Stabilization Initiative.
 *
 * Tool handlers populate a DiagnosticsCollector during execution and include
 * collector.list() in their response payload as the `diagnostics` field. This
 * makes warnings, retries, and partial failures visible to the chat operator
 * instead of being logged-only on Railway.
 *
 * Codes are stable identifiers (SCREAMING_SNAKE_CASE). Messages are short
 * human-readable strings (<200 chars). Context is optional structured data
 * for downstream analysis.
 */

export type DiagnosticLevel = "info" | "warn" | "error";

export interface Diagnostic {
  level: DiagnosticLevel;
  code: string;
  message: string;
  context?: Record<string, unknown>;
}

export class DiagnosticsCollector {
  private items: Diagnostic[] = [];

  add(d: Diagnostic): void {
    this.items.push(d);
  }

  info(code: string, message: string, context?: Record<string, unknown>): void {
    this.items.push({ level: "info", code, message, context });
  }

  warn(code: string, message: string, context?: Record<string, unknown>): void {
    this.items.push({ level: "warn", code, message, context });
  }

  error(code: string, message: string, context?: Record<string, unknown>): void {
    this.items.push({ level: "error", code, message, context });
  }

  list(): Diagnostic[] {
    return [...this.items];
  }

  isEmpty(): boolean {
    return this.items.length === 0;
  }

  count(): number {
    return this.items.length;
  }
}
