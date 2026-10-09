const prisma = require("../../config/prisma");
// Phase 6 — the PURE deterministic scorer the submit transaction delegates to.
const { scoreAttempt } = require("./jobAssessment.scoring");

// ---------------------------------------------------------------------------
// Attempt aggregate data access (Phase 3 — persistent assessment attempt).
//
// ALL attempt/answer database operations live here. Every lifecycle change is
// a CONDITIONAL write (updateMany guarded on the current status) so the
// transitions are atomic in PostgreSQL and correct across any number of Node
// instances — no process memory, no local locks, no in-memory timers.
// ---------------------------------------------------------------------------

const ACTIVE_STATUSES = ["STARTED", "IN_PROGRESS"];
// Phase 5 adds CHEATED as the third TERMINAL attempt state: it is reached only
// through markAttemptCheated's conditional UPDATE, and a terminal attempt is
// never reopened by any later request.
const TERMINAL_STATUSES = ["SUBMITTED", "TIMED_UP", "CHEATED"];

// One attempt is keyed by (assessment, normalized email) — the candidate's own
// verified identity. No attempt is ever looked up by an id a candidate could
// guess, which is what makes cross-candidate access structurally impossible.
const findAttemptByAssessmentAndEmail = async (assessmentId, email) =>
  prisma.jobAssessmentAttempt.findUnique({
    where: { assessmentId_email: { assessmentId, email } },
  });

const findAttemptById = async (attemptId) =>
  prisma.jobAssessmentAttempt.findUnique({ where: { id: attemptId } });

// The persisted questions of a FINALIZED + ACTIVATED assessment, in persisted
// order. Same authorization read the existing public flow uses — never a
// regeneration, never an AI call.
const findAssessmentForAttempt = async (publicId) =>
  prisma.jobAssessment.findUnique({
    where: { publicId },
    include: {
      questions: {
        orderBy: { sortOrder: "asc" },
        select: {
          id: true,
          section: true,
          sortOrder: true,
          prompt: true,
          questionType: true,
          points: true,
          difficulty: true,
          options: true,
        },
      },
    },
  });

const findQuestionById = async (questionId) =>
  prisma.jobAssessmentQuestion.findUnique({
    where: { id: questionId },
    select: {
      id: true,
      assessmentId: true,
      questionType: true,
      options: true,
    },
  });

const createAttempt = async ({ jobId, assessmentId, invitationId, email, startedAt, deadlineAt }) =>
  prisma.jobAssessmentAttempt.create({
    data: {
      jobId,
      assessmentId,
      invitationId,
      email,
      status: "STARTED",
      startedAt,
      deadlineAt,
      lastActivityAt: startedAt,
    },
  });

// CAS transition: only succeeds while the attempt is still in one of the
// `fromStatuses`. Returns the number of rows changed so a lost race (another
// request already moved the attempt) is detectable instead of silent.
const transitionAttempt = async (attemptId, fromStatuses, data) => {
  const changed = await prisma.jobAssessmentAttempt.updateMany({
    where: { id: attemptId, status: { in: fromStatuses } },
    data,
  });
  return changed.count;
};

// Lazy expiry enforcement against the PERSISTED deadline — the replacement for
// an in-memory timer. Idempotent: once TIMED_UP, the where-clause no longer
// matches.
const markAttemptTimedUpIfExpired = async (attemptId, now) => {
  const changed = await prisma.jobAssessmentAttempt.updateMany({
    where: {
      id: attemptId,
      status: { in: ACTIVE_STATUSES },
      deadlineAt: { lte: now },
    },
    data: { status: "TIMED_UP", timedOutAt: now },
  });
  return changed.count;
};

// ---------------------------------------------------------------------------
// Phase 5 — the ONE authoritative CHEATED transition.
//
// A single conditional UPDATE: it can only ever match an attempt that is STILL
// active. Consequences (all deliberate):
//   * Atomic — PostgreSQL evaluates the status predicate inside the write, so
//     of N concurrent threshold-triggering requests exactly ONE updates a row
//     and the rest update 0. No read-then-write race, no lost update.
//   * Idempotent — a second call after the transition matches no row and
//     returns 0, so the terminal state is written at most once.
//   * Terminal — an attempt that is already SUBMITTED / TIMED_UP / CHEATED
//     matches no row, so it can never be moved back to an active state and a
//     CHEATED decision can never overwrite a legitimate submission.
// Returns the number of rows changed so the caller can tell whether IT was the
// winner (and therefore whether it should publish the realtime event).
// ---------------------------------------------------------------------------
const markAttemptCheated = async (attemptId, { reason, now, fromStatuses = ACTIVE_STATUSES } = {}) => {
  const changed = await prisma.jobAssessmentAttempt.updateMany({
    where: { id: attemptId, status: { in: fromStatuses } },
    data: {
      status: "CHEATED",
      cheatedAt: now ?? new Date(),
      cheatReason: reason ?? null,
      lastActivityAt: now ?? new Date(),
    },
  });
  return changed.count;
};

// Recruiter-view correction: every active attempt of a job whose deadline has
// passed is persisted as TIMED_UP before the statuses are read.
const markExpiredAttemptsTimedUpForJob = async (jobId, now) => {
  const changed = await prisma.jobAssessmentAttempt.updateMany({
    where: {
      jobId,
      status: { in: ACTIVE_STATUSES },
      deadlineAt: { lte: now },
    },
    data: { status: "TIMED_UP", timedOutAt: now },
  });
  return changed.count;
};

// Phase 4 (additive) — the attempts a job sweep is about to close, read BEFORE
// markExpiredAttemptsTimedUpForJob runs. They are used only to publish
// realtime TIMED_UP events for rows that actually transitioned; the persisted
// status remains the authority (a row that another process already closed is
// simply not reported again). No lifecycle rule is duplicated here.
const listExpiredActiveAttempts = async (jobId, now) =>
  prisma.jobAssessmentAttempt.findMany({
    where: {
      jobId,
      status: { in: ACTIVE_STATUSES },
      deadlineAt: { lte: now },
    },
    select: { id: true, jobId: true, assessmentId: true, email: true },
  });

const findAnswersByAttempt = async (attemptId) =>
  prisma.jobAssessmentAttemptAnswer.findMany({
    where: { attemptId },
    select: { questionId: true, answer: true, answeredAt: true, updatedAt: true },
    orderBy: { answeredAt: "asc" },
  });

const getAttemptWithAnswers = async (attemptId) =>
  prisma.jobAssessmentAttempt.findUnique({
    where: { id: attemptId },
    include: {
      answers: {
        select: { questionId: true, answer: true, answeredAt: true, updatedAt: true },
        orderBy: { answeredAt: "asc" },
      },
    },
  });

// Recruiter status view — status + the persisted Phase 6 assessment score.
// Answers are never selected here: the recruiter sees the server-calculated
// result, never what a candidate wrote and never an answer key.
const listAttemptsForJob = async (jobId) =>
  prisma.jobAssessmentAttempt.findMany({
    where: { jobId },
    select: {
      id: true,
      email: true,
      status: true,
      startedAt: true,
      deadlineAt: true,
      submittedAt: true,
      timedOutAt: true,
      lastActivityAt: true,
      // Phase 5 — deterministic integrity termination facts. No answers, no
      // integrity metadata, just the persisted decision.
      cheatedAt: true,
      cheatReason: true,
      // Phase 6 — the persisted server-calculated score triple (null until a
      // submission produced it; always null for TIMED_UP/CHEATED).
      score: true,
      maxScore: true,
      scorePercentage: true,
    },
    orderBy: { startedAt: "asc" },
  });

// One interactive transaction per answer write: the attempt state, the
// question's assessment membership and the upsert are all decided against the
// SAME committed data, so a concurrent Submit can never interleave.
const saveAnswerTransactional = async ({ attemptId, questionId, answer, now }) =>
  prisma.$transaction(async (tx) => {
    const attempt = await tx.jobAssessmentAttempt.findUnique({
      where: { id: attemptId },
      select: { id: true, status: true, deadlineAt: true, assessmentId: true },
    });
    if (!attempt) {
      return { outcome: "NO_ATTEMPT" };
    }
    if (TERMINAL_STATUSES.includes(attempt.status)) {
      // Phase 5: CHEATED is terminal too — an integrity-terminated attempt
      // accepts no further answers, exactly like a submitted or timed-up one.
      return { outcome: "TERMINAL", status: attempt.status };
    }
    if (attempt.deadlineAt.getTime() <= now.getTime()) {
      // Lazy timeout: the first touch after the deadline closes the attempt.
      const changed = await tx.jobAssessmentAttempt.updateMany({
        where: { id: attempt.id, status: { in: ACTIVE_STATUSES } },
        data: { status: "TIMED_UP", timedOutAt: now },
      });
      return { outcome: changed.count > 0 ? "TIMED_UP" : "TERMINAL", status: "TIMED_UP" };
    }

    // Membership re-check INSIDE the transaction: the question must belong to
    // the attempt's own assessment, so an answer can never cross boundaries.
    const question = await tx.jobAssessmentQuestion.findUnique({
      where: { id: questionId },
      select: { id: true, assessmentId: true },
    });
    if (!question || question.assessmentId !== attempt.assessmentId) {
      return { outcome: "QUESTION_NOT_FOUND" };
    }

    const saved = await tx.jobAssessmentAttemptAnswer.upsert({
      where: { attemptId_questionId: { attemptId, questionId } },
      create: { attemptId, questionId, answer, answeredAt: now },
      update: { answer, answeredAt: now },
    });

    // Deterministic lifecycle rule: the FIRST persisted answer moves the
    // attempt STARTED → IN_PROGRESS. Later saves only refresh activity.
    if (attempt.status === "STARTED") {
      await tx.jobAssessmentAttempt.updateMany({
        where: { id: attempt.id, status: "STARTED" },
        data: { status: "IN_PROGRESS", lastActivityAt: now },
      });
      // transitioned: TRUE only when THIS write performed the STARTED →
      // IN_PROGRESS flip, so the realtime event is emitted for a real
      // transition and repeated answer saves stay quiet (Phase 4).
      return {
        outcome: "SAVED",
        status: "IN_PROGRESS",
        answeredAt: saved.answeredAt,
        transitionedToInProgress: true,
      };
    }

    await tx.jobAssessmentAttempt.updateMany({
      where: { id: attempt.id, status: "IN_PROGRESS" },
      data: { lastActivityAt: now },
    });
    return {
      outcome: "SAVED",
      status: "IN_PROGRESS",
      answeredAt: saved.answeredAt,
      transitionedToInProgress: false,
    };
  });

// ---------------------------------------------------------------------------
// Phase 6 — ATOMIC submit + score: ONE authoritative server-side transaction.
//
// validate → load → calculate → persist → COMMIT, all against the same
// transaction, so submission and scoring can never be observed separately:
//   * re-reads the attempt and re-checks assessment membership, terminal
//     state (SUBMITTED/TIMED_UP/CHEATED short-circuit to the persisted row —
//     never recomputed, never rewritten) and the persisted deadline (lazy
//     TIMED_UP; the `transitioned` flag tells the caller whether IT performed
//     the close and should publish the realtime event);
//   * loads the persisted questions (points + correctAnswer key) and the
//     persisted answers, then scores them with the PURE deterministic scorer
//     (jobAssessment.scoring.js) — no client input participates;
//   * writes score/maxScore/scorePercentage + submittedAt + SUBMITTED in ONE
//     updateMany guarded on the ACTIVE statuses: of N concurrent submits
//     exactly ONE commits a score; every loser reads the winner's persisted
//     row and reports it unchanged (a repeat submit of an already-SUBMITTED
//     attempt short-circuits the same way — idempotent by construction).
// No external call (AI/Redis/HTTP) happens inside the transaction; the caller
// publishes the realtime event only after this function returns a committed
// transition.
// ---------------------------------------------------------------------------
const submitAndScoreTransactional = async ({ attemptId, assessmentId, now }) =>
  prisma.$transaction(async (tx) => {
    const attempt = await tx.jobAssessmentAttempt.findUnique({ where: { id: attemptId } });
    if (!attempt || attempt.assessmentId !== assessmentId) {
      return { outcome: "NO_ATTEMPT" };
    }

    // Terminal outcomes return the persisted row as-is: a score is never
    // (re)computed for SUBMITTED (idempotency), TIMED_UP or CHEATED.
    const terminalOutcomeFor = (row) => {
      if (!row) return { outcome: "NO_ATTEMPT" };
      if (row.status === "SUBMITTED") return { outcome: "ALREADY_SUBMITTED", attempt: row };
      if (row.status === "CHEATED") return { outcome: "CHEATED", attempt: row };
      return { outcome: "TIMED_UP", attempt: row, transitioned: false };
    };
    if (attempt.status !== "STARTED" && attempt.status !== "IN_PROGRESS") {
      return terminalOutcomeFor(attempt);
    }

    // Lazy deadline enforcement inside the same transaction: an expired
    // attempt closes as TIMED_UP and NO score fields are ever written for it.
    if (attempt.deadlineAt.getTime() <= now.getTime()) {
      const changed = await tx.jobAssessmentAttempt.updateMany({
        where: { id: attempt.id, status: { in: ACTIVE_STATUSES } },
        data: { status: "TIMED_UP", timedOutAt: now, lastActivityAt: now },
      });
      const row = await tx.jobAssessmentAttempt.findUnique({ where: { id: attempt.id } });
      if (changed.count > 0) {
        return { outcome: "TIMED_UP", attempt: row, transitioned: true };
      }
      return terminalOutcomeFor(row);
    }

    // Trusted scoring inputs ONLY: persisted question points/keys and the
    // persisted candidate answers — never anything the browser supplied.
    const questions = await tx.jobAssessmentQuestion.findMany({
      where: { assessmentId: attempt.assessmentId },
      orderBy: { sortOrder: "asc" },
      select: { id: true, sortOrder: true, questionType: true, points: true, correctAnswer: true },
    });
    const answers = await tx.jobAssessmentAttemptAnswer.findMany({
      where: { attemptId: attempt.id },
      select: { questionId: true, answer: true },
    });
    const scored = scoreAttempt({ questions, answers });

    const changed = await tx.jobAssessmentAttempt.updateMany({
      where: { id: attempt.id, status: { in: ACTIVE_STATUSES } },
      data: {
        status: "SUBMITTED",
        submittedAt: now,
        lastActivityAt: now,
        score: scored.score,
        maxScore: scored.maxScore,
        scorePercentage: scored.scorePercentage,
      },
    });
    if (changed.count === 0) {
      // Lost the CAS to a concurrent submit / integrity termination / lazy
      // timeout: NOTHING was written here — report the winner's persisted row.
      return terminalOutcomeFor(
        await tx.jobAssessmentAttempt.findUnique({ where: { id: attempt.id } })
      );
    }
    const submitted = await tx.jobAssessmentAttempt.findUnique({ where: { id: attempt.id } });
    return { outcome: "SUBMITTED", attempt: submitted, details: scored.details };
  });

module.exports = {
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  findAttemptByAssessmentAndEmail,
  findAttemptById,
  findAssessmentForAttempt,
  findQuestionById,
  createAttempt,
  transitionAttempt,
  markAttemptTimedUpIfExpired,
  // Phase 5 — the ONE authoritative CHEATED transition (atomic + idempotent).
  markAttemptCheated,
  markExpiredAttemptsTimedUpForJob,
  listExpiredActiveAttempts,
  saveAnswerTransactional,
  // Phase 6 — ONE transaction: validate + deterministic score + persist + SUBMITTED.
  submitAndScoreTransactional,
  findAnswersByAttempt,
  getAttemptWithAnswers,
  listAttemptsForJob,
};


