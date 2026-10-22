"""Update the public version files locally, only after the release is published.

OLD_VERSIONS_JSON is the public baseline captured by prep. VERSIONS_JSON is
the built release's versions. Refuse stale updates; repeated finalization is safe.
The workflow commits and pushes these files after this script succeeds.
"""

import json
import os
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[2]


def main():
    previous = json.loads(os.environ["OLD_VERSIONS_JSON"])
    versions = json.loads(os.environ["VERSIONS_JSON"])
    path = ROOT / "version.json"
    current = json.loads(path.read_text(encoding="utf-8"))
    if current == versions:
        print("Release versions already announced; no changes needed.")
        return
    if current != previous:
        sys.exit("Public versions changed since preparation; refusing to overwrite another release.")
    subprocess.run(
        [sys.executable, str(ROOT / ".github/scripts/apply_app_version.py"), "all"],
        check=True,
    )
    path.write_text(json.dumps(versions, indent=2) + "\n", encoding="utf-8")
    print(f"Ready to announce release {versions['release']}.")


if __name__ == "__main__":
    main()
