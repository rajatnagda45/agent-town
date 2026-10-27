import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { findNpmCli } from "./lib/npm-cli.mjs";

assert.equal(
  process.versions.node.split(".")[0],
  "22",
  "Local release packages must be validated using Node 22.",
);
const output = resolve("../artifacts/agent-town-release");
const validation = JSON.parse(readFileSync(resolve("../artifacts/phase3-validation.json"), "utf8"));
const buildId = readFileSync(".next/BUILD_ID", "utf8").trim();
assert.equal(
  validation.buildId,
  buildId,
  "Run phase3:check against this production build before packaging.",
);
assert.equal(validation.mocked, true);
assert.equal(validation.node.split(".")[0], "v22");
mkdirSync(output, { recursive: true });
const npm = findNpmCli(process.execPath);
assert(npm, "Use a Node 22 distribution with npm to create the local archive.");
const args = [npm, "pack", "--ignore-scripts", "--json", "--pack-destination", output];
const packOptions = {
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
  env: {
    ...process.env,
    HUSKY: "0",
    npm_config_ignore_scripts: "true",
    npm_config_offline: "true",
    npm_config_update_notifier: "false",
    npm_config_cache: resolve("../artifacts/npm-release-cache"),
  },
};
// npm 10 still emits the disabled Husky prepare message before --json output.
const pack = (extra = []) => {
  const output = execFileSync(process.execPath, [...args, ...extra], packOptions);
  const json = /\[\s*\{[\s\S]*\}\s*\]\s*$/.exec(output);
  assert(json, "npm pack did not return an archive manifest.");
  return JSON.parse(json[0])[0];
};
const preview = pack(["--dry-run"]);
for (const { path } of preview.files) {
  assert(
    !/(?:^|\/)\.env(?:\.|$)|\.sqlite(?:-(?:wal|shm))?$/.test(path),
    `Private runtime file in release: ${path}`,
  );
}
for (const path of [
  "bin/agent-town.mjs",
  ".next/standalone/server.prod.mjs",
  ".next/standalone/lib/server/voice.mjs",
  ".next/standalone/lib/reasoning-contracts.mjs",
  ".next/standalone/lib/voice/diagnostics.mjs",
  ".next/standalone/node_modules/ws/package.json",
  ".next/standalone/node_modules/ajv/package.json",
])
  assert(
    preview.files.some((file) => file.path === path),
    `Missing packaged runtime file: ${path}`,
  );
const result = pack();
const archive = join(output, result.filename);
const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
const report = {
  package: result.filename,
  version: result.version,
  node: process.version,
  buildId,
  size: result.size,
  files: result.entryCount,
  sha256,
  published: false,
  mockedValidation: validation,
};
writeFileSync(join(output, "release-validation.json"), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(join(output, `${result.filename}.sha256`), `${sha256}  ${result.filename}\n`);
console.log(
  `Local release package: ${archive}\nSHA-256: ${sha256}\nNo publishing or version change performed.`,
);
