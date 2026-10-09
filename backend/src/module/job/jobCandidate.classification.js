// ---------------------------------------------------------------------------
// Candidate classification — the recruiter workflow's ONE pure decision layer.
//
// For every candidate row of the recruiter's persisted Excel list it answers a
// single question: does this email already belong to a candidate account on the
// platform?
//
//   IN_SYSTEM      → the platform already knows this candidate; its EXISTING
//                    verified skill score (computed by the candidate's own
//                    earlier verification) is shown as INFORMATION ONLY
//   NOT_IN_SYSTEM  → the platform has no candidate account for this email; the
//                    existing platform skill score is REPORTED AS 0 and nothing
//                    is fabricated or attempted on the candidate's behalf
//
// Everything here is pure and synchronous: the caller (job.service) performs
// the database reads through the candidate-workflow repository and injects the
// results. That keeps the rules deterministic and testable, and makes it
// structurally impossible for this step to write data, call AI or re-derive any
// verification result.
//
// The three value types this stage must never merge:
//   * existingVerifiedSkillScore → EXISTING platform verification (display only)
//   * assessment score           → does not exist yet (a later phase)
//   * final AI analysis          → does not exist yet (a later phase)
// ---------------------------------------------------------------------------

const CANDIDATE_SYSTEM_STATUS = {
  IN_SYSTEM: "IN_SYSTEM",
  NOT_IN_SYSTEM: "NOT_IN_SYSTEM",
};

const CANDIDATE_INVITATION_STATUS = {
  NOT_INVITED: "NOT_INVITED",
  INVITED: "INVITED",
  EMAIL_VERIFIED: "EMAIL_VERIFIED",
  EXPIRED: "EXPIRED",
};

// The candidate fields the CURRENT Excel contract carries: Email (required) and
// Name. Every other field the later phases may consume (preferred role, skills,
// skill notes, resume/LinkedIn/GitHub references) is NOT part of the current
// sheet, so it is reported as unavailable instead of being invented or silently
// replaced with platform profile data.
const UNAVAILABLE_CANDIDATE_FIELDS = {
  preferredRole: null,
  skills: null,
  skillNotes: null,
  resumeReference: null,
  linkedinReference: null,
  githubReference: null,
};

// A per-row invitation status derived from the existing invitation row. The
// invitation lifecycle itself (creation, expiry windows, verification tokens)
// stays owned by the existing invitation service — this is a projection.
const resolveInvitationStatus = (invitation, now) => {
  if (!invitation) {
    return CANDIDATE_INVITATION_STATUS.NOT_INVITED;
  }
  if (invitation.status === "EMAIL_VERIFIED") {
    return CANDIDATE_INVITATION_STATUS.EMAIL_VERIFIED;
  }
  const expiresAt = invitation.expiresAt ? new Date(invitation.expiresAt).getTime() : 0;
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    return CANDIDATE_INVITATION_STATUS.EXPIRED;
  }
  return CANDIDATE_INVITATION_STATUS.INVITED;
};

// The sheet's Name column is optional; when it is missing the parser falls back
// to the first column, which can be the email itself. An email is never a name,
// so that case is reported as "no name provided" rather than echoed back.
const resolveCandidateName = (name, email) => {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) {
    return null;
  }
  return normalizeCandidateEmail(trimmed) === email ? null : trimmed;
};

// The ONE email normalization rule for this workflow (identical to
// job.service's candidate-facing rule: trim + lowercase). Invitations, account
// matching and duplicate detection all compare normalized values only.
const normalizeCandidateEmail = (email) => String(email ?? "").trim().toLowerCase();

/**
 * Classifies every candidate row of a job's persisted Excel list.
 *
 * @param {object} input
 * @param {Array<{rowIndex:number, name?:string, email:string}>} input.rows
 *   Candidate rows in file order
 *   (jobCandidateList.parser#parseCandidateListRows).
 * @param {Record<string, {userId:string}>} [input.accountsByEmail]
 *   Normalized email → platform candidate account.
 * @param {Record<string, object>} [input.verificationByUserId]
 *   Candidate user id → existing verified skill score projection
 *   (verificationRead.service#getExistingVerifiedSkillScoresForUsers).
 * @param {Record<string, object>} [input.invitationsByEmail]
 *   Normalized email → existing invitation row of THIS job's assessment.
 * @param {Date} [input.now] Injectable clock (deterministic expiry tests).
 */
const classifyCandidateRows = ({
  rows = [],
  accountsByEmail = {},
  verificationByUserId = {},
  invitationsByEmail = {},
  now = new Date(),
} = {}) => {
  const nowMs = new Date(now).getTime();
  const seenEmails = new Set();
  const duplicateEmails = [];

  const candidates = rows.map((row) => {
    const email = normalizeCandidateEmail(row?.email);
    const account = email ? accountsByEmail[email] ?? null : null;
    const inSystem = Boolean(account);

    if (email && seenEmails.has(email) && !duplicateEmails.includes(email)) {
      duplicateEmails.push(email);
    }
    seenEmails.add(email);

    // The existing platform skill score: read-only, never recomputed, never
    // mixed with the (not yet existing) assessment score. An in-system
    // candidate without any completed verification reports null — an absent
    // value is never turned into a fabricated score.
    const verification = inSystem ? verificationByUserId[account.userId] ?? null : null;
    const existingVerifiedSkillScore = inSystem
      ? verification?.existingVerifiedSkillScore ?? null
      : 0;

    const invitation = email ? invitationsByEmail[email] ?? null : null;

    return {
      // Stable persisted-row identity (the sheet's own row number within the
      // immutable stored file — never an array position). Phase 2 uses it as
      // the mutation identifier: INVITE carries this id and the backend
      // re-resolves the email from the stored file itself.
      id: Number.isInteger(row?.rowIndex) ? row.rowIndex : null,
      rowIndex: Number.isInteger(row?.rowIndex) ? row.rowIndex : null,
      name: resolveCandidateName(row?.name, email),
      email,
      systemStatus: inSystem
        ? CANDIDATE_SYSTEM_STATUS.IN_SYSTEM
        : CANDIDATE_SYSTEM_STATUS.NOT_IN_SYSTEM,
      candidateUserId: account?.userId ?? null,
      existingVerifiedSkillScore,
      existingVerifiedSkillCount: inSystem ? verification?.verifiedSkillCount ?? 0 : 0,
      existingVerifiedSkills: inSystem ? verification?.verifiedSkills ?? [] : [],
      invitationStatus: resolveInvitationStatus(invitation, nowMs),
      invitedAt: invitation?.invitedAt ?? null,
      invitationExpiresAt: invitation?.expiresAt ?? null,
      ...UNAVAILABLE_CANDIDATE_FIELDS,
    };
  });

  const countByInvitationStatus = (status) =>
    candidates.filter((candidate) => candidate.invitationStatus === status).length;

  const summary = {
    candidateCount: candidates.length,
    distinctCandidateEmailCount: seenEmails.size,
    duplicateEmails,
    inSystemCount: candidates.filter(
      (candidate) => candidate.systemStatus === CANDIDATE_SYSTEM_STATUS.IN_SYSTEM
    ).length,
    notInSystemCount: candidates.filter(
      (candidate) => candidate.systemStatus === CANDIDATE_SYSTEM_STATUS.NOT_IN_SYSTEM
    ).length,
    notInvitedCount: countByInvitationStatus(CANDIDATE_INVITATION_STATUS.NOT_INVITED),
    invitedCount: countByInvitationStatus(CANDIDATE_INVITATION_STATUS.INVITED),
    emailVerifiedCount: countByInvitationStatus(CANDIDATE_INVITATION_STATUS.EMAIL_VERIFIED),
    expiredInvitationCount: countByInvitationStatus(CANDIDATE_INVITATION_STATUS.EXPIRED),
  };

  return {
    candidates,
    summary,
    // Honest capability description of the CURRENT Excel contract: the UI reads
    // these flags instead of hardcoding which columns exist.
    availableCandidateFields: {
      email: true,
      name: candidates.some((candidate) => candidate.name !== null),
      ...Object.fromEntries(
        Object.keys(UNAVAILABLE_CANDIDATE_FIELDS).map((field) => [field, false])
      ),
    },
  };
};

module.exports = {
  CANDIDATE_SYSTEM_STATUS,
  CANDIDATE_INVITATION_STATUS,
  UNAVAILABLE_CANDIDATE_FIELDS,
  normalizeCandidateEmail,
  resolveInvitationStatus,
  resolveCandidateName,
  classifyCandidateRows,
};

