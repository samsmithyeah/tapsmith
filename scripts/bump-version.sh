#!/usr/bin/env bash
set -euo pipefail

# Bump the version across all packages in the monorepo.
# Usage: ./scripts/bump-version.sh <new-version>
# Example: ./scripts/bump-version.sh 0.2.0

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

NEW_VERSION="${1:-}"
if [[ -z "$NEW_VERSION" ]]; then
  echo "Usage: $0 <new-version>"
  echo "Example: $0 0.2.0"
  exit 1
fi

# Read current version from the main package.json
CURRENT_VERSION=$(node -p "require('$ROOT/packages/tapsmith/package.json').version")
echo "Bumping $CURRENT_VERSION → $NEW_VERSION"

# 1. Main package.json (version + optionalDependencies)
sed -i '' "s/\"$CURRENT_VERSION\"/\"$NEW_VERSION\"/g" "$ROOT/packages/tapsmith/package.json"

# 2. Rust daemon
sed -i '' "s/^version = \"$CURRENT_VERSION\"/version = \"$NEW_VERSION\"/" "$ROOT/packages/tapsmith-core/Cargo.toml"

# 3. Platform-specific npm packages
for pkg in "$ROOT"/npm-packages/*/package.json; do
  sed -i '' "s/\"version\": \"$CURRENT_VERSION\"/\"version\": \"$NEW_VERSION\"/" "$pkg"
done

# 4. Website footer
sed -i '' "s/v$CURRENT_VERSION/v$NEW_VERSION/g" "$ROOT/website/src/pages/index.astro"

# 5. Regenerate lockfiles
echo "Regenerating lockfiles..."
(cd "$ROOT/packages/tapsmith" && npm install --package-lock-only --silent)
(cd "$ROOT/packages/tapsmith-core" && cargo check --quiet)
for dir in website test-app benchmark/tapsmith; do
  lockfile="$ROOT/$dir/package-lock.json"
  if [[ -f "$lockfile" ]]; then
    (cd "$ROOT/$dir" && npm install --package-lock-only --silent)
  fi
done

echo "Done. Verify with:"
echo "  grep -rn '\"$CURRENT_VERSION\"' --include='package.json' --include='Cargo.toml' --include='*.astro' . | grep -v node_modules"
