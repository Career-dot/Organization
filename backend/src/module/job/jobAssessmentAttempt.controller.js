const attemptService = require("./jobAssessmentAttempt.service");

// ---------------------------------------------------------------------------
// Phase 3 — candidate assessment attempt controller.
//
// Thin HTTP adapters only: every lifecycle rule lives in
// jobAssessmentAttempt.service.js and every database operation in
// jobAssessmentAttempt.repository.js. The candidate identity is the PERSISTED
// EMAIL_VERIFIED invitation for (publicId → assessment, normalized email); the
// body never carries an attempt id, status, start time, deadline or duration,
// and the server never trusts any of them.
// ---------------------------------------------------------------------------

const sendErrorResponse = (res, context, error) => {
  const status = error.status || 500;
  let message = error.message || "Something went wrong while processing your request";

  if (status >= 500) {
    console.error(`[assessment-attempt] ${context}:`, error);
    message = "Something went wrong while processing your request";
  } else {
    console.error(`[assessment-attempt] ${context}: ${status} ${message}`);
  }

  return res.status(status).json({ success: false, message });
};

// START — begin (or resume) the ONE persistent attempt for this verified
// candidate email. Idempotent: the persisted attempt is returned on repeat.
const startAssessmentAttempt = async (req, res) => {
  try {
    const result = await attemptService.startAssessmentAttempt(
      req.params.publicId,
      req.body.email
    );

    return res.status(200).json({
      success: true,
      message: result.attempt.status === "STARTED" ? "Assessment attempt started" : "Assessment attempt in progress",
      data: result,
    });
  } catch (error) {
    return sendErrorResponse(res, "startAssessmentAttempt", error);
  }
};

// RESUME — read the current persisted attempt state (browser refresh,
// reconnect). Never starts a new attempt and never resets the timer.
const getAssessmentAttempt = async (req, res) => {
  try {
    const result = await attemptService.getAssessmentAttempt(
      req.params.publicId,
      req.body.email
    );

    return res.status(200).json({
      success: true,
      message: "Assessment attempt retrieved successfully",
      data: result,
    });
  } catch (error) {
    return sendErrorResponse(res, "getAssessmentAttempt", error);
  }
};

// ANSWER — persist or update one answer. Rejected once the attempt is terminal
// or the server-side deadline has passed (which also persists TIMED_UP).
const saveAttemptAnswer = async (req, res) => {
  try {
    const result = await attemptService.saveAttemptAnswer(
      req.params.publicId,
      req.body.email,
      req.body.questionId,
      req.body.answer
    );

    return res.status(200).json({
      success: true,
      message: "Answer saved successfully",
      data: result,
    });
  } catch (error) {
    return sendErrorResponse(res, "saveAttemptAnswer", error);
  }
};

// SUBMIT — idempotent terminal transition. A deadline that has already passed
// closes the attempt as TIMED_UP instead of SUBMITTED.
const submitAssessmentAttempt = async (req, res) => {
  try {
    const result = await attemptService.submitAssessmentAttempt(
      req.params.publicId,
      req.body.email
    );

    const timedOut = result.attempt.status === "TIMED_UP";

    return res.status(200).json({
      success: true,
      message: timedOut
        ? "The assessment deadline has passed — this attempt is closed"
        : "Assessment submitted successfully",
      data: result,
    });
  } catch (error) {
    return sendErrorResponse(res, "submitAssessmentAttempt", error);
  }
};

// RECRUITER STATUS — the persisted attempt lifecycle per candidate email for a
// job the caller owns. STATUS ONLY: answers are never exposed here.
const listJobCandidateAttempts = async (req, res) => {
  try {
    const result = await attemptService.listJobCandidateAttempts(
      req.user,
      req.params.jobId
    );

    return res.status(200).json({
      success: true,
      message: "Candidate assessment attempts retrieved successfully",
      data: result,
    });
  } catch (error) {
    return sendErrorResponse(res, "listJobCandidateAttempts", error);
  }
};

module.exports = {
  startAssessmentAttempt,
  getAssessmentAttempt,
  saveAttemptAnswer,
  submitAssessmentAttempt,
  listJobCandidateAttempts,
};
