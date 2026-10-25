#!/usr/bin/env bash
# Download previous-release artifacts for platforms that were NOT bumped
# in this release, so the new release contains a full snapshot.
#
# Inputs (env):
#   BUMPED_KEYS   - JSON array of bumped version.json keys
#   OUT_DIR       - directory to write downloaded artifacts into
#   GH_TOKEN      - github token (set by workflow)
#
# Asset names are static (no version suffix). Mapping:
#   windows                       -> ClipCascade.exe, ClipCascade.msi
#   macos                         -> Apple Silicon and Intel macOS ZIPs
#   linux_gui OR linux_non_gui    -> ClipCascade_Linux.zip, ClipCascade_Linux.tar.xz
#   android                       -> ClipCascade.apk
#   server                        -> ClipCascade-Server-JRE_21.jar, docker-compose.yml

set -euo pipefail

: "${BUMPED_KEYS:?BUMPED_KEYS env var required}"
: "${OUT_DIR:?OUT_DIR env var required}"

mkdir -p "$OUT_DIR"

is_bumped() {
  echo "$BUMPED_KEYS" | jq -e --arg k "$1" 'index($k) != null' >/dev/null
}

CARRY_OVER=()

if ! is_bumped windows; then
  CARRY_OVER+=("ClipCascade.exe" "ClipCascade.msi")
fi
if ! is_bumped macos; then
  CARRY_OVER+=("ClipCascade-Apple_macOS.ARM_M-Series.zip" "ClipCascade-Apple_macOS.Intel-Series.zip")
fi
# Linux package is built fresh if EITHER linux variant bumped; carry over only
# when neither was bumped.
if ! is_bumped linux_gui && ! is_bumped linux_non_gui; then
  CARRY_OVER+=("ClipCascade_Linux.zip" "ClipCascade_Linux.tar.xz")
fi
if ! is_bumped android; then
  CARRY_OVER+=("ClipCascade.apk")
fi
if ! is_bumped server; then
  CARRY_OVER+=("ClipCascade-Server-JRE_21.jar" "docker-compose.yml")
fi

if [ ${#CARRY_OVER[@]} -eq 0 ]; then
  echo "All platforms bumped — nothing to carry over."
  exit 0
fi

echo "Assets to carry over: ${CARRY_OVER[*]}"

PREV_TAG=$(gh release list --limit 50 --json tagName,isDraft \
  --jq '[.[] | select(.isDraft==false) | .tagName] | map(select(startswith("v"))) | .[0]' \
  || true)

if [ -z "$PREV_TAG" ] || [ "$PREV_TAG" = "null" ]; then
  echo "No previous release found — skipping carry-over (bootstrap mode)."
  exit 0
fi

echo "Carrying assets from previous release: $PREV_TAG"

PATTERNS=()
for a in "${CARRY_OVER[@]}"; do
  PATTERNS+=("--pattern" "$a")
done

gh release download "$PREV_TAG" \
  --dir "$OUT_DIR" \
  "${PATTERNS[@]}" \
  || echo "Note: some patterns matched no assets (acceptable for bootstrap)."

echo "Carried-over assets:"
ls -la "$OUT_DIR" || true
