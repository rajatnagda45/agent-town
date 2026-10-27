// Only isolated, headless test processes use these options.
export function browserCheckOptions(extraArgs = []) {
  const isolated = process.env.AGENT_TOWN_BROWSER_NO_SANDBOX === "1";
  return {
    headless: true,
    pipe: true,
    args: [
      "--autoplay-policy=no-user-gesture-required",
      ...(isolated ? ["--no-sandbox", "--disable-gpu"] : []),
      ...(isolated && process.platform === "win32"
        ? ["--disable-software-rasterizer", "--in-process-gpu"]
        : []),
      ...extraArgs,
    ],
  };
}
