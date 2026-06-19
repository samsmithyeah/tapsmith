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

# 1. Main package.json version. The @tapsmith/* optionalDependencies are
# intentionally pinned to "*" here (not the exact version) so the committed
# lockfile never references an as-yet-unpublished version — see the note at
# step 5. The release workflow rewrites them to the exact version at publish
# time ("Set version from tag" in release.yml), so the published package
# still pins the matching platform packages exactly.
sed -i '' "s/\"$CURRENT_VERSION\"/\"$NEW_VERSION\"/g" "$ROOT/packages/tapsmith/package.json"

# 2. Rust daemon
sed -i '' "s/^version = \"$CURRENT_VERSION\"/version = \"$NEW_VERSION\"/" "$ROOT/packages/tapsmith-core/Cargo.toml"

# 3. Platform-specific npm packages
for pkg in "$ROOT"/npm-packages/*/package.json; do
  sed -i '' "s/\"version\": \"$CURRENT_VERSION\"/\"version\": \"$NEW_VERSION\"/" "$pkg"
done

# 4. Website footer
sed -i '' "s/v$CURRENT_VERSION/v$NEW_VERSION/g" "$ROOT/website/src/pages/index.astro"

# 5. Regenerate lockfiles — only for packages whose manifests this script
# changed. website/test-app/benchmark don't reference the tapsmith version,
# so regenerating their lockfiles can only pick up unrelated churn, and
# doing it with a different npm than CI breaks `npm ci` there.
#
# NOTE: because the @tapsmith/* optionalDependencies use "*" (see step 1),
# this regen resolves them to the latest *published* version, so the lockfile
# always carries valid version/resolved/integrity and `npm ci` stays in sync
# on every branch. (If these were pinned to the new, not-yet-published
# version, npm would strip that metadata and `npm ci` would break for
# everyone once the version went live.)
echo "Regenerating lockfiles..."
(cd "$ROOT/packages/tapsmith" && npm install --package-lock-only --silent)
(cd "$ROOT/packages/tapsmith-core" && cargo check --quiet)

echo "Done. Verify with:"
echo "  grep -rn '\"$CURRENT_VERSION\"' --include='package.json' --include='Cargo.toml' --include='*.astro' . | grep -v node_modules"
