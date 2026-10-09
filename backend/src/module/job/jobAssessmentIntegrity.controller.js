// Phase 5 — assessment integrity event controller (thin HTTP adapter).
//
// The browser reports signals (visibility-hidden / visible) but NEVER decides
// that the attempt is cheated. The server records each signal in PostgreSQL and
// the rule layer (jobAssessmentIntegrity.service.js) decides whether the
// deterministic threshold has been reached.

const attemptService = require("./jobAssessmentAttempt.service");
const integrityService = require("./jobAssessmentIntegrity.service");
const jobService = require("./job.service");
const { INTEGRITY_EVENT_TYPES } = require("./jobAssessmentIntegrity.repository");

// The accepted body shape lives in job.validation.js (assessmentIntegrityEventSchema)
// so this boundary uses the SAME zod style as every other assessment route. The
// controller therefore validates nothing itself — it only reads the two fields
// the schema already whitelisted (email + type) and ignores the rest.

const errorResponse = (res, status, message) =>
  res.status(status).json({ success: false, message });

module.exports = {
  /** POST /:publicId/attempt/:attemptId/integrity-event
   *
   * Browser → server signal. Each transition (hidden/visible) is recorded.
   * The 10-hidden threshold is evaluated server-side against the PERSISTED
   * count; if reached, the attempt is atomically moved to CHEATED and the
   * recruiter realtime channel is notified (DB commit → publish).
   */
  reportIntegrityEvent: async (req, res) => {
    const { publicId, attemptId } = req.params;
    const { email, type, detail } = (req.body && typeof req.body === "object") ? req.body : {};

    // Authorization: the attempt must belong to the (publicId → assessment →
    // EMAIL_VERIFIED invitation) context the candidate already holds. This is
    // the SAME Phase 3 guard every other attempt route uses — the integrity
    // endpoint adds no second authorization system, and the email is an
    // identity KEY resolved server-side, never proof on its own.
    let context;
    try {
      context = await jobService.requireActiveInvitationContext(publicId, email);
    } catch (error) {
      return errorResponse(res, error.status || 403, error.message || "Access denied");
    }

    // Candidate reachability (status FINALIZED + activatedAt set) is enforced by
    // the context lookup itself: job.repository.findFinalizedAssessmentByPublicId
    // filters on BOTH inside its WHERE clause and deliberately does not project
    // them (only the candidate-visible fields leave the server). Re-reading those
    // two fields here would always be false and would reject every legitimate
    // browser signal with a 404.
    const assessment = context.assessment;
    if (!assessment) {
      return errorResponse(res, 404, "Assessment not found");
    }

    // Resolve the attempt by (assessment, email). The attempt identity is the
    // (assessment + EMAIL_VERIFIED invitation) pairing Phase 3 enforces — never
    // a client-supplied attempt id used as proof.
    const attempt = await attemptService.findAttemptByAssessmentAndEmail(
      assessment.id,
      context.email
    );
    if (!attempt) {
      return errorResponse(res, 404, "No active attempt found for this assessment");
    }

    // The attemptId path param must match the ONE persisted attempt for this
    // (assessment, email). A mismatch is a cross-attempt/cross-candidate probe
    // and is rejected without revealing whether a different attempt exists.
    if (attempt.id !== attemptId) {
      return errorResponse(res, 403, "This request cannot access that attempt");
    }

    // Terminal attempts ignore further signals (recorded? no — terminal means
    // no more interaction). Reaching CHEATED is terminal.
    if (integrityService.isActiveAttemptStatus(attempt.status) === false) {
      return errorResponse(
        res,
        409,
        attempt.status === "CHEATED"
          ? "This attempt was already terminated for an integrity violation"
          : `This attempt is already ${attempt.status}`
      );
    }

    // Only the two browser-reported signal types are accepted here. Anything
    // else (including status=CHEATED or arbitrary reason) is rejected outright.
    if (
      type !== INTEGRITY_EVENT_TYPES.VISIBILITY_HIDDEN &&
      type !== INTEGRITY_EVENT_TYPES.VISIBILITY_VISIBLE
    ) {
      return errorResponse(res, 400, "Only visibility signals are accepted from the browser");
    }

    try {
      const result = await integrityService.processVisibilitySignal({
        attempt,
        publicId,
        job: context.job,
        assessmentId: assessment.id,
        type,
        metadata: (detail && typeof detail === "object") ? detail : {},
      });

      // If the attempt was moved to CHEATED, the recruiter SSE sees it and the
      // candidate UI must stop normal interaction. We return the new terminal
      // status so the browser can render the terminal state without waiting for
      // the SSE path (the SSE path is the same source of truth, but the
      // immediate response is authoritative too).
      const isCheated =
        result.applied && result.applied.transitioned && result.applied.newStatus === "CHEATED";

      return res.status(200).json({
        success: true,
        event: result.event,
        assessmentStatus: isCheated ? "CHEATED" : attempt.status,
        isCheated,
        reason: isCheated ? result.applied.reason : null,
      });
    } catch (error) {
      console.error("[integrity:event] failed to process visibility signal:", error);
      return errorResponse(
        res,
        error.status || 500,
        error.status === 400 ? error.message : "Failed to record integrity event"
      );
    }
  },

  /** Thin accessor used by the integrity service + verifier to look up an
   * attempt by (assessment, email) without going through the full public flow.
   * Kept here to preserve the existing thin-controller pattern. */
  findAttemptByAssessmentAndEmail: async (assessmentId, email) =>
    attemptService.findAttemptByAssessmentAndEmail(assessmentId, email),
};
