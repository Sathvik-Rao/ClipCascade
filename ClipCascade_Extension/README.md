# ClipCascade for Chrome

A browser extension client for ClipCascade. It syncs your clipboard with your other ClipCascade devices through a server running in **server mode** (the default; P2P mode isn't supported yet). It works with any Chromium browser version 116 or later, including ChromeOS, Edge and Brave.

It's aimed at machines where you can't install the desktop app, such as ChromeOS and managed work laptops. It also works as a lightweight companion on machines where you can.

## Features

- **Compatible with the other clients.** Same login, same STOMP protocol and same end-to-end encryption as the desktop and Android apps. No server changes are needed.
- **Two ways to capture copies:**
  - **Web pages** (on by default): whatever you copy or cut in a tab is sent.
  - **Other apps** (opt-in): the system clipboard is checked every second, like the desktop app does.
- **Receiving:**
  - Text goes straight to your clipboard.
  - Images and files wait in the popup, where you can copy or save them.
- **Right-click menu:** send a selection, link, image or page URL.
- **Keyboard shortcut:** <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> sends the current clipboard.
- **Recent clips:** the popup lists the last 20 clips. They're kept in memory only and cleared when the browser exits.

## Install (developer mode)

```sh
cd ClipCascade_Extension
npm install
npm run build
```

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick `ClipCascade_Extension/dist`.
3. Click the ClipCascade icon and sign in with your server URL and account.

If encryption is on for your other devices, keep it on here with the same hash rounds and salt. You'll find these under **Encryption** in the sign-in form.

### Self-hosted servers with `CC_ALLOWED_ORIGINS`

The extension's websocket connects from `chrome-extension://<extension id>`. If you've restricted `CC_ALLOWED_ORIGINS`, add that origin to it. The extension id is shown on `chrome://extensions`.

## Development

```sh
npm run build      # typecheck + build into dist/
npm test           # unit tests, including crypto interop with the desktop client
npm run typecheck
```

The crypto tests check the extension against vectors made by the desktop client's own `CipherManager` (`tests/fixtures/generate_crypto_fixtures.py`). If `python3` with `pycryptodome` is installed, the tests also have the desktop code decrypt what the extension encrypts.

`npm run test:e2e` drives the built extension in Chromium against a real server, with a Node client standing in for another device. It covers sign-in, receiving, copy capture, polling, echo suppression, the popup and service-worker restarts. Details are at the top of `tests/e2e/extension.e2e.mjs`.

```sh
SERVER=http://127.0.0.1:8080 CC_USER=admin CC_PASS=admin123 xvfb-run -a npm run test:e2e
```

## Continuous integration and releases

`.github/workflows/extension.yml` runs on every push or pull request that touches this folder. It has three jobs:

- **test:** typecheck, unit tests (including the Python interop check), build, and a packaged `ClipCascade-Extension-<version>.zip` with `SHA256SUMS.txt`, uploaded as a workflow artifact.
- **e2e:** builds and starts the server from this repository, then runs `npm run test:e2e` against it in Chromium.
- **release:** runs only for tags named `extension-v<version>`, and only after both jobs above pass. It publishes the zip and checksums as a GitHub release.

To cut a release:

1. Bump `version` in `package.json`. The build copies it into `manifest.json`.
2. Commit, then tag and push:

   ```sh
   git tag extension-v1.0.1
   git push origin extension-v1.0.1
   ```

Or, without pushing a tag: open **Actions → Chrome extension → Run workflow**, pick the branch and tick **release**. The job then creates the `extension-v<version>` tag on the commit it built, and refuses if that tag already exists.

The release job fails if the tag doesn't match `package.json`. It also marks the release as not "Latest", so the desktop and server downloads stay the repository's latest release.

See [DESIGN.md](DESIGN.md) for the architecture, the protocol details and the Manifest V3 constraints behind them.
