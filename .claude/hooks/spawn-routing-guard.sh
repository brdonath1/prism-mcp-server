#!/usr/bin/env bash
# harness-kit: v3.0.0 owned — written by apply-harness-kit.sh (brdonath1/prism-framework/_templates/harness-kit); hand edits are overwritten on the next apply
# PreToolUse hook — Rule 0 spawn routing guard (D-34): every Task, Agent or Workflow
# spawn must carry an explicit class-routed model pin (haiku|sonnet|opus|fable); the
# host model is NEVER the inherited default. Denies any Task/Agent spawn with no
# model, or a model outside that alias set, and any Workflow whose script contains an
# agent( call missing its own top-level model: pin. Any other tool is allowed
# silently.
#
# Machine-wide, no scope gate: no roster check, no .prism/ check — this fires
# wherever it is wired (per-repo via harness-kit v3 at .claude/hooks/, and at user
# scope as ~/.claude/hooks/prism-spawn-routing-guard.sh so it runs in EVERY Claude
# Code session on this machine, identical bytes after 3.0.0 rendering).
# See reference/spawn-routing.md and .prism/decisions/_INDEX.md D-34.
#
# Contract: Claude Code PreToolUse hook. Reads stdin JSON {tool_name, tool_input,
# cwd, ...}. Denies by printing one single-line hookSpecificOutput JSON object to
# stdout; allows by printing nothing to stdout. Always exits 0 — the decision lives
# on stdout, never in the exit code. Fails OPEN (allows, with exactly one stderr
# note) only for a tooling failure: python3 missing, python3 exiting non-zero (e.g.
# an unexpected traceback), or empty/malformed stdin JSON. A Workflow spawn whose
# script text cannot be obtained at all (no script and no scriptPath, or an
# unreadable scriptPath) is DENIED, not fail-opened — pins cannot be verified, so
# per Rule 0 the spawn is refused rather than let through.
#
# Portable: bash 3.2 (macOS /bin/bash) and bash 5 (Ubuntu) alike. No arrays, no
# `declare -A`, no `mapfile`. All JSON parsing and the Workflow script scan live in
# the single embedded python3 program below. The shell layer only checks for
# python3 on PATH, captures that program's source into a variable with a plain
# heredoc redirection into `read` (`read -r -d '' PY_PROG <<'PY' ... PY`), and runs
# it with `python3 -c "$PY_PROG"`. This is deliberate, and the exact form matters:
#   - Piping the hook's stdin JSON through an exported environment variable (an
#     earlier revision of this script) is bounded by ARG_MAX — a payload anywhere
#     near it fails outright ("Argument list too long"), silently fail-open.
#     Capturing only the ~13 KB python SOURCE this way, and letting python3 read
#     the (arbitrarily large) JSON payload itself off `sys.stdin.buffer`, removes
#     that bound entirely — the size limit that matters is fixed and tiny, not
#     tied to the caller's payload.
#   - `PY_PROG=$(cat <<'PY' ... PY)` (a heredoc wrapped in a `$(...)` command
#     substitution) was tried first and rejected: bash's scan for the matching
#     `)` of a `$(...)` is not fully heredoc-opaque in practice — an unbalanced
#     count of `` ` `` or quote characters inside the heredoc body (routine in a
#     ~13 KB python program full of docstrings, regexes and comments) can make
#     bash misparse where the command substitution ends, breaking `bash -n` on
#     this very file. `read -r -d '' PY_PROG <<'PY' ... PY` is a plain heredoc
#     redirection with no command substitution involved, so the body is read
#     verbatim regardless of its quote/backtick content.
# python3's exit status is captured and, if non-zero, reported as one stderr note
# before the unconditional final `exit 0` — so a python-side crash can never turn
# into a silent, unreported allow.
set -u

if ! command -v python3 >/dev/null 2>&1; then
  printf '%s\n' "spawn-routing-guard: python3 not found on PATH — allowing spawn (Rule 0 guard fail-open)" >&2
  exit 0
fi

# read -d '' hits EOF (never finds its NUL delimiter) at the heredoc's end, which
# gives it a non-zero exit status even though PY_PROG is populated correctly —
# expected and harmless here since nothing branches on it and `set -e` is not in
# effect.
read -r -d '' PY_PROG <<'PY'
import json
import os
import re
import sys

# Rule 0's class map sentence, copied verbatim (D-34; _templates/core-template-mcp.md
# and _templates/core-template.md, "## Operating Posture"). Every deny reason below
# must teach this so the caller can self-correct.
CLASS_MAP = (
    "Map: mechanical/seeding/stat-gathering → `haiku` or `sonnet`; "
    "review-verified builds → `sonnet` (`opus` for the hardest); "
    "reviews/specs → `opus`; binding verdicts at gates ONLY → `fable`, "
    "and a Fable host renders those in-session, never by spawn."
)

ALIASES = ("haiku", "sonnet", "opus", "fable")
ALIAS_RE = re.compile(r'(haiku|sonnet|opus|fable)')
# The `model` key test applied to an object-literal's raw text (brief-specified
# regex), and the tail-value extractor applied to the ORIGINAL (unblanked) text
# immediately after a confirmed top-level key match — see top_level_key_view().
# The key itself may be written bare (`model:`) or quoted (`'model':` /
# `"model":`) — all three are the same JS object key, so the optional quote is
# part of the key pattern; the quoted forms survive blanking because
# top_level_key_view() preserves string literals in KEY position only.
KEY_RE = re.compile(r'(^|[{,\s])["\']?model["\']?\s*:')
VALUE_TAIL_RE = re.compile(r'^\s*(["\'`])((?:\\.|(?!\1).)*)\1', re.DOTALL)
KEY_NAME_RE = re.compile(r'[A-Za-z_$][A-Za-z0-9_$]*')
AGENT_CALL_RE = re.compile(r'agent\s*\(')


def note(msg):
    sys.stderr.write("spawn-routing-guard: " + msg + "\n")


def deny(reason):
    payload = {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")


# Strips `//` line comments and `/* */` block comments from `text`, respecting
# ' " ` string literals (with backslash escapes) so a comment marker inside a
# string is never treated as a comment. Newlines inside a stripped comment are
# preserved (as newlines) so line numbers in the result exactly match the
# original text; every other stripped character becomes a single space so no
# new token can form across the join.
#
# A `'` or `"` string cannot legally contain a raw newline in JS — only a
# backtick template literal can span lines. So if we are inside a `'`/`"`
# "string" and hit a newline, that string must in fact already be closed (most
# likely a stray/mismatched quote, e.g. from a character class inside a regex
# literal like `/['"]/`); resetting there bounds the damage to at most one line
# instead of letting a bogus quote swallow the rest of the script.
def strip_comments(text):
    out = []
    i = 0
    n = len(text)
    in_str = None
    while i < n:
        c = text[i]
        if in_str:
            if in_str in ("'", '"') and c == "\n":
                in_str = None
                out.append(c)
                i += 1
                continue
            out.append(c)
            if c == "\\" and i + 1 < n:
                i += 1
                out.append(text[i])
            elif c == in_str:
                in_str = None
            i += 1
            continue
        if c in ("'", '"', "`"):
            in_str = c
            out.append(c)
            i += 1
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "/":
            j = i
            while j < n and text[j] != "\n":
                out.append(" ")
                j += 1
            i = j
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "*":
            end = text.find("*/", i + 2)
            end = end + 2 if end != -1 else n
            j = i
            while j < end:
                out.append("\n" if text[j] == "\n" else " ")
                j += 1
            i = end
            continue
        out.append(c)
        i += 1
    return "".join(out)


# For each index in `text`, True iff that character sits inside a ' " ` string
# literal (including the quotes and any backslash-escaped character). Callers
# use this to skip over string content when tracking bracket depth or matching
# `agent(` calls, so a stray bracket or the literal text "agent(" inside a
# string is never mistaken for real code. Same newline-reset rule as
# strip_comments above, and for the same reason: a `'`/`"` string cannot
# legally contain a raw newline, so one bounds a stray/mismatched quote to a
# single line instead of letting it mask everything after it.
def string_mask(text):
    n = len(text)
    mask = [False] * n
    in_str = None
    i = 0
    while i < n:
        c = text[i]
        if in_str:
            if in_str in ("'", '"') and c == "\n":
                in_str = None
                i += 1
                continue
            mask[i] = True
            if c == "\\" and i + 1 < n:
                mask[i + 1] = True
                i += 2
                continue
            if c == in_str:
                in_str = None
            i += 1
            continue
        if c in ("'", '"', "`"):
            in_str = c
            mask[i] = True
            i += 1
            continue
        i += 1
    return mask


# `start` is the index right after an opening `(` (so depth already counts it).
# Scans forward tracking depth over ( [ { / ) ] } uniformly (not per bracket
# type — sufficient for well-formed script text), skipping any index where
# `mask` says we are inside a string literal. Returns the index of the
# character that brings depth back to 0 (the matching close), or -1 if the
# call is never closed.
def find_matching_close(text, mask, start):
    depth = 1
    i = start
    n = len(text)
    while i < n:
        if not mask[i]:
            c = text[i]
            if c in "([{":
                depth += 1
            elif c in ")]}":
                depth -= 1
                if depth == 0:
                    return i
        i += 1
    return -1


# Splits `text` on depth-0 commas (over ( [ { / ) ] }, strings skipped via
# `mask`), returning every top-level argument's raw text in order.
def split_top_level(text, mask):
    parts = []
    depth = 0
    start = 0
    n = len(text)
    for i in range(n):
        if mask[i]:
            continue
        c = text[i]
        if c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
        elif c == "," and depth == 0:
            parts.append(text[start:i])
            start = i + 1
    parts.append(text[start:])
    return parts


# Indices of every character belonging to a string literal that sits in KEY
# position — one whose closing quote is followed, after optional whitespace,
# by a `:`. A JS object key may be written bare (`model:`) or quoted
# (`'model':` / `"model":`), and all three are the same key, so the quoted
# forms must survive top_level_key_view()'s string blanking. A string in any
# other position is a VALUE (or an array element, or an argument) and stays
# blanked — which is what keeps `{ prompt: 'model: x' }` from counting as a
# pin. `mask` is the string_mask() of `text`; each maximal run of masked
# indices is one string literal, quotes included.
def key_string_indices(text, mask):
    keep = set()
    n = len(text)
    i = 0
    while i < n:
        if not mask[i]:
            i += 1
            continue
        start = i
        while i < n and mask[i]:
            i += 1
        j = i
        while j < n and text[j] in " \t\r\n":
            j += 1
        b = start - 1
        while b >= 0 and text[b] in " \t\r\n":
            b -= 1
        if (
            j < n
            and text[j] == ":"
            and b >= 0
            and text[b] in "{,"
            and KEY_NAME_RE.fullmatch(text[start + 1:i - 1])
        ):
            for k in range(start, i):
                keep.add(k)
    return keep


# `text` is an agent() call's second argument, raw source starting with (after
# whitespace) the opts object's own opening `{`. Returns a SAME-LENGTH view of
# `text` with every string literal (per string_mask, except one in KEY
# position at depth < 2 — see key_string_indices) and everything nested
# deeper than that outermost `{}` (depth >= 2 over ( [ { / ) ] }, strings
# skipped) replaced by spaces (newlines kept). This view is used ONLY to
# locate a genuine TOP-LEVEL `model` key: a `model:`-looking substring inside
# some unrelated string value (e.g. a `prompt` field) or inside a nested
# object/array must never count as a pin, and a pin nested inside a
# sub-object is not a top-level pin either. The actual value is read back
# from the ORIGINAL `text` at the same offsets — blanking never changes
# length or position — since blanking the value's own string away here would
# make it unreadable.
def top_level_key_view(text):
    mask = string_mask(text)
    keep = key_string_indices(text, mask)
    n = len(text)
    out = []
    depth = 0
    for i in range(n):
        c = text[i]
        if mask[i]:
            if depth < 2 and i in keep:
                out.append(c)
            else:
                out.append("\n" if c == "\n" else " ")
            continue
        if c in "([{":
            depth += 1
            out.append(c if depth < 2 else " ")
            continue
        if c in ")]}":
            visible = depth < 2
            depth -= 1
            out.append(c if visible else " ")
            continue
        out.append(c if depth < 2 else ("\n" if c == "\n" else " "))
    return "".join(out)


# Given the second argument's raw text and a KEY_RE match found against its
# top_level_key_view(), decides whether that confirmed top-level `model` key
# is pinned to a valid alias. Reads the value from `second` (the ORIGINAL,
# unblanked text) at the same offset the key match ended at. A quoted string
# literal (' " or a backtick with no `${` interpolation) must be one of the
# four aliases; a backtick literal containing `${` is a template (non-static)
# and, like any other non-literal value (an identifier or expression), is
# accepted unconditionally since it cannot be checked statically.
def value_is_pinned(second, key_match):
    tail = second[key_match.end():]
    vm = VALUE_TAIL_RE.match(tail)
    if not vm:
        return True
    quote, value = vm.group(1), vm.group(2)
    if quote == "`" and "${" in value:
        return True
    return value in ALIASES


# Returns the 1-indexed source line number of every `agent(` call in
# `script_text` whose second argument does not carry a top-level class-routed
# model pin. A call counts only when the preceding character is not
# [A-Za-z0-9_$.] (so `subagent(` / `x.agent(` are skipped; whitespace before
# the `(` is allowed, e.g. `agent (`); its second top-level argument must
# exist, must start with `{` after trimming whitespace, and must contain a
# TOP-LEVEL `model` key (see top_level_key_view) — see value_is_pinned() for
# how that key's value is judged.
def find_unpinned_agent_calls(script_text):
    stripped = strip_comments(script_text)
    mask = string_mask(stripped)
    n = len(stripped)
    violations = []
    for m in AGENT_CALL_RE.finditer(stripped):
        p = m.start()
        if mask[p]:
            continue
        prev = stripped[p - 1] if p > 0 else ""
        if re.match(r"[A-Za-z0-9_$.]", prev):
            continue
        start = m.end()
        close_idx = find_matching_close(stripped, mask, start)
        end = close_idx if close_idx != -1 else n
        args_text = stripped[start:end]
        args_mask = mask[start:end]
        parts = split_top_level(args_text, args_mask)
        pinned = False
        if len(parts) >= 2:
            second = parts[1]
            if second.strip().startswith("{"):
                km = KEY_RE.search(top_level_key_view(second))
                if km:
                    pinned = value_is_pinned(second, km)
        if not pinned:
            line_no = stripped.count("\n", 0, p) + 1
            violations.append(line_no)
    return violations


def handle_task_agent(tool_name, tool_input):
    if tool_input.get("subagent_type") == "fork":
        return
    model = tool_input.get("model", None)
    fix = "Fix: re-issue with model:<alias> (one of haiku|sonnet|opus|fable)."
    if model is None:
        deny(
            "Rule 0 — Spawn routing: this %s spawn has no model pin; the host "
            "model is never the inherited default. %s %s" % (tool_name, CLASS_MAP, fix)
        )
        return
    if not (isinstance(model, str) and ALIAS_RE.fullmatch(model)):
        deny(
            "Rule 0 — Spawn routing: this %s spawn's model (%s) is not a "
            "class-routed alias. %s %s" % (tool_name, json.dumps(model), CLASS_MAP, fix)
        )
        return


def handle_workflow(tool_input, cwd):
    script = tool_input.get("script")
    if not isinstance(script, str):
        script_path = tool_input.get("scriptPath")
        script = None
        if isinstance(script_path, str) and script_path:
            path = script_path
            if not os.path.isabs(path):
                base = cwd if isinstance(cwd, str) and cwd else os.getcwd()
                path = os.path.join(base, path)
            try:
                with open(path, "r", encoding="utf-8", errors="replace") as fh:
                    script = fh.read()
            except OSError:
                script = None
        if script is None:
            deny(
                "Rule 0 — Spawn routing: unable to verify pins for this Workflow "
                "spawn (no script or scriptPath, or scriptPath could not be read). "
                "%s Fix: pass the script inline or via scriptPath so pins can be "
                "verified." % CLASS_MAP
            )
            return
    violations = find_unpinned_agent_calls(script)
    if violations:
        lines_str = ", ".join("line %d" % n for n in violations)
        fixes = "; ".join(
            "add model:'<alias>' to agent() at line %d" % n for n in violations
        )
        deny(
            "Rule 0 — Spawn routing: unpinned agent() call(s) at %s. %s Fix: %s."
            % (lines_str, CLASS_MAP, fixes)
        )


def main():
    raw_bytes = sys.stdin.buffer.read()
    raw = raw_bytes.decode("utf-8", errors="replace")
    if not raw.strip():
        note("empty stdin JSON — allowing spawn (Rule 0 guard fail-open)")
        return
    try:
        data = json.loads(raw)
    except Exception:
        note("malformed stdin JSON — allowing spawn (Rule 0 guard fail-open)")
        return
    if not isinstance(data, dict):
        note(
            "malformed stdin JSON (not an object) — allowing spawn "
            "(Rule 0 guard fail-open)"
        )
        return

    tool_name = data.get("tool_name")
    if tool_name not in ("Task", "Agent", "Workflow"):
        return

    tool_input = data.get("tool_input")
    if not isinstance(tool_input, dict):
        tool_input = {}

    if tool_name in ("Task", "Agent"):
        handle_task_agent(tool_name, tool_input)
    else:
        handle_workflow(tool_input, data.get("cwd"))


main()
PY

python3 -c "$PY_PROG"
status=$?
if [ "$status" -ne 0 ]; then
  printf '%s\n' "spawn-routing-guard: python3 exited $status — fail-open" >&2
fi
exit 0
