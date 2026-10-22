"""
Parse a PR title into a structured bump descriptor.

Grammar:
    <group>[+<group>...]: <description>
    <group>  = <type>[!](<scope>[,<scope>...])
    <bare>   = <non-releasing-type>: <description>

Releasing types: feat, fix, perf (any may carry "!" for major bump).
Non-releasing types: docs, chore, refactor, test, ci, build, style.

Scopes: windows, macos, linux-gui, linux-cli, linux, android, server, desktop, all.
  - linux   -> linux_gui + linux_non_gui (shorthand)
  - desktop -> windows + macos + linux_gui + linux_non_gui
  - all     -> every platform key in version.json (not the release counter)

The strongest bump across all groups advances the global release version.
Every selected platform adopts that same new version.

Note: linux_gui and linux_non_gui are tracked separately in version.json so
each variant can carry its own version, but they share a single Linux package
artifact (the package contains both GUI and CLI source paths).

Output (stdout): JSON
    {
      "release": true|false,
      "bumps": {"server": "minor", "windows": "patch", ...},
      "platforms": ["server", "windows", ...],
      "reason": "<human-readable summary or rejection reason>"
    }

Exit code: 0 on parse success (even if release=false), 1 on invalid title.
"""

from __future__ import annotations

import json
import os
import re
import sys

RELEASING_TYPES = {"feat", "fix", "perf"}
NON_RELEASING_TYPES = {"docs", "chore", "refactor", "test", "ci", "build", "style"}

SCOPE_TO_KEYS = {
    "windows": ["windows"],
    "macos": ["macos"],
    "linux-gui": ["linux_gui"],
    "linux-cli": ["linux_non_gui"],
    "linux": ["linux_gui", "linux_non_gui"],
    "android": ["android"],
    "server": ["server"],
    "desktop": ["windows", "macos", "linux_gui", "linux_non_gui"],
    "all": ["windows", "macos", "linux_gui", "linux_non_gui", "android", "server"],
}

GROUP_RE = re.compile(r"^([a-z]+)(!)?\(([a-z0-9,\-_ ]+)\)$")
BARE_RE = re.compile(r"^([a-z]+)$")


def _fail(reason: str) -> None:
    json.dump({"release": False, "bumps": {}, "platforms": [], "reason": reason}, sys.stdout)
    sys.stdout.write("\n")
    sys.exit(1)


def _ok(release: bool, bumps: dict[str, str], reason: str) -> None:
    json.dump(
        {
            "release": release,
            "bumps": bumps,
            "platforms": sorted(bumps.keys()),
            "reason": reason,
        },
        sys.stdout,
    )
    sys.stdout.write("\n")
    sys.exit(0)


def parse(title: str) -> None:
    title = title.strip()
    if ":" not in title:
        _fail("PR title must contain ':' separating header from description")

    header, _, _description = title.partition(":")
    header = header.strip()
    if not header:
        _fail("PR title header is empty")

    groups_raw = [g.strip() for g in header.split("+") if g.strip()]
    if not groups_raw:
        _fail("PR title has no type/scope groups before ':'")

    has_releasing = False
    has_non_releasing = False
    parsed_groups: list[tuple[str, bool, list[str]]] = []

    for grp in groups_raw:
        m = GROUP_RE.match(grp)
        if m:
            ctype = m.group(1)
            breaking = m.group(2) == "!"
            scopes = [s.strip() for s in m.group(3).split(",") if s.strip()]
            if ctype not in RELEASING_TYPES:
                _fail(
                    f"type '{ctype}' is not a releasing type. "
                    f"Only {sorted(RELEASING_TYPES)} may carry a scope."
                )
            unknown = [s for s in scopes if s not in SCOPE_TO_KEYS]
            if unknown:
                _fail(
                    f"unknown scope(s) {unknown}. "
                    f"Valid: {sorted(SCOPE_TO_KEYS.keys())}"
                )
            has_releasing = True
            parsed_groups.append((ctype, breaking, scopes))
            continue

        m = BARE_RE.match(grp)
        if m:
            ctype = m.group(1)
            if ctype in RELEASING_TYPES:
                _fail(
                    f"type '{ctype}' requires a scope, e.g. '{ctype}(windows): ...'"
                )
            if ctype not in NON_RELEASING_TYPES:
                _fail(
                    f"unknown type '{ctype}'. "
                    f"Valid: {sorted(RELEASING_TYPES | NON_RELEASING_TYPES)}"
                )
            has_non_releasing = True
            parsed_groups.append((ctype, False, []))
            continue

        _fail(f"group '{grp}' does not match '<type>[!](<scope>[,<scope>...])' or bare '<type>'")

    if has_releasing and has_non_releasing:
        _fail("cannot mix releasing (feat/fix/perf) and non-releasing types in the same title")

    if not has_releasing:
        _ok(False, {}, "non-releasing title; no build will run")

    bumps: dict[str, str] = {}
    seen_keys: dict[str, str] = {}

    for ctype, breaking, scopes in parsed_groups:
        if breaking:
            level = "major"
        elif ctype == "feat":
            level = "minor"
        else:
            level = "patch"

        for scope in scopes:
            for key in SCOPE_TO_KEYS[scope]:
                if key in seen_keys:
                    _fail(
                        f"platform '{key}' is targeted by more than one group "
                        f"(via scopes '{seen_keys[key]}' and '{scope}'). "
                        f"Each platform may appear in only one group."
                    )
                seen_keys[key] = scope
                bumps[key] = level

    summary = ", ".join(f"{k}:{v}" for k, v in sorted(bumps.items()))
    _ok(True, bumps, f"release: {summary}")


def main() -> None:
    title = os.environ.get("PR_TITLE") or (sys.argv[1] if len(sys.argv) > 1 else "")
    if not title:
        _fail("no PR title provided (set PR_TITLE env var or pass as arg)")
    parse(title)


if __name__ == "__main__":
    main()
