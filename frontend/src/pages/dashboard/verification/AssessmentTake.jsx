import { useEffect, useState, useRef, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import Alert from "../../../components/ui/Alert";
import { ClockIcon } from "../../../components/ui/icons";
import runVerificationPipeline from "../../../services/verificationPipeline";
import {
  getActiveVerificationAttempt,
  submitSkillAssessment,
  cancelSkillAssessment,
  recordAssessmentViolation,
  getSkillVerificationEligibility,
} from "../../../services/authService";

const AssessmentTake = () => {
  const { skillId, attemptId } = useParams();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attemptData, setAttemptData] = useState(null);
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [answers, setAnswers] = useState({});
  const [remainingSeconds, setRemainingSeconds] = useState(null);
  const [isTimeExpired, setIsTimeExpired] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [cancelModalOpen, setCancelModalOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancellationInfo, setCancellationInfo] = useState({ remainingCancelCount: 3, cancellationCount: 0 });
  const [violationModalOpen, setViolationModalOpen] = useState(false);
  const [violationDetails, setViolationDetails] = useState({ title: "", message: "", isTerminated: false, count: 0 });

  const timerRef = useRef(null);
  const lastViolationTimeRef = useRef(0);

  // Anti-Cheating Monitoring (Visibility Change & Clipboard Events with 2s Deduplication)
  useEffect(() => {
   if (!attemptData?.attemptId || isSubmitted || isSubmitting || isTimeExpired || cancelling) return;

    const targetAttemptId = attemptData.attemptId;

    const handleViolation = (type) => {
      const now = Date.now();
      if (now - lastViolationTimeRef.current < 2000) return; // 2s deduplication
      lastViolationTimeRef.current = now;

      recordAssessmentViolation(skillId, targetAttemptId, type)
        .then((res) => {
          const data = res?.data || res;
          if (!data) return;
          if (data.isTerminated) {
            if (timerRef.current) clearInterval(timerRef.current);
            setIsSubmitted(true);
            setViolationDetails({
              title: "Assessment Terminated",
              message: data.warningMessage || "Assessment terminated due to anti-cheating violations. Access to this skill is blocked for 7 days.",
              isTerminated: true,
              count: 3,
            });
            setViolationModalOpen(true);
          } else {
            setViolationDetails({
              title: `Assessment Violation Warning (${data.violationCount}/3)`,
              message: data.warningMessage || "Switching tabs or copying content is strictly prohibited during the assessment.",
              isTerminated: false,
              count: data.violationCount,
            });
            setViolationModalOpen(true);
          }
        })
        .catch(() => {
          // The backend is the only authority for violation counts. If this
          // violation could not be recorded (network/API failure), do not
          // invent a count locally or claim it was recorded — warn the
          // candidate visibly instead.
          setViolationDetails({
            title: "Violation Not Recorded",
            message:
              "We could not confirm this violation with the server (connection issue). Tab switching and copying remain strictly prohibited — if a violation is recorded, your assessment can still be terminated and this skill blocked for 7 days.",
            isTerminated: false,
            count: 0,
          });
          setViolationModalOpen(true);
        });
    };

    const onVisibilityChange = () => {
      if (document.hidden) handleViolation("TAB_SWITCH");
    };

    const onCopyCutPaste = (e) => {
      handleViolation("CLIPBOARD_" + e.type.toUpperCase());
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    document.addEventListener("copy", onCopyCutPaste);
    document.addEventListener("cut", onCopyCutPaste);
    document.addEventListener("paste", onCopyCutPaste);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      document.removeEventListener("copy", onCopyCutPaste);
      document.removeEventListener("cut", onCopyCutPaste);
      document.removeEventListener("paste", onCopyCutPaste);
    };
  }, [attemptData?.attemptId, skillId, isSubmitted, isSubmitting, isTimeExpired, cancelling]);
  // Load Active Attempt Data & restore existing answers
  useEffect(() => {
    let mounted = true;

    getActiveVerificationAttempt(skillId)
      .then((res) => {
        if (!mounted) return;
        const data = res?.data;
        if (!data) {
          throw new Error("Active assessment attempt not found.");
        }

        setAttemptData(data);

        // Restore saved answers if present
        const restored = {};
        (data.savedAnswers || []).forEach((item) => {
          restored[item.questionId] = item.answer;
        });
        setAnswers(restored);

        // Calculate initial remaining seconds from server deadlineAt
        const deadlineMs = new Date(data.deadlineAt).getTime();
        const diffSec = Math.max(0, Math.floor((deadlineMs - Date.now()) / 1000));
        setRemainingSeconds(diffSec);

        if (diffSec <= 0) {
          setIsTimeExpired(true);
        }
      })
      .catch((err) => {
        if (!mounted) return;
        setError(err.response?.data?.message || err.message || "Unable to load active assessment.");
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [skillId]);

  // Fetch cancellation info for exact credential combination
  useEffect(() => {
    if (!skillId) return;
    getSkillVerificationEligibility(skillId)
      .then((res) => {
        if (res?.data?.cancellationInfo) {
          setCancellationInfo(res.data.cancellationInfo);
        }
      })
      .catch(() => {});
  }, [skillId]);

 const handleConfirmCancel = async () => {
  const targetAttemptId = attemptData?.attemptId || attemptId;
  if (!targetAttemptId || cancelling) return;

  setCancelling(true);
  setIsSubmitted(true);

  try {
    if (timerRef.current) clearInterval(timerRef.current);

    await cancelSkillAssessment(skillId, targetAttemptId);

    setCancelModalOpen(false);
    navigate(`/employee/skills/${skillId}/verify/ended/${targetAttemptId}`);
  } catch (err) {
    setError(err.response?.data?.message || "Failed to cancel assessment.");
    setCancelling(false);
    setIsSubmitted(false);
  }
};

  // Format answers for submission backend
  const buildFormattedAnswers = useCallback(() => {
    const questions = attemptData?.questions || [];
    return questions.map((q) => ({
      questionId: q.id,
      answer: answers[q.id] ?? (q.questionType === "MULTIPLE_CHOICE" ? { optionIds: [] } : { optionId: null, text: "" }),
    }));
  }, [attemptData, answers]);

  // Submit Handler
  const executeSubmission = useCallback(
    async (expired = false) => {
      if (isSubmitting || isSubmitted) return;
      setIsSubmitting(true);
      if (expired) setIsTimeExpired(true);

      const formattedAnswers = buildFormattedAnswers();
      const targetAssessmentId = attemptData?.assessmentId;
      const targetAttemptId = attemptData?.attemptId || attemptId;

      try {
        await submitSkillAssessment(targetAssessmentId, targetAttemptId, formattedAnswers);
        setIsSubmitted(true);
        // Start the existing score → prepare evidence → Gemini analysis
        // pipeline as background execution (fire-and-forget, NOT awaited) so
        // the candidate is taken to the dedicated Test Ended page immediately
        // while verification continues. Idempotent backend status gates keep
        // this safe; it is intentionally NOT triggered for cancellation or
        // violation-termination endings.
        runVerificationPipeline({
          skillId,
          attemptId: targetAttemptId,
          assessmentId: targetAssessmentId,
        }).catch(() => {});
        navigate(`/employee/skills/${skillId}/verify/ended/${targetAttemptId}`);
      } catch (err) {
        if (err.response?.status === 400 || err.response?.data?.message?.includes("submitted") || err.response?.data?.message?.includes("expired")) {
          setIsSubmitted(true);
          // Submission already landed server-side (e.g. duplicate request) —
          // safe to run the idempotent pipeline and show Test Ended as well.
          runVerificationPipeline({
            skillId,
            attemptId: targetAttemptId,
            assessmentId: targetAssessmentId,
          }).catch(() => {});
          navigate(`/employee/skills/${skillId}/verify/ended/${targetAttemptId}`);
        } else {
          setError(err.response?.data?.message || "Failed to submit assessment.");
          setIsSubmitting(false);
        }
      }
    },
    [isSubmitting, isSubmitted, buildFormattedAnswers, attemptData, attemptId, skillId, navigate]
  );

  // Server-authoritative timer countdown effect
  useEffect(() => {
    if (!attemptData?.deadlineAt || isSubmitted || isSubmitting) return;

    const updateTimer = () => {
      const deadlineMs = new Date(attemptData.deadlineAt).getTime();
      const diffSec = Math.max(0, Math.floor((deadlineMs - Date.now()) / 1000));
      setRemainingSeconds(diffSec);

      if (diffSec <= 0) {
        if (timerRef.current) clearInterval(timerRef.current);
        executeSubmission(true);
      }
    };

    updateTimer();
    timerRef.current = setInterval(updateTimer, 1000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [attemptData?.deadlineAt, isSubmitted, isSubmitting, executeSubmission]);

  // Update Answer for a question
  const handleAnswerChange = (questionId, value) => {
    if (isTimeExpired || isSubmitting || isSubmitted) return;
    setAnswers((prev) => ({
      ...prev,
      [questionId]: value,
    }));
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center text-sm font-medium text-slate-400">
        Loading Timed Assessment...
      </div>
    );
  }

  if (error && !attemptData) {
    return (
      <div className="min-h-screen bg-slate-900 p-10 flex items-center justify-center">
        <div className="w-full max-w-md">
          <Alert variant="error">{error}</Alert>
        </div>
      </div>
    );
  }

  const questions = attemptData?.questions || [];
  const endedAttemptId = attemptData?.attemptId || attemptId;
  const currentQuestion = questions[currentQuestionIndex];
  const isLastQuestion = currentQuestionIndex === questions.length - 1;

  const minutes = Math.floor((remainingSeconds || 0) / 60);
  const seconds = (remainingSeconds || 0) % 60;
  const formattedTime = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 flex flex-col font-sans selection:bg-indigo-500 selection:text-white">
      {/* Top Dedicated Assessment Header */}
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-0 z-30 px-6 py-4">
        <div className="mx-auto max-w-5xl flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-cyan-400 font-bold text-white text-sm shadow-md">
              VS
            </span>
            <div>
              <h1 className="font-display font-bold text-base text-white">Skill Verification Assessment</h1>
              <p className="text-xs text-indigo-400 font-medium">Skill: {attemptData?.skillNameSnapshot || "Technical Skill"}</p>
            </div>
          </div>

          {/* Server-Authoritative Prominent Timer */}
          <div
            className={`flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-bold font-mono border transition-all ${
              (remainingSeconds || 0) <= 60
                ? "border-rose-500/50 bg-rose-500/10 text-rose-400 animate-pulse"
                : "border-slate-700 bg-slate-800 text-indigo-300"
            }`}
          >
            <ClockIcon className="h-5 w-5 text-indigo-400" />
            <span>Time Remaining: {formattedTime}</span>
          </div>
        </div>
      </header>

      {/* Progress Bar Header */}
      <div className="border-b border-slate-800 bg-slate-900/50 px-6 py-3">
        <div className="mx-auto max-w-5xl flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-4">
            <span className="font-semibold text-slate-300">
              Question {currentQuestionIndex + 1} of {questions.length}
            </span>
            <span className="text-slate-600">|</span>
            <span className="text-slate-400 font-medium">
              {currentQuestion?.points || 0} Points
            </span>
          </div>

          <div className="flex items-center gap-3 w-full sm:w-64">
            <div className="h-2 flex-1 rounded-full bg-slate-800 overflow-hidden">
              <div
                className="h-2 rounded-full bg-gradient-to-r from-indigo-500 to-cyan-400 transition-all duration-300"
                style={{ width: `${((currentQuestionIndex + 1) / questions.length) * 100}%` }}
              />
            </div>
            <span className="text-slate-400 font-mono text-[11px] font-medium">
              {Math.round(((currentQuestionIndex + 1) / questions.length) * 100)}%
            </span>
          </div>
        </div>
      </div>

      {/* Main Content Area */}
      <main className="flex-1 px-6 py-8">
        <div className="mx-auto max-w-4xl space-y-6">
          {error && <Alert variant="error">{error}</Alert>}

          {/* Lockout Blocking Overlay when Expired or Submitting */}
          {(isTimeExpired || isSubmitting) && (
            <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-6 text-center shadow-lg backdrop-blur">
              <h2 className="font-display text-xl font-bold text-amber-300">
                {isTimeExpired ? "Assessment Time Expired" : "Submitting Assessment..."}
              </h2>
              <p className="mt-2 text-sm text-amber-200">
                {isTimeExpired
                  ? "Your time has expired. Your current answers are being automatically submitted."
                  : "Please wait while your answers are saved."}
              </p>
            </div>
          )}

          {/* Main Question Card */}
          {currentQuestion && (
            <div className="rounded-2xl border border-slate-800 bg-slate-800/80 p-6 sm:p-8 shadow-xl backdrop-blur">
              <div className="flex items-center justify-between border-b border-slate-700/60 pb-4">
                <span className="rounded-lg bg-indigo-500/10 border border-indigo-500/20 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-indigo-300">
                  {currentQuestion.questionType.replaceAll("_", " ")}
                </span>
                <span className="text-xs font-medium text-slate-400">
                  Question {currentQuestionIndex + 1} of {questions.length}
                </span>
              </div>

              <div className="mt-6">
                <p className="font-display text-xl font-medium text-slate-100 leading-relaxed whitespace-pre-wrap">
                  {currentQuestion.prompt}
                </p>
              </div>

              {/* Supported Question Types Rendering */}
              <div className="mt-8">
                {/* SINGLE CHOICE */}
                {currentQuestion.questionType === "SINGLE_CHOICE" && (
                  <div className="space-y-3">
                    {(currentQuestion.options || []).map((opt) => {
                      const isChecked = answers[currentQuestion.id]?.optionId === opt.id;
                      return (
                        <label
                          key={opt.id}
                          className={`flex cursor-pointer items-center gap-4 rounded-xl border p-4 transition-all ${
                            isChecked
                              ? "border-indigo-500 bg-indigo-500/10 text-white ring-1 ring-indigo-500"
                              : "border-slate-700 bg-slate-900/50 text-slate-300 hover:border-slate-600 hover:bg-slate-900"
                          }`}
                        >
                          <input
                            type="radio"
                            name={`q-${currentQuestion.id}`}
                            value={opt.id}
                            checked={isChecked}
                            disabled={isTimeExpired || isSubmitting}
                            onChange={() => handleAnswerChange(currentQuestion.id, { optionId: opt.id })}
                            className="h-4 w-4 border-slate-600 text-indigo-500 focus:ring-indigo-500"
                          />
                          <span className="text-sm font-medium leading-normal">{opt.text}</span>
                        </label>
                      );
                    })}
                  </div>
                )}

                {/* MULTIPLE CHOICE */}
                {currentQuestion.questionType === "MULTIPLE_CHOICE" && (
                  <div className="space-y-3">
                    {(currentQuestion.options || []).map((opt) => {
                      const currentSelected = answers[currentQuestion.id]?.optionIds || [];
                      const isChecked = currentSelected.includes(opt.id);

                      const toggleMultiple = () => {
                        const next = isChecked
                          ? currentSelected.filter((id) => id !== opt.id)
                          : [...currentSelected, opt.id];
                        handleAnswerChange(currentQuestion.id, { optionIds: next });
                      };

                      return (
                        <label
                          key={opt.id}
                          className={`flex cursor-pointer items-center gap-4 rounded-xl border p-4 transition-all ${
                            isChecked
                              ? "border-indigo-500 bg-indigo-500/10 text-white ring-1 ring-indigo-500"
                              : "border-slate-700 bg-slate-900/50 text-slate-300 hover:border-slate-600 hover:bg-slate-900"
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={isChecked}
                            disabled={isTimeExpired || isSubmitting}
                            onChange={toggleMultiple}
                            className="h-4 w-4 rounded border-slate-600 text-indigo-500 focus:ring-indigo-500"
                          />
                          <span className="text-sm font-medium leading-normal">{opt.text}</span>
                        </label>
                      );
                    })}
                  </div>
                )}

                {/* TEXT / SCENARIO / PROBLEM SOLVING / SHORT ANSWER / PRACTICAL */}
                {["SCENARIO", "PROBLEM_SOLVING", "SHORT_ANSWER", "PRACTICAL"].includes(
                  currentQuestion.questionType
                ) && (
                  <div>
                    <textarea
                      rows={7}
                      value={answers[currentQuestion.id]?.text || ""}
                      disabled={isTimeExpired || isSubmitting}
                      onChange={(e) => handleAnswerChange(currentQuestion.id, { text: e.target.value })}
                      placeholder="Type your detailed answer or solution here..."
                      className="w-full rounded-xl border border-slate-700 bg-slate-900/80 p-4 text-sm text-slate-100 placeholder-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:bg-slate-950 disabled:text-slate-500"
                    />
                  </div>
                )}

                {/* CODING / LIVE CODING */}
                {["CODING", "LIVE_CODING"].includes(currentQuestion.questionType) && (
                  <div>
                    <div className="mb-2 flex items-center justify-between text-xs text-slate-400">
                      <span>Code Response Editor (Subjective Evaluation)</span>
                      <span className="font-mono text-emerald-400">Monospace</span>
                    </div>
                    <textarea
                      rows={13}
                      value={answers[currentQuestion.id]?.code || answers[currentQuestion.id]?.text || ""}
                      disabled={isTimeExpired || isSubmitting}
                      onChange={(e) =>
                        handleAnswerChange(currentQuestion.id, {
                          code: e.target.value,
                          text: e.target.value,
                        })
                      }
                      placeholder="// Write your code or implementation here..."
                      className="w-full rounded-xl border border-slate-700 bg-slate-950 p-4 font-mono text-sm text-emerald-400 placeholder-slate-600 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:text-slate-600"
                    />
                  </div>
                )}
              </div>

              {/* Bottom Question Navigation & Submit Bar */}
              <div className="mt-8 flex flex-wrap items-center justify-between gap-4 border-t border-slate-700/60 pt-6">
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    disabled={currentQuestionIndex === 0 || isTimeExpired || isSubmitting}
                    onClick={() => setCurrentQuestionIndex((prev) => Math.max(0, prev - 1))}
                    className="rounded-xl border border-slate-700 bg-slate-900 px-5 py-2.5 text-sm font-semibold text-slate-300 transition hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    ← Previous
                  </button>

                  <button
                    type="button"
                    disabled={isTimeExpired || isSubmitting}
                    onClick={() => setCancelModalOpen(true)}
                    className="rounded-xl border border-slate-700/80 bg-slate-900/60 px-4 py-2.5 text-sm font-medium text-slate-400 transition hover:bg-rose-500/10 hover:border-rose-500/30 hover:text-rose-400 disabled:opacity-40"
                  >
                    Cancel Assessment
                  </button>
                </div>

                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    disabled={isTimeExpired || isSubmitting}
                    onClick={() => {
                      if (window.confirm("Are you sure you want to submit your assessment now?")) {
                        executeSubmission(false);
                      }
                    }}
                    className="rounded-xl border border-emerald-600/40 bg-emerald-600/10 px-5 py-2.5 text-sm font-semibold text-emerald-400 transition hover:bg-emerald-600/20 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Submit Assessment
                  </button>

                  {!isLastQuestion && (
                    <button
                      type="button"
                      disabled={isTimeExpired || isSubmitting}
                      onClick={() =>
                        setCurrentQuestionIndex((prev) => Math.min(questions.length - 1, prev + 1))
                      }
                      className="rounded-xl bg-indigo-600 px-6 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed shadow-md"
                    >
                      Next →
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* Voluntarily Cancel Confirmation Modal */}
      {cancelModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 px-4 backdrop-blur-sm"
          onClick={() => !cancelling && setCancelModalOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <h2 className="font-display text-xl font-bold text-white">Cancel Assessment?</h2>
            <p className="mt-3 text-sm text-slate-300 leading-relaxed">
              Your current assessment progress will be cancelled and will not be scored.
            </p>
            <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950 p-4 text-xs space-y-2">
              <div className="flex justify-between text-slate-400">
                <span>Remaining cancellations for this skill:</span>
                <span className="font-bold text-indigo-400">
                  {cancellationInfo.remainingCancelCount} left
                </span>
              </div>
              <p className="text-slate-500 leading-normal">
                {cancellationInfo.remainingCancelCount === 1 ? (
                  <span className="text-amber-400 font-semibold">
                    ⚠️ Warning: This will be your 3rd cancellation. Access to this skill and credential combination will be blocked for 7 days.
                  </span>
                ) : (
                  "After 3 cancellations for the same skill and credentials, access will be temporarily blocked for 7 days."
                )}
              </p>
            </div>

            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                disabled={cancelling}
                onClick={() => setCancelModalOpen(false)}
                className="rounded-xl border border-slate-700 bg-slate-800 px-4 py-2.5 text-sm font-semibold text-slate-300 transition hover:bg-slate-700"
              >
                Keep Assessment
              </button>
              <button
                type="button"
                disabled={cancelling}
                onClick={handleConfirmCancel}
                className="rounded-xl bg-rose-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-rose-500 disabled:bg-rose-400"
              >
                {cancelling ? "Cancelling..." : "Confirm Cancellation"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Anti-Cheating Violation Warning / Termination Modal */}
      {violationModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 px-4 backdrop-blur-md"
          onClick={() => {
            setViolationModalOpen(false);
            if (violationDetails.isTerminated) {
              navigate(`/employee/skills/${skillId}/verify/ended/${endedAttemptId}`);
            }
          }}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-rose-800/60 bg-slate-900 p-6 shadow-2xl space-y-4"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-rose-500/20 text-rose-400 text-lg font-bold">
                ⚠️
              </span>
              <h2 className="font-display text-lg font-bold text-white">
                {violationDetails.title}
              </h2>
            </div>

            <p className="text-sm text-slate-300 leading-relaxed bg-rose-950/30 p-3.5 rounded-xl border border-rose-900/50">
              {violationDetails.message}
            </p>

            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={() => {
                  setViolationModalOpen(false);
                  if (violationDetails.isTerminated) {
                    navigate(`/employee/skills/${skillId}/verify/ended/${endedAttemptId}`);
                  }
                }}
                className="rounded-xl bg-rose-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-rose-500"
              >
                {violationDetails.isTerminated ? "Return to Skills" : "Understand & Continue"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AssessmentTake;
