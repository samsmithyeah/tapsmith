#!/usr/bin/env bash
#
# check-proto-compat.sh
#
# Verifies that the Selector oneof fields in pilot.proto are handled in both:
#   - selectorToProto()  in packages/pilot/src/selectors.ts
#   - selector_to_json() in packages/pilot-core/src/grpc_server.rs
#
# Exits non-zero if any field is missing from either mapping.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

PROTO_FILE="$REPO_ROOT/proto/pilot.proto"
TS_FILE="$REPO_ROOT/packages/pilot/src/selectors.ts"
RS_FILE="$REPO_ROOT/packages/pilot-core/src/grpc_server.rs"

errors=0

# Portable snake_case to camelCase: text_contains -> textContains
to_camel() {
  echo "$1" | awk -F'_' '{
    for (i=1; i<=NF; i++) {
      if (i == 1) { printf "%s", $i }
      else { printf "%s%s", toupper(substr($i,1,1)), substr($i,2) }
    }
    print ""
  }'
}

# Portable snake_case to PascalCase: text_contains -> TextContains
to_pascal() {
  echo "$1" | awk -F'_' '{
    for (i=1; i<=NF; i++) {
      printf "%s%s", toupper(substr($i,1,1)), substr($i,2)
    }
    print ""
  }'
}

# ── Extract oneof field names from the Selector message ──
# Matches lines like:  string text = 2;  or  RoleSelector role = 1;
# inside the "oneof selector { ... }" block.
proto_fields=$(
  sed -n '/^message Selector/,/^}/p' "$PROTO_FILE" \
    | sed -n '/oneof selector/,/}/p' \
    | grep -E '^\s+\w+\s+\w+\s*=' \
    | awk '{print $2}' \
    | sort
)

echo "Proto Selector oneof fields:"
echo "$proto_fields"
echo ""

# ── Check TypeScript: selectorToProto in selectors.ts ──
echo "--- Checking TypeScript (selectors.ts) ---"
for field in $proto_fields; do
  camel=$(to_camel "$field")

  # The TS file uses either proto.KEY = or case 'KEY':
  if ! grep -qE "(proto\.$camel\b|case '$camel'|proto\[.$camel.\])" "$TS_FILE"; then
    # Special case: proto 'resource_id' maps to 'resourceId' in TS, but the
    # selector kind is 'id' so it appears as case 'id' with proto.resourceId
    if [ "$field" = "resource_id" ] && grep -qE "(proto\.resourceId|case 'id')" "$TS_FILE"; then
      echo "  OK: $field -> resourceId (via case 'id')"
      continue
    fi
    echo "  MISSING in TS: proto field '$field' (expected '$camel')"
    errors=$((errors + 1))
  else
    echo "  OK: $field -> $camel"
  fi
done

echo ""

# ── Check Rust: selector_to_json in grpc_server.rs ──
echo "--- Checking Rust (grpc_server.rs) ---"
for field in $proto_fields; do
  pascal=$(to_pascal "$field")

  if ! grep -qE "Selector::$pascal\b" "$RS_FILE"; then
    echo "  MISSING in Rust: proto field '$field' (expected Selector::$pascal)"
    errors=$((errors + 1))
  else
    echo "  OK: $field -> Selector::$pascal"
  fi
done

echo ""

if [ "$errors" -gt 0 ]; then
  echo "FAIL: $errors proto field(s) not handled in SDK or core."
  exit 1
else
  echo "PASS: All Selector oneof fields are handled in both TypeScript and Rust."
  exit 0
fi
