// Runs the official Meterless H-MEM conformance suite (vendored with the engine) against the
// exact engine copy Agent Town uses, and prints the scorecard. Exit code is the suite's.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

// Default: the built engine Agent Town ships. Pass "source" to test the TypeScript original.
const engine = resolve(
  process.argv[2] === "source"
    ? "lib/vendor/hmem-reference/index.ts"
    : "lib/vendor/hmem-reference/dist/index.mjs",
);
const runner = resolve("lib/vendor/hmem-reference/conformance/runner.ts");
const result = spawnSync(process.execPath, ["--import", "tsx", runner], {
  env: { ...process.env, HMEM_IMPL: engine.replaceAll("\\", "/") },
  stdio: "inherit",
});
process.exitCode = result.status ?? 1;
