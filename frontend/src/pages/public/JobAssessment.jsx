import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import Alert from "../../components/ui/Alert";
import Button from "../../components/ui/Button";
import Spinner from "../../components/ui/Spinner";
import { extractApiErrorMessage as extractMessage } from "../../utils/apiError";
import {
  getPublicJobAssessment,
  requestAssessmentEmailVerification,
  confirmAssessmentEmailVerification,
  startJobAssessmentAttempt,
  saveJobAssessmentAttemptAnswer,
  submitJobAssessmentAttempt,
  reportJobAssessmentIntegrityEvent,
} from "../../services/jobService";

const QUESTION_TYPE_LABELS = {
  SINGLE_CHOICE: "Single choice",
  MULTIPLE_CHOICE: "Multiple choice",
  SCENARIO: "Scenario",
  PROBLEM_SOLVING: "Problem solving",
  SHORT_ANSWER: "Short answer",
};

const formatDuration = (seconds) => {
  const total = Number(seconds);
  if (!Number.isInteger(total) || total <= 0) return "not set";
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
};

const formatClock = (totalSeconds) => {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};

// The candidate-visible availability deadline, formatted for a human.
//
// Only the ASSESSMENT's own expiry is shown. The invitation-link deadline is an
// internal detail and is deliberately not displayed: the link simply stops
// working when it is reached, which is explained in the invitation email.
const formatAvailability = (isoString) => {
  if (!isoString) return null;
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

// A CHEATED/SUBMITTED/TIMED_UP attempt is terminal: no restart, no answers, no visibility reporting.
const attemptIsTerminal = (status) =>
  status === "SUBMITTED" || status === "TIMED_UP" || status === "CHEATED";

// Candidate-facing JOB assessment landing page.
//
// The candidate arrives here from the ASSESSMENT INVITATION EMAIL (the link the
// recruiter's "Invite Selected" sent) or from the in-app notification, which
// points at exactly this same link.
//
// Lifecycle implemented on THIS page (backend-authoritative at every step):
//   1. load the ACTIVATED assessment via the public link (404 otherwise)
//   2. "Enter your invited email" → POST verify-email. The BACKEND authorizes
//      that address against the PERSISTED invitation for THIS job + assessment,
//      and only if that succeeds does it generate a code and email it. The typed
//      address is never trusted on its own, and a refused address gets no code.
//   3. enter the emailed code → POST confirm-verification → the invitation
//      flips to EMAIL_VERIFIED server-side and the candidate is authorized
//
// Note the two emails are distinct lifecycle events: the invitation email (the
// link) was already sent by the recruiter; the verification code email is sent
// ONLY in step 2, after the authorization check passes.
//
// There is deliberately NO attempt, NO score and NO assessment timer here:
// the assessment timer (durationSeconds) starts only in the next stage, when
// the real attempt system exists. The ONLY countdown shown is the invitation
// window (expiresAt) — display only; the backend decides authorization.
//
// This page is separate from the EMPLOYEE skill-verification AssessmentTake
// flow (different workflow, different backend, different authorization).
const JobAssessment = () => {
  const { publicId } = useParams();
  const [assessment, setAssessment] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  // Verification stages: enter-email → check-code → verified.
  const [stage, setStage] = useState("enter-email");
  const [emailInput, setEmailInput] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const [deadline, setDeadline] = useState(null);
  const [stageNotice, setStageNotice] = useState(null);
  const [stageBusy, setStageBusy] = useState(false);
  // Display-only clock for the invitation window. Ticking does not gate
  // anything — authorization is decided by the backend on every request.
  const [nowTick, setNowTick] = useState(() => Date.now());

  // --- Phase 3 attempt lifecycle (server-authoritative at every step) --------
  // The attempt state mirrors ONLY what the server returns. There is no local
  // timer authority: durationSeconds/deadline come from the persisted attempt,
  // and the browser never sends timer values anywhere.
  const [attempt, setAttempt] = useState(null); // { attemptId, status, deadlineAt, ... }
  const [attemptError, setAttemptError] = useState(null);
  const [attemptBusy, setAttemptBusy] = useState(false);
  const [answers, setAnswers] = useState({});
  const [answerSavedAt, setAnswerSavedAt] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  // --- Phase 5 integrity signal reporting ------------------------------------
  // One visibilitychange listener fires one report per REAL transition (the
  // last-known state is held in a ref, so a duplicate visibilitychange event
  // with an unchanged state is ignored). A lost/failed report is swallowed:
  // the browser is a signal source, not the authority, and a network hiccup
  // must never break the assessment.
  const lastVisibilityState = useRef(null);
  const activeEmailRef = useRef(null);

  const reportVisibility = useCallback(
    async (visibilityState) => {
      // The email is the correlation context the signal carries — NOT proof of
      // identity. Every request is still authorized server-side (invitation,
      // normalized email, attempt ownership, publicId, attemptId, terminal state).
      const email = activeEmailRef.current ?? emailInput.trim().toLowerCase();
      if (!attempt?.attemptId || !email || attemptIsTerminal(attempt?.status)) return;
      // Only the two specified transitions exist: hidden → VISIBILITY_HIDDEN,
      // visible → VISIBILITY_VISIBLE. Any other document state is not a signal.
      const eventType =
        visibilityState === "hidden"
          ? "VISIBILITY_HIDDEN"
          : visibilityState === "visible"
            ? "VISIBILITY_VISIBLE"
            : null;
      if (!eventType) return;
      try {
        const response = await reportJobAssessmentIntegrityEvent(
          publicId,
          attempt.attemptId,
          email,
          eventType
        );
        // The server decides CHEATED — the browser never does. If the persisted
        // transition happened, adopt the authoritative terminal state.
        if (response?.isCheated) {
          setAttempt((prev) =>
            prev && prev.attemptId === attempt.attemptId
              ? { ...prev, status: "CHEATED", cheatReason: response.reason ?? prev.cheatReason }
              : prev
          );
        }
      } catch {
        // Deliberate: an unreportable signal is not a candidate error. The
        // server-side count is authoritative; a lost signal simply is not
        // counted. Nothing here pauses, resets or extends the timer.
      }
    },
    [publicId, attempt, emailInput]
  );

  // The normalized email is the correlation context the visibility signal
  // carries, so it must be present for EVERY verified stage entry — including
  // the already-verified path and an attempt restored after a refresh. It is
  // re-derived from the verified stage here so a restored context is never
  // silently dropped. The backend remains the only authority.
  useEffect(() => {
    if (stage !== "verified") return;
    const normalized = emailInput.trim().toLowerCase();
    if (normalized) activeEmailRef.current = normalized;
  }, [stage, emailInput]);

  useEffect(() => {
    // Reporting runs ONLY while a verified candidate holds a non-terminal
    // attempt. SUBMITTED / TIMED_UP / CHEATED (or a completed submit) tear the
    // listener down, so a terminal attempt can never report another signal.
    if (
      stage !== "verified" ||
      !attempt?.attemptId ||
      attemptIsTerminal(attempt?.status) ||
      submitted
    ) {
      return undefined;
    }
    const onVisibilityChange = () => {
      const state = document.visibilityState;
      if (state === lastVisibilityState.current) return; // duplicate transition
      lastVisibilityState.current = state;
      if (state === "hidden" || state === "visible") void reportVisibility(state);
    };
    lastVisibilityState.current = document.visibilityState;
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [stage, attempt?.attemptId, attempt?.status, submitted, reportVisibility]);
  // Stage 2 deliberately has NO attempt timer and NO start-assessment state.
  // The assessment timer (durationSeconds) starts only when the attempt system
  // is implemented in a later stage. There is no "started" flag, no
  // timeIsUp, no remainingSeconds, and no startAssessment handler here.

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await getPublicJobAssessment(publicId);
        if (!cancelled) {
          setAssessment(data?.data ?? null);
        }
      } catch (caught) {
        if (!cancelled) {
          setError(
            caught?.response?.status === 404
              ? "This assessment link is not available. It may not be active yet."
              : "The assessment could not be loaded. Please check the link and try again."
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [publicId]);

  useEffect(() => {
    const timer = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const submitEmail = async (event) => {
    event.preventDefault();
    setStageNotice(null);
    setStageBusy(true);
    try {
      const response = await requestAssessmentEmailVerification(publicId, emailInput);
      const data = response?.data ?? {};
      setDeadline(data.expiresAt ?? null);
      if (data.alreadyVerified || data.status === "EMAIL_VERIFIED") {
        setStage("verified");
        activeEmailRef.current = emailInput.trim().toLowerCase();
      } else {
        setStage("check-code");
        setStageNotice({
          variant: "success",
          message: `A verification code was sent to ${emailInput.trim()}. It is valid for 15 minutes.`,
        });
      }
    } catch (caught) {
      setStageNotice({
        variant: "error",
        message:
          caught?.response?.status === 403
            ? "This email cannot access this assessment right now. Check the address or ask your recruiter for a valid invitation."
            : extractMessage(caught),
      });
    } finally {
      setStageBusy(false);
    }
  };

  const submitToken = async (event) => {
    event.preventDefault();
    setStageNotice(null);
    setStageBusy(true);
    try {
      const response = await confirmAssessmentEmailVerification(publicId, emailInput, tokenInput);
      setDeadline(response?.data?.expiresAt ?? deadline);
      setStage("verified");
      setStageNotice(null);
      activeEmailRef.current = emailInput.trim().toLowerCase();
    } catch (caught) {
      setStageNotice({
        variant: "error",
        message:
          caught?.response?.status === 403
            ? "That code is not valid for this email and assessment. Request a new code and try again."
            : extractMessage(caught),
      });
    } finally {
      setStageBusy(false);
    }
  };

  // --- Phase 3 attempt actions -------------------------------------------------
  // The attempt identity, status and deadline are ALWAYS the server's response.
  // A CHEATED/SUBMITTED/TIMED_UP attempt is terminal: no restart, no answers.

  const handleStartAttempt = async () => {
    setAttemptError(null);
    setAttemptBusy(true);
    try {
      const response = await startJobAssessmentAttempt(publicId, emailInput.trim());
      const data = response?.data ?? null;
      setAttempt(data);
      activeEmailRef.current = emailInput.trim().toLowerCase();
      if (data?.deadlineAt) setDeadline(data.deadlineAt);
      if (data?.status === "SUBMITTED") setSubmitted(true);
    } catch (caught) {
      setAttemptError(extractMessage(caught));
    } finally {
      setAttemptBusy(false);
    }
  };

  const handleAnswerChange = (questionId, value) => {
    if (!attempt || attemptIsTerminal(attempt.status)) return;
    setAnswers((prev) => ({ ...prev, [questionId]: value }));
  };

  const handleSaveAnswer = async (question) => {
    if (!attempt || attemptIsTerminal(attempt.status)) return;
    const value = answers[question.id];
    if (value === undefined || value === null || value === "") return;
    setAttemptBusy(true);
    try {
      await saveJobAssessmentAttemptAnswer(
        publicId,
        attempt.attemptId,
        emailInput.trim(),
        question.id,
        value
      );
      setAnswerSavedAt((prev) => ({ ...prev, [question.id]: Date.now() }));
    } catch (caught) {
      setAttemptError(extractMessage(caught));
    } finally {
      setAttemptBusy(false);
    }
  };

  const handleSubmitAttempt = async () => {
    if (!attempt || attemptIsTerminal(attempt.status) || submitting) return;
    setSubmitting(true);
    setAttemptError(null);
    try {
      const response = await submitJobAssessmentAttempt(
        publicId,
        attempt.attemptId,
        emailInput.trim()
      );
      const data = response?.data ?? null;
      setAttempt(data?.attempt ?? { ...attempt, status: data?.status ?? "SUBMITTED" });
      setSubmitted(true);
    } catch (caught) {
      setAttemptError(extractMessage(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const bySection = useMemo(() => {
    const grouped = new Map();
    for (const question of assessment?.questions ?? []) {
      if (!grouped.has(question.section)) grouped.set(question.section, []);
      grouped.get(question.section).push(question);
    }
    return [...grouped.entries()];
  }, [assessment]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  if (error || !assessment) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center px-4">
        <div className="w-full max-w-xl space-y-4 text-center">
          <Alert variant="error">{error ?? "This assessment link is not available."}</Alert>
          <Button as="link" to="/" variant="outline">
            Back to Home
          </Button>
        </div>
      </div>
    );
  }

  // The candidate-visible availability deadline, rendered only when the server
  // actually holds one. Absent means the job has no configured window.
  const availabilityLabel = formatAvailability(assessment.expiresAt);

  const attemptStatusLabels = {
    STARTED: "In progress",
    IN_PROGRESS: "In progress",
    SUBMITTED: "Submitted",
    TIMED_UP: "Time is up",
    CHEATED: "Closed — integrity rule reached",
  };
  const attemptCheatReasonLabels = {
    EXCESSIVE_VISIBILITY_CHANGES: "Too many tab switches during this attempt.",
    TIMER_INTEGRITY_VIOLATION: "The attempt timer could not be kept consistent.",
    DUPLICATE_ATTEMPT: "This assessment was already started for this email.",
    PROHIBITED_CLIENT_ACTION: "A prohibited action was attempted.",
    SERVER_INTEGRITY_VIOLATION: "This attempt could not be kept valid.",
  };
  // Terminal = the SERVER's persisted status. The browser never decides this.
  const attemptTerminal = attempt ? attemptIsTerminal(attempt.status) || submitted : false;
  const remainingSeconds = attempt?.deadlineAt
    ? Math.max(0, Math.floor((new Date(attempt.deadlineAt).getTime() - nowTick) / 1000))
    : null;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10">
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-indigo-600">
              Assessment
            </p>
            <h1 className="mt-1 text-2xl font-bold text-slate-900">{assessment.title}</h1>
          </div>
          <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-600">
            {attempt ? attemptStatusLabels[attempt.status] ?? attempt.status : "Not started"}
          </span>
        </div>

        {assessment.description && (
          <p className="mt-3 whitespace-pre-wrap text-sm text-slate-600">
            {assessment.description}
          </p>
        )}

        {/* Terminal CHEATED: the persisted server decision. No restart, no
            answers, no submit. The reason is the concise deterministic rule
            name — never an AI accusation. */}
        {attempt?.status === "CHEATED" && (
          <div className="mt-6 space-y-3">
            <Alert variant="error">
              <span className="font-semibold">Assessment closed.</span>{" "}
              {attemptCheatReasonLabels[attempt.cheatReason] ??
                "This attempt was closed by an integrity rule."}{" "}
              The decision was made by the server, not this browser, and is final.
            </Alert>
            <p className="text-xs text-slate-500">
              Integrity monitoring records deterministic technical signals only (for example,
              the number of times this tab was hidden). It does not detect or prevent every
              form of cheating, and no automated judgement is involved.
            </p>
          </div>
        )}

        {submitted && attempt?.status !== "CHEATED" && (
          <div className="mt-6">
            <Alert variant="success">Your assessment was submitted. Thank you.</Alert>
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm text-slate-600">
          <p>
            <span className="font-semibold text-slate-800">Duration:</span>{" "}
            {formatDuration(assessment.durationSeconds)}
          </p>
          <p>
            <span className="font-semibold text-slate-800">Questions:</span>{" "}
            {assessment.questions.length}
          </p>
          {/* The ONE deadline the candidate is shown: when this assessment stops
              being available. It comes from the server's persisted timestamp and
              is display-only — the backend decides access, and any request made
              after this moment is refused server-side regardless of this text. */}
          {availabilityLabel && (
            <p>
              <span className="font-semibold text-slate-800">
                Assessment available until:
              </span>{" "}
              {availabilityLabel}
            </p>
          )}
        </div>

        {/* An expired assessment is stated plainly. The candidate is not offered
            a form to enter an email or a code: the server refuses both anyway,
            and hiding that would only produce a confusing dead end. */}
        {assessment.expired && (
          <div className="mt-6 space-y-2">
            <Alert variant="error">
              <span className="font-semibold">This assessment has expired.</span>{" "}
              It is no longer available and no new attempt can be started. If you
              believe this is a mistake, contact the recruiter who invited you.
            </Alert>
          </div>
        )}

        {/* Pre-verification stages. Suppressed entirely once the assessment has
            expired: the backend refuses a verification code and an attempt start
            for an expired job, so offering the forms would only produce a dead
            end. The server remains the authority — this is presentation only. */}
        {stage !== "verified" && !assessment.expired && (
          <div className="mt-6 space-y-3">
            {stage === "enter-email" ? (
              <form onSubmit={submitEmail} className="space-y-3">
                <label className="block text-sm font-medium text-slate-700" htmlFor="candidate-email">
                  Your invited email
                </label>
                <input
                  id="candidate-email"
                  type="email"
                  required
                  value={emailInput}
                  onChange={(event) => setEmailInput(event.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                  placeholder="you@example.com"
                />
                <Button type="submit" disabled={stageBusy || !emailInput}>
                  {stageBusy ? <Spinner className="h-4 w-4" /> : "Verify my access"}
                </Button>
              </form>
            ) : (
              <form onSubmit={submitToken} className="space-y-3">
                <label className="block text-sm font-medium text-slate-700" htmlFor="candidate-token">
                  Verification code sent to {emailInput}
                </label>
                <input
                  id="candidate-token"
                  type="text"
                  required
                  value={tokenInput}
                  onChange={(event) => setTokenInput(event.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                  placeholder="6-digit code"
                />
                <Button type="submit" disabled={stageBusy || !tokenInput}>
                  {stageBusy ? <Spinner className="h-4 w-4" /> : "Confirm verification"}
                </Button>
              </form>
            )}
            {stageNotice && <Alert variant={stageNotice.variant}>{stageNotice.message}</Alert>}
          </div>
        )}

        {/* Verified: attempt start / active attempt / terminal states.
            An assessment that has since expired offers no Start button, matching
            the server's refusal of a new attempt on an expired job. An attempt
            that is ALREADY running still renders normally, because its own timer
            is a separate lifecycle that job expiration does not retroactively
            cancel. */}
        {stage === "verified" && (
          <div className="mt-6 space-y-4">
            {!attempt && assessment.expired && (
              <Alert variant="error">
                This assessment has expired, so a new attempt can no longer be started.
              </Alert>
            )}
            {!attempt && !assessment.expired && (
              <div className="space-y-3">
                <Button type="button" onClick={handleStartAttempt} disabled={attemptBusy}>
                  {attemptBusy ? <Spinner className="h-4 w-4" /> : "Start the assessment"}
                </Button>
                <p className="text-xs text-slate-500">
                  The timer starts on the server when you click. It cannot be paused or
                  extended from this browser.
                </p>
                {attemptError && <Alert variant="error">{attemptError}</Alert>}
              </div>
            )}

            {attempt && !attemptTerminal && (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                  <p className="text-sm font-semibold text-slate-700">
                    Time remaining: {formatClock(remainingSeconds ?? 0)}
                  </p>
                  <p className="text-xs text-slate-500">Server-authoritative countdown.</p>
                </div>
                {attemptError && <Alert variant="error">{attemptError}</Alert>}
                {bySection.map(([section, questions]) => (
                  <div key={section}>
                    <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                      {section.replace(/_/g, " ")}
                    </h2>
                    <ol className="mt-2 space-y-3">
                      {questions.map((question) => (
                        <li
                          key={`${question.section}-${question.sortOrder}`}
                          className="rounded-xl border border-slate-200 bg-slate-50/60 p-4"
                        >
                          <p className="text-sm font-medium text-slate-900">{question.prompt}</p>
                          <p className="mt-1 text-xs text-slate-500">
                            {QUESTION_TYPE_LABELS[question.questionType] ?? question.questionType}
                            {" · "}
                            {question.points} {question.points === 1 ? "point" : "points"}
                            {question.difficulty ? ` · ${question.difficulty}` : ""}
                          </p>
                          {Array.isArray(question.options) && question.options.length > 0 ? (
                            <div className="mt-2 space-y-1">
                              {question.options.map((option) => (
                                <label
                                  key={option}
                                  className="flex items-center gap-2 text-sm text-slate-700"
                                >
                                  <input
                                    type={
                                      question.questionType === "MULTIPLE_CHOICE"
                                        ? "checkbox"
                                        : "radio"
                                    }
                                    name={`q-${question.id}`}
                                    checked={
                                      question.questionType === "MULTIPLE_CHOICE"
                                        ? (answers[question.id] ?? []).includes(option)
                                        : answers[question.id] === option
                                    }
                                    onChange={(event) => {
                                      if (question.questionType === "MULTIPLE_CHOICE") {
                                        const current = answers[question.id] ?? [];
                                        handleAnswerChange(
                                          question.id,
                                          event.target.checked
                                            ? [...current, option]
                                            : current.filter((item) => item !== option)
                                        );
                                      } else {
                                        handleAnswerChange(question.id, event.target.value);
                                      }
                                    }}
                                  />
                                  {option}
                                </label>
                              ))}
                            </div>
                          ) : (
                            <textarea
                              className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                              rows={3}
                              value={answers[question.id] ?? ""}
                              onChange={(event) =>
                                handleAnswerChange(question.id, event.target.value)
                              }
                            />
                          )}
                          <div className="mt-2 flex items-center gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              onClick={() => handleSaveAnswer(question)}
                              disabled={attemptBusy}
                            >
                              {attemptBusy ? <Spinner className="h-4 w-4" /> : "Save answer"}
                            </Button>
                            {answerSavedAt[question.id] && (
                              <span className="text-xs text-emerald-600">Saved</span>
                            )}
                          </div>
                        </li>
                      ))}
                    </ol>
                  </div>
                ))}

                <div className="mt-8 flex items-center justify-between border-t border-slate-200 pt-5">
                  <p className="text-xs text-slate-500">
                    Make sure you have saved all answers before submitting.
                  </p>
                  <Button
                    type="button"
                    onClick={handleSubmitAttempt}
                    disabled={submitting || attemptBusy}
                  >
                    {submitting ? <Spinner className="h-4 w-4" /> : "Submit assessment"}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default JobAssessment;
