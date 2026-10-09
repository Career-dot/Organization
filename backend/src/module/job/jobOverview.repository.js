const prisma = require("../../config/prisma");

// ---------------------------------------------------------------------------
// PHASE 8 — recruiter read-only Jobs overview (repository half).
//
// THIS MODULE IS STRICTLY READ-ONLY. It contains no create/update/delete call of
// any kind, enqueues nothing and calls no AI service. Every query is keyed by a
// jobId (or a list of jobIds) that the CALLER's service layer has already
// resolved through the existing requireOwnedJob chain, so no row belonging to
// another recruiter or organization can be selected here.
//
// REUSE, NOT DUPLICATION: this module adds no new table, no new candidate record
// and no new report store. It reads the existing Job, JobCandidateReference,
// JobAssessmentAttempt and JobCandidateAnalysis rows.
//
// SCALABILITY RULES ENFORCED HERE:
//   * Job list: ONE findMany + ONE count over the caller's own job rows, with
//     skip/take pagination. Candidate/attempt/analysis COUNTS are aggregated in
//     the SAME query (no per-job follow-up query = no N+1).
//   * `result` (the candidate-analysis JSON blob) is NEVER selected by any list
//     or count query - only the light status columns are. The full report is
//     fetched on demand by the existing getCandidateAnalysis path.
//   * Candidate list: one paginated findMany plus batched `in` lookups keyed by
//     the page's own ids. Never a per-candidate query.
// ---------------------------------------------------------------------------

// The lightweight job row for the overview list. Deliberately excludes every
// heavy relation (assessment questions, clarifications, aiJobs, candidate list)
// and includes only the counts the list needs.
const OVERVIEW_JOB_SELECT = {
  id: true,
  title: true,
  status: true,
  createdAt: true,
  analysisEndsAt: true,
  closedAt: true,
  closedReason: true,
  startedAt: true,
  preferredCandidateCount: true,
  organizationId: true,
  recruiterId: true,
  // Aggregate counts resolved in the same round trip as the rows.
  _count: {
    select: {
      candidateReferences: true,
      assessmentAttempts: true,
      candidateAnalyses: true,
    },
  },
  // The assessment's lifecycle status is meaningful on the overview row; its
  // questions are not (they are only needed inside the job-details card).
  assessment: { select: { id: true, status: true, activatedAt: true } },
};

// Free-text search over the two fields the recruiter searches by: the job title
// and the job id. `contains` + `mode: insensitive` maps to ILIKE '%term%', which
// the pg_trgm GIN index (migration 20260930010000) makes index-backed.
//
// The term is matched against BOTH title and id so pasting a Job ID into the same
// search box works. Both predicates are OR-ed inside one query, so this stays a
// single indexed statement rather than two round trips.
const buildOverviewSearchWhere = (search) => {
  const term = typeof search === "string" ? search.trim() : "";
  if (!term) {
    return {};
  }
  // Bound the raw term so a pathological input cannot become an unbounded
  // pattern. The list never needs a very long search string.
  const bounded = term.slice(0, 200);
  return {
    OR: [
      { title: { contains: bounded, mode: "insensitive" } },
      { id: { contains: bounded, mode: "insensitive" } },
    ],
  };
};

// One recruiter's own jobs, filtered + paginated SERVER-SIDE.
//
// `ownershipWhere` is built by the service from the authenticated principal only
// (recruiterId or organizationId) - a client can never supply it.
const findOverviewJobs = async ({
  ownershipWhere,
  search,
  status,
  createdFrom,
  createdTo,
  skip,
  take,
}) => {
  const createdAt =
    createdFrom || createdTo
      ? {
          ...(createdFrom ? { gte: createdFrom } : {}),
          ...(createdTo ? { lte: createdTo } : {}),
        }
      : null;

  const where = {
    AND: [
      ownershipWhere,
      buildOverviewSearchWhere(search),
      ...(status ? [{ status }] : []),
      ...(createdAt ? [{ createdAt }] : []),
    ],
  };

  const [jobs, total] = await prisma.$transaction([
    prisma.job.findMany({
      where,
      select: OVERVIEW_JOB_SELECT,
      // Stable, total ordering: newest first, id as the deterministic tiebreak
      // so pagination can never repeat or skip a row.
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip,
      take,
    }),
    prisma.job.count({ where }),
  ]);
  return { jobs, total };
};

// ---------------------------------------------------------------------------
// Per-job counts for the job-details card.
//
// Candidate count, attempt statuses and completed-analysis count are GROUP BY
// aggregates issued together - a fixed number of queries per opened job,
// independent of how many candidates the job has. This is deliberately NOT the
// existing `/candidates` path (which re-reads and re-parses the stored Excel
// sheet); the overview card needs counts, not a classified candidate listing.
// ---------------------------------------------------------------------------
const findOverviewJobCounts = async (jobId) => {
  const [candidateCount, attempts, analyses] = await prisma.$transaction([
    prisma.jobCandidateReference.count({ where: { jobId } }),
    prisma.jobAssessmentAttempt.groupBy({
      by: ["status"],
      where: { jobId },
      _count: { _all: true },
    }),
    prisma.jobCandidateAnalysis.groupBy({
      by: ["completedAt"],
      where: { jobId },
      _count: { _all: true },
    }),
  ]);

  const attemptCountByStatus = {};
  for (const row of attempts) {
    attemptCountByStatus[row.status] = row._count._all;
  }
  return {
    candidateCount,
    attemptCountByStatus,
    completedAnalysisCount: analyses
      .filter((row) => row.completedAt !== null)
      .reduce((sum, row) => sum + row._count._all, 0),
    totalAnalysisCount: analyses.reduce((sum, row) => sum + row._count._all, 0),
  };
};

// ---------------------------------------------------------------------------
// Paginated candidate list for ONE authorized job.
//
// Reads the EXISTING JobCandidateReference rows (the same rows the analysis
// pipeline, the resume flow and the recruiter candidate list already use). It
// creates nothing and never duplicates a candidate.
//
// `result` is deliberately NOT selected: a candidate page must never download a
// full analysis JSON document. Only status/version/timestamp columns come back;
// the full report is fetched through the existing on-demand analysis endpoint.
// ---------------------------------------------------------------------------
const OVERVIEW_CANDIDATE_SELECT = {
  id: true,
  candidateEmail: true,
  candidateName: true,
  preferredRole: true,
  linkedinUrl: true,
  githubUrl: true,
  skills: true,
  resumeFileId: true,
  resumeText: true,
  createdAt: true,
};

const findOverviewCandidates = async ({ jobId, search, skip, take }) => {
  const term = typeof search === "string" ? search.trim() : "";
  const bounded = term.slice(0, 200);
  const where = {
    jobId,
    ...(bounded
      ? {
          OR: [
            { candidateEmail: { contains: bounded, mode: "insensitive" } },
            { candidateName: { contains: bounded, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [references, total] = await prisma.$transaction([
    prisma.jobCandidateReference.findMany({
      where,
      select: OVERVIEW_CANDIDATE_SELECT,
      // Stable ordering independent of the stored sheet, so pagination is
      // deterministic even for manually added candidates.
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      skip,
      take,
    }),
    prisma.jobCandidateReference.count({ where }),
  ]);

  return { references, total };
};

// The latest analysis STATUS per reference for a page of candidates - light
// columns only, never `result`. Keyed by referenceId so the caller can join the
// statuses onto its page rows in memory.
const findLatestAnalysisStatusByReferenceIds = async (jobId, referenceIds) => {
  if (!Array.isArray(referenceIds) || referenceIds.length === 0) {
    return [];
  }
  return prisma.jobCandidateAnalysis.findMany({
    where: { jobId, referenceId: { in: referenceIds } },
    // No `result` selected - this is the list projection, not the report read.
    select: {
      id: true,
      referenceId: true,
      analysisVersion: true,
      attemptId: true,
      completedAt: true,
      aiJob: { select: { id: true, status: true } },
    },
    orderBy: { analysisVersion: "desc" },
  });
};

// The persisted attempt + score triple for a page of candidates, keyed by the
// attempt's normalized email. This is the AUTHORITATIVE assessment result the
// recruiter table shows: it is read straight from JobAssessmentAttempt, which is
// written once inside the submit transaction. The frontend can never supply it.
const findAttemptsByJobAndEmails = async (jobId, emails) => {
  if (!Array.isArray(emails) || emails.length === 0) {
    return [];
  }
  return prisma.jobAssessmentAttempt.findMany({
    where: { jobId, email: { in: emails } },
    select: {
      id: true,
      email: true,
      status: true,
      score: true,
      maxScore: true,
      scorePercentage: true,
      submittedAt: true,
      timedOutAt: true,
      cheatedAt: true,
      cheatReason: true,
    },
  });
};

module.exports = {
  OVERVIEW_JOB_SELECT,
  findOverviewJobs,
  findOverviewJobCounts,
  findOverviewCandidates,
  findLatestAnalysisStatusByReferenceIds,
  findAttemptsByJobAndEmails,
};
