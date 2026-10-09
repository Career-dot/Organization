import { API_URL } from "./apiClient";
import { getAuthSession } from "./authSession";

// ---------------------------------------------------------------------------
// Phase 4 — realtime candidate-status client (Server-Sent Events over fetch).
//
// WHY fetch INSTEAD OF EventSource: this platform authenticates with a Bearer
// access token held in sessionStorage (there is no auth cookie), and
// EventSource cannot send an Authorization header. A plain fetch + stream
// reader therefore reuses the EXISTING authentication unchanged, supports a
// proper abort on unmount, and never puts a token in a URL where it could be
// logged.
//
// CONTRACT WITH THE BACKEND: this client is a NOTIFICATION channel, never a
// source of truth. Events only tell the UI which job changed; the component
// then re-reads the authoritative API. Duplicate and out-of-order events are
// therefore harmless by construction, and a missed event is recovered by the
// refetch that runs on every (re)connect.
//
// RECONNECT: bounded exponential backoff with jitter — 1s, 2s, 4s, 8s, 15s,
// 30s (capped). An authentication failure (401/403) is retried with the longest
// delay while the access token may be refreshed elsewhere, then reported
// OFFLINE; the dashboard keeps working through normal HTTP either way.
// ---------------------------------------------------------------------------

export const REALTIME_CONNECTION_STATE = {
  CONNECTING: "CONNECTING",
  CONNECTED: "CONNECTED",
  RECONNECTING: "RECONNECTING",
  OFFLINE: "OFFLINE",
};

export const REALTIME_STATE_LABELS = {
  CONNECTING: "Connecting…",
  CONNECTED: "Live",
  RECONNECTING: "Reconnecting…",
  OFFLINE: "Offline",
};

const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000, 30000];
const MAX_AUTH_RETRIES = 3;

const delayFor = (attempt) => {
  const base = BACKOFF_MS[Math.min(Math.max(attempt, 1), BACKOFF_MS.length) - 1];
  // Jitter keeps many tabs from reconnecting on the same tick.
  return base + Math.floor(Math.random() * 250);
};

// The authorized stream URL for ONE job. The jobId is a REQUEST: the backend
// re-derives ownership from the authenticated session and answers 403/404
// otherwise.
export const candidateStatusStreamUrl = (jobId) =>
  `${API_URL}/realtime/candidates/${jobId}/events`;

// Minimal SSE frame parser: comments (`:` keep-alives) are ignored, malformed
// JSON payloads are dropped, and unknown event names are simply not delivered
// to the caller — a bad frame can never break the connection.
const parseFrame = (rawFrame) => {
  let eventName = "message";
  const dataLines = [];

  for (const line of rawFrame.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).replace(/^ /, ""));
    }
  }

  if (dataLines.length === 0) return null;

  try {
    return { event: eventName, data: JSON.parse(dataLines.join("\n")) };
  } catch {
    return null;
  }
};

const createFrameReader = (onFrame) => {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const parsed = parseFrame(frame.replace(/\r/g, ""));
      if (parsed) onFrame(parsed);
      boundary = buffer.indexOf("\n\n");
    }
  };
};

/**
 * Open the recruiter candidate-status stream for one job.
 *
 * @param {object} params
 * @param {string} params.jobId
 * @param {(event: object) => void} [params.onEvent]     candidate-status events
 * @param {(state: string) => void} [params.onStateChange]
 * @param {() => void} [params.onReady]                  stream established
 * @returns {{close: () => void}}
 */
export const openCandidateStatusStream = ({ jobId, onEvent, onStateChange, onReady }) => {
  const url = candidateStatusStreamUrl(jobId);
  let closed = false;
  let controller = null;
  let reconnectTimer = null;
  let attempt = 0;
  let authRetries = 0;
  let state = null;

  const setState = (next) => {
    if (state === next) return;
    state = next;
    onStateChange?.(next);
  };

  const scheduleReconnect = (delayMs) => {
    if (closed) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delayMs);
  };

  const connect = async () => {
    if (closed) return;

    const { accessToken } = getAuthSession();
    if (!accessToken) {
      // No session to authenticate with: the stream stays off and the page
      // keeps working through the normal authenticated HTTP API.
      setState(REALTIME_CONNECTION_STATE.OFFLINE);
      return;
    }

    setState(
      attempt === 0
        ? REALTIME_CONNECTION_STATE.CONNECTING
        : REALTIME_CONNECTION_STATE.RECONNECTING
    );

    controller = new AbortController();

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "text/event-stream",
        },
        credentials: "include",
        signal: controller.signal,
        // A streaming response must not be cached or buffered.
        cache: "no-store",
      });

      if (!response.ok || !response.body) {
        controller = null;

        if (response.status === 401 || response.status === 403) {
          authRetries += 1;
          if (authRetries > MAX_AUTH_RETRIES) {
            setState(REALTIME_CONNECTION_STATE.OFFLINE);
            return;
          }
          setState(REALTIME_CONNECTION_STATE.RECONNECTING);
          scheduleReconnect(BACKOFF_MS[BACKOFF_MS.length - 1]);
          return;
        }

        // 503 (realtime transport unavailable) and every other failure: keep
        // retrying on the bounded schedule.
        attempt += 1;
        setState(REALTIME_CONNECTION_STATE.RECONNECTING);
        scheduleReconnect(delayFor(attempt));
        return;
      }

      attempt = 0;
      authRetries = 0;
      setState(REALTIME_CONNECTION_STATE.CONNECTED);
      onReady?.();

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const readFrames = createFrameReader((frame) => {
        if (frame.event === "candidate-status") {
          onEvent?.(frame.data);
        }
      });

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        readFrames(decoder.decode(value, { stream: true }));
      }

      // The server closed the stream (restart, network drop, Redis hiccup).
      controller = null;
      if (!closed) {
        attempt += 1;
        setState(REALTIME_CONNECTION_STATE.RECONNECTING);
        scheduleReconnect(delayFor(attempt));
      }
    } catch (error) {
      controller = null;
      if (closed || error?.name === "AbortError") return;
      attempt += 1;
      setState(REALTIME_CONNECTION_STATE.RECONNECTING);
      scheduleReconnect(delayFor(attempt));
    }
  };

  void connect();

  return {
    close() {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      try {
        controller?.abort();
      } catch {
        /* already aborted */
      }
      controller = null;
    },
  };
};

