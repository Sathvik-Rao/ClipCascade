#!/usr/bin/env bash
# Stage all downloads in a draft, then publish. Safe to retry before announcing
# version.json: an already-public release must still contain every expected asset.
set -euo pipefail

: "${TAG:?TAG required}"
: "${RELEASE_TITLE:?RELEASE_TITLE required}"
: "${BODY_PATH:?BODY_PATH required}"
: "${TARGET_SHA:?TARGET_SHA required}"
ASSET_DIR="${ASSET_DIR:-release-assets}"

shopt -s nullglob
assets=("$ASSET_DIR"/*)
if [ ${#assets[@]} -eq 0 ]; then
  echo "No release assets found" >&2
  exit 1
fi

if release_json=$(gh release view "$TAG" --json isDraft,assets); then
  if [ "$(jq -r '.isDraft' <<<"$release_json")" = false ]; then
    for asset in "${assets[@]}"; do
      jq -e --arg name "$(basename "$asset")" '.assets | any(.name == $name)' \
        <<<"$release_json" >/dev/null
    done
    echo "Release $TAG is already published with the expected assets."
    exit 0
  fi
else
  gh release create "$TAG" --draft --title "$RELEASE_TITLE" \
    --notes-file "$BODY_PATH" --target "$TARGET_SHA"
fi

gh release upload "$TAG" "${assets[@]}" --clobber
gh release edit "$TAG" --draft=false --latest
