// The custom server and Next routes share one runtime and one SQLite owner.
const key = Symbol.for("agent-town.server-runtime");

export function setServerRuntime(runtime) {
  globalThis[key] = runtime;
}

export function getServerRuntime() {
  const runtime = globalThis[key];
  if (!runtime)
    throw Object.assign(new Error("The authoritative task runtime is unavailable."), {
      status: 503,
    });
  return runtime;
}
