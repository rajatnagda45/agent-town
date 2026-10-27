import { NightshiftGateway } from "../lib/server/nightshift-gateway.mjs";

const gateway = new NightshiftGateway({
  baseUrl: process.env.NIGHTSHIFT_BASE_URL ?? "http://127.0.0.1:8088/v1",
  apiKey: process.env.NIGHTSHIFT_API_KEY,
  model: process.env.NIGHTSHIFT_MODEL ?? "meterless/auto",
});
await gateway.start();
const result = {
  provider: "nightshift",
  status: gateway.status,
  model: gateway.model,
  reason: gateway.lastError,
};
console.log(JSON.stringify(result));
process.exitCode = result.status === "connected" ? 0 : 1;
gateway.stop();
