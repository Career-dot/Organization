const {
  subscribeRealtimeEvents,
  getRealtimePubSubStats,
} = require("../../config/redis.pubsub");
const { sanitizeRealtimeEvent } = require("../job/jobAssessmentRealtime.events");
const { resolveSubscriptionAccess } = require("../subscription/subscription.service");
const jobService = require("../job/job.service");
// PHASE 3 — the SAME centralized policy the REST routes use, applied to the event
// payload. An ORG_ADMIN on an ACTIVE job keeps the connection (and the job-level
// signal) but receives no candidate identity.
const { redactEventForPrincipal, evaluateCandidateLevelAccess } = require("../job/jobCandidatePrivacy");

// ---------------------------------------------------------------------------
// Phase 4 — realtime recruiter gateway (Server-Sent Events).
//
// RESPONSIBILITIES (nothing else):
//   * authorize ONE authenticated recruiter/Org-Admin for ONE job,
//   * keep the connection alive,
//   * forward ONLY that job's sanitized events to that connection,
//   * clean up every resource when the connection ends.
//
// AUTHORIZATION IS DERIVED SERVER-SIDE. The client supplies only a jobId in the
// URL; the gateway re-runs the SAME ownership check every other recruiter route
// uses (subscription scope + requireOwnedJob), so:
//   * another recruiter's job → 403,
//   * another organization's job → 403,
//   * an unknown job → 404,
//   * an unauthenticated request → 401 (auth middleware, before this code).
// The jobId in the URL is therefore a REQUEST, never proof.
//
// SCALABILITY: one shared Redis subscription per Express process feeds every
// connected client (no Redis connection per browser, no channel per candidate),
// and it is released when the last client disconnects. Any number of Express
// instances may serve recruiters — Redis Pub/Sub distributes events between
// them, so an event produced by instance B reaches a client on instance A.
//
// The database stays authoritative: the transport never caches status and the
// frontend reconciles through the normal candidate-list API.
// ---------------------------------------------------------------------------

const HEARTBEAT_INTERVAL_MS = 25000;

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-store, must-revalidate",
  Connection: "keep-alive",
  // Proxies must not buffer an event stream.
  "X-Accel-Buffering": "no",
};

// clientId → { res, jobId, userId }
const clients = new Map();
let clientSequence = 0;

// The process-wide Redis subscription (ref-counted by the pub/sub module) plus
// the heartbeat keeping idle connections alive. Both exist only while at least
// one client is connected.
let subscription = null;
let heartbeat = null;

const httpError = (status, message) => Object.assign(new Error(message), { status });

/**
 * Authorize an authenticated user to observe candidate status for ONE job.
 * Reuses the platform's single ownership implementation.
 */
const authorizeJobStream = async (user, jobId) => {
  if (!user || !user.id) {
    throw httpError(401, "Authentication required");
  }

  const access = await resolveSubscriptionAccess(user);
  if (!access || access.scope === "none" || access.scope === "bypass") {
    // Mirrors every other scoped route: an account without a usable
    // subscription/organization context cannot observe candidates.
    throw httpError(403, "Your account cannot access job candidates right now");
  }

  // Throws 403 for another recruiter's/organization's job and 404 for an
  // unknown job — the exact behavior of GET /api/job/:jobId/candidates.
  const job = await jobService.requireOwnedJob(user, access, jobId);

  // PHASE 3 — an ORG_ADMIN gets NO candidate-level realtime detail for an ACTIVE
  // job. Rather than refusing the connection (which would leave the admin unable
  // to see that anything is happening), the stream opens and every event is
  // redacted per client. Same policy as the REST routes, decided from the job row
  // authorization already loaded — no extra query per event.
  const candidateLevelAllowed = evaluateCandidateLevelAccess(user, job).allowed;
  if (!candidateLevelAllowed) {
    console.warn(
      `[realtime:gateway] ORG_ADMIN joined job ${job.id} in redacted mode (ACTIVE job): candidate-level events are withheld`
    );
  }

  // The principal and the job row are cached on the client so dispatch can redact
  // per recipient without re-querying on every event.
  return { jobId: job.id, job, user, scope: access.scope, candidateLevelAllowed };
};

const writeFrame = (client, frame) => {
  try {
    client.res.write(frame);
    return true;
  } catch {
    // The socket is gone; the close handler unregisters the client.
    return false;
  }
};

const sendEvent = (client, event) =>
  writeFrame(client, `event: candidate-status\ndata: ${JSON.stringify(event)}\n\n`);

/**
 * Fan an event out to every connected client authorized for its job. Events for
 * other jobs are dropped here — never forwarded to a browser.
 *
 * PHASE 3 — per-client redaction. The SAME job can have a recruiter client (full
 * candidate detail) and an ORG_ADMIN client (no candidate detail on an ACTIVE
 * job), so redaction MUST happen per recipient, not per event. The shared event
 * object is frozen by the sanitizer and is never mutated: `redactEventForPrincipal`
 * returns a copy when redaction applies.
 */
const dispatchEvent = (rawEvent) => {
  // One gate for every event family (candidate status and job lifecycle). A
  // malformed/unknown payload is rejected safely and logged without contents.
  const event = sanitizeRealtimeEvent(rawEvent);
  if (!event) {
    console.error("[realtime:gateway] dropped an unusable realtime event");
    return 0;
  }

  let delivered = 0;
  for (const client of clients.values()) {
    if (client.jobId !== event.jobId) {
      continue;
    }
    // Redact per recipient: the SAME job can have a recruiter client (full
    // candidate detail) and an ORG_ADMIN client (no candidate detail on an ACTIVE
    // job), so redaction MUST happen per recipient, not per event. The job row was
    // loaded once at connect time and cached on the client, so this costs NO query
    // per event (an N+1 here would hit PostgreSQL on every realtime frame).
    //
    // CONSEQUENCE (deliberate, fail-closed): the cached status is a snapshot from
    // connect time. If the job is closed while the stream stays open, the admin's
    // stream KEEPS redacting until they reconnect. That is the safe direction —
    // it can only ever withhold more, never leak — and it avoids re-reading job
    // status on every event. Reconnecting (or reloading the page) picks up the new
    // status. Do NOT "fix" this by querying per event.
    const payload = redactEventForPrincipal(client.user, client.job, event);
    if (sendEvent(client, payload)) {
      delivered += 1;
    }
  }
  return delivered;
};

const startHeartbeat = () => {
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    for (const client of clients.values()) {
      // A comment frame is a valid SSE keep-alive and is ignored by clients.
      writeFrame(client, `: keep-alive\n\n`);
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();
};

const stopHeartbeat = () => {
  if (!heartbeat) return;
  clearInterval(heartbeat);
  heartbeat = null;
};

// The FIRST client opens the shared subscription; the LAST one releases it.
const ensureSubscription = async () => {
  if (subscription) return;
  subscription = await subscribeRealtimeEvents(dispatchEvent);
};

const releaseSubscription = async () => {
  const current = subscription;
  subscription = null;
  if (!current) return;
  try {
    await current.unsubscribe();
  } catch {
    /* best effort */
  }
};

const unregisterClient = async (clientId) => {
  if (!clients.has(clientId)) return;
  clients.delete(clientId);

  if (clients.size === 0) {
    stopHeartbeat();
    await releaseSubscription();
  }
};

/**
 * Open an SSE stream for one authorized job.
 *
 * Responds 401/403/404/503 as JSON BEFORE the stream starts when the connection
 * cannot be authorized or the realtime transport is unavailable — the recruiter
 * UI keeps working through the normal HTTP API in either case.
 */
const openJobStream = async (req, res) => {
  let authorization;
  try {
    authorization = await authorizeJobStream(req.user, req.params.jobId);
  } catch (error) {
    const status = error.status || 403;
    res.status(status).json({
      success: false,
      message: status === 401 ? error.message : "You cannot observe this job's candidates",
    });
    return;
  }

  try {
    await ensureSubscription();
  } catch (error) {
    // Redis unavailable: no fake events, no broken stream — the frontend
    // reconnects with backoff and reconciles through the API meanwhile.
    console.error(`[realtime:gateway] realtime stream unavailable: ${error.message}`);
    res.status(503).json({
      success: false,
      message: "The realtime status stream is temporarily unavailable",
    });
    return;
  }

  clientSequence += 1;
  const clientId = `${authorization.jobId}:${clientSequence}`;
  // PHASE 3 — the principal and the job row ride along so dispatchEvent can redact
  // per recipient (a recruiter and an ORG_ADMIN may share this job's stream).
  const client = {
    res,
    jobId: authorization.jobId,
    userId: req.user.id,
    user: req.user,
    job: authorization.job,
    candidateLevelAllowed: authorization.candidateLevelAllowed,
  };

  clients.set(clientId, client);
  res.writeHead(200, SSE_HEADERS);
  startHeartbeat();

  // Handshake frame: tells the client the stream is live so it can reconcile
  // against the authoritative API (and display "Connected").
  writeFrame(
    client,
    `event: ready\ndata: ${JSON.stringify({
      jobId: authorization.jobId,
      connectedAt: new Date().toISOString(),
    })}\n\n`
  );

  // Client disconnect: release this connection's resources. The shared Redis
  // subscription is dropped when the LAST client leaves.
  req.on("close", () => {
    void unregisterClient(clientId);
  });
};

// Introspection for health checks and the verification harness.
const getGatewayStats = () => ({
  connectedClients: clients.size,
  subscribedJobs: [...new Set([...clients.values()].map((client) => client.jobId))].length,
  subscriptionActive: subscription !== null,
  heartbeatActive: heartbeat !== null,
  transport: getRealtimePubSubStats(),
});

// Graceful shutdown (tests and process teardown).
const closeAllStreams = async () => {
  clients.clear();
  stopHeartbeat();
  await releaseSubscription();
};

module.exports = {
  HEARTBEAT_INTERVAL_MS,
  authorizeJobStream,
  openJobStream,
  dispatchEvent,
  getGatewayStats,
  closeAllStreams,
};
