const prisma = require("../../config/prisma");
const { prunePasswordHistory } = require("../auth/auth.repository");
const { assertProtectedSuperAdminCanReceiveRole } = require("../auth/super-admin-protection");

const findOrganizationById = async (organizationId) => {
  return prisma.organization.findUnique({
    where: { id: organizationId },
  });
};

// `client` defaults to the plain prisma client but accepts a `tx` from
// inside a transaction — used by the seat-limit check below, which needs
// this count to be read under the same transaction as the Organization row
// lock, not as a separate, unlocked query.
const countRecruiterMembershipsByStatus = async (organizationId, client = prisma) => {
  const grouped = await client.organizationMembership.groupBy({
    by: ["status"],
    where: { organizationId, role: "RECRUITER" },
    _count: { _all: true },
  });

  const counts = { total: 0, active: 0, invited: 0, removed: 0 };

  for (const row of grouped) {
    counts.total += row._count._all;
    if (row.status === "ACTIVE") counts.active = row._count._all;
    if (row.status === "INVITED") counts.invited = row._count._all;
    if (row.status === "REMOVED") counts.removed = row._count._all;
  }

  return counts;
};

const listRecruiterMemberships = async (organizationId) => {
  return prisma.organizationMembership.findMany({
    where: { organizationId, role: "RECRUITER" },
    include: {
      user: {
        select: {
          id: true,
          fullName: true,
          email: true,
          status: true,
          emailVerified: true,
          createdAt: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });
};

const findMembershipByIdInOrganization = async (membershipId, organizationId) => {
  return prisma.organizationMembership.findFirst({
    where: { id: membershipId, organizationId, role: "RECRUITER" },
    include: { user: { select: { id: true, fullName: true, email: true } } },
  });
};

// Used by the reset-credentials endpoint, which is addressed by recruiter
// userId (not membershipId) — still scoped to organizationId so an admin can
// never act on a recruiter outside their own organization.
const findMembershipByUserIdInOrganization = async (userId, organizationId) => {
  return prisma.organizationMembership.findFirst({
    where: { userId, organizationId, role: "RECRUITER" },
    include: { user: { select: { id: true, fullName: true, email: true } } },
  });
};

// Thrown (never caught here) when a seat-limited operation would push an
// organization's ACTIVE recruiter count over its plan's maxUsers. Callers in
// organization.service.js catch it by `.code` and translate it into the
// user-facing 409.
const seatLimitExceededError = () => {
  const error = new Error("Recruiter seat limit exceeded");
  error.code = "SEAT_LIMIT_EXCEEDED";
  return error;
};

// Row-locks the Organization first (SELECT ... FOR UPDATE) so two concurrent
// seat-limited operations for the *same* organization serialize instead of
// both reading a stale "under limit" count — the second one waits until the
// first's transaction commits (or rolls back) and then sees the up-to-date
// count. Other organizations are unaffected (the lock is per-row). Only
// meaningful when called from inside a transaction (`tx`), since a plain
// SELECT ... FOR UPDATE outside a transaction releases the lock immediately.
const assertRecruiterSeatAvailable = async (tx, organizationId, maxUsers) => {
  await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${organizationId} FOR UPDATE`;

  // null maxUsers = unlimited seats (not expected for an ORGANIZATION-type
  // plan in practice, but treated as "no limit" rather than assumed
  // unreachable).
  if (maxUsers === null) {
    return;
  }

  const counts = await countRecruiterMembershipsByStatus(organizationId, tx);

  if (counts.active >= maxUsers) {
    throw seatLimitExceededError();
  }
};

// status is either a plain ACTIVE->REMOVED deactivation (no seat check
// needed — removing a recruiter can never overshoot a limit) or a
// REMOVED->ACTIVE reactivation, which increases the active seat count
// exactly like provisioning a new recruiter does. `seatCheck` (passed only
// for the latter) carries the organizationId + maxUsers needed to run the
// same locked check createActiveRecruiter runs below.
const updateMembershipStatus = async (membershipId, status, seatCheck) => {
  if (!seatCheck) {
    return prisma.organizationMembership.update({
      where: { id: membershipId },
      data: { status },
    });
  }

  return prisma.$transaction(async (tx) => {
    await assertRecruiterSeatAvailable(tx, seatCheck.organizationId, seatCheck.maxUsers);

    return tx.organizationMembership.update({
      where: { id: membershipId },
      data: { status },
    });
  });
};

// ---------------------------------------------------------------------------
// ORG ADMIN READ-ONLY AUDIT DASHBOARD — repository half (aggregate reads).
//
// REUSE-FIRST: the platform audit found every underlying read path already
// exists — organization/membership scope (resolveAdminOrganization), seats
// (resolveRecruiterSeatLimit), job quota (job.service getJobLimits +
// jobRepository.countQuotaConsumptions), and the per-job candidate/attempt/
// analysis counts (jobOverview.repository OVERVIEW_JOB_SELECT). This module adds
// ONLY the organization-level aggregates that genuinely do not exist yet.
//
// It creates no table, stores no snapshot, and never duplicates a Job,
// candidate, analysis or report: every number is a live COUNT/GROUP BY.
//
// NO N+1 BY CONSTRUCTION: the recruiter card is a FIXED number of queries that
// does not grow with recruiter or job count — one GROUP BY per metric family,
// keyed by owning recruiter. Per-recruiter totals are an in-memory fold over
// those grouped rows, never a per-recruiter query.
// ---------------------------------------------------------------------------
const OVERVIEW_JOB_SELECT = require("../job/jobOverview.repository").OVERVIEW_JOB_SELECT;

// Counters grouped per OWNING RECRUITER for all jobs in one organization.
//
// Job.createdByUserId is the authoritative owning-recruiter key for
// organization jobs: those jobs are created with recruiterId = null and
// organizationId = <org> (see buildOwnershipData in job.service.js), so
// `recruiterId` is NULL for them and unusable here.
const countOrganizationJobsByRecruiter = async (organizationId) => {
  return prisma.job.groupBy({
    by: ["createdByUserId", "status"],
    where: { organizationId },
    _count: { _all: true },
  });
};

// Candidate / attempt / analysis counts per owning recruiter for one
// organization: three grouped queries, each at most (recruiters x statuses)
// rows — never (recruiters x jobs x candidates).
const countOrganizationActivityByRecruiter = async (organizationId) => {
  const [candidates, completedAnalyses] = await Promise.all([
    prisma.jobCandidateReference.groupBy({
      by: ["createdByUserId"],
      where: { job: { organizationId } },
      _count: { _all: true },
    }),
    // Only COMPLETED analyses count as "analyzed", matching the meaning already
    // used by jobOverview.repository's completedAnalysisCount.
    prisma.jobCandidateAnalysis.groupBy({
      by: ["jobId"],
      where: { job: { organizationId }, completedAt: { not: null } },
      _count: { _all: true },
    }),
  ]);

  // Map completed analyses onto their owning recruiter in one query.
  const jobOwners = await prisma.job.findMany({
    where: { organizationId },
    select: { id: true, createdByUserId: true },
  });
  const ownerByJobId = new Map(jobOwners.map((j) => [j.id, j.createdByUserId]));
  const completedByRecruiter = {};
  for (const row of completedAnalyses) {
    const owner = ownerByJobId.get(row.jobId);
    if (owner) {
      completedByRecruiter[owner] = (completedByRecruiter[owner] || 0) + row._count._all;
    }
  }

  const candidatesByRecruiter = {};
  for (const row of candidates) {
    candidatesByRecruiter[row.createdByUserId] =
      (candidatesByRecruiter[row.createdByUserId] || 0) + row._count._all;
  }

  return { candidatesByRecruiter, completedByRecruiter };
};

// Same aggregate families, date-windowed for the PHASE 9 analytics filter. The
// window is applied to the persisted timestamps the platform already stores
// (Job.createdAt / JobCandidateReference.createdAt / Analysis.completedAt), so
// the filter answers the same question the recruiter dashboard answers.
const countOrganizationJobsByRecruiterInRange = async (
  organizationId,
  createdFrom,
  createdTo
) => {
  const createdAt = {
    ...(createdFrom ? { gte: createdFrom } : {}),
    ...(createdTo ? { lte: createdTo } : {}),
  };

  const [jobs, candidates] = await Promise.all([
    prisma.job.groupBy({
      by: ["createdByUserId", "status"],
      where: { organizationId, createdAt },
      _count: { _all: true },
    }),
    prisma.jobCandidateReference.groupBy({
      by: ["createdByUserId"],
      where: { job: { organizationId }, createdAt },
      _count: { _all: true },
    }),
  ]);

  const jobsByRecruiter = {};
  for (const row of jobs) {
    const entry = (jobsByRecruiter[row.createdByUserId] ??= { total: 0, ACTIVE: 0, DRAFT: 0, CLOSED: 0 });
    entry.total += row._count._all;
    if (row.status in entry) entry[row.status] += row._count._all;
  }
  const candidatesByRecruiter = {};
  for (const row of candidates) {
    candidatesByRecruiter[row.createdByUserId] =
      (candidatesByRecruiter[row.createdByUserId] || 0) + row._count._all;
  }

  return { jobsByRecruiter, candidatesByRecruiter };
};

// ---------------------------------------------------------------------------
// ORG ADMIN EXECUTIVE DASHBOARD — organization-wide aggregates.
//
// These are the ONLY genuinely new reads: organization-level counters that no
// existing service exposed. Each is a database-level COUNT/GROUP BY over the
// EXISTING rows. Nothing is written, nothing is snapshotted, and no table,
// score, ranking or hiring record is created.
//
// HIRING IS DELIBERATELY NOT COMPUTED HERE. The audit of the schema found NO
// persisted candidate hiring/selection state, so there is nothing to count. The
// service reports an explicit "not available" block rather than deriving hiring
// from an assessment score, an AI analysis or a preferred/selected target.
// ---------------------------------------------------------------------------

// Organization-wide candidate + assessment counters.
const countOrganizationCandidateStats = async (organizationId) => {
  const [totalCandidates, completedAssessments] = await Promise.all([
    prisma.jobCandidateReference.count({ where: { job: { organizationId } } }),
    // A "completed assessment" is a SUBMITTED attempt — the only persisted state
    // that carries an authoritative score. Never recomputed here.
    prisma.jobAssessmentAttempt.count({
      where: { job: { organizationId }, submittedAt: { not: null } },
    }),
  ]);

  return { totalCandidates, completedAssessments };
};

// Candidate-analysis pipeline state, from the EXISTING AiJob lifecycle
// (operation = CANDIDATE_ANALYSIS). This is the platform's own record of
// pending/processing/completed/failed analysis work — no AI service is called.
const countOrganizationAnalysisStatus = async (organizationId) => {
  const rows = await prisma.aiJob.groupBy({
    by: ["status"],
    where: { operation: "CANDIDATE_ANALYSIS", job: { organizationId } },
    _count: { _all: true },
  });

  const byStatus = { PENDING: 0, PROCESSING: 0, COMPLETED: 0, FAILED: 0 };
  for (const row of rows) {
    if (row.status in byStatus) byStatus[row.status] += row._count._all;
  }

  return {
    completed: byStatus.COMPLETED,
    // PENDING + PROCESSING are both "not finished yet".
    pending: byStatus.PENDING + byStatus.PROCESSING,
    failed: byStatus.FAILED,
    total: rows.reduce((sum, row) => sum + row._count._all, 0),
  };
};

// ORG-WIDE job list for the Job Analysis section, newest first.
//
// `organizationId` is ALWAYS the server-resolved organization — never a client
// value — so a job from another organization can never be selected here. The
// owning recruiter's NAME is joined in the same query (a single relation
// include, not a per-row lookup), so the list needs no follow-up round trip.
const listOrganizationJobsForAudit = async ({
  organizationId,
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
    organizationId,
    ...(status ? { status } : {}),
    ...(createdAt ? { createdAt } : {}),
  };

  const [jobs, total] = await prisma.$transaction([
    prisma.job.findMany({
      where,
      select: {
        ...OVERVIEW_JOB_SELECT,
        // The owning recruiter's display identity, joined in the SAME query.
        // The Prisma relation is `createdByUser` (JobsCreatedByUser) — it is the
        // authoritative owning-recruiter link for organization jobs, whose
        // `recruiterId` is null. A single relation select, not a per-row lookup.
        createdByUser: { select: { id: true, fullName: true, email: true } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip,
      take,
    }),
    prisma.job.count({ where }),
  ]);

  return { jobs, total };
};

// ---------------------------------------------------------------------------
// PHASE 2 — Recruiter Analysis.
//
// Recruiter membership rows WITH server-side search.
//
// The search is applied in PostgreSQL against the membership's joined User
// (fullName + email), never by loading every recruiter and filtering in React.
// `search` is trimmed and length-capped; an empty value returns every recruiter,
// so the unfiltered call site is unchanged.
//
// `organizationId` is ALWAYS the server-resolved organization. There is no way
// for a caller to widen this by passing an organization id of their own.
const searchRecruiterMemberships = async (organizationId, search) => {
  const term = typeof search === "string" ? search.trim() : "";
  const where = {
    organizationId,
    role: "RECRUITER",
    ...(term
      ? {
          // Case-insensitive substring match on the persisted recruiter identity.
          // `mode: "insensitive"` maps to ILIKE in PostgreSQL.
          user: {
            OR: [
              { fullName: { contains: term, mode: "insensitive" } },
              { email: { contains: term, mode: "insensitive" } },
            ],
          },
        }
      : {}),
  };

  return prisma.organizationMembership.findMany({
    where,
    include: {
      user: {
        select: {
          id: true,
          fullName: true,
          email: true,
          status: true,
          emailVerified: true,
          createdAt: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });
};

// PHASE 2 — assessment attempt counts per recruiter, from the PERSISTED attempt
// lifecycle (JobAssessmentAttempt.status).
//
// Counts the whole organization in ONE grouped query keyed by the job's owning
// recruiter, so the cost is constant regardless of how many recruiters or jobs
// exist — there is deliberately no per-recruiter loop.
//
// Optional `submittedFrom`/`submittedTo` bound the window on `submittedAt`
// (a real persisted timestamp), used by the date filters. When the window is
// active, `inWindowTotal` counts only attempts that actually carry a submittedAt.
//
// NOTE the join is on `Job.createdByUserId`. Because Phase 1 made that column
// nullable (SetNull), jobs belonging to a permanently deleted recruiter are
// correctly ABSENT from this per-recruiter map: they belong to no recruiter.
// They are surfaced separately as unattributed historical jobs by
// countUnattributedHistoricalJobs below, so they are never silently dropped
// from the organization's own totals.
// PHASE 4 — the persisted attempt lifecycle mapped onto stable response keys.
//
// JobAssessmentAttemptStatus is STARTED | IN_PROGRESS | SUBMITTED | TIMED_UP |
// CHEATED. The map is explicit so a new enum member cannot silently fall into
// `total` while every named bucket reads 0 — an earlier version compared the raw
// enum value against lower-cased keys and reported all zeros.
//
// EXPIRED is not a member of the enum today (attempt expiry resolves to TIMED_UP),
// so its bucket is always 0. It is retained because the EXISTING per-recruiter
// contract already carries an `expired` key, and removing it would silently change
// that response shape.
//
// STARTED and IN_PROGRESS both map to `inProgress`: both are the "started, not
// finished" state. The raw per-state counts are preserved separately as
// ATTEMPT_STATUS_RAW_KEYS so nothing is actually merged away.
const ATTEMPT_STATUS_TO_KEY = {
  STARTED: "inProgress",
  IN_PROGRESS: "inProgress",
  SUBMITTED: "submitted",
  TIMED_UP: "timedUp",
  CHEATED: "cheated",
  EXPIRED: "expired",
};

// The UNMERGED persisted enum values, used only for the two states that
// ATTEMPT_STATUS_TO_KEY deliberately folds together.
//
// It must contain ONLY STARTED and IN_PROGRESS. SUBMITTED / TIMED_UP / CHEATED /
// EXPIRED already map one-to-one onto their own buckets above, so listing them
// here too would add their counts a SECOND time and silently inflate
// submitted/timedUp/cheated to roughly double the real number.
const ATTEMPT_STATUS_RAW_KEYS = {
  STARTED: "started",
  IN_PROGRESS: "inProgressRaw",
};

// Every key the aggregate can write MUST exist here and start at 0. A key that is
// absent would make `undefined += n` evaluate to NaN, which serializes to null in
// JSON and reports as a missing number rather than as an error.
const emptyAssessmentActivity = () => ({
  total: 0,
  started: 0,
  inProgress: 0,
  inProgressRaw: 0,
  submitted: 0,
  timedUp: 0,
  cheated: 0,
  expired: 0,
});

// PHASE 4 — ASSESSMENT ACTIVITY FOR THE WHOLE ORGANIZATION.
//
// The organization-level counterpart to countAssessmentActivityByRecruiter. It is
// deliberately a SEPARATE function rather than a sum of the per-recruiter map,
// because that map intentionally drops attempts belonging to jobs whose recruiter
// was permanently deleted (Phase 1's SetNull detach). Those attempts are still the
// ORGANIZATION's real history and must appear in an organization-level total.
//
// One grouped query over JobAssessmentAttempt joined to the organization's jobs.
// No row is ever loaded into JavaScript, and no per-job or per-recruiter loop is
// issued. Aggregate-only: no candidate identity is read or returned.
const countOrganizationAssessmentActivity = async (
  organizationId,
  { startedFrom, startedTo } = {}
) => {
  const startedAt =
    startedFrom || startedTo
      ? {
          ...(startedFrom ? { gte: startedFrom } : {}),
          ...(startedTo ? { lte: startedTo } : {}),
        }
      : null;

  const rows = await prisma.jobAssessmentAttempt.groupBy({
    by: ["status"],
    where: {
      job: { organizationId },
      ...(startedAt ? { startedAt } : {}),
    },
    _count: { _all: true },
  });

  const activity = emptyAssessmentActivity();
  for (const row of rows) {
    activity.total += row._count._all;
    const key = ATTEMPT_STATUS_TO_KEY[row.status];
    if (key) activity[key] += row._count._all;
    const rawKey = ATTEMPT_STATUS_RAW_KEYS[row.status];
    if (rawKey) activity[rawKey] += row._count._all;
  }

  return activity;
};

const countAssessmentActivityByRecruiter = async (
  organizationId,
  { submittedFrom, submittedTo } = {}
) => {
  const submittedAt =
    submittedFrom || submittedTo
      ? {
          ...(submittedFrom ? { gte: submittedFrom } : {}),
          ...(submittedTo ? { lte: submittedTo } : {}),
        }
      : null;

  const where = {
    job: { organizationId },
    ...(submittedAt ? { submittedAt } : {}),
  };

  // Per-status counts per recruiter (invitations started/completed/etc.).
  const byStatus = await prisma.jobAssessmentAttempt.groupBy({
    by: ["jobId", "status"],
    where,
    _count: { _all: true },
  });

  // The owning recruiter of every job carrying attempts in this organization.
  // Selecting ids is cheap and lets us fold attempts to a recruiter in memory,
  // so no per-recruiter query is ever issued.
  const jobOwners = await prisma.job.findMany({
    where: { organizationId, assessmentAttempts: { some: {} } },
    select: { id: true, createdByUserId: true },
  });
  const ownerByJobId = new Map(jobOwners.map((j) => [j.id, j.createdByUserId]));

  // The persisted lifecycle statuses are mapped with the shared
  // ATTEMPT_STATUS_TO_KEY above, so the organization-level and per-recruiter
  // surfaces can never drift apart.
  const perRecruiter = {};
  let inWindowTotal = 0;
  for (const row of byStatus) {
    const recruiterId = ownerByJobId.get(row.jobId);
    // A detached job (createdByUserId === null) belongs to no recruiter.
    if (recruiterId === undefined || recruiterId === null) continue;
    const entry = (perRecruiter[recruiterId] ??= {
      total: 0, submitted: 0, inProgress: 0, timedUp: 0, cheated: 0, expired: 0,
    });
    entry.total += row._count._all;
    const key = ATTEMPT_STATUS_TO_KEY[row.status];
    if (key) entry[key] += row._count._all;
    inWindowTotal += row._count._all;
  }

  return { perRecruiter, inWindowTotal };
};

// PHASE 2 — jobs whose owning recruiter no longer exists (Phase 1's SetNull
// detach), plus their candidate/attempt/analysis counts.
//
// These rows are REAL historical organization data that would otherwise vanish
// from every per-recruiter rollup, because a deleted recruiter has no membership
// row to be listed under. They are reported once, as an explicit unattributed
// bucket, and are never reassigned to a surviving recruiter.
//
// One findMany (with the existing count projection) + one count, so this stays
// constant regardless of how many detached jobs exist.
const countUnattributedHistoricalJobs = async (organizationId, { createdFrom, createdTo } = {}) => {
  const createdAt =
    createdFrom || createdTo
      ? {
          ...(createdFrom ? { gte: createdFrom } : {}),
          ...(createdTo ? { lte: createdTo } : {}),
        }
      : null;

  const where = {
    organizationId,
    // The definition of "unattributed": no owning recruiter link remains.
    createdByUserId: null,
    ...(createdAt ? { createdAt } : {}),
  };

  const [rows, total] = await prisma.$transaction([
    prisma.job.findMany({
      where,
      select: { ...OVERVIEW_JOB_SELECT, status: true },
    }),
    prisma.job.count({ where }),
  ]);

  const byStatus = { ACTIVE: 0, CLOSED: 0, DRAFT: 0 };
  let candidates = 0;
  let attempts = 0;
  let analyses = 0;
  for (const row of rows) {
    if (row.status in byStatus) byStatus[row.status] += 1;
    candidates += row._count?.candidateReferences ?? 0;
    attempts += row._count?.assessmentAttempts ?? 0;
    analyses += row._count?.candidateAnalyses ?? 0;
  }

  return { total, byStatus, candidates, attempts, analyses };
};

// Monthly activity buckets for the dashboard's time-series charts.
//
// Aggregated ENTIRELY IN POSTGRES via date_trunc — no rows are loaded into
// JavaScript to be counted in a loop. Uses the same parameterized tagged-template
// $queryRaw convention already used elsewhere in this codebase for row locks;
// every value below is bound as a parameter, so no user input is interpolated
// into SQL.
//
// Bounded by `months` (capped server-side) so the response size never depends on
// how long the organization has existed.
// The monthly series is always zero-filled and NEVER longer than this, so the
// response cannot grow with the organization's age or with an absurd custom range.
const MONTHLY_SERIES_MAX_BUCKETS = 24;

const startOfUtcMonth = (date) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));

// PHASE 4 — dense monthly organization series, now driven by the SAME window the
// dashboard's range selector resolves to.
//
// With no window (ALL time) this keeps the original behaviour exactly: `months`
// calendar months back from the current month. When a range IS selected, the
// buckets span that range instead, so a trend can never contradict the period the
// user is looking at. `to` bounds the upper edge and `from` the lower edge, both in
// UTC to match every other date boundary in this module.
//
// Every aggregate below is computed in PostgreSQL (date_trunc + COUNT FILTER).
// No row is loaded into JavaScript to be counted.
const countOrganizationMonthlyActivity = async (
  organizationId,
  months = 12,
  { from = null, to = null } = {}
) => {
  const now = new Date();

  const requestedFirst = from
    ? startOfUtcMonth(from)
    : new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1)
      );
  const requestedLast = to ? startOfUtcMonth(to) : startOfUtcMonth(now);

  let firstBucket = requestedFirst;
  let lastBucket = requestedLast;

  // An inverted window (only possible if a caller bypasses resolveAuditWindow)
  // still yields one bucket instead of throwing.
  if (firstBucket.getTime() > lastBucket.getTime()) firstBucket = lastBucket;

  let bucketCount =
    (lastBucket.getUTCFullYear() - firstBucket.getUTCFullYear()) * 12 +
    (lastBucket.getUTCMonth() - firstBucket.getUTCMonth()) +
    1;

  // Over-wide windows keep the MOST RECENT cap of buckets rather than erroring:
  // the recent tail is what a trend chart is actually read for.
  if (bucketCount > MONTHLY_SERIES_MAX_BUCKETS) {
    firstBucket = new Date(
      Date.UTC(
        lastBucket.getUTCFullYear(),
        lastBucket.getUTCMonth() - (MONTHLY_SERIES_MAX_BUCKETS - 1),
        1
      )
    );
    bucketCount = MONTHLY_SERIES_MAX_BUCKETS;
  }

  const since = firstBucket;
  // Exclusive upper edge = the first instant of the month AFTER the last bucket.
  const until = new Date(
    Date.UTC(lastBucket.getUTCFullYear(), lastBucket.getUTCMonth() + 1, 1)
  );

  const jobs = await prisma.$queryRaw`
    SELECT to_char(date_trunc('month', j."createdAt"), 'YYYY-MM') AS bucket,
           COUNT(*)::int AS count
    FROM "Job" j
    WHERE j."organizationId" = ${organizationId}
      AND j."createdAt" >= ${since}
      AND j."createdAt" < ${until}
    GROUP BY 1
    ORDER BY 1
  `;

  const candidates = await prisma.$queryRaw`
    SELECT to_char(date_trunc('month', c."createdAt"), 'YYYY-MM') AS bucket,
           COUNT(*)::int AS count
    FROM "JobCandidateReference" c
    JOIN "Job" j ON j."id" = c."jobId"
    WHERE j."organizationId" = ${organizationId}
      AND c."createdAt" >= ${since}
      AND c."createdAt" < ${until}
    GROUP BY 1
    ORDER BY 1
  `;

  const analyses = await prisma.$queryRaw`
    SELECT to_char(date_trunc('month', a."completedAt"), 'YYYY-MM') AS bucket,
           COUNT(*)::int AS count
    FROM "JobCandidateAnalysis" a
    JOIN "Job" j ON j."id" = a."jobId"
    WHERE j."organizationId" = ${organizationId}
      AND a."completedAt" IS NOT NULL
      AND a."completedAt" >= ${since}
      AND a."completedAt" < ${until}
    GROUP BY 1
    ORDER BY 1
  `;

  // PHASE 4 — assessment activity per month, bucketed on the PERSISTED
  // `startedAt` of the attempt. Conditional aggregation keeps this to ONE grouped
  // query and reads the persisted status enum directly; the enum is cast to text
  // for comparison so the literal never depends on implicit enum coercion.
  //
  // This is deliberately aggregate-only: it counts attempts, never candidates.
  const assessmentRows = await prisma.$queryRaw`
    SELECT to_char(date_trunc('month', t."startedAt"), 'YYYY-MM') AS bucket,
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE t."status"::text = 'SUBMITTED')::int AS submitted,
           COUNT(*) FILTER (WHERE t."status"::text = 'TIMED_UP')::int AS timed_up,
           COUNT(*) FILTER (WHERE t."status"::text = 'CHEATED')::int AS cheated
    FROM "JobAssessmentAttempt" t
    JOIN "Job" j ON j."id" = t."jobId"
    WHERE j."organizationId" = ${organizationId}
      AND t."startedAt" >= ${since}
      AND t."startedAt" < ${until}
    GROUP BY 1
    ORDER BY 1
  `;

  const toMap = (rows) => {
    const map = {};
    for (const row of rows) map[row.bucket] = row.count;
    return map;
  };

  // A DENSE series: every month in the window is present and zero-filled, so a
  // chart never silently skips a month that had no activity.
  const jobMap = toMap(jobs);
  const candidateMap = toMap(candidates);
  const analysisMap = toMap(analyses);
  const assessmentMap = new Map(assessmentRows.map((row) => [row.bucket, row]));

  const series = [];
  for (let i = 0; i < bucketCount; i += 1) {
    const cursor = new Date(
      Date.UTC(firstBucket.getUTCFullYear(), firstBucket.getUTCMonth() + i, 1)
    );
    const key = `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}`;
    const attempts = assessmentMap.get(key);
    series.push({
      bucket: key,
      jobsPosted: jobMap[key] ?? 0,
      candidatesAdded: candidateMap[key] ?? 0,
      candidatesAnalyzed: analysisMap[key] ?? 0,
      assessmentsStarted: attempts?.total ?? 0,
      assessmentsSubmitted: attempts?.submitted ?? 0,
      assessmentsTimedUp: attempts?.timed_up ?? 0,
      assessmentsCheated: attempts?.cheated ?? 0,
    });
  }

  return series;
};

// Count of SUBMITTED attempts (the ones that produced a persisted assessment
// score) inside one organization, optionally date-windowed. A single COUNT —
// never a per-job or per-candidate loop.
const countSubmittedAssessmentsInRange = async (organizationId, createdFrom, createdTo) => {
  const submittedAt = {
    not: null,
    ...(createdFrom ? { gte: createdFrom } : {}),
    ...(createdTo ? { lte: createdTo } : {}),
  };

  return prisma.jobAssessmentAttempt.count({
    where: { job: { organizationId }, submittedAt },
  });
};

// The job ids owned by ONE recruiter inside ONE organization, newest first.
//
// `userId` is the recruiter's user id and `organizationId` is the ALREADY
// server-resolved organization — the caller supplies neither. Both are AND-ed
// into the WHERE clause, so a recruiter id from another organization yields an
// empty page rather than that organization's jobs.
const findOrganizationJobsByRecruiter = async ({
  organizationId,
  userId,
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
    organizationId,
    createdByUserId: userId,
    ...(status ? { status } : {}),
    ...(createdAt ? { createdAt } : {}),
  };

  const [jobs, total] = await prisma.$transaction([
    prisma.job.findMany({
      where,
      // The EXISTING overview job projection, reused verbatim rather than
      // re-specified: it already carries candidateReferences / assessmentAttempts
      // / candidateAnalyses counts in the SAME round trip (no per-job follow-up).
      select: OVERVIEW_JOB_SELECT,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip,
      take,
    }),
    prisma.job.count({ where }),
  ]);

  return { jobs, total };
};

// Confirms a (organizationId, recruiter user id) pair is a REAL ACTIVE
// membership in THIS organization before that recruiter's jobs are listed.
//
// This is an ownership/existence check, NOT a second authorization system: the
// authoritative organization scope was already established by
// resolveAdminOrganization, and the status comes from the existing membership row.
const findActiveRecruiterMembership = async (organizationId, userId) => {
  return prisma.organizationMembership.findFirst({
    where: { organizationId, userId, role: "RECRUITER", status: "ACTIVE" },
    include: { user: { select: { id: true, fullName: true, email: true } } },
  });
};

// PHASE 1 — permanent recruiter deletion.
//
// This is a REAL row delete, not the existing `REMOVED` membership status: the
// User row itself is destroyed, so the account can never authenticate again and
// is no longer an active account of any kind.
//
// WHY THE SCHEMA HAD TO CHANGE FIRST (see migration
// 20261003120000_job_creator_detach_for_permanent_recruiter_delete):
//   Job.createdByUserId was NOT NULL + ON DELETE RESTRICT, and it is the
//   AUTHORITATIVE owning-recruiter link for organization jobs (whose
//   `recruiterId` is null). So any recruiter who had ever posted a job could not
//   be deleted at all. Making both links `SetNull` + nullable means deleting the
//   recruiter DETACHES them and keeps the job.
//
// WHAT SURVIVES vs WHAT IS DESTROYED — deliberately asymmetric:
//   DESTROYED (account-scoped, cascades from User): UserRole,
//     OrganizationMembership, RecruiterProfile, LoginSession, RefreshToken,
//     PasswordHistory, PasswordResetToken, EmailVerificationToken,
//     Notification, Subscription, AuditLog, VerificationAttempt/EmployeeProfile.
//   SURVIVES (organization-scoped historical record): Job, JobCandidateReference,
//     JobAssessment, JobAssessmentAttempt + answers + integrity events,
//     JobCandidateAnalysis, AiJob — all untouched, with createdByUserId = NULL.
//
// The asymmetry is the whole point: a job's candidates, attempts and analyses are
// the ORGANIZATION's audit history (the Job Analysis + Dashboard sections read
// exactly those rows), so they must survive an account deletion.
//
// Everything runs in ONE transaction so a failure cannot leave a half-deleted
// account (e.g. membership gone but User still present). The row lock on the
// Organization serializes concurrent deletes of the same organization's
// recruiters, so two simultaneous DELETEs cannot interleave a stale read.
const permanentlyDeleteRecruiterAccount = async ({
  organizationId,
  recruiterUserId,
  actorUserId,
}) => {
  return prisma.$transaction(async (tx) => {
    // Serialize per-organization, exactly like the seat-limit path does. Also
    // re-validates that the organization still exists inside this transaction.
    await tx.$queryRaw`SELECT 1 FROM "Organization" WHERE id = ${organizationId} FOR UPDATE`;

    // Re-validate ownership INSIDE the transaction. The service already checked,
    // but authorization and the delete must not be separated by time: doing it
    // here means a membership revoked between the check and this statement
    // cannot be deleted.
    const membership = await tx.organizationMembership.findFirst({
      where: { organizationId, userId: recruiterUserId, role: "RECRUITER" },
      include: { user: { select: { id: true, fullName: true, email: true } } },
    });

    if (!membership) {
      const error = new Error("Recruiter not found in your organization");
      error.status = 404;
      throw error;
    }

    // SAFETY GUARD — Organization.ownerId is ON DELETE CASCADE.
    //
    // An account can be both an organization owner AND a RECRUITER member (e.g.
    // it created its own organization and was later added as a recruiter). If we
    // deleted such a User, PostgreSQL would cascade-delete the WHOLE
    // Organization — and through it every job, candidate, assessment and
    // analysis inside it. That is precisely the historical destruction this
    // feature exists to prevent, so it is refused rather than executed.
    //
    // Ownership is transferred through the organization's own lifecycle, never as
    // a side effect of deleting a recruiter account.
    const ownedOrganizations = await tx.organization.count({
      where: { ownerId: recruiterUserId },
    });

    if (ownedOrganizations > 0) {
      const error = new Error(
        "This account owns an organization and cannot be deleted here. Transfer organization ownership first."
      );
      error.status = 409;
      throw error;
    }

    // Count what is being preserved, so the caller can report it honestly
    // instead of claiming the jobs were deleted.
    const [preservedJobs, preservedCandidates, preservedAttempts, preservedAnalyses] =
      await Promise.all([
        tx.job.count({ where: { createdByUserId: recruiterUserId } }),
        tx.jobCandidateReference.count({ where: { createdByUserId: recruiterUserId } }),
        tx.jobAssessmentAttempt.count({
          where: { job: { createdByUserId: recruiterUserId } },
        }),
        tx.jobCandidateAnalysis.count({
          where: { job: { createdByUserId: recruiterUserId } },
        }),
      ]);

    // Audit trail FIRST, while the actor and target both still exist. Written
    // inside the same transaction as the delete so a permanent deletion is
    // always recorded — never a silent, unrecoverable action. Metadata carries
    // identifiers only: never a password, token, resume or candidate text.
    await tx.auditLog.create({
      data: {
        actorUserId,
        action: "ORGANIZATION_RECRUITER_PERMANENTLY_DELETED",
        targetType: "USER",
        targetId: recruiterUserId,
        metadata: {
          organizationId,
          deletedUserEmail: membership.user.email,
          deletedUserFullName: membership.user.fullName,
          preservedJobs,
          preservedCandidates,
          preservedAttempts,
          preservedAnalyses,
        },
      },
    });

    // The permanent delete. Cascades remove the account-scoped rows; the two
    // Job ownership links are SetNull so the historical jobs stay intact.
    await tx.user.delete({ where: { id: recruiterUserId } });

    return {
      deletedUserId: recruiterUserId,
      deletedEmail: membership.user.email,
      deletedFullName: membership.user.fullName,
      preserved: {
        jobs: preservedJobs,
        candidates: preservedCandidates,
        assessmentAttempts: preservedAttempts,
        candidateAnalyses: preservedAnalyses,
      },
    };
  });
};


// Every domain conflict raised inside createActiveRecruiter is a 409, never a
// bare Error. A bare Error has no .status, so organization.controller.js's
// respondError would fall back to 400 and report a state conflict as a client
// error. The status is attached here so the controller's `error.status || 400`
// resolves to the correct 409 without duplicating any status logic.
const recruiterConflictError = (message) => {
  const error = new Error(message);
  error.status = 409;
  return error;
};

// Creates the recruiter's User record already fully usable through the
// normal /auth/login flow — real bcrypt passwordHash, emailVerified: true,
// status: ACTIVE — plus an ACTIVE OrganizationMembership, atomically. No
// token, no separate activation step: the organization vouches for this
// account by creating it, so it never needs email verification of its own.
// mustChangePassword starts true since the password was generated by the
// server, not chosen by the recruiter.
//
// The `permissions` argument is intentionally absent: recruiter capabilities
// come from the single global RECRUITER role, never from a per-membership
// matrix. The Prisma column keeps its `[]` default and is never written here.
const createActiveRecruiter = async ({
  fullName,
  email,
  organizationId,
  passwordHash,
  maxUsers,
}) => {
  return prisma.$transaction(async (tx) => {
    assertProtectedSuperAdminCanReceiveRole({ email }, "RECRUITER");
    await assertRecruiterSeatAvailable(tx, organizationId, maxUsers);

    const existingUser = await tx.user.findUnique({
      where: { email },
      include: { roles: { include: { role: true } } },
    });

    let user;
    let usesExistingPassword = false;

    if (existingUser) {
      const existingRoles = existingUser.roles.map(({ role }) => role.name);
      if (existingRoles.includes("ORG_ADMIN")) {
        throw recruiterConflictError("Organization admins cannot be organization recruiters");
      }
      if (existingRoles.length > 0) {
        throw recruiterConflictError("This account already has a global account capability");
      }
      const existingMembership = await tx.organizationMembership.findUnique({
        where: {
          userId_organizationId: { userId: existingUser.id, organizationId },
        },
      });
      if (existingMembership) {
        throw recruiterConflictError("This user is already a member of the organization");
      }

      user = existingUser;
      await tx.recruiterProfile.upsert({
        where: { userId: user.id },
        update: {},
        create: { userId: user.id },
      });

      await tx.user.update({
        where: { id: user.id },
        data: { emailVerified: true, status: "ACTIVE" },
      });
      usesExistingPassword = true;
    } else {
      user = await tx.user.create({
        data: {
          fullName,
          email,
          passwordHash,
          provider: "LOCAL",
          emailVerified: true,
          status: "ACTIVE",
          mustChangePassword: true,
        },
      });
    }

    if (!existingUser) {
      await tx.recruiterProfile.create({ data: { userId: user.id } });
    }

    // `permissions` is intentionally NOT written: the Prisma column keeps its
    // `[]` default and stays dead legacy data (see the permissions note above).
    const membership = await tx.organizationMembership.create({
      data: {
        userId: user.id,
        organizationId,
        role: "RECRUITER",
        status: "ACTIVE",
      },
    });

    if (!usesExistingPassword) {
      await tx.passwordHistory.create({
        data: { userId: user.id, passwordHash },
      });
    }

    return { user, membership, usesExistingPassword };
  });
};

// Used by reset-credentials: replaces the recruiter's password hash with a
// newly generated temporary one and flags mustChangePassword again — the
// old password stops working the instant this commits. No reuse check here
// (unlike auth.service.js's user-chosen-password paths): this password is
// server-generated random, not user-chosen, so checking it against history
// has no real security value — see assertPasswordNotReused's comment.
// History is still recorded and pruned, same as every other password-set
// path.
const resetRecruiterPassword = async (userId, passwordHash) => {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.update({
      where: { id: userId },
      data: {
        passwordHash,
        mustChangePassword: true,
        lastPasswordChanged: new Date(),
      },
    });

    await tx.loginSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), lastActive: new Date() },
    });

    await tx.refreshToken.updateMany({
      where: { userId, revoked: false },
      data: { revoked: true, revokedAt: new Date() },
    });

    await tx.passwordHistory.create({
      data: { userId, passwordHash },
    });

    await prunePasswordHistory(tx, userId);

    return user;
  });
};

// Updates organization profile fields scoped to a specific organizationId.
const updateOrganizationProfile = async (organizationId, data = {}) => {
  const updateData = {};

  const allowedFields = ["name", "website", "businessEmail"];
  for (const field of allowedFields) {
    if (!Object.prototype.hasOwnProperty.call(data, field)) {
      continue;
    }

    const value = data[field];
    const normalized = typeof value === "string" ? value.trim() || null : null;
    updateData[field] = normalized;
  }

  if (Object.keys(updateData).length === 0) {
    return prisma.organization.findUnique({ where: { id: organizationId } });
  }

  return prisma.organization.update({
    where: { id: organizationId },
    data: updateData,
  });
};

const findOrganizationLogoByOwnerId = async (ownerId) => {
  return prisma.storedFile.findFirst({
    where: {
      ownerType: "ORGANIZATION",
      ownerId,
      category: "ORGANIZATION_DOCUMENT",
    },
    orderBy: { createdAt: "desc" },
  });
};

module.exports = {
  findOrganizationById,
  countRecruiterMembershipsByStatus,
  listRecruiterMemberships,
  findMembershipByIdInOrganization,
  findMembershipByUserIdInOrganization,
  updateMembershipStatus,
  createActiveRecruiter,
  resetRecruiterPassword,
  updateOrganizationProfile,
  findOrganizationLogoByOwnerId,
  countOrganizationJobsByRecruiter,
  countOrganizationActivityByRecruiter,
  countOrganizationJobsByRecruiterInRange,
  countSubmittedAssessmentsInRange,
  findOrganizationJobsByRecruiter,
  findActiveRecruiterMembership,
  permanentlyDeleteRecruiterAccount,
  countOrganizationCandidateStats,
  countOrganizationAnalysisStatus,
  listOrganizationJobsForAudit,
  countOrganizationMonthlyActivity,
  searchRecruiterMemberships,
  countOrganizationAssessmentActivity,
  countAssessmentActivityByRecruiter,
  countUnattributedHistoricalJobs,
};
