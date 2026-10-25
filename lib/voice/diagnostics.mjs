// Shared by the browser and server. Never retain provider text, URLs, or credentials.
export const VOICE_MODEL = "gemini-3.8-live";
export const VOICE_API_VERSION = "v1beta";
export const VOICE_BILLING_NOTICE =
  "Usage records are provider-reported metadata relayed by the browser, not Google's actual bill. Missing usage is unknown. Duration and any cost estimates are estimates, not charges. Check Google Cloud Billing for actual charges.";

const messages = {
  configuration:
    "Voice is not configured. Set GEMINI_API_KEY on the server and restart Agent Town.",
  selection:
    "This conversation or agent binding changed. Select the teammate again and start a new call.",
  origin: "Voice requires the same localhost or approved HTTPS origin as the workspace.",
  rate_limit: "Too many voice starts. Wait one minute before starting another call.",
  service_unavailable:
    "The voice service is temporarily unavailable. Check the server connection and try again.",
  model_api_version:
    "Gemini model or API version is unavailable. Check model access and API-version compatibility.",
  auth: "Google rejected Gemini access. Check key restrictions, project access, and billing.",
  quota: "Gemini quota exceeded. Check your Google project quota and billing.",
  connection: "Gemini voice connection failed. Check your network and Gemini access.",
  timeout: "Voice connection timed out. Check your network and Gemini access.",
  microphone_permission: "Allow microphone access in browser site settings.",
  microphone_missing: "Connect a microphone and try again.",
  microphone_busy:
    "The microphone could not be opened. Check your Mac or Windows microphone privacy settings, close other apps using it, and try again.",
  microphone_constraints:
    "The selected microphone does not support the requested audio settings. Choose another input device in browser settings.",
  browser_support:
    "Voice needs localhost or HTTPS and a browser with microphone and audio worklet support.",
  session_closed: "Gemini ended the voice session. Start a new call to continue.",
  call_limit: "10-minute call limit reached. Start a new call to continue.",
  media: "Voice audio connection failed. Check your microphone and start a new call.",
};

export function diagnosticMessage(code) {
  return messages[code] ?? messages.connection;
}

/** Whitelist only: diagnostic text is always generated locally. */
export function sanitizeDiagnostic(value) {
  const code = Object.hasOwn(messages, value?.code) ? value.code : "connection";
  const phase = ["browser", "provisioning", "connection", "call"].includes(value?.phase)
    ? value.phase
    : "connection";
  return {
    code,
    phase,
    message: diagnosticMessage(code),
    ...(Number.isInteger(value?.httpStatus) && value.httpStatus >= 400 && value.httpStatus <= 599
      ? { httpStatus: value.httpStatus }
      : {}),
    ...(Number.isInteger(value?.closeCode) && value.closeCode >= 1000 && value.closeCode <= 4999
      ? { closeCode: value.closeCode }
      : {}),
  };
}

/** Provider messages are examined for classification only, never returned or stored. */
export function classifyVoiceError(error, phase = "connection") {
  const status = Number(error?.status ?? error?.code);
  const text = typeof error?.message === "string" ? error.message : "";
  const code =
    error?.name === "NotAllowedError" || error?.name === "SecurityError"
      ? "microphone_permission"
      : error?.name === "NotFoundError"
        ? "microphone_missing"
        : error?.name === "NotReadableError" || error?.name === "TrackStartError"
          ? "microphone_busy"
          : error?.name === "OverconstrainedError"
            ? "microphone_constraints"
            : status === 429 || /RESOURCE_EXHAUSTED|quota exceeded|rate limit/i.test(text)
              ? "quota"
              : status === 401 ||
                  status === 403 ||
                  /PERMISSION_DENIED|UNAUTHENTICATED|invalid api key|token.*expired/i.test(text)
                ? "auth"
                : status === 404 ||
                    /api.?version|unsupported.*model|model.*(not found|not supported|unavailable)/i.test(
                      text,
                    )
                  ? "model_api_version"
                  : error?.name === "TimeoutError"
                    ? "timeout"
                    : phase === "browser"
                      ? "media"
                      : "connection";
  return sanitizeDiagnostic({ code, phase, httpStatus: status });
}

const tokenFields = [
  "promptTokenCount",
  "responseTokenCount",
  "totalTokenCount",
  "cachedContentTokenCount",
  "thoughtsTokenCount",
  "toolUsePromptTokenCount",
];
/** Preserve absent counts as unknown and discard all unrecognized fields. */
export function sanitizeUsage(value) {
  if (!value || typeof value !== "object") return undefined;
  const result = {};
  for (const field of tokenFields)
    if (Number.isSafeInteger(value[field]) && value[field] >= 0) result[field] = value[field];
  return Object.keys(result).length ? result : undefined;
}
