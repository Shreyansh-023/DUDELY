/* eslint-disable */
/**
 * Resolver hook so `node --experimental-strip-types` can import the app's own
 * TypeScript directly, the way scripts/qa-regress.mjs does.
 *
 * The source uses extensionless relative imports ("./util", "../ops") and the
 * "@/..." alias, both of which the Next/tsc bundler resolves and plain Node does
 * not. This adds the extension (and the alias root) at resolve time, so the
 * scripts test the real modules rather than patched copies of them.
 *
 *   node --experimental-strip-types --import ./scripts/ts-resolve.mjs scripts/qa-regress.mjs
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "node:module";

const ROOT = path.resolve(import.meta.dirname, "..");

export function resolve(specifier, context, next) {
  // "@/lib/x" -> "<root>/src/lib/x"
  let spec = specifier;
  if (spec.startsWith("@/")) {
    spec = pathToFileURL(path.join(ROOT, "src", spec.slice(2))).href;
  }
  // Extensionless relative import: try .ts, then .tsx, then /index.ts.
  if (/^(\.\.?\/|file:)/.test(spec) && !/\.(m?[jt]sx?|json|node)$/.test(spec)) {
    const base = spec.startsWith("file:")
      ? fileURLToPath(spec)
      : path.resolve(path.dirname(fileURLToPath(context.parentURL)), spec);
    for (const cand of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
      if (existsSync(cand)) {
        spec = pathToFileURL(cand).href;
        break;
      }
    }
  }
  return next(spec, context);
}

// Self-registering when passed via --import, so the script needs no other flags.
if (!process.env.__TS_RESOLVE_REGISTERED) {
  process.env.__TS_RESOLVE_REGISTERED = "1";
  register(import.meta.url, import.meta.url);
}
