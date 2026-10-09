const jobRepository = require("./job.repository");
const overviewRepository = require("./jobOverview.repository");
const jobCandidateRepository = require("./jobCandidate.repository");
const {
  getExistingVerifiedSkillScoresForUsers,
} = require("../assessment/verificationRead.service");
// Authorization is the EXISTING single implementation. This feature does not
// define its own ownership rule: requireAuthorizedJob is the same chain
// (resolveSubscriptionAccess -> assertJobScope -> requireOwnedJob) every other
// recruiter job read uses, so a job id in the URL is a request, never proof.
const { requireAuthorizedJob } = require("./job.service");
// PHASE 3 — the centralized ORG_ADMIN candidate-level privacy policy. Applied to
// the ALREADY-authorized job, before any candidate row is read.
const { assertCandidateLevelAccess, evaluateCandidateLevelAccess } = require("./jobCandidatePrivacy");

// The UI-facing form of the policy. It reports WHY a candidate panel is absent
// rather than letting the frontend guess from an empty candidate list (which
// would be indistinguishable from "this job has no candidates").
const candidateLevelAccessDecision = (user, job) => {
  const decision = evaluateCandidateLevelAccess(user, job);
  return {
    allowed: decision.allowed,
    isOrgAdmin: decision.isOrgAdmin,
    isActiveJob: decision.isActiveJob,
    reason: decision.allowed
      ? null
      : "Candidate-level reporting becomes available once this job is closed.",
  };
};

// ---------------------------------------------------------------------------
// PHASE 8 — recruiter READ-ONLY Jobs overview (service half).
//
// HARD RULES ENFORCED HERE:
//   1. READ-ONLY. This module exports no mutating function. No Job, candidate,
//      assessment, analysis, preferred/selected or report row is ever written.
//   2. JOB-SCOPED AUTHORIZATION. Every entry point resolves the job through
//      requireAuthorizedJob BEFORE any candidate/analysis/report read, and
//      candidates/analyses are always read with the resolved jobId in the WHERE
//      clause - never by a bare referenceId the client supplied.
//   3. NO SCORE MERGING. Three values stay separate and are returned under three
//      distinct keys, each with its own documented source:
//        existingVerifiedSkillScore - the STORED platform verification headline
//        assessmentScore            - the AUTHORITATIVE persisted attempt triple
//        candidate analysis status  - the persisted JobCandidateAnalysis lifecycle
//      No combined/overall/hiring score is computed, derived or inferred anywhere.
//   4. CLOSED JOBS STAY READABLE. Reads are allowed in every status; nothing here
//      mutates, so a CLOSED job is simply historical data.
// ---------------------------------------------------------------------------

const httpError = (status, message) => Object.assign(new Error(message), { status });

const DAY_IN_MS = 24 * 60 * 60 * 1000;

// Bounded page sizes. The recruiter overview is a reading surface, so a small
// default and a hard ceiling keep one request from ever materializing an
// unbounded result set.
const OVERVIEW_DEFAULT_LIMIT = 10;
const OVERVIEW_MAX_LIMIT = 50;
const OVERVIEW_CANDIDATE_DEFAULT_LIMIT = 25;
const OVERVIEW_CANDIDATE_MAX_LIMIT = 100;

// Only the two persisted job statuses are filterable, plus the two derived
// groupings the recruiter actually thinks in ("active" / "closed"). DRAFT is
// excluded from `ACTIVE`/`CLOSED` grouping so a grouped filter never silently
// hides drafts.
const JOB_STATUS_VALUES = ["DRAFT", "ACTIVE", "CLOSED"];
const JOB_STATUS_GROUPS = {
  ACTIVE: "ACTIVE",
  CURRENT: "ACTIVE",
  CLOSED: "CLOSED",
  COMPLETED: "CLOSED",
  EXPIRED: "CLOSED",
};

const parseBoundedInt = (value, { fallback, min, max }) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
};

// Date filters accept an ISO calendar day. `from` starts at 00:00:00.000 UTC of
// that day and `to` ends at 23:59:59.999 of it, so "posted on 2026-09-30"
// includes the whole day. An unparseable value is a client error rather than a
// silently ignored filter (silently ignoring it would make the UI lie).
const parseDayBoundary = (value, edge) => {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw httpError(422, "Dates must be provided as YYYY-MM-DD");
  }
  const parsed = Date.parse(
    edge === "start" ? `${text}T00:00:00.000Z` : `${text}T23:59:59.999Z`
  );
  if (!Number.isFinite(parsed)) {
    throw httpError(422, "Dates must be provided as YYYY-MM-DD");
  }
  return new Date(parsed);
};

// Status filter: an exact persisted status, or one of the recruiter-facing
// groups. Unknown values are rejected instead of ignored.
const parseStatusFilter = (value) => {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const raw = String(value).trim().toUpperCase();
  if (JOB_STATUS_VALUES.includes(raw)) {
    return raw;
  }
  if (JOB_STATUS_GROUPS[raw]) {
    return JOB_STATUS_GROUPS[raw];
  }
  throw httpError(422, "Unknown job status filter");
};

const normalizeEmail = (email) => String(email ?? "").trim().toLowerCase();

// The recruiter-facing date range. `within=month` is the "posted within the last
// month" control; explicit from/to win over it when both are supplied.
const resolveDateWindow = (query) => {
  const from = parseDayBoundary(query.from, "start");
  const to = parseDayBoundary(query.to, "end");
  if (from && to && from.getTime() > to.getTime()) {
    throw httpError(422, "The start date must not be after the end date");
  }
  if (from || to) {
    return { createdFrom: from, createdTo: to };
  }
  const within = String(query.within ?? "").trim().toLowerCase();
  if (within === "month") {
    return { createdFrom: new Date(Date.now() - 30 * DAY_IN_MS), createdTo: null };
  }
  if (within === "week") {
    return { createdFrom: new Date(Date.now() - 7 * DAY_IN_MS), createdTo: null };
  }
  if (within === "quarter") {
    return { createdFrom: new Date(Date.now() - 90 * DAY_IN_MS), createdTo: null };
  }
  if (within === "year") {
    return { createdFrom: new Date(Date.now() - 365 * DAY_IN_MS), createdTo: null };
  }
  if (within) {
    throw httpError(422, "Unknown date range filter");
  }
  return { createdFrom: null, createdTo: null };
};

// One overview row. Explicitly a WHITELISTED projection: `preferredCandidateCount`
// is reported as the recruiter's configured TARGET (the existing, already-persisted
// field - not a computed or ranked list of people), and no candidate-level
// preferred/selected marker is invented here because no such state is persisted
// anywhere in the schema.
const sanitizeOverviewJob = (job) => ({
  id: job.id,
  title: job.title,
  status: job.status,
  createdAt: job.createdAt,
  startedAt: job.startedAt ?? null,
  analysisEndsAt: job.analysisEndsAt ?? null,
  closedAt: job.closedAt ?? null,
  closedReason: job.closedReason ?? null,
  // The recruiter-defined preferred-candidate TARGET exactly as they set it on
  // the job. It is a count they configured, never a score and never a ranking.
  preferredCandidateTarget: job.preferredCandidateCount ?? null,
  counts: {
    candidates: job._count?.candidateReferences ?? 0,
    attempts: job._count?.assessmentAttempts ?? 0,
    analyses: job._count?.candidateAnalyses ?? 0,
  },
  assessmentStatus: job.assessment?.status ?? null,
  assessmentActivatedAt: job.assessment?.activatedAt ?? null,
  // Historical jobs remain readable; this is a display flag, not an
  // authorization input. Every read below is allowed in every status.
  isClosed: job.status === "CLOSED",
});

// Recruiter's own jobs (independent recruiter OR their organization's jobs),
// filtered and paginated server-side.
const listOverviewJobs = async (user, ownership, query = {}) => {
  // requireAuthorizedJob is the single existing ownership implementation; the
  // overview reuses it rather than defining a second rule.
  const page = parseBoundedInt(query.page, { fallback: 1, min: 1, max: 1_000_000 });
  const limit = parseBoundedInt(query.limit, {
    fallback: OVERVIEW_DEFAULT_LIMIT,
    min: 1,
    max: OVERVIEW_MAX_LIMIT,
  });
  const status = parseStatusFilter(query.status);
  const { createdFrom, createdTo } = resolveDateWindow(query);

  // Ownership predicate is derived from the AUTHENTICATED principal only.
  const ownershipWhere =
    ownership.scope === "organization"
      ? { organizationId: ownership.organizationId }
      : { recruiterId: user.id };

  const { jobs, total } = await overviewRepository.findOverviewJobs({
    ownershipWhere,
    search: query.search,
    status,
    createdFrom,
    createdTo,
    skip: (page - 1) * limit,
    take: limit,
  });

  return {
    jobs: jobs.map(sanitizeOverviewJob),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(Math.ceil(total / limit), 1),
    },
    filters: {
      search: typeof query.search === "string" ? query.search.trim() : "",
      status: status ?? null,
      from: query.from ?? null,
      to: query.to ?? null,
      within: query.within ?? null,
    },
  };
};

// The read-only job-details card payload. Description/requirements come from the
// EXISTING JobDetail projection (findJobById + JOB_DETAIL_INCLUDE) so the card can
// never drift from the job the recruiter already manages, and counts come from the
// aggregate queries. Nothing here is written and nothing is copied to a new table.
const getOverviewJobDetails = async (user, jobId) => {
  // Authorize FIRST. A job of another recruiter/organization 403s here and the
  // counts below are never issued.
  const job = await requireAuthorizedJob(user, jobId);
  const counts = await overviewRepository.findOverviewJobCounts(job.id);

  return {
    job: {
      id: job.id,
      title: job.title,
      description: job.description ?? null,
      yearsExperience: job.yearsExperience ?? null,
      status: job.status,
      createdAt: job.createdAt,
      startedAt: job.startedAt ?? null,
      analysisEndsAt: job.analysisEndsAt ?? null,
      closedAt: job.closedAt ?? null,
      closedReason: job.closedReason ?? null,
      preferredCandidateTarget: job.preferredCandidateCount ?? null,
      // Persisted requirement data, projected straight from the job's own rows.
      skills: (job.skills ?? []).map((skill) => ({
        name: skill.name,
        weight: skill.weight ?? null,
      })),
      tools: (job.tools ?? []).map((tool) => ({ name: tool.name })),
      requirements: (job.questions ?? []).map((question) => ({
        id: question.id,
        question: question.question,
      })),
      assessment: job.assessment
        ? {
            id: job.assessment.id,
            title: job.assessment.title,
            description: job.assessment.description ?? null,
            status: job.assessment.status,
            questionCount: (job.assessment.questions ?? []).length,
            durationSeconds: job.assessment.durationSeconds,
            activatedAt: job.assessment.activatedAt ?? null,
          }
        : null,
      // Where the informational platform score comes from - never the assessment
      // score, never the candidate analysis.
      existingVerifiedSkillScoreSource: "STORED_PLATFORM_VERIFICATION_REPORTS",
    },
    counts: {
      candidates: counts.candidateCount,
      // Selected-candidate counts are reported as null on purpose: no selected
      // state is persisted anywhere in the schema, so inventing a number here
      // would be fabricating data.
      preferredCandidates: null,
      selectedCandidates: null,
      assessmentAttemptsByStatus: counts.attemptCountByStatus,
      completedCandidateAnalyses: counts.completedAnalysisCount,
      totalCandidateAnalyses: counts.totalAnalysisCount,
    },
    // PHASE 3 — tells the UI whether candidate-level panels are available for
      // THIS job. Job-level data above is never withheld; only the candidate rows
      // are, and only for an ORG_ADMIN on an ACTIVE job.
      candidateLevelAccess: candidateLevelAccessDecision(user, job),
      isClosed: job.status === "CLOSED",
  };
};

// Candidates of ONE authorized job, paginated and searched server-side.
//
// THE THREE VALUES ARE RETURNED SEPARATELY AND NEVER COMBINED:
//   * existingVerifiedSkillScore + systemStatus come from the STORED platform
//     verification reports, resolved for the page's IN_SYSTEM accounts only,
//     through the SAME existing read service the recruiter candidate list uses.
//     NOT_IN_SYSTEM candidates report null and are never given a fabricated 0/100.
//   * assessmentStatus / assessmentScore come from the PERSISTED attempt row.
//     They are never recomputed here and never accepted from the client.
//   * analysisStatus is the persisted JobCandidateAnalysis lifecycle only; the
//     report itself is fetched on demand by the existing analysis endpoint.
//
// PREFERRED / SELECTED: no such per-candidate state is persisted anywhere in the
// schema, so both are reported as null with an explicit reason instead of being
// invented from a score. The job's recruiter-configured preferred TARGET is
// reported separately by the job endpoints.
const listOverviewCandidates = async (user, jobId, query = {}) => {
  const job = await requireAuthorizedJob(user, jobId);

  // PHASE 3 — ACTIVE-job candidate privacy. Applied to the ALREADY-authorized job
  // and BEFORE any candidate/attempt/verification/analysis row is read, so a denied
  // request never loads the data it refuses to return. Recruiters are unaffected.
  assertCandidateLevelAccess(user, job);

  const page = parseBoundedInt(query.page, { fallback: 1, min: 1, max: 1_000_000 });
  const limit = parseBoundedInt(query.limit, {
    fallback: OVERVIEW_CANDIDATE_DEFAULT_LIMIT,
    min: 1,
    max: OVERVIEW_CANDIDATE_MAX_LIMIT,
  });

  const { references, total } = await overviewRepository.findOverviewCandidates({
    jobId: job.id,
    search: query.search,
    skip: (page - 1) * limit,
    take: limit,
  });

  const pagination = {
    page,
    limit,
    total,
    totalPages: Math.max(Math.ceil(total / limit), 1),
  };

  if (references.length === 0) {
    return { jobId: job.id, candidates: [], pagination, isClosed: job.status === "CLOSED" };
  }

  const referenceIds = references.map((row) => row.id);
  const emails = references.map((row) => normalizeEmail(row.candidateEmail));

  // --- Batched reads for the WHOLE page. Fixed query count per page: never a
  // per-candidate query, so this cannot become an N+1 explosion. ---
  const [analysisRows, attempts, accounts] = await Promise.all([
    overviewRepository.findLatestAnalysisStatusByReferenceIds(job.id, referenceIds),
    overviewRepository.findAttemptsByJobAndEmails(job.id, emails),
    jobCandidateRepository.findCandidateAccountsByEmails(emails),
  ]);

  const accountByEmail = new Map();
  for (const account of accounts) {
    accountByEmail.set(normalizeEmail(account.email), account);
  }
  const accountIds = [...new Set([...accountByEmail.values()].map((account) => account.id))];

  // The EXISTING stored-verification projection. Read-only, informational, and
  // never merged with the assessment score or the candidate analysis.
  const verificationByUserId =
    accountIds.length > 0 ? await getExistingVerifiedSkillScoresForUsers(accountIds) : {};

  // Latest analysis per reference (rows arrive version-desc).
  const latestAnalysisByReference = new Map();
  for (const row of analysisRows) {
    if (!latestAnalysisByReference.has(row.referenceId)) {
      latestAnalysisByReference.set(row.referenceId, row);
    }
  }
  const attemptByEmail = new Map();
  for (const attempt of attempts) {
    attemptByEmail.set(normalizeEmail(attempt.email), attempt);
  }

  const candidates = references.map((reference) => {
    const email = normalizeEmail(reference.candidateEmail);
    const account = accountByEmail.get(email) ?? null;
    const verification = account ? verificationByUserId[account.id] ?? null : null;
    const attempt = attemptByEmail.get(email) ?? null;
    const analysis = latestAnalysisByReference.get(reference.id) ?? null;

    return {
      // The candidate's stable, job-scoped identity. The frontend sends this
      // back only as a request; the server re-resolves it against THIS job.
      referenceId: reference.id,
      candidateName: reference.candidateName ?? null,
      // Recruiter-safe display: the normalized address the recruiter themselves
      // supplied on the sheet / when adding the candidate.
      candidateEmail: email,
      preferredRole: reference.preferredRole ?? null,
      skills: Array.isArray(reference.skills) ? reference.skills : [],
      hasResume: Boolean(reference.resumeFileId),
      hasResumeText: Boolean(reference.resumeText),
      // Reference availability only. Whether a LinkedIn/GitHub URL was ANALYZED
      // is decided by the persisted analysis report, not by this list.
      linkedinUrl: reference.linkedinUrl ?? null,
      githubUrl: reference.githubUrl ?? null,

      // (1) EXISTING PLATFORM VERIFICATION - informational, never recomputed.
      systemStatus: account ? "IN_SYSTEM" : "NOT_IN_SYSTEM",
      existingVerifiedSkillScore: account
        ? verification?.existingVerifiedSkillScore ?? null
        : null,
      existingVerifiedSkillCount: account ? verification?.verifiedSkillCount ?? 0 : 0,

      // (2) ASSESSMENT - the AUTHORITATIVE persisted attempt triple.
      assessmentStatus: attempt?.status ?? null,
      assessmentScore: attempt?.score ?? null,
      assessmentMaxScore: attempt?.maxScore ?? null,
      assessmentScorePercentage:
        attempt?.scorePercentage === null || attempt?.scorePercentage === undefined
          ? null
          : Number(attempt.scorePercentage),
      assessmentSubmittedAt: attempt?.submittedAt ?? null,
      assessmentTimedOutAt: attempt?.timedOutAt ?? null,
      assessmentCheatedAt: attempt?.cheatedAt ?? null,
      assessmentCheatReason: attempt?.cheatReason ?? null,

      // (3) JOB CANDIDATE ANALYSIS - lifecycle only; the report is fetched on
      // demand through the existing analysis endpoint.
      analysisId: analysis?.id ?? null,
      analysisStatus: analysis?.aiJob?.status ?? null,
      analysisVersion: analysis?.analysisVersion ?? null,
      analysisCompletedAt: analysis?.completedAt ?? null,

      // Explicitly unresolved states. Reporting them as null (rather than 0 or a
      // derived ranking) is the honest answer: no such state is persisted.
      preferredStatus: null,
      preferredStatusReason:
        "No per-candidate preferred state exists in the platform yet. The job's preferred-candidate figure is a recruiter-configured target, not a per-candidate flag.",
      selectedStatus: null,
      selectedStatusReason:
        "No per-candidate selected state exists in the platform yet. Invitation selection is a transient UI action, not a persisted candidate state.",
    };
  });

  return {
    jobId: job.id,
    candidates,
    pagination,
    isClosed: job.status === "CLOSED",
    // Where the informational platform score comes from. No combined/overall
    // score is offered by this endpoint, by design.
    existingVerifiedSkillScoreSource: "STORED_PLATFORM_VERIFICATION_REPORTS",
  };
};

module.exports = {
  OVERVIEW_DEFAULT_LIMIT,
  OVERVIEW_MAX_LIMIT,
  OVERVIEW_CANDIDATE_DEFAULT_LIMIT,
  OVERVIEW_CANDIDATE_MAX_LIMIT,
  listOverviewJobs,
  getOverviewJobDetails,
  listOverviewCandidates,
};
