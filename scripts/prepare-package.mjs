/**
 * Prepare the standalone build for npm publishing.
 *
 * After `next build` with output: 'standalone':
 * 1. Flatten pnpm node_modules (resolve .pnpm symlinks into flat structure)
 * 2. Copy public/        → .next/standalone/public/
 * 3. Copy .next/static/  → .next/standalone/.next/static/
 * 4. Copy server.prod.mjs → .next/standalone/server.prod.mjs
 * 5. Copy lib/*.mjs runtime modules → .next/standalone/lib/
 */

import {
  existsSync,
  readdirSync,
  statSync,
  mkdirSync,
  rmSync,
  renameSync,
  cpSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { resolve, dirname, join, sep, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const standalone = resolve(root, ".next", "standalone");

if (!existsSync(standalone)) {
  console.error("ERROR: .next/standalone/ not found. Run `next build` first.");
  process.exit(1);
}

console.log("Preparing standalone package...\n");

// --- 1. Flatten pnpm node_modules ---
const nm = resolve(standalone, "node_modules");
const pnpmDir = resolve(nm, ".pnpm");
const flatNm = resolve(standalone, "node_modules_flat");
// Only generated directories immediately inside this standalone output may be
// replaced. Copying is also safe on Windows volumes that reject directory rename.
if (dirname(nm) !== standalone || dirname(flatNm) !== standalone)
  throw new Error("Package dependency paths escaped the standalone output.");
if (existsSync(flatNm) && !existsSync(nm)) {
  cpSync(flatNm, nm, { recursive: true });
  rmSync(flatNm, { recursive: true });
  console.log("  done  Recovered flattened dependencies from an interrupted preparation");
}

if (existsSync(pnpmDir)) {
  if (existsSync(flatNm)) rmSync(flatNm, { recursive: true });
  mkdirSync(flatNm, { recursive: true });

  for (const spec of readdirSync(pnpmDir)) {
    if (spec.startsWith(".")) continue;
    const innerNm = resolve(pnpmDir, spec, "node_modules");
    if (!existsSync(innerNm) || !statSync(innerNm).isDirectory()) continue;

    for (const pkg of readdirSync(innerNm)) {
      if (pkg.startsWith(".")) continue;
      const src = resolve(innerNm, pkg);

      if (pkg.startsWith("@")) {
        for (const scopedPkg of readdirSync(src)) {
          const scopedSrc = resolve(src, scopedPkg);
          const scopedDest = resolve(flatNm, pkg, scopedPkg);
          if (!existsSync(scopedDest)) {
            mkdirSync(resolve(flatNm, pkg), { recursive: true });
            cpSync(scopedSrc, scopedDest, { recursive: true, dereference: true });
          }
        }
      } else {
        const dest = resolve(flatNm, pkg);
        if (!existsSync(dest)) {
          cpSync(src, dest, { recursive: true, dereference: true });
        }
      }
    }
  }

  rmSync(nm, { recursive: true });
  try {
    renameSync(flatNm, nm);
  } catch (error) {
    if (error.code !== "EPERM" && error.code !== "EACCES") throw error;
    cpSync(flatNm, nm, { recursive: true });
    rmSync(flatNm, { recursive: true });
  }
  console.log("  done  Flattened pnpm node_modules/");
} else {
  console.log("  skip  node_modules/ already flat");
}

// --- 2. Copy public/ ---
cpSync(resolve(root, "public"), resolve(standalone, "public"), {
  recursive: true,
});
console.log("  done  public/ → standalone/public/");

// --- 3. Copy .next/static/ ---
cpSync(resolve(root, ".next", "static"), resolve(standalone, ".next", "static"), {
  recursive: true,
});
console.log("  done  .next/static/ → standalone/.next/static/");

// --- 4. Copy server.prod.mjs ---
cpSync(resolve(root, "server.prod.mjs"), resolve(standalone, "server.prod.mjs"));
console.log("  done  server.prod.mjs → standalone/server.prod.mjs");

// --- 5. Copy runtime modules imported by server.prod.mjs ---
for (const file of [
  "ws-proxy.mjs",
  "auggie-bridge.mjs",
  "internal-api.mjs",
  "server-security.mjs",
  "ws-proxy-shared.mjs",
  "operations-contracts.mjs",
  "reasoning-contracts.mjs",
  "mcp/agent-town-mcp.mjs",
  "voice/diagnostics.mjs",
]) {
  cpSync(resolve(root, "lib", file), resolve(standalone, "lib", file));
}
console.log("  done  lib/*.mjs → standalone/lib/");
cpSync(resolve(root, "lib/server"), resolve(standalone, "lib/server"), { recursive: true });
// The built Meterless H-MEM engine imported by lib/server/decision-memory.mjs.
cpSync(
  resolve(root, "lib/vendor/hmem-reference/dist"),
  resolve(standalone, "lib/vendor/hmem-reference/dist"),
  {
    recursive: true,
  },
);

// Next traces route dependencies, but does not trace imports of the custom server
// entry point. Bundle those packages and their required dependency trees explicitly.
function copyServerDependency(name, requireFrom, nodeModules, ancestors = new Set()) {
  const manifest = realpathSync(requireFrom.resolve(`${name}/package.json`));
  const source = dirname(manifest);
  const destination = resolve(nodeModules, name);
  cpSync(source, destination, {
    recursive: true,
    dereference: true,
    filter: (path) => !relative(source, path).split(sep).includes("node_modules"),
  });
  if (ancestors.has(manifest)) return;
  const next = new Set([...ancestors, manifest]);
  const dependencies = JSON.parse(readFileSync(manifest, "utf8")).dependencies ?? {};
  for (const dependency of Object.keys(dependencies))
    copyServerDependency(
      dependency,
      createRequire(manifest),
      resolve(destination, "node_modules"),
      next,
    );
}
for (const name of ["ws", "ajv"])
  copyServerDependency(name, createRequire(resolve(root, "package.json")), nm);
console.log("  done  Custom server dependencies and required transitive packages");

// A previous local build can leave runtime data in this generated directory.
// Strip only generated copies; the workspace database and local environment stay intact.
function stripPrivateFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = resolve(join(directory, entry.name));
    if (!target.startsWith(`${standalone}${sep}`))
      throw new Error("Package cleanup escaped standalone output.");
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") stripPrivateFiles(target);
    } else if (/^\.env(?:\.|$)/.test(entry.name) || /\.sqlite(?:-(?:wal|shm))?$/.test(entry.name)) {
      rmSync(target);
    }
  }
}
stripPrivateFiles(standalone);

console.log("\n  Standalone package ready.\n");
