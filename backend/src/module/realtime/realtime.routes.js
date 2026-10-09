// ---------------------------------------------------------------------------
// Phase 4 — realtime recruiter candidate status (SSE).
//
// Mounted on /api/realtime. Authenticated accounts only; each connection is
// scoped to ONE jobId and authorized inside the gateway through the same
// ownership check every other recruiter route uses (the URL's jobId is a
// request, never proof of access).
//
// Server-Sent Events was chosen over WebSockets deliberately: the recruiter
// stream is one-directional (server → browser), SSE needs no extra dependency,
// no handshake/upgrade handling and no separate port, and it survives proxies
// as plain HTTP. The frontend consumes it with fetch + a stream reader so the
// existing Bearer-token authentication is reused unchanged (EventSource cannot
// send an Authorization header).
// ---------------------------------------------------------------------------
const express = require("express");
const authenticate = require("../../middleware/authenticate");
const { streamCandidateEvents } = require("./realtime.controller");

const router = express.Router();

// GET /api/realtime/candidates/:jobId/events
// Live candidate status changes for one job the caller owns.
router.get("/candidates/:jobId/events", authenticate, streamCandidateEvents);

module.exports = router;
