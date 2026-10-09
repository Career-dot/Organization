// ---------------------------------------------------------------------------
// PHASE 3 — the ONE centralized ORG_ADMIN candidate-level privacy policy.
//
// WHY THIS EXISTS (a real, previously-open gap)
// Every candidate-level job route below authorized `authorize("RECRUITER",
// "ORG_ADMIN")` and then read candidates for ANY job status. An ORG_ADMIN could
// therefore call, for an ACTIVE job:
//   GET /job/:jobId/candidates                              -> names, emails
//   GET /job/overview/:jobId/candidates                     -> names, emails,
//                                                              resume flags,
//                                                              assessment scores,
//                                                              cheat reasons
//   GET /job/:jobId/candidate-references                    -> resume text,
//                                                              LinkedIn/GitHub text
//   GET /job/:jobId/candidate-references/:referenceId       -> the above, one row
//   GET /job/:jobId/candidate-references/:referenceId/resume-> the resume file
//   GET /job/:jobId/candidate-references/:referenceId/analysis -> analysis JSON
//   GET /job/:jobId/candidates/:referenceId/verification-report
//   GET /job/:jobId/assessment/attempts                     -> per-candidate scores
// and an SSE stream forwarded candidateEmail + per-candidate status for the same
// job. Frontend-only hiding was never in place and would not be sufficient.
//
// THE RULE
//   ACTIVE job          -> ORG_ADMIN candidate-level access DENIED
//   CLOSED job          -> ALLOWED (unchanged historical reporting)
//   any other persisted -> ALLOWED (DRAFT is not live candidate activity, and a
//                          stricter rule would break the existing job-detail view)
//
// WHAT IS *NOT* AFFECTED
//   * Recruiter access is untouched. Only the ORG_ADMIN branch is gated.
//   * Job-LEVEL aggregates (title, description, skills, tools, status, dates,
//     candidate COUNT, analyzed COUNT, assessment activity counts) are never
//     blocked — Job Analysis must keep working for ACTIVE jobs.
//   * The SSE transport, its auth and its event shape are unchanged; only the
//     payload handed to an ORG_ADMIN on an ACTIVE job is redacted.
//
// FAIL FAST: called with the ALREADY-AUTHORIZED job row, BEFORE any candidate
// row, attempt, analysis or report is read, so a denied request never loads the
// sensitive data it would refuse to return.
// ---------------------------------------------------------------------------

// The persisted Job.status values (JobStatus enum: DRAFT | ACTIVE | CLOSED).
// CLOSED is also what the existing lifecycle writes when a job expires
// (closedReason SYSTEM_EXPIRED), so one value covers both "closed" and "expired".
const JOB_STATUS_ACTIVE = "ACTIVE";

const CANDIDATE_LEVEL_DENIED_MESSAGE =
  "Candidate-level data for an active job is only available to the recruiter who runs it. " +
  "This becomes available here once the job is closed.";

/**
 * Is this principal an ORG_ADMIN? Role resolution stays where it already lives
 * (middleware/authenticate + authorize); this only inspects the ALREADY-RESOLVED
 * principal so the policy can branch on it. It never re-resolves roles.
 */
const isOrgAdminPrincipal = (user) =>
  Boolean(user) &&
  (user.role === "ORG_ADMIN" ||
    (Array.isArray(user.roles) && user.roles.includes("ORG_ADMIN")));

/**
 * THE policy. Call with the job that has already passed the EXISTING ownership /
 * organization check (requireAuthorizedJob or requireOwnedJob).
 *
 * @returns {{ allowed: boolean, isOrgAdmin: boolean, isActiveJob: boolean }}
 */
const evaluateCandidateLevelAccess = (user, job) => {
  const isOrgAdmin = isOrgAdminPrincipal(user);
  const isActiveJob = job?.status === JOB_STATUS_ACTIVE;
  if (!isOrgAdmin) {
    // RECRUITER (and any other scoped principal) keeps exactly what it had.
    return { allowed: true, isOrgAdmin: false, isActiveJob };
  }
  return { allowed: !isActiveJob, isOrgAdmin: true, isActiveJob };
};

/**
 * Gate a candidate-level read for ORG_ADMIN. Throws 403 when denied; returns
 * silently otherwise, so call sites read as a single line.
 */
const assertCandidateLevelAccess = (user, job) => {
  const decision = evaluateCandidateLevelAccess(user, job);
  if (!decision.allowed) {
    const error = new Error(CANDIDATE_LEVEL_DENIED_MESSAGE);
    error.status = 403;
    // Machine-readable marker so the frontend can explain WHY a panel is absent,
    // instead of showing an empty state that looks like "no candidates".
    error.code = "ORG_ADMIN_ACTIVE_JOB_CANDIDATE_DATA_RESTRICTED";
    throw error;
  }
  return decision;
};
/**
 * The realtime counterpart. An ORG_ADMIN watching an ACTIVE job receives only
 * job-level information; candidate-identifying fields are removed from the event
 * rather than the whole event being dropped, so the connection stays meaningful
 * (it still learns the job exists and is active) while carrying no candidate data.
 *
 * Never mutates the shared event object: the sanitizer freezes it and the SAME
 * object is fanned out to every connected client of that job.
 */
const CANDIDATE_SCOPED_EVENT_FIELDS = ["candidateEmail", "candidateId"];

const redactEventForPrincipal = (user, job, event) => {
  if (!event) return event;
  if (evaluateCandidateLevelAccess(user, job).allowed) return event;

  const redacted = { ...event };
  for (const field of CANDIDATE_SCOPED_EVENT_FIELDS) {
    delete redacted[field];
  }
  // An explicit, unambiguous marker so a consumer can never mistake a redacted
  // event for a real candidate transition.
  redacted.candidateDataRestricted = true;
  return redacted;
};

module.exports = {
  JOB_STATUS_ACTIVE,
  CANDIDATE_LEVEL_DENIED_MESSAGE,
  isOrgAdminPrincipal,
  evaluateCandidateLevelAccess,
  assertCandidateLevelAccess,
  redactEventForPrincipal,
};