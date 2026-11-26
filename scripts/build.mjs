import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(rootDir, "dist");
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: {
    cli: resolve(rootDir, "src/cli.ts"),
  },
  outdir: outDir,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  minify: false,
  banner: {
    js: "#!/usr/bin/env node",
  },
});

console.log("Built dist/cli.mjs");
