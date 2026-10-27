import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";

/** Node distributions place npm beside node on Windows and under lib on Unix. */
export function findNpmCli(execPath, exists = existsSync) {
  const { dirname, resolve } = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(execPath) ? win32 : posix;
  const bin = dirname(execPath);
  return [
    resolve(bin, "node_modules/npm/bin/npm-cli.js"),
    resolve(bin, "../lib/node_modules/npm/bin/npm-cli.js"),
  ].find((candidate) => exists(candidate));
}
