const { getAiServiceConfig } = require("../../config/aiService");
const { getAiQueueConfig } = require("../../config/redis");
const { buildRequest, validateResponse } = require("./aiJob.validation");

class AiServiceError extends Error {
  constructor(code, retryable, retryAfterMs = 0) {
    super(code);
    this.code = code;
    this.retryable = retryable;
    this.retryAfterMs = Math.min(300000, Math.max(0, Number(retryAfterMs) || 0));
  }
}
const errorPolicy = {
  AI_PROVIDER_RATE_LIMITED: [429, true], AI_PROVIDER_UNAVAILABLE: [503, true],
  AI_PROVIDER_TIMEOUT: [504, true], AI_PROVIDER_NETWORK_ERROR: [503, true],
  AI_RESPONSE_VALIDATION_FAILED: [502, true], AI_REQUEST_INVALID: [422, false],
  AI_PROVIDER_SAFETY_BLOCKED: [422, false], AI_SERVICE_UNAUTHORIZED: [401, false],
  AI_PROVIDER_NOT_CONFIGURED: [503, false], AI_SERVICE_NOT_CONFIGURED: [503, false],
  AI_PROVIDER_CONFIGURATION_ERROR: [503, false], AI_SERVICE_INTERNAL_ERROR: [500, false],
};
const analyzeAiJob = async (row) => {
  let config, request;
  try { config = getAiServiceConfig(row?.operation); } catch { throw new AiServiceError("AI_SERVICE_NOT_CONFIGURED", false); }
  try { request = buildRequest(row); } catch { throw new AiServiceError("AI_REQUEST_INVALID", false); }
  const body = JSON.stringify(request);
  if (Buffer.byteLength(body) > 262144) throw new AiServiceError("AI_REQUEST_INVALID", false);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), getAiQueueConfig().requestTimeoutMs);
  try {
    const response = await fetch(config.url, {
      method: "POST", redirect: "error", signal: controller.signal,
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" }, body,
    });
    const reader = response.body?.getReader();
    if (!reader) throw new AiServiceError("AI_RESPONSE_VALIDATION_FAILED", true);
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 262144) { await reader.cancel(); throw new AiServiceError("AI_RESPONSE_VALIDATION_FAILED", true); }
      chunks.push(Buffer.from(value));
    }
    let data;
    try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new AiServiceError("AI_RESPONSE_VALIDATION_FAILED", true); }
    if (response.status !== 200) {
      const policy = errorPolicy[data?.error?.code];
      if (policy && policy[0] === response.status) throw new AiServiceError(data.error.code, policy[1], data.error.retryAfterMs);
      throw new AiServiceError("AI_SERVICE_HTTP_ERROR", [429, 502, 503, 504].includes(response.status));
    }
    if (!response.headers.get("content-type")?.includes("application/json")) throw new AiServiceError("AI_RESPONSE_VALIDATION_FAILED", true);
    try { return validateResponse(data, request); }
    catch { throw new AiServiceError("AI_RESPONSE_VALIDATION_FAILED", true); }
  } catch (error) {
    if (error instanceof AiServiceError) throw error;
    throw new AiServiceError(controller.signal.aborted ? "AI_PROVIDER_TIMEOUT" : "AI_PROVIDER_NETWORK_ERROR", true);
  } finally { clearTimeout(timer); }
};
module.exports = { analyzeAiJob, AiServiceError };
