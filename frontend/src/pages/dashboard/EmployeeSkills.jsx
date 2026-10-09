import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import DashboardShell from "../../components/ui/DashboardShell";
import Alert from "../../components/ui/Alert";
import Button from "../../components/ui/Button";
import FormField, { inputClasses } from "../../components/ui/FormField";
import { EditIcon, EyeIcon, PlusIcon, TrashIcon } from "../../components/ui/icons";
import {
  deleteCandidateCertificate,
  deleteCandidateSkill,
  deleteEmployeeFile,
  fetchEmployeeFileUrl,
  getCandidateProfile,
  getEmployeeDashboard,
  getSkillVerificationEligibility,
  saveCandidateCertificate,
  saveCandidateSkill,
  uploadEmployeeFile,
} from "../../services/authService";
import { EMPLOYEE_NAV_ITEMS } from "../../constants/employeeNav";
const LEVELS = { BEGINNER: 1, INTERMEDIATE: 2, ADVANCED: 3, EXPERT: 4 };
const PROFICIENCIES = Object.keys(LEVELS);
const EMPTY_SKILL = { name: "", category: "", proficiency: "BEGINNER", yearsOfExperience: "" };
const EMPTY_CERTIFICATE = { name: "", issuer: "", skillId: "", file: null };
const cardClasses = "rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-shadow hover:shadow-md";
const prettyLevel = (value) => value?.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase()) || "Not provided";
const fileType = (file) => file.mimeType?.includes("pdf") ? "PDF" : file.mimeType?.startsWith("image/") ? "IMG" : "FILE";

const EmployeeSkills = () => {
  const [skills, setSkills] = useState([]);
  const [certificates, setCertificates] = useState([]);
  const [eligibilityMap, setEligibilityMap] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [skillForm, setSkillForm] = useState(null);
  const [evidenceForm, setEvidenceForm] = useState(null);
  const [certificateForm, setCertificateForm] = useState(null);
  const [saving, setSaving] = useState(false);

  const fetchSkillEligibilities = async (skillList) => {
    const map = {};
    await Promise.all(
      skillList.map(async (skill) => {
        try {
          const res = await getSkillVerificationEligibility(skill.id);
          if (res?.data) {
            map[skill.id] = res.data;
          }
        } catch {
          // ignore individual skill eligibility fetch error
        }
      })
    );
    setEligibilityMap(map);
    return map;
  };

  const loadData = async () => {
    setLoading(true);
    setError("");
    try {
      const [dashboard, profile] = await Promise.all([getEmployeeDashboard(), getCandidateProfile()]);
      const loadedSkills = dashboard?.data?.skills ?? [];
      setSkills(loadedSkills);
      setCertificates(profile?.data?.profile?.certificates ?? []);
      await fetchSkillEligibilities(loadedSkills);
    } catch {
      setError("Unable to load your Candidate data.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let mounted = true;
    const init = async () => {
      try {
        const [dashboard, profile] = await Promise.all([getEmployeeDashboard(), getCandidateProfile()]);
        if (!mounted) return;
        const loadedSkills = dashboard?.data?.skills ?? [];
        setSkills(loadedSkills);
        setCertificates(profile?.data?.profile?.certificates ?? []);
        await fetchSkillEligibilities(loadedSkills);
      } catch {
        if (mounted) setError("Unable to load your Candidate data.");
      } finally {
        if (mounted) setLoading(false);
      }
    };
    init();
    return () => { mounted = false; };
  }, []);

  const saveSkill = async (event) => {
    event.preventDefault();
    if (!skillForm.name.trim()) return;
    setSaving(true);
    try {
      await saveCandidateSkill({ name: skillForm.name.trim(), category: skillForm.category.trim() || null, proficiency: skillForm.proficiency, yearsOfExperience: skillForm.yearsOfExperience === "" ? null : Number(skillForm.yearsOfExperience) }, skillForm.id);
      setSkillForm(null); setNotice("Skill saved."); loadData();
    } catch (requestError) { setError(requestError.response?.data?.message ?? "Unable to save this skill."); }
    finally { setSaving(false); }
  };

  const deleteSkill = async (skill) => {
    if (!window.confirm(`Delete ${skill.name}? This also removes its linked evidence and certificates.`)) return;
    try { await deleteCandidateSkill(skill.id); setNotice("Skill deleted."); loadData(); }
    catch (requestError) { setError(requestError.response?.data?.message ?? "Unable to delete this skill."); }
  };

  const addEvidence = async (event) => {
    event.preventDefault();
    if (!evidenceForm.file) return;
    setSaving(true);
    try { await uploadEmployeeFile({ category: "SKILL_EVIDENCE", skillId: evidenceForm.skillId, file: evidenceForm.file }); setEvidenceForm(null); setNotice("Evidence added."); loadData(); }
    catch (requestError) { setError(requestError.response?.data?.message ?? "Unable to add evidence."); }
    finally { setSaving(false); }
  };

  const saveCertificate = async (event) => {
    event.preventDefault();
    if (!certificateForm.name.trim()) return;
    setSaving(true);
    try {
      const response = await saveCandidateCertificate({ name: certificateForm.name.trim(), issuer: certificateForm.issuer.trim() || null, skillId: certificateForm.skillId || null }, certificateForm.id);
      const certificate = response?.data?.item ?? response?.data;
      if (certificateForm.file && certificate?.id) {
        await uploadEmployeeFile({ category: "OTHER_CERTIFICATE", certificateId: certificate.id, file: certificateForm.file });
        if (certificateForm.existingFileId) await deleteEmployeeFile(certificateForm.existingFileId);
      }
      setCertificateForm(null); setNotice("Certificate saved."); loadData();
    } catch (requestError) { setError(requestError.response?.data?.message ?? "Unable to save this certificate."); }
    finally { setSaving(false); }
  };

  const deleteCertificate = async (certificate) => {
    if (!window.confirm(`Delete certificate ${certificate.name}? Its files will also be removed.`)) return;
    try { await deleteCandidateCertificate(certificate.id); setNotice("Certificate deleted."); loadData(); }
    catch (requestError) { setError(requestError.response?.data?.message ?? "Unable to delete this certificate."); }
  };

  const fileAction = async (file, disposition = "view") => {
    try {
      const url = await fetchEmployeeFileUrl(file.id, disposition);
      if (disposition === "view") { window.open(url, "_blank", "noopener,noreferrer"); window.setTimeout(() => URL.revokeObjectURL(url), 60_000); return; }
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = file.originalName || "evidence"; document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url);
    } catch { setError("Unable to open this file."); }
  };

  const deleteFile = async (file) => {
    if (!window.confirm(`Delete ${file.originalName}? The skill or certificate will remain.`)) return;
    try { await deleteEmployeeFile(file.id); setNotice("Evidence file deleted."); loadData(); }
    catch (requestError) { setError(requestError.response?.data?.message ?? "Unable to delete this file."); }
  };

  const replaceFile = (file, skillId, certificateId) => {
    const input = document.createElement("input"); input.type = "file"; input.accept = ".jpg,.jpeg,.png,.webp,.pdf,.txt,.doc,.docx,.xls,.xlsx";
    input.onchange = async () => { const nextFile = input.files?.[0]; if (!nextFile) return; try { await uploadEmployeeFile({ category: certificateId ? "OTHER_CERTIFICATE" : "SKILL_EVIDENCE", skillId, certificateId, file: nextFile }); await deleteEmployeeFile(file.id); setNotice("Evidence file replaced."); loadData(); } catch (requestError) { setError(requestError.response?.data?.message ?? "Unable to replace this file."); } };
    input.click();
  };

  if (loading) return <div className="p-10 text-sm text-slate-500">Loading Skills...</div>;
  if (error && skills.length === 0) return <div className="p-10"><Alert variant="error">{error}</Alert><Button type="button" variant="outline" size="sm" className="mt-4" onClick={loadData}>Try Again</Button></div>;

  return <DashboardShell roleLabel="Candidate" title="Skills" description="Build a clear record of your skills, projects, and supporting evidence." navItems={EMPLOYEE_NAV_ITEMS}>
    <div className="space-y-6">
      {error && <Alert variant="error">{error}</Alert>}{notice && <Alert variant="success">{notice}</Alert>}
      <div className="flex flex-wrap items-center justify-between gap-4"><div><p className="text-sm font-semibold uppercase tracking-wide text-indigo-600">Your Technical Skills</p><p className="mt-1 text-sm text-slate-500">{skills.length} skill{skills.length === 1 ? "" : "s"} in your profile</p></div><Button type="button" onClick={() => setSkillForm({ ...EMPTY_SKILL })}><PlusIcon className="h-4 w-4" />Add Skill</Button></div>
      {skillForm && <form className={cardClasses} onSubmit={saveSkill}><h2 className="font-display text-lg font-bold text-slate-900">{skillForm.id ? "Edit Skill" : "Add Skill"}</h2><div className="mt-5 grid gap-4 md:grid-cols-2"><FormField label="Name" required><input className={inputClasses} value={skillForm.name} onChange={(event) => setSkillForm({ ...skillForm, name: event.target.value })} /></FormField><FormField label="Category"><input className={inputClasses} value={skillForm.category || ""} onChange={(event) => setSkillForm({ ...skillForm, category: event.target.value })} /></FormField><FormField label="Proficiency" required><select className={inputClasses} value={skillForm.proficiency || "BEGINNER"} onChange={(event) => setSkillForm({ ...skillForm, proficiency: event.target.value })}>{PROFICIENCIES.map((value) => <option key={value} value={value}>{prettyLevel(value)}</option>)}</select></FormField><FormField label="Years of experience"><input className={inputClasses} type="number" min="0" max="80" value={skillForm.yearsOfExperience ?? ""} onChange={(event) => setSkillForm({ ...skillForm, yearsOfExperience: event.target.value })} /></FormField></div><div className="mt-5 flex justify-end"><Button type="submit" disabled={saving}>{saving ? "Saving..." : "Save Skill"}</Button></div></form>}
      {skills.length === 0 ? <div className={`${cardClasses} text-center`}><p className="font-display text-lg font-bold text-slate-900">Build your skills passport</p><p className="mt-2 text-sm text-slate-500">Add your first skill to showcase your expertise.</p><Button type="button" className="mt-5" onClick={() => setSkillForm({ ...EMPTY_SKILL })}><PlusIcon className="h-4 w-4" />Add Skill</Button></div> : <div className="grid gap-6 xl:grid-cols-2">{skills.map((skill) => {
        const skillCertificates = certificates.filter(({ skillId }) => skillId === skill.id);
        const certificateFiles = skillCertificates.flatMap((certificate) => (certificate.files ?? []).map((file) => ({ ...file, certificateId: certificate.id, certificateName: certificate.name })));
        const evidence = [...(skill.evidenceFiles ?? []), ...certificateFiles].filter((file, index, all) => all.findIndex(({ id }) => id === file.id) === index);
        const level = LEVELS[skill.proficiency] ?? 0;
        const eligibility = eligibilityMap[skill.id];

        return <article key={skill.id} className={cardClasses}>
          <div className="flex items-start justify-between gap-4">
            <div><h2 className="font-display text-xl font-bold text-slate-900">{skill.name}</h2><p className="mt-1 text-sm text-slate-500">{skill.category || "Uncategorized"}</p></div>
            <div className="flex gap-1">
              <Button type="button" variant="ghost" size="sm" onClick={() => setSkillForm({ ...skill })} aria-label={`Edit ${skill.name}`}><EditIcon className="h-4 w-4" /></Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => deleteSkill(skill)} aria-label={`Delete ${skill.name}`}><TrashIcon className="h-4 w-4 text-rose-600" /></Button>
            </div>
          </div>
          <div className="mt-5 border-y border-slate-100 py-4">
            <div className="flex justify-between text-sm"><span className="font-semibold text-slate-900">{prettyLevel(skill.proficiency)}</span><span className="text-slate-500">{skill.yearsOfExperience != null ? `${skill.yearsOfExperience} years experience` : "Experience not provided"}</span></div>
            <div className="mt-3 flex gap-1.5">{[1, 2, 3, 4].map((item) => <span key={item} className={`h-2 flex-1 rounded-full ${item <= level ? "bg-indigo-600" : "bg-slate-100"}`} />)}</div>
          </div>
          <div className="mt-5">
            <h3 className="text-sm font-semibold text-slate-900">Projects</h3>
            {skill.projects?.length ? <div className="mt-2 flex flex-wrap gap-2">{skill.projects.map((project) => <Link key={project.id} to={`/employee/projects#project-${project.id}`} className="rounded-full bg-indigo-50 px-3 py-1.5 text-sm font-medium text-indigo-700 hover:bg-indigo-100">{project.name}</Link>)}</div> : <p className="mt-2 text-sm text-slate-500">No projects linked yet</p>}
          </div>
          <div className="mt-5">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-slate-900">Evidence <span className="font-normal text-slate-400">({evidence.length})</span></h3>
              <div className="flex gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => setEvidenceForm({ skillId: skill.id, file: null })}><PlusIcon className="h-4 w-4" />Add Evidence</Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setCertificateForm({ ...EMPTY_CERTIFICATE, skillId: skill.id })}>Add Certificate</Button>
              </div>
            </div>
            {evidence.length ? <div className="mt-3 grid gap-3 sm:grid-cols-2">{evidence.map((file) => <div key={file.id} className="rounded-xl border border-slate-200 p-3"><div className="flex items-center gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-50 text-xs font-bold text-indigo-700">{fileType(file)}</span><span className="min-w-0 truncate text-sm font-medium text-slate-700">{file.originalName}</span></div><p className="mt-2 text-xs text-slate-500">{file.certificateId ? `Certificate: ${file.certificateName}` : "Evidence File"}</p><div className="mt-3 flex flex-wrap gap-1"><Button type="button" variant="ghost" size="sm" onClick={() => fileAction(file)}><EyeIcon className="h-4 w-4" />View</Button><Button type="button" variant="ghost" size="sm" onClick={() => fileAction(file, "download")}>Download</Button><Button type="button" variant="ghost" size="sm" onClick={() => replaceFile(file, skill.id, file.certificateId)}>Replace</Button><Button type="button" variant="ghost" size="sm" onClick={() => deleteFile(file)}>Delete</Button></div></div>)}</div> : <p className="mt-3 text-sm text-slate-500">No evidence provided</p>}
            {skillCertificates.length > 0 && (
              <div className="mt-3 space-y-2">
                {skillCertificates.map((certificate) => (
                  <div key={certificate.id} className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2">
                    <span className="truncate text-sm text-slate-700">{certificate.name}</span>
                    <span className="flex gap-1">
                      <Button type="button" variant="ghost" size="sm" onClick={() => setCertificateForm({ id: certificate.id, name: certificate.name, issuer: certificate.issuer || "", skillId: certificate.skillId || skill.id, existingFileId: certificate.files?.[0]?.id || "", file: null })}><EditIcon className="h-4 w-4" /></Button>
                      <Button type="button" variant="ghost" size="sm" onClick={() => deleteCertificate(certificate)}><TrashIcon className="h-4 w-4 text-rose-600" /></Button>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="mt-5 border-t border-slate-100 pt-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              {eligibility?.cancellationInfo?.isBlocked || eligibility?.antiCheatingInfo?.isBlocked ? (
                <div className="flex flex-col gap-1">
                  <span className="rounded-full bg-rose-100 px-2.5 py-0.5 text-xs font-semibold text-rose-800">
                    {eligibility?.antiCheatingInfo?.isBlocked
                      ? "Blocked (Anti-Cheating)"
                      : "Blocked (7-Day Limit)"}
                  </span>
                  <span className="text-[11px] font-medium text-rose-600">
                    Available again in{" "}
                    {(eligibility?.antiCheatingInfo?.isBlocked
                      ? eligibility.antiCheatingInfo
                      : eligibility.cancellationInfo
                    ).blockedRemainingText}
                  </span>
                </div>
              ) : eligibility?.hasCompletedVerification ? (
                <div className="flex items-center gap-2">
                  <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-800">
                    {eligibility.latestReport?.verificationStatus || "VERIFIED"}
                  </span>
                  {eligibility.latestReport?.verificationScore !== null && (
                    <span className="text-xs font-bold text-slate-700">
                      Score: {eligibility.latestReport.verificationScore}%
                    </span>
                  )}
                </div>
              ) : eligibility?.processing ? (
                <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-800">
                  Processing Verification...
                </span>
              ) : eligibility?.hasActiveAttempt ? (
                <span className="rounded-full bg-indigo-100 px-2.5 py-0.5 text-xs font-semibold text-indigo-800">
                  Assessment In Progress
                </span>
              ) : (
                <span className="text-sm font-medium text-slate-500">Not verified yet</span>
              )}
            </div>

            <div className="flex items-center gap-2">
              {eligibility?.cancellationInfo?.isBlocked || eligibility?.antiCheatingInfo?.isBlocked ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled
                  title={
                    eligibility?.antiCheatingInfo?.isBlocked
                      ? `Temporarily blocked due to anti-cheating violations. Available again in ${eligibility.antiCheatingInfo.blockedRemainingText}`
                      : `Temporarily blocked. Available again in ${eligibility.cancellationInfo.blockedRemainingText}`
                  }
                >
                  Blocked ({(eligibility?.antiCheatingInfo?.isBlocked
                    ? eligibility.antiCheatingInfo
                    : eligibility.cancellationInfo
                  ).blockedRemainingText})
                </Button>
              ) : eligibility?.hasActiveAttempt ? (
                <Link to={`/employee/skills/${skill.id}/verify/test/${eligibility.activeAttemptId || "active"}`}>
                  <Button type="button" size="sm">Resume Assessment</Button>
                </Link>
              ) : eligibility?.processing ? (
                <Link to={`/employee/skills/${skill.id}/verify/processing/${eligibility.processingAttemptId || "active"}`}>
                  <Button type="button" size="sm" variant="outline">Analyzing...</Button>
                </Link>
              ) : eligibility?.hasCompletedVerification ? (
                <>
                  {eligibility.latestReport?.id && (
                    <Link to={`/employee/skills/${skill.id}/verify/report/${eligibility.latestReport.id}`}>
                      <Button type="button" size="sm" variant="outline">View Report</Button>
                    </Link>
                  )}
                  {eligibility.eligible ? (
                    <Link to={`/employee/skills/${skill.id}/verify/intro`}>
                      <Button type="button" size="sm" variant="outline">Re-verify</Button>
                    </Link>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled
                      title="No relevant skill changes since last verification"
                    >
                      Re-verify
                    </Button>
                  )}
                </>
              ) : (
                <Link to={`/employee/skills/${skill.id}/verify/intro`}>
                  <Button type="button" size="sm">Verify Skill</Button>
                </Link>
              )}
            </div>
          </div>
        </article>;
      })}</div>}
      {evidenceForm && <form className={cardClasses} onSubmit={addEvidence}><h2 className="font-display text-lg font-bold text-slate-900">Add Evidence File</h2><input className={`${inputClasses} mt-5`} type="file" onChange={(event) => setEvidenceForm({ ...evidenceForm, file: event.target.files?.[0] ?? null })} /><div className="mt-5 flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setEvidenceForm(null)}>Cancel</Button><Button type="submit" disabled={saving}>Upload Evidence</Button></div></form>}
      {certificateForm && <form className={cardClasses} onSubmit={saveCertificate}><h2 className="font-display text-lg font-bold text-slate-900">{certificateForm.id ? "Edit Certificate" : "Add Certificate"}</h2><div className="mt-5 grid gap-4 md:grid-cols-2"><FormField label="Certificate name" required><input className={inputClasses} value={certificateForm.name} onChange={(event) => setCertificateForm({ ...certificateForm, name: event.target.value })} /></FormField><FormField label="Issuer"><input className={inputClasses} value={certificateForm.issuer} onChange={(event) => setCertificateForm({ ...certificateForm, issuer: event.target.value })} /></FormField><FormField label="Associated skill"><select className={inputClasses} value={certificateForm.skillId} onChange={(event) => setCertificateForm({ ...certificateForm, skillId: event.target.value })}><option value="">No associated skill</option>{skills.map((skill) => <option key={skill.id} value={skill.id}>{skill.name}</option>)}</select></FormField><FormField label="Certificate file"><input className={inputClasses} type="file" onChange={(event) => setCertificateForm({ ...certificateForm, file: event.target.files?.[0] ?? null })} /></FormField></div><div className="mt-5 flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setCertificateForm(null)}>Cancel</Button><Button type="submit" disabled={saving}>Save Certificate</Button></div></form>}
    </div>
  </DashboardShell>;
};

export default EmployeeSkills;

