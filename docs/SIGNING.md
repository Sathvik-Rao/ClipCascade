# Release signing

This document describes how to sign ClipCascade release artifacts for self-hosted and public builds.

## Server (JAR / Docker)

- Prefer publishing Docker images by **digest** (`repo/image@sha256:…`) rather than mutable tags.
- For JAR distribution, create a detached signature:

```bash
# Example with cosign (keyless OIDC or local key)
cosign sign-blob --yes ClipCascade-Server-JRE_21.jar > ClipCascade-Server-JRE_21.jar.sig
cosign verify-blob --signature ClipCascade-Server-JRE_21.jar.sig ClipCascade-Server-JRE_21.jar
```

- Optionally attach an SBOM produced in CI (`sbom-server.cdx.json`) next to the artifact.

## Desktop (Windows / macOS / Linux)

### Windows
- Use an Authenticode certificate (EV recommended for SmartScreen).
- Sign the PyInstaller/exe output with `signtool` after the build.
- Timestamp with a trusted TSA.

### macOS
- Sign with a Developer ID Application certificate.
- Notarize with Apple Notary Service.
- Staple the notarization ticket to the `.app` / `.dmg`.

### Linux
- Publish a detached `sha256sum` and optionally a GPG signature of the wheel/tarball:

```bash
sha256sum clipcascade-*.whl > SHA256SUMS
gpg --detach-sign --armor SHA256SUMS
```

## Android

- Use a dedicated upload keystore (never commit keystores).
- Configure Gradle signing configs via environment variables / CI secrets:

```properties
# local.properties / CI secrets — do not commit
CLIPCASCADE_STORE_FILE=...
CLIPCASCADE_STORE_PASSWORD=...
CLIPCASCADE_KEY_ALIAS=...
CLIPCASCADE_KEY_PASSWORD=...
```

- For Play Store, enroll in Play App Signing and upload an AAB.
- For sideload APKs, publish the APK + SHA-256 checksum.

## iOS

- Sign with an Apple Distribution certificate and provisioning profile.
- Archive via Xcode / `xcodebuild` and notarize if distributing outside the App Store.

## Provenance

CI can emit:

- CycloneDX SBOM for the server JAR (`syft` / Maven CycloneDX plugin)
- GitHub Actions provenance via `actions/attest-build-provenance` on release tags

Operators should verify digests before deploying production self-host instances.
