"""
Convert plain-text LICENSE to a minimal RTF file for use in the WiX installer
ReadmeDlg. Output: LICENSE.rtf next to the input file (or to a given path).
"""

from __future__ import annotations

import sys
from pathlib import Path


def to_rtf(text: str) -> str:
    out = ["{\\rtf1\\ansi\\ansicpg1252\\deff0", "{\\fonttbl{\\f0\\fnil Arial;}}", "\\fs20"]
    for ch in text:
        if ch == "\\":
            out.append("\\\\")
        elif ch == "{":
            out.append("\\{")
        elif ch == "}":
            out.append("\\}")
        elif ch == "\n":
            out.append("\\par\n")
        elif ord(ch) < 128:
            out.append(ch)
        else:
            out.append(f"\\u{ord(ch)}?")
    out.append("}")
    return "".join(out)


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit("usage: generate_rtf.py <input-text-file> [output.rtf]")
    src = Path(sys.argv[1])
    dst = Path(sys.argv[2]) if len(sys.argv) >= 3 else src.with_suffix(".rtf")
    text = src.read_text(encoding="utf-8", errors="replace")
    dst.write_text(to_rtf(text), encoding="utf-8")
    print(f"wrote {dst}")


if __name__ == "__main__":
    main()
