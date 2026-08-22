#!/usr/bin/env bash
# Patches prime-agent's refinement JSON parser to tolerate raw control
# characters inside string literals (models sometimes emit raw \n / \t
# inside JSON strings, which crashes JSON.parse with
# "Bad control character in string literal").
# Idempotent: safe to run multiple times.
set -e
TARGET="${1:-/usr/lib/node_modules/prime-agent/dist/core/refinement/refinement.js}"
[ -f "$TARGET" ] || { echo "not found: $TARGET"; exit 1; }

if grep -q "sanitizeJsonControlChars" "$TARGET"; then
  echo "already patched: $TARGET"
  exit 0
fi

python3 - "$TARGET" <<'PYEOF'
import sys
path = sys.argv[1]
src = open(path).read()

san = '''function sanitizeJsonControlChars(text) {
    let out = "";
    let inString = false;
    let escaped = false;
    for (const ch of text) {
        if (escaped) { out += ch; escaped = false; continue; }
        if (inString && ch === "\\\\") { out += ch; escaped = true; continue; }
        if (ch === '"') { inString = !inString; out += ch; continue; }
        if (inString) {
            const code = ch.charCodeAt(0);
            if (code === 10) { out += "\\\\n"; continue; }
            if (code === 13) { continue; }
            if (code === 9) { out += "\\\\t"; continue; }
            if (code < 32) { continue; }
        }
        out += ch;
    }
    return out;
}
'''
anchor = 'function parseJsonCandidate(candidate) {'
assert src.count(anchor) == 1
src = src.replace(anchor, san + anchor)

old = 'function parseJsonCandidate(candidate) {\n    try {\n        return JSON.parse(candidate);\n    }'
new = 'function parseJsonCandidate(candidate) {\n    try {\n        return JSON.parse(sanitizeJsonControlChars(candidate));\n    }'
assert src.count(old) == 1
src = src.replace(old, new)

old2 = '''    if (start !== -1 && end > start) {
        try {
            return JSON.parse(trimmed.slice(start, end + 1));
        }'''
new2 = '''    if (start !== -1 && end > start) {
        try {
            return JSON.parse(sanitizeJsonControlChars(trimmed.slice(start, end + 1)));
        }'''
assert src.count(old2) == 1
src = src.replace(old2, new2)

open(path, 'w').write(src)
print("patched:", path)
PYEOF
node --check "$TARGET" && echo "syntax OK"
