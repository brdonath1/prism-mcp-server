#!/bin/bash
# claude-md-lint.sh - rot check for AI instruction files (CLAUDE.md, .claude/rules/*.md, also usable on ~/.zshrc).
# Usage: claude-md-lint.sh [--budget BYTES] [--max-age-days N] [--strict] FILE...
#   --budget         size limit in bytes (default 3072; use 4096 for the global file, 2048 for rule files)
#   --max-age-days   a dated rule older than this without a decisions/ link is stale (default 180)
#   --strict         exit 1 on any finding, not only on a budget breach
# Read-only. macOS bash 3.2 and BSD grep/awk/date.
set -o pipefail
BUDGET=3072; MAXAGE=180; STRICT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --budget) BUDGET="$2"; shift 2 ;;
    --max-age-days) MAXAGE="$2"; shift 2 ;;
    --strict) STRICT=1; shift ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    --) shift; break ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) break ;;
  esac
done
[ $# -ge 1 ] || { echo "usage: $0 [--budget N] [--max-age-days N] [--strict] FILE..." >&2; exit 2; }

HISTORY_RE='(retired|formerly|no longer|previously|superseded|was removed|was deleted|historical|legacy|deprecated|old (way|behaviour|behavior)|used to)'
RULE_RE='\b(never|always|must|do not|don.t|only ever|required)\b'
fail=0; findings=0
today=$(date +%s)

lint() {
  f="$1"; dir=$(cd "$(dirname "$f")" && pwd); n=0
  [ -r "$f" ] || { echo "$f: not readable"; fail=1; return; }
  size=$(wc -c < "$f" | tr -d ' '); lines=$(wc -l < "$f" | tr -d ' ')
  echo "## $f  ($size bytes, $lines lines, budget $BUDGET)"
  if [ "$size" -gt "$BUDGET" ]; then echo "  FAIL budget: $size > $BUDGET bytes (move explanation to docs/CONTEXT.md, history to docs/decisions/)"; fail=1; n=$((n+1)); fi

  # 1. history language
  # code spans (`legacy-workflow`) are names, not narrative; strip them first (line numbers are preserved)
  c=$(sed -E 's/`[^`]*`//g' "$f" | grep -ciE "$HISTORY_RE"); if [ "$c" -gt 0 ]; then echo "  history words on $c line(s) (belong in docs/decisions/):"; sed -E 's/`[^`]*`//g' "$f" | grep -niE "$HISTORY_RE" | cut -c1-120 | sed 's/^/     /' | head -8; n=$((n+c)); fi

  # 2. dated lines: stale without a decision link
  stale=0
  while IFS= read -r line; do
    d=$(echo "$line" | grep -oE '20[0-9]{2}-[0-9]{2}-[0-9]{2}' | head -1); [ -z "$d" ] && continue
    ts=$(date -j -f '%Y-%m-%d' "$d" +%s 2>/dev/null) || continue
    age=$(( (today - ts) / 86400 ))
    if [ "$age" -gt "$MAXAGE" ] && ! echo "$line" | grep -qE 'decisions?/'; then
      [ "$stale" = 0 ] && echo "  dated rules older than $MAXAGE days with no decisions/ link (re-justify or delete):"
      echo "     $(echo "$line" | cut -c1-120)"; stale=$((stale+1))
    fi
  done < "$f"
  n=$((n+stale))

  # 3. undated imperatives (warn; every rule should carry a date and a reason)
  u=$(grep -iE "$RULE_RE" "$f" | grep -vcE '20[0-9]{2}-[0-9]{2}-[0-9]{2}')
  [ "$u" -gt 0 ] && echo "  undated imperatives: $u line(s) say never/always/must without a (YYYY-MM-DD, decisions/...) tag"
  [ "$STRICT" = 1 ] && n=$((n+u))

  # 4. dead paths
  dead=0
  for p in $(grep -oE '(~|\$HOME)/[A-Za-z0-9_./@-]+|/Users/[A-Za-z0-9_./@-]+|(\./)?(scripts|docs|src|templates|hooks|\.claude|\.github)/[A-Za-z0-9_./@-]+' "$f" | sed -E 's/[.,;:)]+$//' | sort -u); do
    q="$p"; case "$q" in '~/'*) q="$HOME/${q#\~/}";; '$HOME/'*) q="$HOME/${q#\$HOME/}";; /*) ;; *) q="$dir/${q#./}";; esac
    q=$(echo "$q" | sed -E 's/<[^>]*>.*$//; s/\*.*$//; s/\/$//')   # stop at placeholders and globs
    [ -z "$q" ] && continue
    if [ ! -e "$q" ]; then [ "$dead" = 0 ] && echo "  paths that do not exist:"; echo "     $p"; dead=$((dead+1)); fi
  done
  n=$((n+dead))

  # 5. duplicate lines
  dup=$(grep -vE '^\s*$|^\s*[-#*|]' "$f" | sort | uniq -d | wc -l | tr -d ' ')
  [ "$dup" -gt 0 ] && { echo "  duplicate lines: $dup"; grep -vE '^\s*$|^\s*[-#*|]' "$f" | sort | uniq -d | head -3 | cut -c1-100 | sed 's/^/     /'; n=$((n+dup)); }

  # 6. contradictions: the same object after both "never" and "always"
  contra=$(comm -12 <(grep -oiE 'never [a-z]+ [a-z]+' "$f" | sed -E 's/^never //I' | tr 'A-Z' 'a-z' | sort -u) <(grep -oiE 'always [a-z]+ [a-z]+' "$f" | sed -E 's/^always //I' | tr 'A-Z' 'a-z' | sort -u))
  [ -n "$contra" ] && { echo "  never/always on the same object:"; echo "$contra" | sed 's/^/     /'; n=$((n+1)); }

  # 7. shape: longest section
  longest=$(awk '/^#/{if(c>m){m=c;h=hdr}; c=0; hdr=$0; next}{c++} END{if(c>m){m=c;h=hdr}; print m" lines under \""h"\""}' "$f")
  echo "  longest section: $longest"
  [ "$n" = 0 ] && echo "  ok: no findings"
  findings=$((findings+n))
}

for f in "$@"; do lint "$f"; echo; done
echo "total findings: $findings"
[ "$fail" = 1 ] && exit 1
[ "$STRICT" = 1 ] && [ "$findings" -gt 0 ] && exit 1
exit 0
