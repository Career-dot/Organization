const express = require("express");
const jobController = require("./job.controller");
const jobAssessmentAttemptController = require("./jobAssessmentAttempt.controller");
const jobAssessmentIntegrityController = require("./jobAssessmentIntegrity.controller");
const validate = require("../../middleware/validate");
const {
  assessmentEmailVerificationSchema,
  assessmentVerificationConfirmSchema,
  assessmentAttemptActionSchema,
  assessmentAttemptAnswerSchema,
  assessmentIntegrityEventSchema,
} = require("./job.validation");

// Candidate-facing assessment routes for the JOB assessment workflow.
//
// DELIBERATELY UNAUTHENTICATED, and deliberately a separate router from
// job.routes.js (whose `router.use(authenticate)` applies to every recruiter
// route). The finalized assessment link issued by
// POST /api/job/:jobId/assessment/finalize is an opaque, unguessable segment
// (JobAssessment.publicId — base64url of 16 random bytes).
//
// BUT the link alone does NOT authorize a candidate. This router's contract:
//   * GET /:publicId            — content ONLY for a FINALIZED **and
//                                 ACTIVATED** assessment (preview-free,
//                                 stateless; never starts a timer or attempt)
//   * POST /:publicId/verify-email        — the invited email must match an
//                                 invitation bound to THIS job + assessment;
//                                 issues an emailed verification code
//   * POST /:publicId/confirm-verification — the emailed code flips the
//                                 invitation to EMAIL_VERIFIED server-side
// Every failure path answers with the same generic 403, so nothing about
// other candidates' invitations (or even which emails are invited) can be
// probed. This router is read + verify only: no assessment can be created,
// edited, deleted, finalized or activated here, no attempt/timer/score exists
// at this stage, and responses never include tokens, recruiter data or
// internal ids.
const router = express.Router();

router.get("/:publicId", jobController.getAssessmentForCandidate);
router.post(
  "/:publicId/verify-email",
  validate(assessmentEmailVerificationSchema),
  jobController.requestAssessmentEmailVerification
);
router.post(
  "/:publicId/confirm-verification",
  validate(assessmentVerificationConfirmSchema),
  jobController.confirmAssessmentEmailVerification
);

// --- Candidate assessment attempt (Phase 3, wired in Phase 4) ----------------
// The attempt lifecycle of ONE verified candidate. The candidate identity is
// ALWAYS the invited email in the body, re-resolved against the PERSISTED
// EMAIL_VERIFIED invitation; no attempt id, status, start time, deadline or
// duration is ever accepted from a client, and answers are validated per the
// persisted question type inside the service. The response never carries
// verification tokens, hashes or another candidate's data.
//
// These four routes exist so the lifecycle the recruiter observes in real time
// (STARTED → IN_PROGRESS → SUBMITTED/TIMED_UP) is reachable over real HTTP by
// the candidate's own session.
router.post(
  "/:publicId/attempt",
  validate(assessmentAttemptActionSchema),
  jobAssessmentAttemptController.getAssessmentAttempt
);
router.post(
  "/:publicId/attempt/start",
  validate(assessmentAttemptActionSchema),
  jobAssessmentAttemptController.startAssessmentAttempt
);
router.post(
  "/:publicId/attempt/answer",
  validate(assessmentAttemptAnswerSchema),
  jobAssessmentAttemptController.saveAttemptAnswer
);
router.post(
  "/:publicId/attempt/submit",
  validate(assessmentAttemptActionSchema),
  jobAssessmentAttemptController.submitAssessmentAttempt
);

// --- Phase 5: assessment integrity / cheating detection ----------------------
// Browser → server integrity signals (visibility-hidden / visible). The browser
// reports transitions but NEVER decides that the attempt is cheated — the server
// records each signal in PostgreSQL and applies a deterministic threshold
// (MAX_VISIBILITY_HIDDEN_EVENTS). The body is validated by the same zod layer
// every other assessment route uses, so a client cannot smuggle in a status,
// a cheat reason, a score or a timer value.
router.post(
  "/:publicId/attempt/:attemptId/integrity-event",
  validate(assessmentIntegrityEventSchema),
  jobAssessmentIntegrityController.reportIntegrityEvent
);

module.exports = router;
