import { useEffect, useState, useRef } from "react";
import { useParams, Link } from "react-router-dom";
import DashboardShell from "../../../components/ui/DashboardShell";
import Alert from "../../../components/ui/Alert";
import Button from "../../../components/ui/Button";
import { CheckIcon, SparkIcon } from "../../../components/ui/icons";
import {
  prepareVerificationEvidence,
  analyzeVerification,
  getSkillVerificationEligibility,
} from "../../../services/authService";
import runVerificationPipeline from "../../../services/verificationPipeline";
import { EMPLOYEE_NAV_ITEMS } from "../../../constants/employeeNav";

const AssessmentProcessing = () => {
  const { skillId, attemptId } = useParams();

  const [status, setStatus] = useState("PROCESSING"); // NOT_STARTED, PROCESSING, COMPLETED, FAILED
  const [error, setError] = useState("");
  const [report, setReport] = useState(null);
  const [stepMessage, setStepMessage] = useState("Submitting answers & scoring assessment...");

  const isExecutingRef = useRef(false);

  useEffect(() => {
    let mounted = true;
    if (isExecutingRef.current) return;
    isExecutingRef.current = true;

    const runPipeline = async () => {
      try {
        const res = await runVerificationPipeline({
          skillId,
          attemptId,
          assessmentId: null,
          onStep: (message) => {
            if (mounted) setStepMessage(message);
          },
        });

        if (mounted) {
          setReport(res?.data || null);
          setStatus("COMPLETED");
        }
      } catch (err) {
        if (!mounted) return;
        try {
          const eligibility = await getSkillVerificationEligibility(skillId);
          if (eligibility?.data?.latestReport?.completedAt) {
            setReport(eligibility.data.latestReport);
            setStatus("COMPLETED");
            return;
          }
        } catch {
          // Ignore check error
        }

        setStatus("FAILED");
        setError(err.response?.data?.message || err.message || "Verification processing failed.");
      }
    };

    runPipeline();

    return () => {
      mounted = false;
    };
  }, [skillId, attemptId]);

  const handleRetry = async () => {
    setStatus("PROCESSING");
    setError("");
    setStepMessage("Retrying verification analysis...");

    try {
      await prepareVerificationEvidence(skillId, attemptId);
      const res = await analyzeVerification(skillId, attemptId, true);
      setReport(res?.data || null);
      setStatus("COMPLETED");
    } catch (err) {
      setStatus("FAILED");
      setError(err.response?.data?.message || err.message || "Retry failed.");
    }
  };

  return (
    <DashboardShell
      roleLabel="Candidate"
      title="Verification Processing"
      description="Processing your skill assessment and evidence verification."
      navItems={EMPLOYEE_NAV_ITEMS}
    >
      <div className="mx-auto max-w-2xl space-y-6 text-center">
        {error && <Alert variant="error">{error}</Alert>}

        {status === "PROCESSING" && (
          <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm sm:p-12">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-indigo-50 text-indigo-600 animate-spin">
              <SparkIcon className="h-8 w-8" />
            </div>
            <h2 className="mt-6 font-display text-2xl font-bold text-slate-900">
              Analyzing Verification Evidence
            </h2>
            <p className="mt-2 text-sm text-slate-500">{stepMessage}</p>
            <div className="mx-auto mt-6 h-2 w-48 overflow-hidden rounded-full bg-slate-100">
              <div className="h-full w-3/4 rounded-full bg-indigo-600 animate-pulse" />
            </div>
          </div>
        )}

        {status === "COMPLETED" && (
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50/50 p-8 shadow-sm sm:p-12">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
              <CheckIcon className="h-8 w-8" />
            </div>
            <h2 className="mt-6 font-display text-2xl font-bold text-slate-900">
              Verification Complete!
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              Your skill verification evidence and test performance have been successfully analyzed.
            </p>

            {report && (
              <div className="mx-auto mt-6 max-w-md space-y-2 rounded-xl border border-emerald-100 bg-white p-4 text-left shadow-sm">
                <div className="flex justify-between text-sm">
                  <span className="text-slate-500">Verification Status:</span>
                  <span className="font-bold text-emerald-700">{report.verificationStatus}</span>
                </div>
                {report.verificationScore !== null && (
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-500">Verification Score:</span>
                    <span className="font-bold text-slate-900">{report.verificationScore}%</span>
                  </div>
                )}
                {report.confidenceScore !== null && (
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-500">Confidence Score:</span>
                    <span className="font-bold text-slate-900">{report.confidenceScore}%</span>
                  </div>
                )}
              </div>
            )}

            <div className="mt-8 flex justify-center gap-3">
              <Link to="/employee/skills">
                <Button type="button">Back to My Skills</Button>
              </Link>
            </div>
          </div>
        )}

        {status === "FAILED" && (
          <div className="rounded-2xl border border-rose-200 bg-rose-50/50 p-8 shadow-sm sm:p-12">
            <h2 className="font-display text-2xl font-bold text-rose-900">
              Verification Analysis Failed
            </h2>
            <p className="mt-2 text-sm text-rose-700">
              {error || "An error occurred while analyzing your verification evidence."}
            </p>

            <div className="mt-8 flex justify-center gap-3">
              <Button type="button" onClick={handleRetry}>
                Retry Verification Analysis
              </Button>
              <Link to="/employee/skills">
                <Button type="button" variant="outline">
                  Return to Skills
                </Button>
              </Link>
            </div>
          </div>
        )}
      </div>
    </DashboardShell>
  );
};

export default AssessmentProcessing;
