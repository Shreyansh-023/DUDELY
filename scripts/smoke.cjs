/* eslint-disable */
/**
 * Headless smoke test: drives Chrome over the DevTools Protocol, opens the app
 * with an auto-asked question, waits for the lesson to play, then reports
 * console errors, the transcript, the Excalidraw scene and saves a screenshot.
 *
 *   node scripts/smoke.cjs http://localhost:3000 "why is 2/4 equal to 1/2?" out.png
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const CHROME =
  process.env.CHROME ||
  ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"].find((p) =>
    fs.existsSync(p),
  );
const base = process.argv[2] || "http://localhost:3000";
const question = process.argv[3] || "why is 2/4 equal to 1/2?";
const out = process.argv[4] || path.join(process.cwd(), ".tmp", "smoke.png");
const waitMs = Number(process.env.SMOKE_WAIT_MS || 40000);
const port = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const profile = path.join(process.cwd(), ".tmp", "chrome-cdp");
  fs.mkdirSync(path.join(process.cwd(), ".tmp"), { recursive: true });
  const chromeLog = fs.openSync(path.join(process.cwd(), ".tmp", "chrome.log"), "w");
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--no-first-run",
      "--disable-extensions",
      "--hide-scrollbars",
      "--autoplay-policy=no-user-gesture-required",
      `--remote-debugging-port=${port}`,
      "--remote-allow-origins=*",
      "--window-size=1400,900",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: ["ignore", chromeLog, chromeLog] },
  );
  try {
    let targets = null;
    for (let i = 0; i < 180 && !targets; i++) {
      await sleep(500);
      try {
        const list = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json());
        if (list.some((t) => t.type === "page")) targets = list;
      } catch {}
    }
    if (!targets) throw new Error("Chrome did not expose a debugging port (see .tmp/chrome.log)");
    const page = targets.find((t) => t.type === "page");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = rej;
    });
    let id = 0;
    const pending = new Map();
    const problems = [];
    const send = (method, params = {}) =>
      new Promise((res, rej) => {
        const i = ++id;
        pending.set(i, { res, rej });
        ws.send(JSON.stringify({ id: i, method, params }));
      });
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
        return;
      }
      if (msg.method === "Runtime.consoleAPICalled" && (msg.params.type === "error" || msg.params.type === "warning")) {
        problems.push(`[console.${msg.params.type}] ` + msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
      }
      if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params.exceptionDetails;
        problems.push(`[exception] ${d.text} ${d.exception?.description ?? ""}`);
      }
      if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
        problems.push(`[log] ${msg.params.entry.text} ${msg.params.entry.url ?? ""}`);
      }
    };
    await send("Runtime.enable");
    await send("Log.enable");
    await send("Page.enable");
    const url = `${base}/?q=${encodeURIComponent(question)}`;
    console.log("navigate", url);
    await send("Page.navigate", { url });
    await sleep(waitMs);

    const { result } = await send("Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => {
        const b = window.__guru;
        const els = b ? b.api.getSceneElements().map(e => e.type + (e.text ? ':' + JSON.stringify(e.text) : '') + '@' + Math.round(e.x) + ',' + Math.round(e.y)) : null;
        return JSON.stringify({
          excalidrawMounted: document.querySelectorAll('.excalidraw').length,
          canvases: document.querySelectorAll('canvas').length,
          status: document.querySelector('aside .font-medium')?.textContent,
          transcript: [...document.querySelectorAll('aside p')].map(p => p.textContent.trim()).filter(Boolean).slice(0, 8),
          sceneElements: els,
        }, null, 2);
      })()`,
    });
    console.log(result.value);
    if (process.env.SMOKE_EXPR) {
      const extra = await send("Runtime.evaluate", { returnByValue: true, expression: process.env.SMOKE_EXPR });
      console.log("EXTRA:", extra.result.value ?? extra.result.description);
    }
    const shot = await send("Page.captureScreenshot", { format: "png" });
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
    console.log("screenshot ->", out);
    console.log(problems.length ? "PROBLEMS:\n" + problems.join("\n") : "no console errors");
    ws.close();
  } finally {
    chrome.kill();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
