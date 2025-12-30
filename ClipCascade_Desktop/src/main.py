#!/usr/bin/env python3

# ClipCascade - A seamless clipboard syncing utility
# Repository: https://github.com/Sathvik-Rao/ClipCascade
#
# Author: Sathvik Rao Poladi
# License: GPL-3.0
#
# This script serves as the entry point for the ClipCascade application,
# initializing and running the core application logic.

import sys
import platform


def show_error_dialog(title, message):
    """Show native error dialog using osascript (macOS) or fallback to console."""
    if platform.system() == "Darwin":
        import subprocess

        def sanitize(text):
            return (text
                .replace("\\", "")
                .replace('"', "'")
                .replace("\n", " ")
                .replace("\r", " ")
                .replace("\t", " "))

        safe_msg = sanitize(message)
        safe_title = sanitize(title)
        script = f'display dialog "{safe_msg}" with title "{safe_title}" buttons {{"OK"}} default button 1 with icon stop'
        try:
            subprocess.run(["osascript", "-e", script], check=False)
        except Exception:
            pass
    print(f"{title}: {message}", file=sys.stderr)


if __name__ == "__main__":
    try:
        from core.application import Application

        Application().run()
    except Exception as e:
        import traceback

        error_msg = f"{type(e).__name__}: {e}"
        show_error_dialog("ClipCascade Error", error_msg)
        traceback.print_exc()
        sys.exit(1)
