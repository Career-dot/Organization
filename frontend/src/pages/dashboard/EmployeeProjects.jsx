import { useEffect, useState } from "react";
import DashboardShell from "../../components/ui/DashboardShell";
import Alert from "../../components/ui/Alert";
import Button from "../../components/ui/Button";
import FormField, { inputClasses } from "../../components/ui/FormField";
import { EditIcon, EyeIcon, PlusIcon, TrashIcon } from "../../components/ui/icons";
import {
  deleteCandidateProject,
  deleteCandidateProjectSkill,
  deleteEmployeeFile,
  fetchEmployeeFileUrl,
  getEmployeeDashboard,
  saveCandidateProject,
  saveCandidateProjectSkill,
  uploadEmployeeFile,
} from "../../services/authService";
import { EMPLOYEE_NAV_ITEMS } from "../../constants/employeeNav";
const PROFICIENCIES = ["BEGINNER", "INTERMEDIATE", "ADVANCED", "EXPERT"];
const PROJECT_FILE_EXTENSIONS = [".c", ".cpp", ".c++", ".h", ".hpp", ".java", ".py", ".js", ".jsx", ".ts", ".tsx", ".cs", ".php", ".go", ".rs", ".sql", ".html", ".css", ".json", ".xml", ".md", ".txt", ".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".csv", ".jpg", ".jpeg", ".png", ".webp"];
const PROJECT_FILE_ACCEPT = "*/*";
const EMPTY_PROJECT = { name: "", description: "", role: "", link: "", startDate: "", endDate: "", isOngoing: false, projectFile: null };
const EMPTY_ASSOCIATION = { skillId: "", proficiency: "BEGINNER", yearsOfExperience: "" };
const cardClasses = "rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-shadow hover:shadow-md";
const fileType = (file) => file.mimeType?.includes("pdf") ? "PDF" : file.mimeType?.startsWith("image/") ? "IMG" : "FILE";
const inputDate = (value) => value ? new Date(value).toISOString().slice(0, 10) : "";
const apiDate = (value) => value ? new Date(`${value}T00:00:00.000Z`).toISOString() : null;
const validProjectFile = (file) => file && PROJECT_FILE_EXTENSIONS.includes(file.name.slice(file.name.lastIndexOf(".")).toLowerCase()) && file.size <= 10 * 1024 * 1024;

const EmployeeProjects = () => {
  const [projects, setProjects] = useState([]);
  const [skills, setSkills] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [projectForm, setProjectForm] = useState(null);
  const [associationForm, setAssociationForm] = useState(null);
  const [saving, setSaving] = useState(false);

  const loadData = () => {
    setLoading(true); setError("");
    getEmployeeDashboard().then((response) => { setProjects(response?.data?.projects ?? []); setSkills(response?.data?.skills ?? []); }).catch(() => setError("Unable to load your Candidate data.")).finally(() => setLoading(false));
  };

  useEffect(() => {
    let mounted = true;
    getEmployeeDashboard().then((response) => { if (!mounted) return; setProjects(response?.data?.projects ?? []); setSkills(response?.data?.skills ?? []); }).catch(() => mounted && setError("Unable to load your Candidate data.")).finally(() => mounted && setLoading(false));
    return () => { mounted = false; };
  }, []);

  const openProjectForm = (project = null) => {
    setProjectForm(project ? { ...project, startDate: inputDate(project.startDate), endDate: inputDate(project.endDate), projectFile: null } : { ...EMPTY_PROJECT });
    setError("");
  };
  const updateProject = (field, value) => setProjectForm((current) => ({ ...current, [field]: value }));

  const saveProject = async (event) => {
    event.preventDefault();
    if (!projectForm.name.trim() || !projectForm.description.trim()) { setError("Project name and description are required."); return; }
    if (projectForm.projectFile && !validProjectFile(projectForm.projectFile)) { setError("This project file type is not supported or exceeds 10 MB."); return; }
    setSaving(true);
    try {
      const response = await saveCandidateProject({ name: projectForm.name.trim(), description: projectForm.description.trim(), role: projectForm.role.trim() || null, link: projectForm.link.trim() || null, startDate: apiDate(projectForm.startDate), endDate: apiDate(projectForm.endDate), isOngoing: projectForm.isOngoing }, projectForm.id);
      const project = response?.data?.item ?? response?.data;
      if (!project?.id) throw new Error("Project was not returned by the server.");
      if (projectForm.projectFile) await uploadEmployeeFile({ category: "PROJECT_FILE", projectId: project.id, file: projectForm.projectFile });
      setProjectForm(null); setNotice("Project saved."); loadData();
    } catch (requestError) { setError(requestError.response?.data?.message ?? requestError.message ?? "Unable to save this project."); }
    finally { setSaving(false); }
  };

  const saveAssociation = async (event) => {
    event.preventDefault();
    if (!associationForm.skillId) { setError("Select a Candidate skill."); return; }
    setSaving(true);
    try {
      await saveCandidateProjectSkill(associationForm.projectId, { skillId: associationForm.skillId, proficiency: associationForm.proficiency, yearsOfExperience: associationForm.yearsOfExperience === "" ? null : Number(associationForm.yearsOfExperience) }, associationForm.id);
      setAssociationForm(null); setNotice("Project skill saved."); loadData();
    } catch (requestError) { setError(requestError.response?.data?.message ?? "Unable to save this project skill."); }
    finally { setSaving(false); }
  };

  const removeAssociation = async (project, association) => {
    if (!window.confirm("Remove this skill from the project? The global Candidate Skill will remain.")) return;
    try { await deleteCandidateProjectSkill(project.id, association.id); setNotice("Project skill removed."); loadData(); }
    catch (requestError) { setError(requestError.response?.data?.message ?? "Unable to remove this project skill."); }
  };

  const removeProject = async (project) => {
    if (!window.confirm(`Delete ${project.name}? Its project evidence will also be removed.`)) return;
    try { await deleteCandidateProject(project.id); setProjects((current) => current.filter(({ id }) => id !== project.id)); setNotice("Project deleted."); }
    catch (requestError) { setError(requestError.response?.data?.message ?? "Unable to delete this project."); }
  };

  const openFile = async (file, disposition = "view") => {
    try { const url = await fetchEmployeeFileUrl(file.id, disposition); if (disposition === "view") { window.open(url, "_blank", "noopener,noreferrer"); window.setTimeout(() => URL.revokeObjectURL(url), 60_000); return; } const anchor = document.createElement("a"); anchor.href = url; anchor.download = file.originalName || "project-file"; document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url); }
    catch { setError("Unable to open this file."); }
  };
  const addFile = async (projectId, file) => { console.log("[PROJECT FILE DEBUG]", {
    name: file?.name,
    type: file?.type,
    size: file?.size,
    sizeMB: file?.size ? (file.size / (1024 * 1024)).toFixed(2) : null,
    extension: file?.name
      ? file.name.slice(file.name.lastIndexOf(".")).toLowerCase()
      : null,
    allowed: file?.name
      ? PROJECT_FILE_EXTENSIONS.includes(
          file.name.slice(file.name.lastIndexOf(".")).toLowerCase()
        )
      : false,
  }); if (!validProjectFile(file)) { setError("This project file type is not supported or exceeds 10 MB."); return; } try { await uploadEmployeeFile({ category: "PROJECT_FILE", projectId, file }); setNotice("Project file added."); loadData(); } catch (requestError) { setError(requestError.response?.data?.message ?? "Unable to add this file."); } };
  const deleteFile = async (file) => { if (!window.confirm(`Delete ${file.originalName}? The project will remain.`)) return; try { await deleteEmployeeFile(file.id); setNotice("Project file deleted."); loadData(); } catch (requestError) { setError(requestError.response?.data?.message ?? "Unable to delete this file."); } };
  const replaceFile = (file, projectId) => { const input = document.createElement("input"); input.type = "file"; input.accept = PROJECT_FILE_ACCEPT; input.onchange = async () => { const nextFile = input.files?.[0]; if (!validProjectFile(nextFile)) { setError("This project file type is not supported or exceeds 10 MB."); return; } try { await uploadEmployeeFile({ category: "PROJECT_FILE", projectId, file: nextFile }); await deleteEmployeeFile(file.id); setNotice("Project file replaced."); loadData(); } catch (requestError) { setError(requestError.response?.data?.message ?? "Unable to replace this file."); } }; input.click(); };

  if (loading) return <div className="p-10 text-sm text-slate-500">Loading Projects...</div>;
  if (error && projects.length === 0) return <div className="p-10"><Alert variant="error">{error}</Alert><Button type="button" variant="outline" size="sm" className="mt-4" onClick={loadData}>Try Again</Button></div>;

  return <DashboardShell roleLabel="Candidate" title="My Projects" description="Projects you've added to showcase your experience and support your skills." navItems={EMPLOYEE_NAV_ITEMS}>
    <div className="space-y-6">
      {error && <Alert variant="error">{error}</Alert>}{notice && <Alert variant="success">{notice}</Alert>}
      <div className="flex flex-wrap items-center justify-between gap-4"><div><p className="text-sm font-semibold uppercase tracking-wide text-indigo-600">Portfolio Evidence</p><p className="mt-1 text-sm text-slate-500">{projects.length} project{projects.length === 1 ? "" : "s"} in your profile</p></div><Button type="button" onClick={() => openProjectForm()}><PlusIcon className="h-4 w-4" />Add Project</Button></div>
      {projectForm && <form className={cardClasses} onSubmit={saveProject}><h2 className="font-display text-lg font-bold text-slate-900">{projectForm.id ? "Edit Project" : "Add Project"}</h2><div className="mt-5 grid gap-4 md:grid-cols-2"><FormField label="Project name" required><input className={inputClasses} value={projectForm.name} onChange={(event) => updateProject("name", event.target.value)} /></FormField><FormField label="Role"><input className={inputClasses} value={projectForm.role || ""} onChange={(event) => updateProject("role", event.target.value)} /></FormField><FormField label="Project URL"><input className={inputClasses} type="url" value={projectForm.link || ""} onChange={(event) => updateProject("link", event.target.value)} /></FormField><FormField label="Project file"><input className={inputClasses} type="file" accept={PROJECT_FILE_ACCEPT} onChange={(event) => updateProject("projectFile", event.target.files?.[0] ?? null)} /></FormField><FormField label="Start date"><input className={inputClasses} type="date" value={projectForm.startDate} onChange={(event) => updateProject("startDate", event.target.value)} /></FormField><FormField label="End date"><input className={inputClasses} type="date" value={projectForm.endDate} onChange={(event) => updateProject("endDate", event.target.value)} /></FormField></div><label className="mt-4 flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={projectForm.isOngoing} onChange={(event) => updateProject("isOngoing", event.target.checked)} />This project is ongoing</label><FormField label="Description" required><textarea className={`${inputClasses} mt-2 min-h-28`} value={projectForm.description} onChange={(event) => updateProject("description", event.target.value)} /></FormField><div className="mt-5 flex justify-end"><Button type="submit" disabled={saving}>{saving ? "Saving..." : "Save Project"}</Button></div></form>}
      {associationForm && <form className={cardClasses} onSubmit={saveAssociation}><h2 className="font-display text-lg font-bold text-slate-900">{associationForm.id ? "Edit Project Skill" : "Add Project Skill"}</h2><div className="mt-5 grid gap-4 md:grid-cols-3"><FormField label="Select skill" required><select className={inputClasses} value={associationForm.skillId} onChange={(event) => setAssociationForm({ ...associationForm, skillId: event.target.value })}><option value="">Choose a skill</option>{skills.map((skill) => <option key={skill.id} value={skill.id}>{skill.name}</option>)}</select></FormField><FormField label="Proficiency" required><select className={inputClasses} value={associationForm.proficiency} onChange={(event) => setAssociationForm({ ...associationForm, proficiency: event.target.value })}>{PROFICIENCIES.map((value) => <option key={value}>{value}</option>)}</select></FormField><FormField label="Years of experience"><input className={inputClasses} type="number" min="0" max="80" value={associationForm.yearsOfExperience ?? ""} onChange={(event) => setAssociationForm({ ...associationForm, yearsOfExperience: event.target.value })} /></FormField></div><div className="mt-5 flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setAssociationForm(null)}>Cancel</Button><Button type="submit" disabled={saving}>Save</Button></div></form>}
      {projects.length === 0 ? <div className={`${cardClasses} text-center`}><p className="font-display text-lg font-bold text-slate-900">Showcase your work</p><p className="mt-2 text-sm text-slate-500">Add your first project and connect it to your skills.</p><Button type="button" className="mt-5" onClick={() => openProjectForm()}><PlusIcon className="h-4 w-4" />Add Project</Button></div> : <div className="grid gap-6 lg:grid-cols-2">{projects.map((project) => <article id={`project-${project.id}`} key={project.id} className={`${cardClasses} scroll-mt-6`}><div className="flex items-start justify-between gap-4"><div><h2 className="font-display text-xl font-bold text-slate-900">{project.name}</h2>{project.role && <p className="mt-1 text-sm font-medium text-indigo-700">{project.role}</p>}</div><div className="flex gap-1"><Button type="button" variant="ghost" size="sm" onClick={() => openProjectForm(project)} aria-label={`Edit ${project.name}`}><EditIcon className="h-4 w-4" /></Button><Button type="button" variant="ghost" size="sm" onClick={() => removeProject(project)} aria-label={`Delete ${project.name}`}><TrashIcon className="h-4 w-4 text-rose-600" /></Button></div></div><p className="mt-4 text-sm leading-6 text-slate-600">{project.description}</p>{project.link && <a className="mt-3 inline-block text-sm font-medium text-indigo-700" href={project.link} target="_blank" rel="noreferrer">View project link</a>}<div className="mt-5"><div className="flex items-center justify-between"><h3 className="text-sm font-semibold text-slate-900">Project Skills</h3><Button type="button" variant="ghost" size="sm" onClick={() => setAssociationForm({ ...EMPTY_ASSOCIATION, projectId: project.id })}><PlusIcon className="h-4 w-4" />Add Skill</Button></div>{project.skills?.length ? <div className="mt-3 space-y-2">{project.skills.map((item) => <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2"><div><p className="font-medium text-slate-700">{item.customSkillName || skills.find(({ id }) => id === item.skillId)?.name || "Linked skill"}</p><p className="text-xs text-slate-500">{item.proficiency || "Not provided"} · {item.yearsOfExperience ?? 0} years</p></div><div className="flex gap-1"><Button type="button" variant="ghost" size="sm" onClick={() => setAssociationForm({ ...item, projectId: project.id, skillId: item.skillId || "" })}><EditIcon className="h-4 w-4" /></Button><Button type="button" variant="ghost" size="sm" onClick={() => removeAssociation(project, item)}><TrashIcon className="h-4 w-4 text-rose-600" /></Button></div></div>)}</div> : <p className="mt-3 text-sm text-slate-500">No skills linked yet</p>}</div><div className="mt-5"><div className="flex items-center justify-between"><h3 className="text-sm font-semibold text-slate-900">Evidence</h3><label className="inline-flex cursor-pointer items-center gap-1 text-sm font-semibold text-indigo-700"><PlusIcon className="h-4 w-4" />Add file<input className="sr-only" type="file" accept={PROJECT_FILE_ACCEPT} onChange={(event) => { addFile(project.id, event.target.files?.[0]); event.target.value = ""; }} /></label></div>{project.files?.length ? <div className="mt-3 grid gap-3 sm:grid-cols-2">{project.files.map((file) => <div key={file.id} className="rounded-xl border border-slate-200 p-3"><div className="flex items-center gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-50 text-xs font-bold text-indigo-700">{fileType(file)}</span><span className="min-w-0 truncate text-sm text-slate-700">{file.originalName}</span></div><div className="mt-3 flex flex-wrap gap-1"><Button type="button" variant="ghost" size="sm" onClick={() => openFile(file)}><EyeIcon className="h-4 w-4" />View</Button><Button type="button" variant="ghost" size="sm" onClick={() => openFile(file, "download")}>Download</Button><Button type="button" variant="ghost" size="sm" onClick={() => replaceFile(file, project.id)}>Replace</Button><Button type="button" variant="ghost" size="sm" onClick={() => deleteFile(file)}>Delete</Button></div></div>)}</div> : <p className="mt-3 text-sm text-slate-500">No evidence files added</p>}</div><p className="mt-5 border-t border-slate-100 pt-4 text-sm font-medium text-slate-600">Not verified</p></article>)}</div>}
    </div>
  </DashboardShell>;
};

export default EmployeeProjects;
