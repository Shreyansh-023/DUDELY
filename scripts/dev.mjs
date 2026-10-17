/**
 * `npm run dev` — Next's dev server plus the live-transcription relay.
 *
 * The relay (scripts/stt-relay.mjs) is what makes speech appear as text while
 * you talk; Next can't host it because route handlers can't hold a WebSocket
 * open. Running both from one command keeps that an implementation detail.
 *
 * Child processes are spawned through this Node binary rather than a shell, so
 * the same script works on Windows and POSIX. Either child exiting takes the
 * other down, so Ctrl-C never leaves an orphan holding port 8787.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

const children = [];
let shuttingDown = false;

function run(name, file, args = []) {
  const child = spawn(process.execPath, [file, ...args], { stdio: "inherit", env: process.env });
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    if (code !== 0) console.error(`[dev] ${name} exited (${signal ?? code})`);
    stopAll(code ?? 0);
  });
  children.push(child);
  return child;
}

function stopAll(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    try {
      c.kill();
    } catch {}
  }
  process.exit(code);
}

run("relay", path.join(here, "stt-relay.mjs"));
run("next", require.resolve("next/dist/bin/next"), ["dev", ...process.argv.slice(2)]);

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => stopAll(0));
