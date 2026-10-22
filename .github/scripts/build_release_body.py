"""
Compose the GitHub Release title and body.

Env:
    PR_BODY       - PR body markdown (full)
    PR_NUMBER     - merged PR number
    REPO          - github 'owner/repo' string (for PR link)
    RELEASE_VERSION - global release version, x.y.z
    VERSIONS_JSON - version.json contents for the platform version table

Title format:   ClipCascade v{X.Y.Z}
Body format:    fixed marketing template with PR-extracted "What's New".

The PR body is expected to contain a section starting with "## Description"
or "## What's New". Everything from that header up to the next "##" header
(or end of body) becomes the "What's New" content. HTML comments are
stripped. If the section is missing or empty, a default fallback is used.

Outputs (GITHUB_OUTPUT):
    title=<release title>
    body_path=<temp file with full release body>
"""

from __future__ import annotations

import json
import os
import re
import sys
import tempfile

BODY_TEMPLATE = """# 🚀 ClipCascade v{version} Release

**ClipCascade**, the lightweight, open-source clipboard sync tool, is now faster, leaner, and more powerful than ever!

### 📥 Available Downloads
| Platform              | File Name               |
|-----------------------|-------------------------|
| **Windows**           | Installer (`ClipCascade.msi`), Portable/Standalone Executable (`ClipCascade.exe`)—No startup option   |
| **macOS (Apple Silicon)** | `ClipCascade-Apple_macOS(ARM_M-Series).zip` |
| **macOS (Intel)**      | `ClipCascade-Apple_macOS(Intel-Series).zip` |
| **Android**           | `ClipCascade.apk`       |
| **Linux (GUI/CLI)**   | `ClipCascade_Linux.zip` / `ClipCascade_Linux.tar.xz` |
| **Docker**            | `docker-compose.yml`    |

### Platform Versions

{platform_versions}

---

### 🔑 Key Features
* Cross-platform clipboard sync for **Windows, macOS, Linux, and Android**
* **Dual-mode sync**: Peer-to-Server (P2S) or Peer-to-Peer (P2P)
* Full **self-hosting** support for privacy and control
* **End-to-end encryption** with zero-knowledge access
* Fully configurable: set clipboard limits, encryption salt, and hash complexity

---

### ✨ What's New in v{version}

{whats_new}
{pr_reference}

---

### 🔄 How to Update
Simply install the new version over your current one—**no uninstall needed**.
Your login and preferences will be preserved.
The **built-in update checker** (on the home screen or taskbar) will notify you when new versions are available.
"""

DEFAULT_WHATS_NEW = "_See PR linked below for details._"

SECTION_HEADERS = ("description", "what's new", "whats new", "release notes")

HEADER_RE = re.compile(r"^\s*##\s+(.+?)\s*$", re.MULTILINE)
HTML_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)


def extract_whats_new(pr_body: str) -> str:
    if not pr_body:
        return ""

    headers = [(m.start(), m.end(), m.group(1).strip().lower())
               for m in HEADER_RE.finditer(pr_body)]
    if not headers:
        return ""

    target_idx = None
    for i, (_, _, name) in enumerate(headers):
        if name in SECTION_HEADERS:
            target_idx = i
            break
    if target_idx is None:
        return ""

    start = headers[target_idx][1]
    end = headers[target_idx + 1][0] if target_idx + 1 < len(headers) else len(pr_body)

    section = pr_body[start:end]
    section = HTML_COMMENT_RE.sub("", section)
    return section.strip()


def emit_output(key: str, value: str) -> None:
    out = os.environ.get("GITHUB_OUTPUT")
    if not out:
        print(f"{key}={value}")
        return
    with open(out, "a", encoding="utf-8") as f:
        f.write(f"{key}<<__BODY_END__\n{value}\n__BODY_END__\n")


def main() -> None:
    pr_body = os.environ.get("PR_BODY", "")
    pr_number = os.environ.get("PR_NUMBER", "").strip()
    repo = os.environ.get("REPO", "").strip()
    release_version = os.environ.get("RELEASE_VERSION", "").strip()
    if not release_version:
        sys.exit("RELEASE_VERSION env var is empty")
    versions = json.loads(os.environ.get("VERSIONS_JSON", "{}"))
    platform_labels = {
        "windows": "Windows",
        "macos": "macOS",
        "linux_gui": "Linux GUI",
        "linux_non_gui": "Linux CLI",
        "android": "Android",
        "server": "Server / Docker",
    }
    platform_versions = "\n".join(
        ["| Platform | Version |", "|---|---|"]
        + [f"| {label} | {versions[key]} |" for key, label in platform_labels.items()
           if key in versions]
    )

    whats_new = extract_whats_new(pr_body) or DEFAULT_WHATS_NEW

    if pr_number and repo:
        pr_reference = f"\n_— from [PR #{pr_number}](https://github.com/{repo}/pull/{pr_number})_"
    elif pr_number:
        pr_reference = f"\n_— from PR #{pr_number}_"
    else:
        pr_reference = ""

    title = f"ClipCascade v{release_version}"
    body = BODY_TEMPLATE.format(
        version=release_version,
        platform_versions=platform_versions,
        whats_new=whats_new,
        pr_reference=pr_reference,
    )

    fd, path = tempfile.mkstemp(prefix="release-body-", suffix=".md")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(body)

    # Title via GITHUB_OUTPUT (single line, no special chars expected)
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as f:
            f.write(f"title={title}\n")
            f.write(f"body_path={path}\n")
    else:
        print(f"title={title}")
        print(f"body_path={path}")

    print(f"--- title ---\n{title}\n--- body ---\n{body}")


if __name__ == "__main__":
    main()
