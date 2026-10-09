// ---------------------------------------------------------------------------
// Job & invitation expiration — the ONE pure decision layer.
//
// This module owns exactly three concepts and nothing else. It performs NO I/O,
// touches no Prisma client and holds no state, which is what makes every rule
// below identical on every Express instance and across a process restart.
//
// THE THREE TIMELINES (never conflated; each is persisted separately):
//
//   1. JOB / ASSESSMENT EXPIRATION  = Job.analysisEndsAt
//      The recruiter-defined availability window (analysisDays). Written ONCE by
//      startJobAtomically as startedAt + analysisDays. This is the only field
//      that decides whether NEW candidate activity is still allowed.
//
//   2. INVITATION LINK EXPIRATION   = JobAssessmentInvitation.expiresAt
//      An invitation link stops working ONE DAY BEFORE the job expires, so a
//      candidate is never handed a link that has already gone dead:
//          invitationExpiry = jobExpiration - 1 day
//      For the minimum 1-day job this yields a ~22-hour usable window, because
//      jobExpiration - 1 day lands 23 hours after the job's own start and the
//      invitation is normally issued some time after that start. That number is
//      an EMERGENT property of the persisted timestamps, never a hardcoded
//      constant — which is exactly why it is derived here and nowhere else.
//
//   3. ASSESSMENT DURATION         = JobAssessmentAttempt.deadlineAt
//      The candidate's own timer, started only when they press Start. Bounded by
//      the attempt, never by this module.
//
// WHY A PERSISTED TIMESTAMP RATHER THAN A FRONTEND COUNTDOWN: every comparison
// below runs against a value read from PostgreSQL at request time, so a stale
// browser tab, a paused scheduler, a direct API call or a manipulated client
// clock can never widen a window.
// ---------------------------------------------------------------------------

const DAY_IN_MS = 24 * 60 * 60 * 1000;

// How much EARLIER than the job deadline an invitation link must stop working.
// Expressed as a lead removed from the job deadline rather than as a window
// length, so the same rule holds for a 1-day job and a 30-day job alike.
const INVITATION_EXPIRY_LEAD_MS = DAY_IN_MS;

const toTime = (value) => {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.getTime();
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0) {
    const parsed = new Date(value).getTime();
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
};

// The canonical job expiration. A job with no persisted deadline (a DRAFT, or
// legacy data predating the field) is NOT expired: the absence of a deadline
// means "no availability window configured", never "expired". The `status`
// column remains the recruiter's own manual CLOSED transition; this module only
// describes the automatic one.
const resolveJobExpiresAt = (job) => toTime(job?.analysisEndsAt);

const isJobExpired = (job, now = new Date()) => {
  const expiresAt = resolveJobExpiresAt(job);
  if (expiresAt === null) return false;
  return expiresAt <= toTime(now);
};

// invitationExpiry = jobExpiration - 1 day.
//
// Guarded so a persisted deadline can never produce a link that outlives its own
// job, and never a deadline in the past (which would make a freshly issued
// invitation dead on arrival):
//   * no job deadline (unusual/legacy)  -> fall back to now + 1 day
//   * the job expires within the next day -> the invitation expires NOW, i.e.
//     the job is already too close to its deadline to admit any new invitation.
// That is the honest reading of the rule: the link must stop a day before the
// job, and once that moment has passed the link is already closed.
const resolveInvitationExpiresAt = (job, now = new Date()) => {
  const nowMs = toTime(now) ?? Date.now();
  const jobExpiresAt = resolveJobExpiresAt(job);
  if (jobExpiresAt === null) {
    return new Date(nowMs + INVITATION_EXPIRY_LEAD_MS);
  }
  return new Date(Math.max(jobExpiresAt - INVITATION_EXPIRY_LEAD_MS, nowMs));
};

// The invitation window is usable only while BOTH the link deadline AND the
// owning job's own deadline are still in the future. Checking both, rather than
// trusting either alone, is what makes an expired job unrecoverable through a
// still-unexpired link — and it is the rule that closes the start-vs-expiration
// race in Part 16, because both timestamps are read from PostgreSQL inside the
// same authorization check.
const isInvitationExpired = (invitation, job, now = new Date()) => {
  const nowMs = toTime(now) ?? Date.now();
  const invitationExpiresAt = toTime(invitation?.expiresAt);
  if (invitationExpiresAt === null) return true;
  if (invitationExpiresAt <= nowMs) return true;
  return isJobExpired(job, nowMs);
};

module.exports = {
  DAY_IN_MS,
  INVITATION_EXPIRY_LEAD_MS,
  resolveJobExpiresAt,
  isJobExpired,
  resolveInvitationExpiresAt,
  isInvitationExpired,
};
