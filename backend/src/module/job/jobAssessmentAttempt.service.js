const { resolveSubscriptionAccess } = require("../subscription/subscription.service");
const jobRepository = require("./job.repository");
const attemptRepository = require("./jobAssessmentAttempt.repository");
const jobService = require("./job.service");
const { normalizeCandidateEmail } = require("./jobCandidate.classification");
const { MAX_ASSESSMENT_DURATION_SECONDS } = require("./job.validation");
const realtimePublisher = require("./jobAssessmentRealtime.publisher");
const jobCandidateReferenceService = require("./jobCandidateReference.service");

// Terminal attempt states that justify an automatic candidate analysis. Kept
// local (not imported) so the trigger's precondition is readable at its single
// call site and cannot drift from the switch it sits above.
const AUTOMATIC_ANALYSIS_STATUSES = new Set(["SUBMITTED", "TIMED_UP", "CHEATED"]);

// Fire-and-forget automatic candidate analysis, invoked from the one post-commit
// terminal funnel. Returning a promise nobody awaits is safe precisely because
// runAutomaticCandidateAnalysis is idempotent and never throws for a duplicate:
// if this process dies before the analysis is created, nothing is lost, because
// the next terminal touch of the attempt re-enters this same funnel. A thrown
// error is logged and swallowed so it can never reject the candidate's already
// committed submission.
const triggerAutomaticCandidateAnalysis = (attempt, assessmentStatus) => {
  if (!AUTOMATIC_ANALYSIS_STATUSES.has(assessmentStatus)) {
    return;
  }
  void Promise.resolve()
    .then(() =>
      jobCandidateReferenceService.runAutomaticCandidateAnalysis({
        id: attempt.id,
        jobId: attempt.jobId,
        assessmentId: attempt.assessmentId,
        email: attempt.email,
        status: assessmentStatus,
      })
    )
    .catch((error) => {
      console.error(
        `[job] automatic candidate analysis failed for attempt ${attempt?.id}: ${error?.message}`
      );
    });
};

// ---------------------------------------------------------------------------
// Phase 3 — the candidate's PERSISTENT assessment attempt.
//
// PostgreSQL is the ONLY authority for attempt existence, lifecycle status,
// start time, deadline, expiry and submission. The browser never supplies any
// of them: every request carries only the assessment's publicId and the
// candidate's invited email, and the backend re-derives the verified identity
// from the PERSISTED invitation (EMAIL_VERIFIED + unexpired + bound to this
// exact job and assessment) before doing anything.
//
// The server is the clock: startedAt is written once at Start, deadlineAt is
// computed server-side as startedAt + JobAssessment.durationSeconds, and expiry
// is enforced LAZILY against the persisted deadline on every read/write — there
// is no setTimeout/interval and no process memory anywhere in the flow, so a
// backend restart can neither lose nor reset a running attempt.
// ---------------------------------------------------------------------------

const ACTIVE_STATUSES = ["STARTED", "IN_PROGRESS"];

const httpError = (status, message) => {
  const error = new Error(message);
  error.status = status;
  return error;
};

// The generic denial mirrors job.service's candidate-flow denial exactly — a
// wrong email, an unknown link, an inactive assessment and an unverified
// invitation are deliberately indistinguishable.
const assessmentAccessDenied = () =>
  httpError(403, "This email cannot access this assessment right now.");

const ATTEMPT_MESSAGES = {
  NOT_FOUND: "No assessment attempt has been started for this email",
  ALREADY_SUBMITTED: "This attempt was already submitted — answers can no longer be saved",
  TIMED_UP: "This attempt has timed out — answers can no longer be saved",
  // Phase 5 — a deterministically terminated attempt is terminal like the rest.
  CHEATED: "This attempt was terminated for an integrity violation — answers can no longer be saved",
  DEADLINE_PASSED: "The assessment deadline has passed — this attempt is closed",
  QUESTION_NOT_IN_ATTEMPT: "This question is not part of this assessment",
  ANSWER_REQUIRED: "An answer payload is required",
  INVALID_CHOICE: "The selected option is not one of this question's options",
  NO_OPTIONS: "This question has no selectable options",
  TEXT_REQUIRED: "Answer text is required",
};

const MAX_TEXT_ANSWER_LENGTH = 8000;
const MAX_ANSWER_JSON_LENGTH = 12000;

// The ONE email normalization rule for this workflow — Phase 1's helper, reused
// verbatim (never a second implementation).
const normalizeAttemptEmail = normalizeCandidateEmail;

// The verified identity: resolved from the PERSISTED invitation context. The
// email is only a lookup key; the invitation row (EMAIL_VERIFIED, unexpired,
// bound to this exact job + assessment) is the authority, and the assessment
// must be FINALIZED and ACTIVATED (requireActiveInvitationContext enforces the
// finalized+activated read via findFinalizedAssessmentByPublicId).
const requireVerifiedAttemptContext = async (publicId, emailRaw) => {
  const { assessment, invitation, email } = await jobService.requireActiveInvitationContext(
    publicId,
    emailRaw
  );

  if (invitation.status !== "EMAIL_VERIFIED") {
    // Unverified email: the candidate has not proven mailbox possession yet.
    throw assessmentAccessDenied();
  }

  return { assessment, invitation, email };
};

// Options are stored as JSON by the AI generator; the candidate view and the
// answer validation must compare against the SAME normalized string list.
const normalizeOptions = (options) => {
  if (!Array.isArray(options)) return [];
  return options
    .map((option) => {
      if (typeof option === "string") return option;
      if (option && typeof option === "object") {
        if (typeof option.text === "string") return option.text;
        if (typeof option.value === "string") return option.value;
      }
      return null;
    })
    .filter((option) => typeof option === "string" && option.length > 0);
};

// Candidate-facing question view: content only. NEVER the guidance (recruiter/
// AI grading material) and NEVER correctAnswer (Phase 6's server-side scoring
// key) — no answer key of any kind exists anywhere in this candidate-facing
// schema.
const candidateQuestionView = (question) => ({
  id: question.id,
  section: question.section,
  sortOrder: question.sortOrder,
  prompt: question.prompt,
  questionType: question.questionType,
  points: question.points,
  difficulty: question.difficulty ?? null,
  options: normalizeOptions(question.options),
});

// The persisted duration is authoritative and was already bounded by the
// assessment-settings phase; the guard only catches impossible legacy data.
const resolveAttemptDuration = (assessment) => {
  const duration = assessment.durationSeconds;
  if (!Number.isInteger(duration) || duration <= 0 || duration > MAX_ASSESSMENT_DURATION_SECONDS) {
    throw httpError(500, "The assessment duration is not configured correctly");
  }
  return duration;
};

const remainingSecondsOf = (attempt, now) => {
  const remaining = Math.ceil((attempt.deadlineAt.getTime() - now.getTime()) / 1000);
  return Number.isFinite(remaining) ? Math.max(0, remaining) : 0;
};

// Lazy expiry: the FIRST touch after the persisted deadline persists TIMED_UP.
// Everything downstream (answers, submission) re-runs this, so no background
// timer and no process memory is ever involved.
const resolveAttempt = async (attempt) => {
  const now = new Date();
  if (attemptRepository.TERMINAL_STATUSES.includes(attempt.status)) {
    return attempt;
  }
  if (attempt.deadlineAt.getTime() <= now.getTime()) {
    await attemptRepository.markAttemptTimedUpIfExpired(attempt.id, now);
    return attemptRepository.findAttemptById(attempt.id);
  }
  return attempt;
};

// ---------------------------------------------------------------------------
// Phase 4 — realtime publication boundary for the attempt lifecycle.
//
// RULES (non-negotiable):
//   * an event is published ONLY after the PostgreSQL statement that produced
//     the transition has committed — never before, never from inside a
//     transaction, so no event can announce a state that later rolls back;
//   * publication is FIRE-AND-FORGET: Redis is a best-effort transport, so a
//     Redis outage can neither fail nor delay the candidate's request and can
//     never roll back committed business state;
//   * the candidate identity carried by the event is the PERSISTED normalized
//     attempt email (the same value the recruiter's candidate row shows).
//     candidateId stays null here because the candidate-facing flow knows the
//     verified email, not the Excel row index; the recruiter UI reconciles by
//     email + authoritative refetch.
// ---------------------------------------------------------------------------
const publishAttemptStatusEvent = (attempt, assessmentStatus) => {
  if (!attempt) return;

  // The automatic candidate-analysis trigger, placed on the ONE post-commit
  // funnel every terminal transition already funnels through. Deliberately
  // fire-and-forget with the same contract as the realtime publish above: the
  // attempt and its authoritative score are already committed, so analysis
  // creation can neither fail nor delay the candidate's submission, and a
  // failure here can never roll back committed business state. Never invoked for
  // STARTED/IN_PROGRESS, so analysis is never created before the assessment is
  // authoritative.
  triggerAutomaticCandidateAnalysis(attempt, assessmentStatus);

  switch (assessmentStatus) {
    case "STARTED":
    case "IN_PROGRESS":
      realtimePublisher.publishAttemptStartedEvent({
        jobId: attempt.jobId,
        assessmentId: attempt.assessmentId,
        candidateId: null,
        candidateEmail: attempt.email,
        assessmentStatus,
      });
      break;
    case "SUBMITTED":
      realtimePublisher.publishAttemptSubmittedEvent({
        jobId: attempt.jobId,
        assessmentId: attempt.assessmentId,
        candidateId: null,
        candidateEmail: attempt.email,
      });
      break;
    case "TIMED_UP":
      realtimePublisher.publishAttemptTimedUpEvent({
        jobId: attempt.jobId,
        assessmentId: attempt.assessmentId,
        candidateId: null,
        candidateEmail: attempt.email,
      });
      break;
    case "CHEATED":
      // Phase 5 — the deterministic integrity decision committed. The
      // publisher carries only the safe lifecycle fields (no integrity
      // metadata, no answers, no reasons).
      realtimePublisher.publishAttemptCheatedEvent({
        jobId: attempt.jobId,
        assessmentId: attempt.assessmentId,
        attemptId: attempt.id,
        candidateId: null,
        candidateEmail: attempt.email,
      });
      break;
    default:
      // Unknown status: publish nothing rather than a wrong status.
      break;
  }
};

// Publishes TIMED_UP only when THIS call performed the transition (the status
// read before the lazy expiry differs from the persisted status after it).
const publishTimedUpIfTransitioned = (beforeStatus, afterAttempt) => {
  if (afterAttempt?.status === "TIMED_UP" && beforeStatus !== "TIMED_UP") {
    publishAttemptStatusEvent(afterAttempt, "TIMED_UP");
  }
};

const attemptView = (assessment, attempt, now, { withAnswers = false, answers = null, flags = {} } = {}) => {
  const isActive = attempt.status === "STARTED" || attempt.status === "IN_PROGRESS";
  return {
    attempt: {
      id: attempt.id,
      status: attempt.status,
      startedAt: attempt.startedAt,
      deadlineAt: attempt.deadlineAt,
      submittedAt: attempt.submittedAt ?? null,
      timedOutAt: attempt.timedOutAt ?? null,
      // Phase 5 — the persisted deterministic termination facts. Null unless the
      // attempt was actually terminated for an integrity violation.
      cheatedAt: attempt.cheatedAt ?? null,
      cheatReason: attempt.cheatReason ?? null,
      durationSeconds: assessment.durationSeconds,
      serverNow: now,
      remainingSeconds: isActive ? remainingSecondsOf(attempt, now) : 0,
    },
    assessment: {
      publicId: assessment.publicId,
      title: assessment.title,
      description: assessment.description ?? null,
      durationSeconds: assessment.durationSeconds,
      questionCount: (assessment.questions ?? []).length,
    },
    // Questions + persisted answers only while the attempt is ACTIVE (a
    // submitted/timed-out attempt is a terminal confirmation, not a worksheet).
    questions: isActive ? (assessment.questions ?? []).map(candidateQuestionView) : undefined,
    answers: isActive && withAnswers ? answers : undefined,
    ...flags,
  };
};

// ---------------------------------------------------------------------------
// START — begin (or resume) the candidate's ONE persistent attempt.
//
// The body carries only the assessment publicId and the invited email; any
// client-supplied startedAt/deadlineAt/durationSeconds would be stripped by the
// validation schema and is never read here. startedAt is written ONCE from the
// server clock and the deadline is derived from the PERSISTED assessment
// duration. The (assessmentId, email) unique constraint makes a concurrent
// double-Start persist exactly one row: the loser of the race re-reads the
// winner and resumes it.
// ---------------------------------------------------------------------------
const startAssessmentAttempt = async (publicId, emailRaw) => {
  const { assessment, invitation, email } = await requireVerifiedAttemptContext(
    publicId,
    emailRaw
  );
  const now = new Date();

  const existing = await attemptRepository.findAttemptByAssessmentAndEmail(assessment.id, email);
  if (existing) {
    // Idempotent resume — never a second attempt, never a timer reset.
    const attempt = await resolveAttempt(existing);
    // A resume that lazily closed an expired attempt IS a committed transition.
    publishTimedUpIfTransitioned(existing.status, attempt);
    return activeViewOrTerminal(assessment, attempt, now, { resumed: true });
  }

  const durationSeconds = resolveAttemptDuration(assessment);
  const startedAt = now;
  const deadlineAt = new Date(startedAt.getTime() + durationSeconds * 1000);

  try {
    const attempt = await attemptRepository.createAttempt({
      jobId: assessment.jobId,
      assessmentId: assessment.id,
      invitationId: invitation.id,
      email,
      startedAt,
      deadlineAt,
    });
    // Committed (STARTED persisted) → the recruiter learns the attempt began.
    publishAttemptStatusEvent(attempt, "STARTED");
    const answers = await attemptRepository.findAnswersByAttempt(attempt.id);
    return attemptView(assessment, attempt, now, { withAnswers: true, answers, flags: { created: true } });
  } catch (error) {
    // Concurrent Start lost the unique race: the winner's attempt IS the
    // candidate's attempt — resume it instead of surfacing an error.
    if (error?.code === "P2002") {
      const winner = await attemptRepository.findAttemptByAssessmentAndEmail(assessment.id, email);
      if (winner) {
        const attempt = await resolveAttempt(winner);
        publishTimedUpIfTransitioned(winner.status, attempt);
        return activeViewOrTerminalSync(assessment, attempt, new Date(), { resumed: true });
      }
    }
    throw error;
  }
};

// ---------------------------------------------------------------------------
// RESUME / READ — the browser-refresh path. Returns the same persisted attempt
// with its persisted deadline and saved answers; lazily persists TIMED_UP when
// the deadline has passed.
// ---------------------------------------------------------------------------
const getAssessmentAttempt = async (publicId, emailRaw) => {
  const { assessment, email } = await requireVerifiedAttemptContext(publicId, emailRaw);

  const existing = await attemptRepository.findAttemptByAssessmentAndEmail(assessment.id, email);
  if (!existing) {
    throw httpError(404, ATTEMPT_MESSAGES.NOT_FOUND);
  }

  const attempt = await resolveAttempt(existing);
  // Refresh-driven lazy expiry is a committed state change: report it.
  publishTimedUpIfTransitioned(existing.status, attempt);
  return activeViewOrTerminal(assessment, attempt, new Date());
};

// ---------------------------------------------------------------------------
// ANSWER — persist or update ONE answer while the attempt is active.
//
// The transaction re-verifies: the attempt is active, the deadline has not
// passed, and the question belongs to the attempt's own assessment. An answer
// can therefore never cross assessment boundaries, and the first persisted
// answer deterministically moves the attempt STARTED → IN_PROGRESS.
// ---------------------------------------------------------------------------
const saveAttemptAnswer = async (publicId, emailRaw, questionIdRaw, answerRaw) => {
  const { assessment, email } = await requireVerifiedAttemptContext(publicId, emailRaw);
  const questionId = String(questionIdRaw ?? "").trim();
  if (!questionId) {
    throw httpError(400, "A question id is required");
  }
  const now = new Date();

  const attempt = await attemptRepository.findAttemptByAssessmentAndEmail(assessment.id, email);
  if (!attempt) {
    throw httpError(404, ATTEMPT_MESSAGES.NOT_FOUND);
  }
  if (attempt.status === "SUBMITTED") {
    throw httpError(409, ATTEMPT_MESSAGES.ALREADY_SUBMITTED);
  }
  if (attempt.status === "TIMED_UP") {
    throw httpError(409, ATTEMPT_MESSAGES.TIMED_UP);
  }
  if (attempt.status === "CHEATED") {
    // Phase 5 — a deterministically terminated attempt accepts no answers. The
    // guard sits BEFORE the deadline check so a CHEATED attempt can never be
    // swept into TIMED_UP by a later request.
    throw httpError(409, ATTEMPT_MESSAGES.CHEATED);
  }
  if (attempt.deadlineAt.getTime() <= now.getTime()) {
    const changed = await attemptRepository.markAttemptTimedUpIfExpired(attempt.id, now);
    // The lazy expiry committed → the recruiter learns the attempt closed.
    if (changed > 0) {
      publishAttemptStatusEvent({ ...attempt, status: "TIMED_UP" }, "TIMED_UP");
    }
    throw httpError(409, ATTEMPT_MESSAGES.DEADLINE_PASSED);
  }

  const question = await attemptRepository.findQuestionById(questionId);
  if (!question || question.assessmentId !== assessment.id) {
    // Unknown id OR a question from another assessment — indistinguishable
    // 404, no membership leak.
    throw httpError(404, ATTEMPT_MESSAGES.QUESTION_NOT_IN_ATTEMPT);
  }

  const answer = validateAnswerPayload(question.questionType, question.options, answerRaw);

  const result = await attemptRepository.saveAnswerTransactional({
    attemptId: attempt.id,
    questionId,
    answer,
    now,
  });

  switch (result.outcome) {
    case "SAVED": {
      // Only the FIRST persisted answer is a transition (STARTED →
      // IN_PROGRESS); later saves change no persisted status and therefore
      // publish nothing (no event storms, no invented states).
      if (result.transitionedToInProgress) {
        publishAttemptStatusEvent({ ...attempt, status: "IN_PROGRESS" }, "IN_PROGRESS");
      }
      return {
        saved: true,
        questionId,
        attemptStatus: result.status,
        answeredAt: result.answeredAt,
        serverNow: new Date(),
        remainingSeconds: remainingSecondsOf(attempt, new Date()),
      };
    }
    case "TIMED_UP":
      // The transaction closed the attempt as TIMED_UP (committed).
      publishAttemptStatusEvent({ ...attempt, status: "TIMED_UP" }, "TIMED_UP");
      throw httpError(409, ATTEMPT_MESSAGES.DEADLINE_PASSED);
    case "TERMINAL": {
      // Terminal is terminal: report the PERSISTED status. Phase 5 added
      // CHEATED to the terminal set, so this can no longer assume that every
      // terminal attempt was a submission.
      const terminalMessage =
        result.status === "TIMED_UP"
          ? ATTEMPT_MESSAGES.TIMED_UP
          : result.status === "CHEATED"
            ? ATTEMPT_MESSAGES.CHEATED
            : ATTEMPT_MESSAGES.ALREADY_SUBMITTED;
      throw httpError(409, terminalMessage);
    }
    case "QUESTION_NOT_FOUND":
    case "NO_ATTEMPT":
    default:
      throw httpError(404, ATTEMPT_MESSAGES.QUESTION_NOT_IN_ATTEMPT);
  }
};

// ---------------------------------------------------------------------------
// SUBMIT — the candidate's final act. Idempotent and deadline-guarded: an
// attempt whose deadline has passed is persisted TIMED_UP and is NEVER marked
// SUBMITTED, while an already-SUBMITTED attempt simply returns its persisted
// terminal state.
//
// Phase 6 — submission AND scoring are ONE authoritative server-side
// transaction (submitAndScoreTransactional): the attempt is re-validated, the
// persisted questions + persisted answers are loaded, the score is computed by
// the pure deterministic scorer, and score/maxScore/scorePercentage +
// submittedAt + SUBMITTED commit together — or the CAS is lost to a concurrent
// transition and this request simply reports the winner's persisted state.
// Nothing external (no AI, no Redis, no HTTP) runs inside the transaction; the
// realtime publish happens only after it commits, exactly like every other
// Phase 4 transition.
// ---------------------------------------------------------------------------
const submitAssessmentAttempt = async (publicId, emailRaw) => {
  const { assessment, email } = await requireVerifiedAttemptContext(publicId, emailRaw);
  const now = new Date();

  const attempt = await attemptRepository.findAttemptByAssessmentAndEmail(assessment.id, email);
  if (!attempt) {
    throw httpError(404, ATTEMPT_MESSAGES.NOT_FOUND);
  }

  if (attempt.status === "SUBMITTED") {
    return activeViewOrTerminalSync(assessment, attempt, now, { alreadySubmitted: true });
  }
  if (attempt.status === "TIMED_UP") {
    return activeViewOrTerminalSync(assessment, attempt, now, { timedOut: true });
  }
  if (attempt.status === "CHEATED") {
    // Phase 5 — a deterministically terminated attempt can never be submitted.
    // Its persisted terminal state is returned unchanged (no transition, no
    // event, no way for a client to launder a CHEATED attempt into SUBMITTED).
    return activeViewOrTerminalSync(assessment, attempt, now, { cheated: true });
  }
  if (attempt.deadlineAt.getTime() <= now.getTime()) {
    const changed = await attemptRepository.markAttemptTimedUpIfExpired(attempt.id, now);
    const closed = await attemptRepository.findAttemptById(attempt.id);
    if (changed > 0) {
      publishAttemptStatusEvent(closed ?? attempt, "TIMED_UP");
    }
    return activeViewOrTerminalSync(assessment, closed, now, { timedOut: true });
  }

  // Phase 6 — ONE transaction: re-validate + load persisted questions/answers
  // + deterministic score + persist the score triple + SUBMITTED, atomically.
  const result = await attemptRepository.submitAndScoreTransactional({
    attemptId: attempt.id,
    assessmentId: assessment.id,
    now,
  });

  switch (result.outcome) {
    case "SUBMITTED":
      // Committed (SUBMITTED + score persisted) → the recruiter learns it is done.
      publishAttemptStatusEvent(result.attempt, "SUBMITTED");
      return activeViewOrTerminalSync(assessment, result.attempt, now, { submitted: true });
    case "TIMED_UP":
      // Only the request whose own transaction performed the lazy close
      // publishes; a race loser reports the winner's persisted state.
      if (result.transitioned) {
        publishAttemptStatusEvent(result.attempt, "TIMED_UP");
      }
      return activeViewOrTerminalSync(assessment, result.attempt, now, { timedOut: true });
    case "ALREADY_SUBMITTED":
      // Lost the CAS to a concurrent submit — the winner published its event
      // and its persisted score is returned unchanged (never recomputed).
      return activeViewOrTerminalSync(assessment, result.attempt, now, { alreadySubmitted: true });
    case "CHEATED":
      // Phase 5 — an integrity termination won the race: terminal, unchanged.
      return activeViewOrTerminalSync(assessment, result.attempt, now, { cheated: true });
    case "NO_ATTEMPT":
    default:
      throw httpError(404, ATTEMPT_MESSAGES.NOT_FOUND);
  }
};

// ---------------------------------------------------------------------------
// RECRUITER STATUS — the persisted attempt lifecycle per candidate email.
// Ownership is enforced exactly like every other job read. Expired active
// attempts are corrected to TIMED_UP before the statuses are read, and the
// response carries STATUS + the PERSISTED Phase 6 assessment score only (no
// answers, no question content, no answer keys): the score fields are null
// until a submission computed them server-side.
// ---------------------------------------------------------------------------
const listJobCandidateAttempts = async (user, jobId) => {
  const access = await resolveSubscriptionAccess(user);
  jobService.assertJobScope(access);
  const job = await jobService.requireOwnedJob(user, access, jobId);
  // PHASE 3 — per-candidate attempt rows (status + the persisted score) are
  // candidate-level. Gated BEFORE the sweep below, so a denied ORG_ADMIN request
  // neither reads attempts nor triggers the TIMED_UP side effects of this read.
  const { assertCandidateLevelAccess } = require("../job/jobCandidatePrivacy");
  assertCandidateLevelAccess(user, job);

  const now = new Date();
  // Rows that this read is about to close as TIMED_UP (read BEFORE the sweep so
  // the realtime events describe exactly the committed transitions below).
  const expiring = await attemptRepository.listExpiredActiveAttempts(job.id, now);
  const closedCount = await attemptRepository.markExpiredAttemptsTimedUpForJob(job.id, now);
  if (closedCount > 0) {
    for (const attempt of expiring) {
      publishAttemptStatusEvent(attempt, "TIMED_UP");
    }
  }
  const attempts = await attemptRepository.listAttemptsForJob(job.id);

  return {
    jobId: job.id,
    attempts: attempts.map((attempt) => ({
      attemptId: attempt.id,
      email: attempt.email,
      status: attempt.status,
      startedAt: attempt.startedAt,
      deadlineAt: attempt.deadlineAt,
      submittedAt: attempt.submittedAt,
      timedOutAt: attempt.timedOutAt,
      lastActivityAt: attempt.lastActivityAt,
      // Phase 5 — the persisted deterministic termination facts, surfaced so
      // the recruiter sees the concise reason behind a CHEATED status.
      cheatedAt: attempt.cheatedAt ?? null,
      cheatReason: attempt.cheatReason ?? null,
      // Phase 6 — the SERVER-calculated assessment result, persisted atomically
      // with the SUBMITTED transition. Null before submission (and for
      // TIMED_UP/CHEATED): never computed here, never client-supplied, and
      // deliberately separate from the platform's existing verified skill
      // score. scorePercentage (DECIMAL) is surfaced as a plain number.
      assessmentScore: attempt.score ?? null,
      assessmentMaxScore: attempt.maxScore ?? null,
      assessmentPercentage:
        attempt.scorePercentage !== null && attempt.scorePercentage !== undefined
          ? Number(attempt.scorePercentage)
          : null,
    })),
  };
};

// ---------------------------------------------------------------------------
// Answer payload validation — per EXISTING question type, deterministic and
// strictly bounded. No scoring, no answer keys: this only decides whether the
// payload is a well-formed answer for THIS question.
// ---------------------------------------------------------------------------
const validateAnswerPayload = (questionType, options, answerRaw) => {
  if (!answerRaw || typeof answerRaw !== "object" || Array.isArray(answerRaw)) {
    throw httpError(400, ATTEMPT_MESSAGES.ANSWER_REQUIRED);
  }

  const optionList = normalizeOptions(options);
  let normalized;

  switch (questionType) {
    case "SINGLE_CHOICE": {
      if (optionList.length === 0) {
        throw httpError(400, ATTEMPT_MESSAGES.NO_OPTIONS);
      }
      const choice = answerRaw.choice;
      if (typeof choice !== "string" || choice.trim().length === 0) {
        throw httpError(400, "Select one option");
      }
      if (!optionList.includes(choice)) {
        throw httpError(400, ATTEMPT_MESSAGES.INVALID_CHOICE);
      }
      normalized = { choice };
      break;
    }
    case "MULTIPLE_CHOICE": {
      if (optionList.length === 0) {
        throw httpError(400, ATTEMPT_MESSAGES.NO_OPTIONS);
      }
      const choices = answerRaw.choices;
      if (!Array.isArray(choices) || choices.length === 0) {
        throw httpError(400, "Select at least one option");
      }
      if (choices.length > optionList.length) {
        throw httpError(400, ATTEMPT_MESSAGES.INVALID_CHOICE);
      }
      for (const choice of choices) {
        if (typeof choice !== "string" || !optionList.includes(choice)) {
          throw httpError(400, ATTEMPT_MESSAGES.INVALID_CHOICE);
        }
      }
      // Repeated saves converge on the same normalized row content.
      normalized = { choices: [...new Set(choices)] };
      break;
    }
    case "SCENARIO":
    case "PROBLEM_SOLVING":
    case "SHORT_ANSWER":
    case "CODING":
    case "LIVE_CODING":
    case "PRACTICAL": {
      const text = answerRaw.text;
      if (typeof text !== "string" || text.trim().length === 0) {
        throw httpError(400, ATTEMPT_MESSAGES.TEXT_REQUIRED);
      }
      if (text.length > MAX_TEXT_ANSWER_LENGTH) {
        throw httpError(
          400,
          `Answer text must be at most ${MAX_TEXT_ANSWER_LENGTH} characters`
        );
      }
      normalized = { text };
      break;
    }
    default:
      // Unknown type: the persisted question type is part of the frozen
      // assessment content, so this is a data-integrity failure.
      throw httpError(500, "This question has an unsupported type");
  }

  if (JSON.stringify(normalized).length > MAX_ANSWER_JSON_LENGTH) {
    throw httpError(400, "The answer payload is too large");
  }
  return normalized;
};

// A terminal attempt returns its persisted confirmation; an active attempt
// returns the full worksheet (questions + saved answers).
const activeViewOrTerminal = async (assessment, attempt, now, flags = {}) => {
  const resolved = await resolveAttempt(attempt);
  return activeViewOrTerminalSync(assessment, resolved, now, flags);
};

const activeViewOrTerminalSync = (assessment, attempt, now, flags = {}) => {
  const isActive = attempt.status === "STARTED" || attempt.status === "IN_PROGRESS";
  if (!isActive) {
    return attemptView(assessment, attempt, now, { flags });
  }

  return attemptRepository.getAttemptWithAnswers(attempt.id).then((withAnswers) =>
    attemptView(assessment, withAnswers ?? attempt, now, {
      withAnswers: true,
      answers: (withAnswers?.answers ?? []).map((answer) => ({
        questionId: answer.questionId,
        answer: answer.answer,
        answeredAt: answer.answeredAt,
      })),
      flags,
    })
  );
};

// ---------------------------------------------------------------------------
// Phase 5 — the shared attempt lookup used by the integrity pipeline.
//
// This reuses the Phase 3 repository read verbatim (one attempt per assessment
// + normalized email, enforced structurally by @@unique([assessmentId, email])).
// It is exposed so the integrity controller resolves the SAME persisted attempt
// the attempt flow uses, rather than introducing a second lookup rule.
// ---------------------------------------------------------------------------
const findAttemptByAssessmentAndEmail = async (assessmentId, email) =>
  attemptRepository.findAttemptByAssessmentAndEmail(assessmentId, email);

module.exports = {
  startAssessmentAttempt,
  getAssessmentAttempt,
  saveAttemptAnswer,
  submitAssessmentAttempt,
  listJobCandidateAttempts,
  // Phase 5 — integrity/cheating detection.
  findAttemptByAssessmentAndEmail,
};






