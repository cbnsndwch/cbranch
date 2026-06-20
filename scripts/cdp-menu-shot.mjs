// Throwaway CDP driver: open the app, click the "Navigate" menubar trigger,
// screenshot the open dropdown, and report the popup's measured width.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const URL = "http://localhost:5173/";
const OUT = "D:/GIT_REPOS/DEVOPS/cbranch/scripts/menu-shot.png";
const PORT = 9222;
const userDir = mkdtempSync(join(tmpdir(), "cdp-"));

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1100,900",
    "--hide-scrollbars",
    URL,
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWsUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://localhost:${PORT}/json`);
      const tabs = await res.json();
      const page = tabs.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error("no CDP page target");
}

const wsUrl = await getWsUrl();
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let nextId = 1;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) {
      reject(new Error(JSON.stringify(msg.error)));
    } else {
      resolve(msg.result);
    }
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

const evalJs = async (expression) => {
  const { result } = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return result.value;
};

await send("Page.enable");
await send("Runtime.enable");
await send("Page.navigate", { url: URL });

// Poll until the menubar mounts (Vite dep re-optimization can trigger a reload).
let ready = false;
for (let i = 0; i < 40; i++) {
  const n = await evalJs(`document.querySelectorAll('[data-slot="menubar-trigger"]').length`);
  if (n > 0) {
    ready = true;
    break;
  }
  await sleep(500);
}
console.log("menubar ready:", ready);
await sleep(400);

// Click the "Navigate" top-menu trigger.
const clicked = await evalJs(`(() => {
  const trig = [...document.querySelectorAll('[data-slot="menubar-trigger"]')]
    .find(el => el.textContent.trim() === 'Navigate');
  if (!trig) return { ok: false, triggers: [...document.querySelectorAll('[data-slot="menubar-trigger"]')].map(e=>e.textContent.trim()) };
  const r = trig.getBoundingClientRect();
  ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(type =>
    trig.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: r.x+r.width/2, clientY: r.y+r.height/2 })));
  return { ok: true };
})()`);
console.log("trigger click:", JSON.stringify(clicked));
await sleep(900);

// Measure the open popup.
const measure = await evalJs(`(() => {
  const pop = document.querySelector('[data-slot="menubar-content"]') || document.querySelector('[data-slot="dropdown-menu-content"]');
  if (!pop) return { open: false };
  const r = pop.getBoundingClientRect();
  const items = [...pop.querySelectorAll('[data-slot="menubar-item"]')].map(el => ({
    text: el.textContent.trim().slice(0, 40),
    h: Math.round(el.getBoundingClientRect().height),
    hasIcon: !!el.querySelector('svg'),
  }));
  return { open: true, width: Math.round(r.width), itemCount: items.length, items };
})()`);
console.log("popup:", JSON.stringify(measure, null, 2));

const { data } = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(OUT, Buffer.from(data, "base64"));
console.log("screenshot saved:", OUT);

ws.close();
chrome.kill();
process.exit(0);
