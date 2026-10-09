import { useEffect, useState } from "react";
import DashboardShell from "../../components/ui/DashboardShell";
import Alert from "../../components/ui/Alert";
import Button from "../../components/ui/Button";
import FormField, { inputClasses } from "../../components/ui/FormField";
import { EyeIcon, TrashIcon } from "../../components/ui/icons";
import { EMPLOYEE_NAV_ITEMS } from "../../constants/employeeNav";
import {
  deleteCandidateResume,
  fetchEmployeeFileUrl,
  getCandidateCareerLinks,
  linkCandidateResume,
  saveCandidateCareerLinks,
  uploadEmployeeFile,
} from "../../services/authService";


const RESUME_ACCEPT = ".pdf,.doc,.docx,.txt,.jpg,.jpeg,.png,.webp";
const cardClasses = "rounded-2xl border border-slate-200 bg-white p-6 shadow-sm";
const fileType = (file) => file?.mimeType?.includes("pdf") ? "PDF" : file?.mimeType?.startsWith("image/") ? "IMG" : "FILE";
const formatBytes = (bytes = 0) => bytes > 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

const EmployeeCareerLinks = () => {
  const [links, setLinks] = useState({ githubUrl: "", linkedInUrl: "", resumeFileId: "" });
  const [resume, setResume] = useState(null);
  const [form, setForm] = useState({ githubUrl: "", linkedInUrl: "" });
  const [resumeFile, setResumeFile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [savingLinks, setSavingLinks] = useState(false);
  const [savingResume, setSavingResume] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let mounted = true;
    getCandidateCareerLinks().then((response) => {
      if (!mounted) return;
      const data = response?.data ?? {};
      setLinks(data.careerLinks ?? { githubUrl: "", linkedInUrl: "", resumeFileId: "" });
      setForm({ githubUrl: data.careerLinks?.githubUrl ?? "", linkedInUrl: data.careerLinks?.linkedInUrl ?? "" });
      setResume(data.resume ?? null);
    }).catch(() => mounted && setError("Unable to load your Career Links.")).finally(() => mounted && setLoading(false));
    return () => { mounted = false; };
  }, []);

  const saveLinks = async (event) => {
    event.preventDefault(); setSavingLinks(true); setError(""); setNotice("");
    try { const response = await saveCandidateCareerLinks(form); const data = response?.data ?? {}; setLinks(data.careerLinks ?? { ...links, ...form }); setResume(data.resume ?? resume); setNotice("Career links saved."); }
    catch (requestError) { setError(requestError.response?.data?.message ?? "Unable to save your Career Links."); }
    finally { setSavingLinks(false); }
  };

  const saveResume = async (event) => {
    event.preventDefault();
    if (!resumeFile || resumeFile.size > 10 * 1024 * 1024) { setError("Choose a resume file under 10 MB."); return; }
    setSavingResume(true); setError(""); setNotice("");
    try {
      const upload = await uploadEmployeeFile({ category: "OTHER", file: resumeFile });
      const uploaded = upload?.data ?? upload;
      if (!uploaded?.id) throw new Error("Resume upload did not return a file ID.");
      const response = await linkCandidateResume(uploaded.id);
      const data = response?.data ?? {};
      setLinks(data.careerLinks ?? links); setResume(data.resume ?? uploaded); setResumeFile(null); setNotice(resume ? "Resume replaced." : "Resume uploaded.");
    } catch (requestError) { setError(requestError.response?.data?.message ?? requestError.message ?? "Unable to upload your resume."); }
    finally { setSavingResume(false); }
  };

  const viewResume = async (disposition = "view") => {
    if (!resume?.id) return;
    try { const url = await fetchEmployeeFileUrl(resume.id, disposition); if (disposition === "view") { window.open(url, "_blank", "noopener,noreferrer"); window.setTimeout(() => URL.revokeObjectURL(url), 60_000); return; } const anchor = document.createElement("a"); anchor.href = url; anchor.download = resume.originalName || "resume"; document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url); }
    catch { setError("Unable to open your resume."); }
  };

  const removeResume = async () => {
    if (!window.confirm("Delete your current resume?")) return;
    try { await deleteCandidateResume(); setResume(null); setLinks((current) => ({ ...current, resumeFileId: "" })); setNotice("Resume deleted."); }
    catch (requestError) { setError(requestError.response?.data?.message ?? "Unable to delete your resume."); }
  };

  if (loading) return <div className="p-10 text-sm text-slate-500">Loading Career Links...</div>;
  return <DashboardShell roleLabel="Candidate" title="Career Links" description="Build your professional presence by connecting your developer profiles and keeping your current resume up to date." navItems={EMPLOYEE_NAV_ITEMS}>
    <div className="space-y-6">
      {error && <Alert variant="error">{error}</Alert>}{notice && <Alert variant="success">{notice}</Alert>}
      <form className={cardClasses} onSubmit={saveLinks}><h2 className="font-display text-lg font-bold text-slate-900">Professional profiles</h2><div className="mt-5 grid gap-5 md:grid-cols-2"><FormField label="GitHub profile"><input className={inputClasses} type="url" placeholder="https://github.com/username" value={form.githubUrl} onChange={(event) => setForm({ ...form, githubUrl: event.target.value })} /></FormField><FormField label="LinkedIn profile"><input className={inputClasses} type="url" placeholder="https://linkedin.com/in/username" value={form.linkedInUrl} onChange={(event) => setForm({ ...form, linkedInUrl: event.target.value })} /></FormField></div><div className="mt-5 flex justify-end"><Button type="submit" disabled={savingLinks}>{savingLinks ? "Saving..." : "Save Changes"}</Button></div></form>
      <section className={cardClasses}><div className="flex items-start justify-between gap-4"><div><h2 className="font-display text-lg font-bold text-slate-900">Resume</h2><p className="mt-1 text-sm text-slate-500">Keep one current resume available for your professional profile.</p></div>{resume && <span className="rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700">Current resume</span>}</div>{resume ? <div className="mt-5 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-200 bg-slate-50 p-4"><div className="flex items-center gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-50 text-xs font-bold text-indigo-700">{fileType(resume)}</span><div><p className="font-semibold text-slate-800">{resume.originalName}</p><p className="text-sm text-slate-500">{resume.mimeType} · {formatBytes(resume.fileSize)}</p></div></div><div className="flex flex-wrap gap-2"><Button type="button" variant="ghost" size="sm" onClick={() => viewResume()}><EyeIcon className="h-4 w-4" />View</Button><Button type="button" variant="ghost" size="sm" onClick={() => viewResume("download")}>Download</Button><Button type="button" variant="outline" size="sm" onClick={() => document.getElementById("resume-replace").click()}>Replace</Button><Button type="button" variant="ghost" size="sm" onClick={removeResume}><TrashIcon className="h-4 w-4 text-rose-600" />Delete</Button></div><input id="resume-replace" className="sr-only" type="file" accept={RESUME_ACCEPT} onChange={(event) => { setResumeFile(event.target.files?.[0] ?? null); event.target.value = ""; }} /></div> : <div className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-6 text-center"><p className="font-semibold text-slate-800">No resume uploaded yet.</p><p className="mt-1 text-sm text-slate-500">Upload your current resume so recruiters can review your professional experience.</p></div>}<form className="mt-5 flex flex-wrap items-center gap-3" onSubmit={saveResume}><input className={`${inputClasses} min-w-0 flex-1`} type="file" accept={RESUME_ACCEPT} onChange={(event) => setResumeFile(event.target.files?.[0] ?? null)} />{resumeFile && <span className="text-sm text-slate-500">{resumeFile.name}</span>}<Button type="submit" disabled={savingResume}>{savingResume ? "Uploading..." : resume ? "Save Replacement" : "Upload Resume"}</Button></form></section>
    </div>
  </DashboardShell>;
};

export default EmployeeCareerLinks;
