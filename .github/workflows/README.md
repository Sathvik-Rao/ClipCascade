# ClipCascade CI/CD

Automated release pipeline for all ClipCascade platforms. A single merge to
`main` parses the PR title, advances the global release version, assigns it
to the selected platforms, builds only the
changed platforms, carries the rest over from the previous release, publishes
a GitHub Release, and only then announces the versions on `main`.

- **[`release.yml`](release.yml)** — the build + release pipeline (push to `main`).
- **[`pr-title.yml`](pr-title.yml)** — validates the PR title on every PR to `main`.
- **[`../scripts/`](../scripts/)** — the Python/Bash helpers both workflows call.

---

## TL;DR for contributors

The **PR title is the release manifest**. Its format decides what gets built
and how the global release version is bumped:

```
<group>[+<group>...]: <description>
<group> = <type>[!](<scope>[,<scope>...])
```

| Type                                                        | Bump  | Releases? |
|-------------------------------------------------------------|-------|-----------|
| `feat!`, `fix!`, `perf!` (any releasing type with `!`)      | major | yes       |
| `feat`                                                      | minor | yes       |
| `fix`, `perf`                                               | patch | yes       |
| `docs`, `chore`, `refactor`, `test`, `ci`, `build`, `style` | none  | **no**    |

**Scopes** (required for `feat`/`fix`/`perf`):
`windows` · `macos` · `linux-gui` · `linux-cli` · `linux`\* · `android` ·
`server` · `desktop`\* · `all`

> \* `linux` = both Linux variants. `desktop` = `windows` + `macos` + both Linux.
> Linux GUI and CLI are versioned separately but ship in **one** Linux package.

**Rules**
- A platform may appear in **only one** group across the whole title.
- Releasing (`feat`/`fix`/`perf`) and non-releasing types **cannot** be mixed.
- Non-releasing types take **no** scope.
- Type and scope are **lowercase** (`Feat:` is rejected).
- A breaking change needs a scope: `feat!(android): …` (not `feat!: …`).

**Examples**
```
feat(server): add OIDC login                      → global minor; server adopts it
fix(windows,macos): clipboard race on paste       → global patch; both adopt it
feat!(android): rework key derivation             → global major; Android adopts it
feat(server)+fix(windows): backend + tray crash   → global minor; both adopt it
docs: update README                               → no release
```

The strongest bump in the title wins (`major` > `minor` > `patch`). All selected
platforms adopt the same new global version. Unselected platforms keep their
existing versions and packages.

Also fill in the **`## Description`** section of the PR — it becomes the
"What's New" block in the release notes.

---

## How the release pipeline works

```
push to main
   │
   ▼
┌─────────────────────────────────────────────────────────────┐
│ prep (ubuntu)                                                │
│  1. Look up the merged PR for this commit                    │
│  2. parse_pr_title.py   → release? which platforms? bumps?   │
│  3. bump_version.py → calculate versions locally             │
│  4. validate the global release tag (vX.Y.Z)                 │
│  5. pass versions as outputs; do not push changes            │
└─────────────────────────────────────────────────────────────┘
   │ per-platform build_* flags + unpublished versions
   ├──────────┬──────────┬─────────┬──────────┬──────────┐
   ▼          ▼          ▼         ▼          ▼          ▼
 windows    macos      linux    android    server     (each runs only
 PyInstaller PyInstaller source  RN/Gradle  Maven jar   if its platform
 + WiX .msi  + .zip     .zip/.tar APK        + Docker    was bumped)
   └──────────┴──────────┴─────────┴──────────┴──────────┘
   │ each build injects versions into its local source files
   │ all artifacts uploaded
   ▼
┌─────────────────────────────────────────────────────────────┐
│ release (ubuntu)                                             │
│  • download freshly built artifacts                          │
│  • carry_artifacts.sh → pull UNCHANGED platforms' assets     │
│    from the previous release (full snapshot every time)      │
│  • build_release_body.py → release notes from the PR body    │
│  • upload downloads to a draft, then publish the release     │
│  • promote the built server image to Docker latest, if changed │
│  • commit + push public versions to main LAST               │
└─────────────────────────────────────────────────────────────┘
```

### version.json — the single source of truth

[`version.json`](../../version.json) at the repo root holds a global `release`
counter and the version shipped for each platform:

```json
{ "release": "…", "android": "…", "windows": "…", "linux_gui": "…",
  "linux_non_gui": "…", "macos": "…", "server": "…" }
```

The `release` counter starts at `3.2.0`, the highest existing platform version
when this scheme was introduced. It must never be below a platform version.
When migrating an existing published release history, set it to the latest
global release version before the next release.

For example, with `release=3.6.0`, Android at `3.6.0`, and desktop at `3.2.0`:

| PR title | Release tag | Desktop versions | Android version |
|---|---|---|---|
| `feat(desktop): new feature` | `v3.7.0` | `3.7.0` | `3.6.0` |
| `fix(android): fix crash` | `v3.7.1` | `3.7.0` | `3.7.1` |

These rows are sequential. A mixed `feat(desktop)+fix(android): improvements`
starting at `3.6.0` instead gives both desktop and Android `3.7.0`.

During builds, `apply_app_version.py` reads unpublished versions from the
`VERSIONS_JSON` environment variable and rewrites local source files so shipped
binaries report the right version. It does not change the public `version.json`.
After the release is published, the final job updates `version.json` and syncs
the same source constants on `main`:

| version.json key                 | Synced into                                                                 |
|----------------------------------|------------------------------------------------------------------------------|
| `windows` / `macos` / `linux_*`  | `ClipCascade_Desktop/src/core/constants.py` (`APP_VERSION` per platform)     |
| `android`                        | `ClipCascade_Mobile/src/AppVersion.js` (`APP_VERSION`)                       |
| `android`                        | `…/android/app/build.gradle` (`versionName` + computed `versionCode`)        |
| `server`                         | `…/constants/ServerConstants.java` (`APP_VERSION`)                          |
| `server`                         | `ClipCascade_Server/docker-compose/docker-compose.yml` (image tag)           |

`versionCode` is derived from the Android semver as `major*10000 + minor*100 + patch`.

### Tagging & the release tag

The tag is `v<release>`. Since every releasing change advances the global
counter, desktop-only releases also get a new tag even when Android previously
had a higher version. An existing tag causes the preparation job to fail before
pushing the version commit; PR-number suffixes are no longer generated.
Release notes list each platform's actual version, including carried-over ones.

### Announce updates only after publication

Clients read `version.json` from `main`, so it stays at the last published versions
throughout preparation and builds. The final job uploads all downloads to a draft
release, publishes it, then checks out the latest `main` and commits the new
metadata with `[skip release]`. Build or publication failures do not announce an
update to clients. The server job pushes only the versioned Docker image.
After GitHub Release publication, the release job points Docker `latest` at the
exact multi-architecture image digest returned by the server build, without
rebuilding it. Public version metadata is updated only after this promotion
succeeds. Releases that do not select the server leave Docker `latest` unchanged.

Retry failed jobs to finish an interrupted release. A retry resumes a draft or
reuses an already-published release only if it contains all expected downloads.
If publication succeeded but the final Git push failed, retrying the release job
finishes the announcement without bumping versions or creating another release.
If Docker promotion fails, the release is already published but `version.json`
remains unchanged. Retrying the release job repeats promotion using the original
server image digest, then finishes the announcement.
Finalization refuses to overwrite public versions changed by another release.

Build jobs still check out `main`, so a non-releasing repair can be merged before
retrying a failed build. Resolve failed releases before merging another releasing
change; the pending versions belong to the original run, not the latest source.

### Carry-over (full snapshot every release)

Release asset names are **static** (no version in the filename), e.g.
`ClipCascade.msi`, `ClipCascade.apk`. Platforms that were *not* bumped are not
rebuilt — `carry_artifacts.sh` downloads their assets from the previous release
so each release page contains the complete set of downloads. The very first
release (no previous tag) runs in "bootstrap mode" and simply skips carry-over.

### Windows packages

The Windows job uses Python **3.12.10** from `actions/setup-python`, builds the
x64 executable with PyInstaller, and packages it with WiX v3 into an MSI.

### macOS packages

The `macos` scope builds two native packages with the same macOS version:

| Processor | GitHub runner | Archive |
|---|---|---|
| Apple Silicon | `macos-14` (`arm64`) | `ClipCascade-Apple_macOS(ARM_M-Series).zip` |
| Intel | `macos-15-intel` (`x86_64`) | `ClipCascade-Apple_macOS(Intel-Series).zip` |

Both architectures use exactly **Python 3.12.10** from the signed python.org
universal2 installer, which bundles **Tcl/Tk 8.6.16**. Each runner creates a
dedicated virtual environment from its Python framework. The job fails before
dependency installation if the Python version or running architecture differs
from the required values. Tcl/Tk versions are not separately checked.
This replaces the previous Intel Python 3.11.2 pin.

Each job also checks aiortc/PyAV imports, uses the existing PyInstaller
specification, and verifies the packaged executable's architecture before uploading
its ZIP. These checks do not replace testing P2P in the packaged app.
Both builds must succeed for the release to publish. When macOS is
unchanged, both ZIPs are carried over from the previous release.

Both macOS jobs run `brew install ffmpeg pkg-config` before installing Python
dependencies to provide native build tools and libraries. Pip can still use
prebuilt PyAV wheels. If PyAV falls back to source, its supported FFmpeg version
must match the installed libraries; installing the tools alone does not guarantee
source-build compatibility.

Include `macos` (or `desktop` / `all`) in the first releasing PR after adding Intel
support so the new Intel ZIP is generated; older releases may not contain it.

### Avoiding release loops

The final announcement commit is pushed with `[skip release]` in its message, and the `prep`
job is gated on `!contains(head_commit.message, '[skip release]')`. (Pushes
made with the automatic `GITHUB_TOKEN` also don't retrigger workflows, so this
is belt-and-suspenders.)

### Concurrency

All runs share the `release` concurrency group with `cancel-in-progress: false`,
so releases are serialized — an in-flight build is never cancelled by a newer
merge; the newer one queues behind it.

---

## Required repository configuration

Set these under **Settings → Secrets and variables → Actions**.

### Secrets

| Secret                       | Used by   | Purpose                                          |
|------------------------------|-----------|--------------------------------------------------|
| `GITHUB_TOKEN`               | all       | Auto-provided. Bump push, tag, release, PR lookup.|
| `ANDROID_KEYSTORE_BASE64`    | android   | Base64-encoded upload keystore.                  |
| `ANDROID_KEYSTORE_PASSWORD`  | android   | Keystore (store) password.                       |
| `ANDROID_KEY_PASSWORD`       | android   | Key password.                                    |
| `DOCKERHUB_TOKEN`            | server + release | Push the versioned image and promote it to `latest`. |

### Variables

| Variable                     | Used by   | Example                          |
|------------------------------|-----------|----------------------------------|
| `ANDROID_KEYSTORE_FILENAME`  | android   | `upload.keystore`                |
| `ANDROID_KEY_ALIAS`          | android   | `upload`                         |
| `DOCKERHUB_USERNAME`         | server    | `sathvikrao`                     |
| `DOCKER_IMAGE_NAME`          | server    | `sathvikrao/clipcascade`         |

> The keystore is decoded into `…/android/app/<ANDROID_KEYSTORE_FILENAME>` and
> `gradle.properties` is materialized from the tracked template
> [`gradle.properties.ci`](../../ClipCascade_Mobile/src/android/gradle.properties.ci)
> at build time — the real `gradle.properties` stays gitignored so passwords
> never enter the repo.

### Branch protection

The final `release` job **pushes the version announcement back to `main`** after
the downloads are published. If `main` is a protected
branch, allow the `github-actions[bot]` actor to bypass the rules (or push with
an app/PAT token that can), otherwise the announcement fails and clients keep
seeing the old versions even though the downloads are published.

---

## Scripts reference

All live in [`../scripts/`](../scripts/).

| Script                  | Role                                                                                          |
|-------------------------|-----------------------------------------------------------------------------------------------|
| `parse_pr_title.py`     | Parse the PR title → `{release, bumps, platforms}` JSON. Exit 1 on an invalid title.          |
| `bump_version.py`       | Apply the strongest bump to `release`, assign it to selected platforms, and emit versions and tag. |
| `apply_app_version.py`  | Rewrite `APP_VERSION`/`versionCode`/image-tag constants from `version.json`. Idempotent.      |
| `finalize_versions.py`  | After publication, sync source constants and public versions; reject stale announcements. |
| `publish_release.sh`   | Upload downloads to a draft and publish it; handle retries without creating duplicate releases. |
| `build_release_body.py` | Build the release title + notes; "What's New" is lifted from the PR's `## Description`.        |
| `carry_artifacts.sh`    | Download unchanged-platform assets from the previous release.                                  |
| `generate_rtf.py`       | Convert `LICENSE` → minimal RTF for the WiX installer dialog.                                  |

### Run the parser locally

```bash
PR_TITLE="feat(server)+fix(windows): backend rewrite + tray crash" \
  python3 .github/scripts/parse_pr_title.py
```

This is exactly what `pr-title.yml` runs on each PR, so you can validate a
title before opening the PR.

---

## Manually skipping a release

Include `[skip release]` anywhere in the head commit message of a push to
`main` to bypass the pipeline entirely.
