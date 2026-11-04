// End-to-end test: the built extension in Chromium <-> a real ClipCascade server
// (server mode) <-> an independent Node "peer" client with its own STOMP and
// crypto (node:crypto), standing in for the desktop app.
//
//   npm run build
//   SERVER=http://127.0.0.1:8080 CC_USER=admin CC_PASS=admin123 npm run test:e2e
//
// Needs a display (use xvfb-run on a headless Linux box). Set CHROMIUM_PATH to
// use a specific Chromium build. Test data is sent through the given account,
// with encryption on and the default hash rounds and salt.
import { chromium } from "playwright";
import { Client } from "@stomp/stompjs";
import WebSocket from "ws";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const SERVER = process.env.SERVER ?? "http://127.0.0.1:8080";
const USER = process.env.CC_USER ?? "admin";
const PASS = process.env.CC_PASS ?? "admin123";
const ROUNDS = 664937;
const EXT = path.resolve(process.argv[2] ?? "dist");
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeout = 10000, step = 200) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  }
  return null;
}

// ---- peer: independent implementation of the desktop client's protocol
const key = crypto.pbkdf2Sync(PASS, USER + PASS + "", ROUNDS, 32, "sha256");
const enc = (text) => {
  const nonce = crypto.randomBytes(16);
  const c = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return JSON.stringify({ nonce: nonce.toString("base64"), ciphertext: ct.toString("base64"), tag: c.getAuthTag().toString("base64") });
};
const dec = (payload) => {
  const { nonce, ciphertext, tag } = JSON.parse(payload);
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(ciphertext, "base64")), d.final()]).toString("utf8");
};
const sha3 = (s) => crypto.createHash("sha3-512").update(s).digest("hex");

async function peerLogin() {
  const r1 = await fetch(SERVER + "/login");
  let cookie = r1.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const csrf = /name="_csrf"[^>]*value="([^"]+)"/.exec(await r1.text())[1];
  const r2 = await fetch(SERVER + "/login", {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: USER, password: sha3(PASS), _csrf: csrf }),
  });
  const set = r2.headers.getSetCookie().map((c) => c.split(";")[0]);
  if (set.length) cookie = set.join("; ");
  if (!String(r2.headers.get("location")).endsWith("/")) throw new Error("peer login failed " + r2.headers.get("location"));
  return cookie;
}

const received = [];
async function startPeer() {
  const cookie = await peerLogin();
  const client = new Client({
    webSocketFactory: () => new WebSocket(SERVER.replace("http", "ws") + "/clipsocket", { headers: { Cookie: cookie } }),
    reconnectDelay: 0,
  });
  await new Promise((resolve, reject) => {
    client.onConnect = () => {
      client.subscribe("/user/queue/cliptext", (m) => {
        const body = JSON.parse(m.body);
        received.push({ type: body.type, text: dec(body.payload) });
      });
      resolve();
    };
    client.onStompError = reject;
    client.onWebSocketError = reject;
    client.activate();
  });
  return {
    send: (text, type = "text") => client.publish({ destination: "/app/cliptext", body: JSON.stringify({ payload: enc(text), type }) }),
    stop: () => client.deactivate(),
  };
}

// ---- browser
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-ext-"));
const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath: process.env.CHROMIUM_PATH || undefined,
  headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
try {
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent("serviceworker");
  const extId = new URL(worker.url()).host;
  check("extension service worker started", !!extId, extId);

  const popup = await context.newPage();
  popup.on("console", (m) => m.type() === "error" && console.log("  [popup]", m.text()));
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.fill('input[name="serverUrl"]', SERVER);
  await popup.fill('input[name="username"]', USER);
  await popup.fill('input[name="password"]', PASS);
  const t0 = Date.now();
  await popup.click('button[type="submit"]');
  // The popup reads "Signed out" until the attempt starts, so a failure needs an error message too.
  const status = await until(async () => {
    const s = await popup.textContent("#status");
    const e = await popup.textContent("[data-error]");
    return s === "Connected" || s === "Offline" || (s === "Signed out" && e) ? s : null;
  }, 20000);
  const err = await popup.textContent("[data-error]");
  check("sign in + websocket connect", status === "Connected", `${status} in ${Date.now() - t0} ms ${err}`);

  const peer = await startPeer();
  const sendMsg = (msg) => popup.evaluate((m) => chrome.runtime.sendMessage(m), msg);
  const readClipboard = async () => (await sendMsg({ target: "offscreen", type: "read" }))?.data;

  // 1. peer -> extension, text lands on the clipboard and in history
  peer.send("hello from the peer ✓");
  const clip = await until(async () => {
    const c = await readClipboard();
    return c?.text === "hello from the peer ✓" ? c : null;
  });
  check("receive: encrypted text decrypted and written to clipboard", !!clip);
  const inHistory = await until(async () => (await popup.textContent("#history"))?.includes("hello from the peer"));
  check("receive: shows in popup history", !!inHistory);

  // 2. copy in a web page -> peer
  const page = await context.newPage();
  await page.goto(SERVER + "/login");
  await page.evaluate(() => {
    const p = document.createElement("p");
    p.id = "src";
    p.textContent = "copied in a web page 123";
    document.body.prepend(p);
    const r = document.createRange();
    r.selectNodeContents(p);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  });
  await page.keyboard.press("Control+C");
  const got = await until(() => received.find((r) => r.text === "copied in a web page 123"));
  check("capture: copy event in a tab is sent (peer decrypts it)", !!got);

  // 3. echo suppression: the server echoes our send back to us
  await sleep(1000);
  const hist = await sendMsg({ type: "getState" });
  const echoes = hist.data.history.filter((h) => h.summary === "copied in a web page 123");
  check("echo: own message not recorded as received", echoes.length === 1 && echoes[0].direction === "out", JSON.stringify(echoes.map((e) => e.direction)));

  // 4. same content again is not re-sent
  const before = received.length;
  await page.keyboard.press("Control+C");
  await sleep(1500);
  check("dedupe: copying the same text again is not re-sent", received.length === before);

  // 5. polling picks up a clipboard write that has no copy event
  await sendMsg({ type: "updateSettings", settings: { pollSystemClipboard: true } });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: SERVER });
  await page.bringToFront();
  await page.evaluate(() => navigator.clipboard.writeText("written without a copy event"));
  const polled = await until(() => received.find((r) => r.text === "written without a copy event"));
  check("polling: clipboard change from 'another app' is sent", !!polled);
  await sendMsg({ type: "updateSettings", settings: { pollSystemClipboard: false } });

  // 6. popup send box
  await popup.bringToFront();
  await popup.fill("#composeText", "typed in the popup");
  await popup.click('#compose button[type="submit"]');
  const typed = await until(() => received.find((r) => r.text === "typed in the popup"));
  check("popup: send box delivers text", !!typed);

  // 7. image from peer -> popup history with thumbnail
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
  peer.send(png, "image");
  const thumb = await until(() => popup.$("#history img.thumb"));
  check("receive: image shows in popup with a thumbnail", !!thumb);

  // 8. files from peer -> Save button
  peer.send(JSON.stringify({ "notes.txt": Buffer.from("file body").toString("base64") }), "files");
  const save = await until(async () => (await popup.$$eval("#history button", (b) => b.map((x) => x.textContent))).includes("Save"));
  check("receive: files show a Save button", !!save);

  // 9. size limit enforced before sending
  const big = await sendMsg({ type: "sendClip", clip: { type: "text", text: "x".repeat(2 * 1024 * 1024) } });
  check("limits: oversize clip rejected with a clear error", big.ok === false && /Too large/.test(big.error), big.error);

  // 10. service worker restart: session restored and reconnects
  const cdp = await context.newCDPSession(popup);
  const { targetInfos } = await cdp.send("Target.getTargets");
  const sw = targetInfos.find((t) => t.type === "service_worker" && t.url.includes(extId));
  await cdp.send("Target.closeTarget", { targetId: sw.targetId });
  await sleep(500);
  await popup.reload();
  const restored = await until(async () => (await popup.textContent("#status")) === "Connected", 20000);
  check("lifecycle: service worker killed -> session restored and reconnected", !!restored);
  peer.send("after restart");
  const afterRestart = await until(async () => (await readClipboard())?.text === "after restart");
  check("lifecycle: receives after restart", !!afterRestart);

  // 11. sign out
  await popup.click("#signOut");
  const out = await until(async () => (await popup.textContent("#status")) === "Signed out");
  check("sign out", !!out);

  await peer.stop();
} finally {
  await context.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
