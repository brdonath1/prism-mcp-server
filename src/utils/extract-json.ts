/**
 * Robust JSON extraction from AI responses (B.8).
 * Tries multiple strategies: direct parse, fence stripping, brace extraction.
 *
 * Lived in src/tools/finalize.ts until brief-s196c; moved here so the
 * openrouter quality gates (src/llm/openrouter.ts) can validate CS-1 draft
 * output without importing the finalize tool (which imports src/ai/client.ts,
 * which imports the gates — a module cycle). finalize.ts re-exports it, so
 * existing importers are unaffected.
 */
export function extractJSON(text: string): unknown {
  // Try direct parse first
  try { return JSON.parse(text.trim()); } catch { /* continue */ }
  // Strip markdown fences
  const fenceStripped = text.replace(/```(?:json)?\s*\n?/g, "").trim();
  try { return JSON.parse(fenceStripped); } catch { /* continue */ }
  // Find first { and last }
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try { return JSON.parse(text.slice(firstBrace, lastBrace + 1)); } catch { /* continue */ }
  }
  // Try array extraction
  const firstBracket = text.indexOf("[");
  const lastBracket = text.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    try { return JSON.parse(text.slice(firstBracket, lastBracket + 1)); } catch { /* continue */ }
  }
  throw new Error("Failed to extract JSON from AI response");
}
