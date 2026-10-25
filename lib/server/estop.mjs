import { statSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";

// Pattern adapted from NousResearch/hermes-agent agent/estop.py (MIT): a sentinel file
// pauses NEW work only. In-flight tasks are never killed, so an emergency stop cannot
// itself create outcome-unknown side effects. Any doubt about the file means engaged.
export class EmergencyStop {
  constructor(path) {
    this.path = path;
  }

  engaged() {
    try {
      statSync(this.path);
      return true;
    } catch (error) {
      // Only a confirmed absence releases the stop; any other error fails safe.
      return error?.code !== "ENOENT";
    }
  }

  status() {
    if (!this.engaged()) return { engaged: false };
    try {
      const value = JSON.parse(readFileSync(this.path, "utf8"));
      return {
        engaged: true,
        since: typeof value.since === "string" ? value.since : null,
        reason: typeof value.reason === "string" ? value.reason.slice(0, 300) : null,
      };
    } catch {
      return { engaged: true, since: null, reason: "Emergency stop file is present." };
    }
  }

  engage(reason = "") {
    writeFileSync(
      this.path,
      JSON.stringify({ since: new Date().toISOString(), reason: String(reason).slice(0, 300) }),
    );
    return this.status();
  }

  release() {
    try {
      unlinkSync(this.path);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return this.status();
  }

  /** Throw before any new work starts. */
  assertClear() {
    const status = this.status();
    if (status.engaged)
      throw Object.assign(
        new Error(
          `Emergency stop is engaged${status.reason ? `: ${status.reason}` : ""}. New work is paused; in-flight work continues.`,
        ),
        { status: 423 },
      );
  }
}
