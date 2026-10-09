import {
  scoreSkillAssessment,
  prepareVerificationEvidence,
  analyzeVerification,
  getActiveVerificationAttempt,
} from "./authService";

// Verification pipeline extracted from AssessmentProcessing.jsx so it can be
// started as background execution right after a successful (normal or timeout)
// assessment submission. Reuses the existing service methods and backend
// status gates only — no new logic, no polling, no timers.
//
// Backend idempotency keeps this safe to re-run:
// - score is rejected (400) for attempts that are not SUBMITTED (ignored here)
// - prepare upserts evidence snapshots for SCORED attempts
// - analyze returns the completed report without re-running Gemini
const runVerificationPipeline = async ({ skillId, attemptId, assessmentId = null, onStep = null } = {}) => {
  const notify = (message) => {
    if (typeof onStep === "function") onStep(message);
  };

  let targetAssessmentId = assessmentId;
  let targetAttemptId = attemptId;

  try {
    if (!targetAssessmentId || !targetAttemptId || targetAttemptId === "active") {
      const activeRes = await getActiveVerificationAttempt(skillId);
      if (activeRes?.data) {
        targetAssessmentId = targetAssessmentId ?? activeRes.data.assessmentId ?? null;
        if (!targetAttemptId || targetAttemptId === "active") {
          targetAttemptId = activeRes.data.attemptId;
        }
      }
    }
  } catch {
    // ignore — scoring simply skipped if the attempt is already submitted
  }

  notify("Evaluating test performance...");
  if (targetAssessmentId && targetAttemptId && targetAttemptId !== "active") {
    try {
      await scoreSkillAssessment(targetAssessmentId, targetAttemptId);
    } catch {
      // ignore if already scored
    }
  }

  notify("Preparing evidence snapshots...");
  await prepareVerificationEvidence(skillId, targetAttemptId);

  notify("Analyzing skill verification evidence with Gemini AI...");
  const result = await analyzeVerification(skillId, targetAttemptId);

  notify("Verification complete.");
  return result;
};

export default runVerificationPipeline;
