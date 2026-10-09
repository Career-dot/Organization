// One path per AI operation. The AI service exposes each operation at its own
// endpoint, so the caller must name the operation it is requesting — there is no
// "generic" endpoint that would let a request be routed by mistake.
const AI_SERVICE_PATHS = {
  JOB_ANALYSIS: "/internal/v1/job-analysis",
  ASSESSMENT_GENERATION: "/internal/v1/assessment-generation",
  CANDIDATE_ANALYSIS: "/internal/v1/candidate-analysis",
};

// Localhost-only development fallback. Used when AI_SERVICE_URL is unset; no
// credential is ever baked in here.
const DEFAULT_AI_SERVICE_URL = "http://localhost:8000";

// The validated base URL of the AI service, WITHOUT any credential.
//
// Kept separate from getAiServiceConfig so a startup diagnostic can report where
// the worker would send its request without touching the shared secret. The
// checks are the same ones the request path applies — in particular userinfo,
// query and fragment are refused so a URL can never smuggle credentials into a
// log line.
const getAiServiceBaseUrl = () => {
  const url = new URL(process.env.AI_SERVICE_URL || DEFAULT_AI_SERVICE_URL);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("AI_SERVICE_NOT_CONFIGURED");
  }
  return url.href.replace(/\/$/, "");
};

const getAiServiceConfig = (operation = "JOB_ANALYSIS") => {
  const apiKey = process.env.AI_SERVICE_API_KEY;
  if (!apiKey?.trim()) {
    throw new Error("AI_SERVICE_NOT_CONFIGURED");
  }
  const path = AI_SERVICE_PATHS[operation];
  if (!path) {
    throw new Error("AI_SERVICE_NOT_CONFIGURED");
  }
  return { url: `${getAiServiceBaseUrl()}${path}`, apiKey };
};

// Secret-free description of the AI service configuration, for the worker's
// startup banner and for safe diagnostics.
//
// It answers exactly two questions and nothing more:
//   * is the internal shared secret present — a BOOLEAN only. The key, a prefix
//     of it and even its length are never included, and no provider credential
//     is read at all;
//   * which base URL would be called — the validated, credential-free value.
// When the configured URL is unusable the raw value is deliberately NOT echoed
// back (a URL can carry userinfo); url is then null and callers report it as
// invalid.
const describeAiServiceConfig = () => {
  let url = null;
  try {
    url = getAiServiceBaseUrl();
  } catch {
    url = null;
  }
  const keyConfigured = Boolean(process.env.AI_SERVICE_API_KEY?.trim());
  return {
    configured: Boolean(url) && keyConfigured,
    keyConfigured,
    url,
  };
};

module.exports = {
  getAiServiceConfig,
  getAiServiceBaseUrl,
  describeAiServiceConfig,
  AI_SERVICE_PATHS,
};
