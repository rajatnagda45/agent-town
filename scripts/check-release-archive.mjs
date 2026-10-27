import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

assert.equal(process.versions.node.split(".")[0], "22", "Archive validation requires Node 22.");
const output = resolve("../artifacts/agent-town-release");
const receiptPath = join(output, "release-validation.json");
const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
assert.equal(basename(receipt.package), receipt.package);
const archive = join(output, receipt.package);
assert.equal(createHash("sha256").update(readFileSync(archive)).digest("hex"), receipt.sha256);
const entries = execFileSync("tar", ["-tzf", archive], {
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
})
  .trim()
  .split(/\r?\n/);
assert(
  entries.every((entry) => entry.startsWith("package/") && !entry.split(/[\\/]/).includes("..")),
);
const temporary = mkdtempSync(join(tmpdir(), "agent-town-release-"));
try {
  execFileSync("tar", ["-xzf", archive, "-C", temporary]);
  const root = join(temporary, "package");
  const version = execFileSync(process.execPath, [join(root, "bin/agent-town.mjs"), "--version"], {
    encoding: "utf8",
  }).trim();
  assert.equal(version, receipt.version);
  await new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [resolve("scripts/check-phase2.mjs")], {
      windowsHide: true,
      stdio: "inherit",
      env: {
        ...process.env,
        AGENT_TOWN_PACKAGED_SERVER: join(root, ".next/standalone/server.prod.mjs"),
      },
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolveRun() : reject(new Error(`Release archive checks failed (${code}).`)),
    );
  });
  receipt.archiveValidation = {
    node: process.version,
    completedAt: new Date().toISOString(),
    cliVersion: version,
    packagedStartup: true,
    mockedBrowserChecks: true,
  };
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(
    `PASS: extracted release archive ${receipt.package}, CLI, packaged startup and mocked browser checks.`,
  );
} finally {
  // Delete only this freshly allocated verification directory inside the OS temp root.
  assert.equal(dirname(resolve(temporary)), resolve(tmpdir()));
  assert(basename(temporary).startsWith("agent-town-release-"));
  rmSync(temporary, { recursive: true, force: true });
}
