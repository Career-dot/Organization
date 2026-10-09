const { createRedisConnection } = require("./redis");

// ---------------------------------------------------------------------------
// Phase 4 — Redis Pub/Sub infrastructure for recruiter realtime candidate
// status.
//
// ARCHITECTURAL CONTRACT
//   * PostgreSQL is the ONLY authority for candidate/attempt status. Redis
//     Pub/Sub is a best-effort DISTRIBUTION mechanism: it stores nothing and
//     owns nothing. A recruiter who misses an event recovers by re-reading the
//     authoritative API (see the SSE gateway + the frontend consumer).
//   * Delivery is AT-LEAST-ONCE / best effort — never exactly-once. Duplicate
//     and out-of-order events are tolerated by design.
//   * Publishing NEVER throws and NEVER delays a request: business code calls
//     this AFTER its transaction has committed, fire-and-forget.
//
// CONNECTIONS (profiles live in config/redis.js)
//   * BullMQ keeps its own producer/worker connections — untouched here.
//   * ONE lazily-created publisher socket for PUBLISH.
//   * ONE shared, reference-counted subscriber socket per process that fans
//     out to every listener (the SSE gateway is one such listener). N connected
//     recruiters therefore never create N Redis connections, and the socket is
//     released once the last listener goes away.
//
// CONFIGURATION (environment only — no hardcoded hosts)
//   REDIS_URL                  — reused through config/redis.js (single reader)
//   REALTIME_REDIS_CHANNEL     — the domain-event channel (one per deployment,
//                                never one per candidate)
//   REALTIME_PUBLISH_TIMEOUT_MS / REALTIME_SUBSCRIBE_TIMEOUT_MS — bounds so a
//                                degraded Redis can never hang a request or an
//                                SSE handshake
// No credential is ever logged: neither the URL nor payload contents reach a
// log line.
// ---------------------------------------------------------------------------

const DEFAULT_REALTIME_CHANNEL = "platform:realtime:candidate-status";

const readPositiveInt = (raw, fallback) => {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

// The channel is resolved at CALL time so a process (or a verification
// harness) can point at an isolated channel without a restart.
const getRealtimeChannel = () => process.env.REALTIME_REDIS_CHANNEL || DEFAULT_REALTIME_CHANNEL;

const getPublishTimeoutMs = () => readPositiveInt(process.env.REALTIME_PUBLISH_TIMEOUT_MS, 2000);
const getSubscribeTimeoutMs = () => readPositiveInt(process.env.REALTIME_SUBSCRIBE_TIMEOUT_MS, 5000);

let publisher = null;
let subscriber = null;

// Handlers registered through subscribeRealtimeEvents(). The subscriber socket
// is created once and dispatches every received message to this set.
const listeners = new Set();

const getPublisher = () => {
  if (!publisher) {
    publisher = createRedisConnection({ role: "publisher" });
  }
  return publisher;
};

// The process-wide message boundary: a malformed payload is dropped (never
// forwarded, never fatal) and a throwing listener can neither kill the socket
// nor starve the other listeners.
const onSubscriberMessage = (channel, raw) => {
  if (channel !== getRealtimeChannel()) {
    return;
  }

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    console.error("[realtime:subscriber] dropped a malformed event payload");
    return;
  }

  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch (error) {
      console.error(`[realtime:subscriber] listener failed: ${error.message}`);
    }
  }
};

const getSubscriber = () => {
  if (!subscriber) {
    subscriber = createRedisConnection({ role: "subscriber" });
    subscriber.on("message", onSubscriberMessage);
  }
  return subscriber;
};

// Bounds a promise WITHOUT cancelling the underlying Redis command: a publish
// still buffered in the offline queue when the bound elapses is reported as
// undelivered, and the rejection handler attached here keeps a later failure
// from becoming an unhandled rejection.
const withinTimeout = (promise, timeoutMs, onTimeout) =>
  new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(onTimeout());
    }, timeoutMs);
    timer.unref?.();

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ failed: true, error: error?.message ?? null });
      }
    );
  });

/**
 * Publish ONE domain event on the realtime channel.
 *
 * MUST be called only after the PostgreSQL transaction that produced the event
 * has committed. It never throws and never rejects: on a Redis outage it
 * resolves { published: false } so the caller keeps its committed business
 * state — Redis availability must never influence PostgreSQL writes.
 *
 * @returns {Promise<{published: boolean, reason?: string, receivers?: number}>}
 */
const publishRealtimeEvent = async (event) => {
  let payload;
  try {
    payload = JSON.stringify({
      ...event,
      occurredAt: event?.occurredAt ?? new Date().toISOString(),
    });
  } catch (error) {
    console.error(`[realtime:publisher] event could not be serialized: ${error.message}`);
    return { published: false, reason: "INVALID_PAYLOAD" };
  }

  const channel = getRealtimeChannel();
  const publishCall = getPublisher().publish(channel, payload);

  const result = await withinTimeout(publishCall, getPublishTimeoutMs(), () => ({ failed: true }));

  if (result?.failed || result?.reason) {
    // Reported, never thrown: the committed database row stays authoritative
    // and the recruiter recovers through reconnect + authoritative refetch.
    const reason = result?.reason ?? "PUBLISH_FAILED";
    console.error(
      `[realtime:publisher] event ${event?.eventType ?? "UNKNOWN"} was not delivered (${reason})`
    );
    return { published: false, reason };
  }

  return { published: true, receivers: Number(result ?? 0) };
};

/**
 * Subscribe an in-process listener to the realtime channel. The FIRST listener
 * opens the shared subscriber socket; the LAST one releases it, so a process
 * with zero realtime clients holds zero Pub/Sub connections.
 *
 * @param {(event: object) => void} handler
 * @returns {Promise<{unsubscribe: () => Promise<void>}>}
 */
const subscribeRealtimeEvents = async (handler) => {
  if (typeof handler !== "function") {
    throw new Error("A realtime event handler is required");
  }

  const channel = getRealtimeChannel();
  const client = getSubscriber();

  if (listeners.size === 0) {
    const result = await withinTimeout(
      client.subscribe(channel).then(() => ({ subscribed: true })),
      getSubscribeTimeoutMs(),
      () => ({ subscribed: false })
    );

    if (!result.subscribed) {
      // Redis unavailable (or too slow): an unusable subscription must NOT be
      // left registered. The gateway answers 503 and the browser reconnects,
      // while every normal HTTP route keeps working.
      if (subscriber === client) {
        subscriber = null;
      }
      try {
        client.disconnect();
      } catch {
        /* already gone */
      }
      throw new Error("The realtime event stream is unavailable right now");
    }
  }

  listeners.add(handler);

  let released = false;
  const unsubscribe = async () => {
    if (released) return;
    released = true;
    listeners.delete(handler);

    if (listeners.size > 0) {
      return;
    }

    // Last listener gone: drop the subscription AND the socket, so a
    // long-running API process does not hold an idle Redis connection.
    const current = subscriber;
    subscriber = null;
    if (!current) return;
    try {
      await current.unsubscribe(channel);
    } catch {
      /* the socket may already be gone */
    }
    try {
      current.disconnect();
    } catch {
      /* already disconnected */
    }
  };

  return { unsubscribe };
};

// Introspection for the gateway, health checks and the verification harness.
// Contains no credentials and no message contents.
const getRealtimePubSubStats = () => ({
  channel: getRealtimeChannel(),
  publisherCreated: publisher !== null,
  publisherConnected: Boolean(publisher && publisher.status === "ready"),
  subscriberCreated: subscriber !== null,
  subscriberConnected: Boolean(subscriber && subscriber.status === "ready"),
  listenerCount: listeners.size,
});

// Graceful shutdown / harness cleanup.
const closeRealtimePubSub = async () => {
  listeners.clear();

  const currentSubscriber = subscriber;
  subscriber = null;
  if (currentSubscriber) {
    try {
      await currentSubscriber.unsubscribe(getRealtimeChannel());
    } catch {
      /* best effort */
    }
    try {
      currentSubscriber.disconnect();
    } catch {
      /* best effort */
    }
  }

  const currentPublisher = publisher;
  publisher = null;
  if (currentPublisher) {
    try {
      currentPublisher.disconnect();
    } catch {
      /* best effort */
    }
  }
};

module.exports = {
  DEFAULT_REALTIME_CHANNEL,
  getRealtimeChannel,
  getRealtimePubSubStats,
  publishRealtimeEvent,
  subscribeRealtimeEvents,
  closeRealtimePubSub,
};
