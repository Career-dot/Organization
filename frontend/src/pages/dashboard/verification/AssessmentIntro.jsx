import { useEffect, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import DashboardShell from "../../../components/ui/DashboardShell";
import Alert from "../../../components/ui/Alert";
import Button from "../../../components/ui/Button";
import { ClockIcon } from "../../../components/ui/icons";
import {
  generateSkillAssessment,
  getSkillVerificationEligibility,
  startSkillAssessment,
} from "../../../services/authService";
import { EMPLOYEE_NAV_ITEMS } from "../../../constants/employeeNav";

const AssessmentIntro = () => {
  const { skillId } = useParams();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const [eligibility, setEligibility] = useState(null);
  const [assessment, setAssessment] = useState(null);
  const [verificationUnavailable, setVerificationUnavailable] = useState(null);

  useEffect(() => {
    let mounted = true;

    const init = async () => {
      try {
        // Eligibility is checked FIRST so that a candidate navigating directly
        // to this URL cannot trigger an AI assessment generation when the
        // normal Skills UI would say verification is unavailable (blocked, or
        // no relevant changes since the last verification).
        const eligRes = await getSkillVerificationEligibility(skillId);
        if (!mounted) return;
        const elig = eligRes?.data || null;
        setEligibility(elig);

        let unavailable = null;
        if (elig?.cancellationInfo?.isBlocked) {
          unavailable = {
            variant: "error",
            message: `Verification is temporarily unavailable. You have cancelled this assessment 3 times for this skill. Please try again in ${elig.cancellationInfo.blockedRemainingText || "7 days"}.`,
          };
        } else if (elig?.antiCheatingInfo?.isBlocked) {
          unavailable = {
            variant: "error",
            message: `Verification is temporarily unavailable because a previous attempt was terminated due to anti-cheating violations. Please try again in ${elig.antiCheatingInfo.blockedRemainingText || "7 days"}.`,
          };
        } else if (elig?.hasCompletedVerification && elig?.eligible === false) {
          unavailable = {
            variant: "info",
            message:
              "You have already verified this skill and no relevant changes have been made since your last verification, so re-verification is not available right now.",
          };
        }

        if (unavailable) {
          setVerificationUnavailable(unavailable);
          return; // do not generate an assessment when verification is unavailable
        }

        const genRes = await generateSkillAssessment(skillId);
        if (!mounted) return;
        setAssessment(genRes?.data || null);
      } catch (err) {
        if (!mounted) return;
        setError(err.response?.data?.message || "Unable to load skill assessment details.");
      } finally {
        if (mounted) setLoading(false);
      }
    };

    init();

    return () => {
      mounted = false;
    };
  }, [skillId]);

  const handleStartAssessment = async () => {
    if (!assessment?.id) return;
    setStarting(true);
    setError("");

    try {
      const res = await startSkillAssessment(skillId, assessment.id);
      const attemptId = res?.data?.attempt?.id;
      if (attemptId) {
        const testUrl = `/employee/skills/${skillId}/verify/test/${attemptId}`;
        window.open(testUrl, "_blank");
        navigate("/employee/skills");
      } else {
        throw new Error("Failed to retrieve assessment attempt ID.");
      }
    } catch (err) {
      setError(err.response?.data?.message || err.message || "Failed to start assessment.");
      setStarting(false);
    }
  };

  if (loading) {
    return <div className="p-10 text-sm text-slate-500">Loading Assessment Details...</div>;
  }

  const durationMinutes = Math.max(1, Math.round((assessment?.durationSeconds || 600) / 60));
  const questionCount = assessment?.questionCount || assessment?.questions?.length || 5;

  return (
    <DashboardShell
      roleLabel="Candidate"
      title="Skill Assessment Intro"
      description="Prepare for your timed skill verification assessment."
      navItems={EMPLOYEE_NAV_ITEMS}
    >
      <div className="mx-auto max-w-3xl space-y-6">
        <Link
          to="/employee/skills"
          className="inline-flex items-center text-sm font-medium text-indigo-600 hover:text-indigo-800"
        >
          ← Back to My Skills
        </Link>

        {error && <Alert variant="error">{error}</Alert>}

        {verificationUnavailable && (
          <Alert variant={verificationUnavailable.variant}>{verificationUnavailable.message}</Alert>
        )}

        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 pb-6">
            <div>
              <span className="text-xs font-semibold uppercase tracking-wider text-indigo-600">
                Skill Verification
              </span>
              <h1 className="mt-1 font-display text-2xl font-bold text-slate-900">
                {assessment?.title || "Skill Assessment"}
              </h1>
              <p className="mt-1 text-sm text-slate-500">
                {assessment?.description || "Skill Verification Assessment"}
              </p>
            </div>
            <div className="flex items-center gap-2 rounded-xl bg-indigo-50 px-4 py-2 text-indigo-700">
              <ClockIcon className="h-5 w-5" />
              <span className="font-display font-bold">{durationMinutes} Minutes</span>
            </div>
          </div>

          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            <div className="rounded-xl border border-slate-100 bg-slate-50 p-4">
              <span className="text-xs font-medium text-slate-500">Duration</span>
              <p className="mt-1 text-lg font-bold text-slate-900">{durationMinutes} mins</p>
            </div>
            <div className="rounded-xl border border-slate-100 bg-slate-50 p-4">
              <span className="text-xs font-medium text-slate-500">Questions</span>
              <p className="mt-1 text-lg font-bold text-slate-900">{questionCount} Questions</p>
            </div>
            <div className="rounded-xl border border-slate-100 bg-slate-50 p-4">
              <span className="text-xs font-medium text-slate-500">Target Proficiency</span>
              <p className="mt-1 text-lg font-bold text-slate-900">
                {eligibility?.latestReport?.verificationStatus || "INTERMEDIATE"}
              </p>
            </div>
          </div>

          <div className="mt-6 space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-900">
            <h3 className="font-semibold">Important Assessment Rules:</h3>
            <ul className="list-disc space-y-1.5 pl-5 text-sm">
              <li>This test is strictly timed by the server ({durationMinutes} minutes total).</li>
              <li>When the timer expires, the test automatically locks and submits your current answers.</li>
              <li>You cannot edit or submit answers after the timer expires.</li>
              <li>You may navigate between questions freely during the test.</li>
              <li>If you refresh or reload the page, your progress will be restored.</li>
            </ul>
          </div>

          <div className="mt-8 flex justify-end gap-3">
            <Link to="/employee/skills">
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </Link>
            <Button
              type="button"
              onClick={handleStartAssessment}
              disabled={starting || !assessment?.id}
            >
              {starting ? "Starting Test..." : "Start Assessment"}
            </Button>
          </div>
        </div>
      </div>
    </DashboardShell>
  );
};

export default AssessmentIntro;
