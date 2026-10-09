
import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import DashboardShell from "../../../components/ui/DashboardShell";
import Alert from "../../../components/ui/Alert";
import Button from "../../../components/ui/Button";
import { CheckIcon } from "../../../components/ui/icons";
import { EMPLOYEE_NAV_ITEMS } from "../../../constants/employeeNav";
import { getLatestVerificationReport } from "../../../services/authService";

const VerificationReport = () => {
  const { skillId } = useParams();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reportData, setReportData] = useState(null);

  const handleDownloadReport = () => {
    window.print();
  };

  useEffect(() => {
    let mounted = true;

    getLatestVerificationReport(skillId)
      .then((res) => {
        if (!mounted) return;

        const data = res?.data || res;

        if (data && (data.verificationOverview || data.id)) {
          setReportData(data);
        } else {
          setError("Requested verification report was not found.");
        }
      })
      .catch((err) => {
        if (mounted) {
          setError(
            err.response?.data?.message ||
              "Unable to load verification report."
          );
        }
      })
      .finally(() => {
        if (mounted) {
          setLoading(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, [skillId]);

  if (loading) {
    return (
      <DashboardShell
        roleLabel="Candidate"
        title="Verification Report"
        description="Loading skill verification report..."
        navItems={EMPLOYEE_NAV_ITEMS}
      >
        <div className="p-10 text-center text-sm font-medium text-slate-500">
          Loading persisted verification report...
        </div>
      </DashboardShell>
    );
  }

  if (error || !reportData) {
    return (
      <DashboardShell
        roleLabel="Candidate"
        title="Verification Report"
        description="Candidate Skill Verification Report"
        navItems={EMPLOYEE_NAV_ITEMS}
      >
        <div className="mx-auto max-w-3xl space-y-6">
          <Alert variant="error">
            {error || "Verification report not found."}
          </Alert>

          <Link to="/employee/skills">
            <Button variant="outline" size="sm">
              ← Back to Skills
            </Button>
          </Link>
        </div>
      </DashboardShell>
    );
  }

  const overview = reportData.verificationOverview || {
    reportId: reportData.id,
    verificationScore: reportData.verificationScore,
    confidenceScore: reportData.confidenceScore,
    verificationStatus: reportData.verificationStatus,
    completedAt: reportData.completedAt,
  };

  const testPerf =
    reportData.assessmentPerformance ||
    reportData.testPerformance ||
    {};

  const aiAnalysis = reportData.aiAnalysis || {
    aiSummary: reportData.aiSummary,
    strengths: reportData.strengths || [],
    areasToImprove: reportData.areasToImprove || [],
  };

  const evidenceGrouped = reportData.evidenceGrouped || {};

  const allEvidences = Object.entries(evidenceGrouped).flatMap(
    ([type, items]) =>
      Array.isArray(items)
        ? items.map((item) => ({
            ...item,
            evidenceType: type,
          }))
        : []
  );

  const statusColors = {
    HIGHLY_VERIFIED:
      "bg-emerald-100 text-emerald-800 border-emerald-200",
    VERIFIED:
      "bg-emerald-50 text-emerald-700 border-emerald-200",
    PARTIALLY_VERIFIED:
      "bg-amber-100 text-amber-800 border-amber-200",
    INSUFFICIENT_EVIDENCE:
      "bg-rose-100 text-rose-800 border-rose-200",
    UNVERIFIED:
      "bg-slate-100 text-slate-700 border-slate-200",
  };

  const statusStyle =
    statusColors[overview.verificationStatus] ||
    statusColors.UNVERIFIED;

  return (
    <DashboardShell
      roleLabel="Candidate"
      title="Skill Verification Report"
      description="Read-only view of your persisted skill assessment and AI verification analysis."
      navItems={EMPLOYEE_NAV_ITEMS}
    >
      <div className="space-y-8">

        {/* Top Navigation and Download */}
        <div className="report-actions flex flex-wrap items-center justify-between gap-4">
          <Link
            to="/employee/skills"
            className="inline-flex items-center gap-2 text-sm font-semibold text-indigo-600 transition hover:text-indigo-700"
          >
            ← Back to My Skills
          </Link>

          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs font-mono text-slate-400">
              Report ID: {overview.reportId || reportData.id}
            </span>

            <Button
              type="button"
              onClick={handleDownloadReport}
            >
              Download Report
            </Button>
          </div>
        </div>

        {/* Overview Header Card */}
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 pb-6">
            <div>
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="font-display text-2xl font-bold capitalize text-slate-900">
                  {testPerf.skillNameSnapshot || "Skill"} Verification
                </h2>

                <span
                  className={`rounded-full border px-3 py-1 text-xs font-bold ${statusStyle}`}
                >
                  {overview.verificationStatus
                    ?.replaceAll("_", " ") || "UNVERIFIED"}
                </span>
              </div>

              <p className="mt-2 text-sm text-slate-600">
                Claimed Proficiency:{" "}
                <span className="font-semibold text-slate-800">
                  {testPerf.claimedProficiencySnapshot ||
                    aiAnalysis.claimAssessment?.claimedProficiency ||
                    "N/A"}
                </span>{" "}
                · Experience:{" "}
                <span className="font-semibold text-slate-800">
                  {testPerf.yearsOfExperienceSnapshot ??
                    aiAnalysis.claimAssessment?.claimedYears ??
                    "N/A"}{" "}
                  years
                </span>
              </p>

              {aiAnalysis.claimAssessment && (
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-medium text-slate-500">
                    Claim Audit:
                  </span>

                  <span className="rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 font-medium text-slate-700">
                    Presence:{" "}
                    {aiAnalysis.claimAssessment.skillPresence?.replaceAll(
                      "_",
                      " "
                    )}
                  </span>

                  <span className="rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 font-medium text-slate-700">
                    Level:{" "}
                    {aiAnalysis.claimAssessment.proficiencyAlignment?.replaceAll(
                      "_",
                      " "
                    )}
                  </span>

                  <span className="rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 font-medium text-slate-700">
                    Duration:{" "}
                    {aiAnalysis.claimAssessment.experienceAlignment?.replaceAll(
                      "_",
                      " "
                    )}
                  </span>
                </div>
              )}
            </div>

            {overview.completedAt && (
              <div className="text-right text-xs text-slate-500">
                <span>Verified on:</span>

                <p className="font-semibold text-slate-700">
                  {new Date(
                    overview.completedAt
                  ).toLocaleDateString(undefined, {
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                  })}
                </p>
              </div>
            )}
          </div>

          {/* Metric Cards */}
          <div className="mt-6 grid gap-4 sm:grid-cols-3">

            <div className="rounded-xl border border-indigo-100 bg-indigo-50/50 p-4">
              <span className="text-xs font-semibold uppercase tracking-wider text-indigo-600">
                Verification Score
              </span>

              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-3xl font-extrabold text-indigo-900">
                  {overview.verificationScore !== null &&
                  overview.verificationScore !== undefined
                    ? `${overview.verificationScore}%`
                    : "N/A"}
                </span>
              </div>

              <div className="mt-3 h-2 overflow-hidden rounded-full bg-indigo-100">
                <div
                  className="h-full rounded-full bg-indigo-600 transition-all"
                  style={{
                    width: `${Math.max(
                      0,
                      Math.min(
                        100,
                        overview.verificationScore || 0
                      )
                    )}%`,
                  }}
                />
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-4">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-600">
                AI Confidence Score
              </span>

              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-3xl font-extrabold text-slate-900">
                  {overview.confidenceScore !== null &&
                  overview.confidenceScore !== undefined
                    ? `${overview.confidenceScore}%`
                    : "N/A"}
                </span>
              </div>

              <p className="mt-2 text-xs text-slate-500">
                Evidence alignment confidence
              </p>
            </div>

            <div className="rounded-xl border border-emerald-100 bg-emerald-50/50 p-4">
              <span className="text-xs font-semibold uppercase tracking-wider text-emerald-600">
                Test Score
              </span>

              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-3xl font-extrabold text-emerald-900">
                  {testPerf.testScorePercentage !== null &&
                  testPerf.testScorePercentage !== undefined
                    ? `${testPerf.testScorePercentage}%`
                    : "N/A"}
                </span>

                {testPerf.testScoreMaxPoints && (
                  <span className="text-xs font-medium text-emerald-700">
                    ({testPerf.testScorePoints || 0} /{" "}
                    {testPerf.testScoreMaxPoints} pts)
                  </span>
                )}
              </div>

              <p className="mt-2 text-xs text-emerald-700">
                Timed assessment performance
              </p>
            </div>
          </div>
        </section>

        {/* AI Summary and Findings */}
        <div className="grid gap-6 lg:grid-cols-2">

          <section className="space-y-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div>
              <h3 className="font-display text-lg font-bold text-slate-900">
                AI Verification Summary
              </h3>

              <p className="mt-3 rounded-xl border border-slate-100 bg-slate-50 p-4 text-sm leading-relaxed text-slate-700">
                {aiAnalysis.aiSummary ||
                  "No detailed summary available."}
              </p>
            </div>

            {aiAnalysis.strengths &&
              aiAnalysis.strengths.length > 0 && (
                <div>
                  <h4 className="text-sm font-bold text-slate-900">
                    Identified Strengths
                  </h4>

                  <ul className="mt-3 space-y-2">
                    {aiAnalysis.strengths.map((item, idx) => (
                      <li
                        key={idx}
                        className="flex items-start gap-2 text-sm text-slate-700"
                      >
                        <span className="flex h-5 w-5 flex-none items-center justify-center rounded-full bg-emerald-100 text-xs text-emerald-700">
                          <CheckIcon className="h-3 w-3" />
                        </span>

                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
          </section>

          <section className="space-y-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div>
              <h3 className="font-display text-lg font-bold text-slate-900">
                Key Areas to Improve
              </h3>

              {aiAnalysis.consistencyAnalysis?.contradictions
                ?.length > 0 && (
                <div className="mt-3 space-y-1.5 rounded-xl border border-rose-200 bg-rose-50/70 p-3.5 text-xs text-rose-900">
                  <span className="flex items-center gap-1.5 font-bold text-rose-800">
                    <span>⚠️</span>
                    Evidence Mismatch Flagged:
                  </span>

                  {aiAnalysis.consistencyAnalysis.contradictions.map(
                    (item, index) => (
                      <p
                        key={index}
                        className="pl-4 leading-relaxed"
                      >
                        • {item}
                      </p>
                    )
                  )}
                </div>
              )}

              {aiAnalysis.areasToImprove &&
              aiAnalysis.areasToImprove.length > 0 ? (
                <ul className="mt-4 space-y-3">
                  {aiAnalysis.areasToImprove.map(
                    (item, idx) => (
                      <li
                        key={idx}
                        className="flex items-start gap-2.5 rounded-xl border border-amber-100 bg-amber-50/60 p-3.5 text-sm text-amber-900"
                      >
                        <span className="mt-0.5 font-bold text-amber-600">
                          ⚠️
                        </span>

                        <span>{item}</span>
                      </li>
                    )
                  )}
                </ul>
              ) : (
                <p className="mt-4 text-sm text-slate-500">
                  No specific areas to improve flagged.
                </p>
              )}
            </div>
          </section>
        </div>

        {/* Evidence Analysis */}
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h3 className="font-display text-lg font-bold text-slate-900">
            Analyzed Evidence Sources
          </h3>

          <p className="mt-1 text-xs text-slate-500">
            Evidence snapshots collected from profile data,
            certificates, projects, and assessment results.
          </p>

          {allEvidences.length > 0 ? (
            <div className="mt-4 space-y-4">
              {Object.entries(evidenceGrouped).map(
                ([groupType, items]) => {
                  if (
                    !Array.isArray(items) ||
                    items.length === 0
                  ) {
                    return null;
                  }

                  return (
                    <div
                      key={groupType}
                      className="overflow-hidden rounded-xl border border-slate-200"
                    >
                      <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-2.5">
                        <span className="text-xs font-bold uppercase tracking-wider text-slate-700">
                          {groupType === "LINKEDIN"
                            ? "LinkedIn Profile"
                            : groupType === "EMPLOYEE_SKILL"
                            ? "Declared Skill Claim"
                            : groupType.replaceAll(
                                "_",
                                " "
                              )}
                        </span>

                        <span className="text-xs font-medium text-slate-500">
                          {items.length} item(s)
                        </span>
                      </div>

                      <div className="divide-y divide-slate-100">
                        {items.map((item) => {
                          const snap = item.snapshot || {};

                          return (
                            <div
                              key={
                                item.id ||
                                item.sourceId
                              }
                              className="space-y-2 p-4 text-sm"
                            >
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <span className="font-semibold text-slate-900">
                                  {snap.name ||
                                    snap.originalName ||
                                    snap.githubUrl ||
                                    (groupType ===
                                    "LINKEDIN"
                                      ? "LinkedIn Profile"
                                      : "Evidence Item")}
                                </span>

                                {item.relevanceScore !==
                                  null &&
                                  item.relevanceScore !==
                                    undefined && (
                                    <span className="rounded bg-indigo-50 px-2 py-0.5 font-mono text-xs font-medium text-indigo-600">
                                      Relevance:{" "}
                                      {
                                        item.relevanceScore
                                      }
                                      %
                                    </span>
                                  )}
                              </div>

                              {/* Resume Evidence */}
                              {groupType === "RESUME" && (
                                <div className="space-y-1 text-xs text-slate-600">
                                  <p>
                                    <span className="font-medium text-slate-700">
                                      File:
                                    </span>{" "}
                                    {snap.originalName} (
                                    {Math.round(
                                      (snap.fileSize || 0) /
                                        1024
                                    )}{" "}
                                    KB)
                                  </p>

                                  {snap.extractedSkillExcerpt && (
                                    <p className="mt-1 rounded border border-slate-200 bg-slate-50 p-2.5 font-mono text-[11px] leading-relaxed text-slate-700">
                                      "{snap.extractedSkillExcerpt}"
                                    </p>
                                  )}
                                </div>
                              )}

                              {/* GitHub Evidence */}
                              {groupType === "GITHUB" && (
                                <div className="space-y-2 text-xs text-slate-600">
                                  {snap.githubUrl && (
                                    <p>
                                      <span className="font-medium text-slate-700">
                                        URL:
                                      </span>{" "}
                                      <a
                                        href={snap.githubUrl}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="text-indigo-600 underline"
                                      >
                                        {snap.githubUrl}
                                      </a>
                                    </p>
                                  )}

                                  {snap.relevantRepos &&
                                  snap.relevantRepos.length >
                                    0 ? (
                                    <div className="space-y-1.5 pt-1">
                                      <span className="font-semibold text-slate-800">
                                        Relevant
                                        Repositories:
                                      </span>

                                      {snap.relevantRepos.map(
                                        (repo, idx) => (
                                          <div
                                            key={idx}
                                            className="rounded border border-slate-200 bg-slate-50 p-2"
                                          >
                                            <div className="flex justify-between font-medium text-slate-800">
                                              <span>
                                                {repo.name} (
                                                {repo.primaryLanguage ||
                                                  "Repo"}
                                                )
                                              </span>

                                              {repo.stargazersCount !=
                                                null && (
                                                <span>
                                                  ★{" "}
                                                  {
                                                    repo.stargazersCount
                                                  }
                                                </span>
                                              )}
                                            </div>

                                            {repo.description && (
                                              <p className="mt-0.5 text-slate-500">
                                                {
                                                  repo.description
                                                }
                                              </p>
                                            )}

                                            {repo.readmeExcerpt && (
                                              <p className="mt-1 line-clamp-2 font-mono text-[11px] text-slate-600">
                                                "
                                                {
                                                  repo.readmeExcerpt
                                                }
                                                "
                                              </p>
                                            )}
                                          </div>
                                        )
                                      )}
                                    </div>
                                  ) : (
                                    <p className="text-slate-500">
                                      Public GitHub profile
                                      reference logged.
                                    </p>
                                  )}
                                </div>
                              )}

                              {/* LinkedIn Evidence */}
                              {groupType === "LINKEDIN" && (
                                <p className="text-xs text-slate-600">
                                  <span className="font-medium text-slate-700">
                                    LinkedIn Profile —
                                    Reference provided:
                                  </span>{" "}
                                  {snap.linkedInUrl ? (
                                    <a
                                      href={snap.linkedInUrl}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="text-indigo-600 underline"
                                    >
                                      {snap.linkedInUrl}
                                    </a>
                                  ) : (
                                    "N/A"
                                  )}
                                </p>
                              )}

                              {/* Project Evidence */}
                              {groupType === "PROJECT" && (
                                <div className="space-y-1 text-xs text-slate-600">
                                  <p>
                                    <span className="font-medium text-slate-700">
                                      Description:
                                    </span>{" "}
                                    {snap.description ||
                                      "N/A"}
                                  </p>

                                  {snap.role && (
                                    <p>
                                      <span className="font-medium text-slate-700">
                                        Role:
                                      </span>{" "}
                                      {snap.role}
                                    </p>
                                  )}
                                </div>
                              )}

                              {/* Certificate Evidence */}
                              {groupType === "CERTIFICATE" && (
                                <div className="space-y-1 text-xs text-slate-600">
                                  {snap.issuer && (
                                    <p>
                                      <span className="font-medium text-slate-700">
                                        Issuer:
                                      </span>{" "}
                                      {snap.issuer}
                                    </p>
                                  )}

                                  {snap.credentialUrl && (
                                    <p>
                                      <span className="font-medium text-slate-700">
                                        Credential:
                                      </span>{" "}
                                      <a
                                        href={
                                          snap.credentialUrl
                                        }
                                        target="_blank"
                                        rel="noreferrer"
                                        className="text-indigo-600 underline"
                                      >
                                        {
                                          snap.credentialUrl
                                        }
                                      </a>
                                    </p>
                                  )}
                                </div>
                              )}

                              {item.analysisSummary && (
                                <p className="border-t border-slate-100 pt-1.5 text-xs italic text-slate-500">
                                  Analysis:{" "}
                                  {item.analysisSummary}
                                </p>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                }
              )}
            </div>
          ) : (
            <p className="mt-4 text-sm text-slate-500">
              No additional evidence snapshots logged.
            </p>
          )}
        </section>
      </div>

      {/* Print styling for Download Report */}
      <style>
        {`
          @media print {
            body {
              background: white !important;
            }

            .report-actions {
              display: none !important;
            }

            aside,
            nav,
            header {
              display: none !important;
            }

            * {
              box-shadow: none !important;
            }

            section {
              break-inside: avoid;
            }

            @page {
              size: A4;
              margin: 12mm;
            }
          }
        `}
      </style>
    </DashboardShell>
  );
};

export default VerificationReport;

