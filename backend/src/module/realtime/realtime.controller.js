const gateway = require("./realtime.gateway");

// ---------------------------------------------------------------------------
// Phase 4 — recruiter realtime candidate status (HTTP adapter).
//
// This controller is deliberately THIN: connection lifecycle, authorization
// and event filtering live in realtime.gateway.js. It never reads or writes
// business state and never touches Redis directly.
// ---------------------------------------------------------------------------

// GET /api/realtime/candidates/:jobId/events
//
// Server-Sent Events stream of candidate status changes for ONE job the
// authenticated recruiter/Org-Admin owns. The gateway answers 401/403/404/503
// (JSON) before the stream opens when the connection cannot be authorized or
// the realtime transport is unavailable.
const streamCandidateEvents = async (req, res) => {
  try {
    await gateway.openJobStream(req, res);
  } catch (error) {
    console.error(`[realtime:controller] stream failed to open: ${error.message}`);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: "The realtime status stream could not be opened",
      });
      return;
    }
    res.end();
  }
};

module.exports = {
  streamCandidateEvents,
};
