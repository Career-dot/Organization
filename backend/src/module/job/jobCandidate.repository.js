const prisma = require("../../config/prisma");

// ---------------------------------------------------------------------------
// Recruiter candidate-workflow reads (the Job's persisted candidate list).
//
// The candidate list IS the Excel file persisted through the existing upload
// path (JobCandidateList + StoredFile) — there is no second candidate table,
// so this module only provides the two lookups the classification needs:
//   1. which of the recruiter's candidate emails already belong to a candidate
//      (EMPLOYEE) account on the platform, and
//   2. the existing invitations of the job's assessment (read-only status).
// Nothing here writes: classification never mutates candidate data, never
// touches the verification tables and never queues AI work.
// ---------------------------------------------------------------------------

// Candidate accounts for a set of normalized emails. Matching is
// case-insensitive (every email in this flow is stored/queried normalized, but
// platform accounts may carry legacy casing) and soft-deleted accounts never
// count as "in system". Only the EMPLOYEE role marks a platform CANDIDATE
// account: a recruiter/admin account that happens to share the email address is
// not a candidate and yields NOT_IN_SYSTEM.
const findCandidateAccountsByEmails = async (emails) => {
  if (!Array.isArray(emails) || emails.length === 0) {
    return [];
  }

  return prisma.user.findMany({
    where: {
      isDeleted: false,
      email: { in: emails, mode: "insensitive" },
      roles: { some: { role: { name: "EMPLOYEE" } } },
    },
    select: { id: true, email: true, status: true },
  });
};

// Existing invitations of ONE assessment, keyed by their stored (normalized)
// email. Read-only: the invitation lifecycle itself is owned by the existing
// invitation service.
const findInvitationsByAssessmentId = async (assessmentId) => {
  if (!assessmentId) {
    return [];
  }

  return prisma.jobAssessmentInvitation.findMany({
    where: { assessmentId },
    // jobId is included so callers can assert the invitation belongs to the
    // exact job they are reporting on (defense in depth).
    select: { email: true, status: true, invitedAt: true, expiresAt: true, jobId: true },
  });
};

// Recruiter-facing summary of the job's assessment for the candidate workflow:
// lifecycle state only (no questions, no AiJob internals). Lets the candidate
// list label invitation status without loading the whole assessment.
const findAssessmentSummaryByJobId = async (jobId) => {
  if (!jobId) {
    return null;
  }

  return prisma.jobAssessment.findUnique({
    where: { jobId },
    select: {
      id: true,
      jobId: true,
      status: true,
      title: true,
      durationSeconds: true,
      finalizedAt: true,
      activatedAt: true,
    },
  });
};

module.exports = {
  findCandidateAccountsByEmails,
  findInvitationsByAssessmentId,
  findAssessmentSummaryByJobId,
};
