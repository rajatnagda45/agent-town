export const MAX_WEBSOCKET_PAYLOAD_BYTES = 1024 * 1024;

/** Build the authenticated upstream connection without accepting browser credentials. */
export function buildGatewayConnection(gatewayUrl, serverToken) {
  const url = new URL(gatewayUrl);
  /** @type {Record<string, string>} */
  const headers = {};
  if (serverToken) {
    url.searchParams.set("token", serverToken);
    headers.Authorization = `Bearer ${serverToken}`;
  }
  return { url: url.toString(), headers };
}

/** Replace auth on connect frames so credentials can only originate on the server. */
export function sanitizeGatewayClientMessage(data, isBinary, serverToken) {
  if (isBinary) return data;
  try {
    const frame = JSON.parse(data.toString());
    if (frame.type === "req" && frame.method === "connect") {
      frame.params = frame.params ?? {};
      frame.params.auth = serverToken ? { token: serverToken } : {};
      return Buffer.from(JSON.stringify(frame));
    }
  } catch {
    // Non-JSON frames are forwarded unchanged.
  }
  return data;
}
