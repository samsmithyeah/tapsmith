#!/bin/bash
# Fingerprint of everything that determines the rendered promo video: the
# committed contents of tools/promo/ minus files that do not affect the render
# (README, the docs-screenshot tooling, this script). Published beside
# promo.mp4 as promo-source.txt so release.yml can tell whether the video
# needs re-rendering. Usage: source-hash.sh [rev]   (default HEAD)
set -euo pipefail
REV="${1:-HEAD}"
git ls-tree -r "$REV:tools/promo" \
  | grep -vE $'\t(README\\.md|\\.gitignore|source-hash\\.sh|docs-shots/.*)$' \
  | sha256sum | cut -c1-16
