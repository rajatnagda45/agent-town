import { expect, it } from "vitest";
import { findNpmCli } from "../../scripts/lib/npm-cli.mjs";

it("finds npm in the standard Unix Node distribution used by setup-node", () => {
  const cli = "/opt/node/lib/node_modules/npm/bin/npm-cli.js";
  expect(findNpmCli("/opt/node/bin/node", (path) => path === cli)).toBe(cli);
});
it("retains support for npm installed beside the Node executable", () => {
  const cli = "/opt/node/node_modules/npm/bin/npm-cli.js";
  expect(findNpmCli("/opt/node/node", (path) => path === cli)).toBe(cli);
});
it("does not substitute another npm when the Node distribution has none", () => {
  expect(findNpmCli("/opt/node/bin/node", () => false)).toBeUndefined();
});
it("finds npm beside a Windows executable independently of the test host", () => {
  const cli = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
  expect(findNpmCli("C:\\Program Files\\nodejs\\node.exe", (path) => path === cli)).toBe(cli);
});
