import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import Container from "../../components/ui/Container";
import Alert from "../../components/ui/Alert";
import { inputClasses } from "../../components/ui/FormField";
import { extractApiErrorMessage } from "../../utils/apiError";
import { useAuth } from "../../hooks/useAuth";
import {
  deleteCandidateCertificate,
  deleteCandidateEducation,
  deleteCandidateProject,
  deleteCandidateProjectSkill,
  deleteCandidateSkill,
  deleteEmployeeFile,
  fetchEmployeeFileUrl,
  getCandidateProfile,
  getCandidateProfileCompletion,
  getCurrentUser,
  listEmployeeFiles,
  markCandidateProfileComplete,
  saveCandidateCertificate,
  saveCandidateEducation,
  saveCandidateProfileSection,
  saveCandidateProject,
  saveCandidateProjectSkill,
  saveCandidateSkill,
  uploadEmployeeFile,
} from "../../services/authService";

const PROFICIENCIES = ["BEGINNER", "INTERMEDIATE", "ADVANCED", "EXPERT"];
const AVAILABILITY = ["ACTIVELY_LOOKING", "OPEN_TO_OPPORTUNITIES", "EMPLOYED_NOT_LOOKING", "FREELANCE_AVAILABLE"];
const STEPS = ["Basics", "Professional", "Education", "Skills", "Projects", "Certificates", "Review"];
const MISSING = {
  profileImage: "Profile picture required",
  age: "Age required",
  phone: "Phone number required",
  city: "City required",
  country: "Country required",
  headline: "Professional headline required",
  bio: "Professional description required",
  careerInformation: "Career information required",
  availability: "Availability required",
  education: "At least one education record required",
  skills: "At least one skill required",
  projects: "At least one project required",
  skillVerification: "Skill verification required",
};

const EMPTY = {
  education: { school: "", degree: "", fieldOfStudy: "", startDate: "", endDate: "", isCurrent: false, grade: "", description: "" },
  skill: { name: "", category: "", proficiency: "BEGINNER", yearsOfExperience: "", skillEvidenceFile: null, skillCertificateFile: null },
  project: { name: "", description: "", role: "", link: "", startDate: "", endDate: "", isOngoing: false, projectFile: null },
  certificate: { name: "", issuer: "", issueDate: "", expiryDate: "", credentialId: "", credentialUrl: "", description: "", skillId: "", certificateFile: null },
};

const VALIDATION_MESSAGES = {
  PROFILE_IMAGE: "Choose a JPG, JPEG, PNG, or WEBP image under 2 MB.",
  SKILL_EVIDENCE: "Skill evidence files must be 10 MB or smaller.",
  OTHER_CERTIFICATE: "Certificates must be an image or PDF.",
  PROJECT_FILE: "Project files must be a supported code, document, or image file under 10 MB.",
};

const FILE_ACCEPTS = {
  PROFILE_IMAGE: ".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp",
  SKILL_EVIDENCE: ".jpg,.jpeg,.png,.webp,.pdf,.txt,.doc,.docx,.xls,.xlsx,image/jpeg,image/png,image/webp,application/pdf,text/plain,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  OTHER_CERTIFICATE: ".jpg,.jpeg,.png,.webp,.pdf,image/jpeg,image/png,image/webp,application/pdf",
  PROJECT_FILE: "*/*",
};

const validateFileForCategory = (file, category) => {
  if (!file) return { valid: false, message: "A file is required." };

  if (category === "PROFILE_IMAGE") {
    const validTypes = ["image/jpeg", "image/png", "image/webp"];
    if (!validTypes.includes(file.type) || file.size > 2 * 1024 * 1024) {
      return { valid: false, message: VALIDATION_MESSAGES.PROFILE_IMAGE };
    }
    return { valid: true };
  }

  if (category === "SKILL_EVIDENCE") {
    if (file.size > 10 * 1024 * 1024) {
      return { valid: false, message: VALIDATION_MESSAGES.SKILL_EVIDENCE };
    }
    return { valid: true };
  }

  if (category === "PROJECT_FILE") {
    const supportedExtensions = [
      ".c", ".cpp", ".c++", ".h", ".hpp", ".java", ".py", ".js", ".jsx", ".ts", ".tsx", ".cs", ".php", ".go", ".rs", ".sql", ".html", ".css", ".json", ".xml", ".md", ".txt",
      ".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".csv",
      ".jpg", ".jpeg", ".png", ".webp",
    ];
    const extension = file.name?.slice(file.name.lastIndexOf(".")).toLowerCase();
    if (!supportedExtensions.includes(extension) || file.size > 10 * 1024 * 1024) {
      return { valid: false, message: VALIDATION_MESSAGES.PROJECT_FILE };
    }
    return { valid: true };
  }

  if (category === "OTHER_CERTIFICATE") {
    const validTypes = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
    const isPdfByFilename = file.name?.toLowerCase().endsWith(".pdf");
    if ((!validTypes.includes(file.type) && !(isPdfByFilename && (!file.type || file.type === "application/octet-stream"))) || file.size > 10 * 1024 * 1024) {
      return { valid: false, message: VALIDATION_MESSAGES[category] };
    }
    return { valid: true };
  }

  return { valid: true };
};

const formatBytes = (bytes = 0) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unitIndex;
  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
};

const dateInput = (value) => (value ? new Date(value).toISOString().slice(0, 10) : "");
const dateValue = (value) => (value ? new Date(`${value}T00:00:00.000Z`).toISOString() : null);
const labelize = (value) => value.replace(/([A-Z])/g, " $1").replace(/^./, (letter) => letter.toUpperCase());

const Field = ({ label, required, optional, error, children }) => (
  <label className={`block space-y-1.5 ${error ? "rounded-lg ring-1 ring-rose-300 ring-offset-2" : ""}`}>
    <span className="text-sm font-semibold text-slate-700">
      {label} {required && <span className="text-rose-500">*</span>}
      {optional && <span className="ml-1 font-normal text-slate-400">Optional</span>}
    </span>
    {children}
    {error && <span className="block text-xs font-medium text-rose-600">{error}</span>}
  </label>
);

const FilePreview = ({ file }) => {
  const [url, setUrl] = useState("");

  useEffect(() => {
    let active = true;
    let objectUrl = "";
    fetchEmployeeFileUrl(file.id, "view")
      .then((nextUrl) => {
        objectUrl = nextUrl;
        if (active) setUrl(nextUrl);
        else URL.revokeObjectURL(nextUrl);
      })
      .catch(() => setUrl(""));
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file.id]);

  if (file.mimeType?.startsWith("image/") && url) {
    return <img src={url} alt={file.originalName} className="h-16 w-16 rounded-lg object-cover" />;
  }

  if (file.mimeType === "application/pdf") {
    return <div className="flex h-16 w-16 items-center justify-center rounded-lg border border-rose-200 bg-rose-50 text-xs font-bold text-rose-700">PDF</div>;
  }

  return <div className="flex h-16 w-16 items-center justify-center rounded-lg border border-slate-200 bg-white text-xs font-semibold text-slate-500">FILE</div>;
};

const LocalFilePreview = ({ file }) => {
  const [preview, setPreview] = useState("");

  useEffect(() => {
    if (!file) return undefined;
    const reader = new FileReader();
    reader.onload = () => setPreview(typeof reader.result === "string" ? reader.result : "");
    reader.readAsDataURL(file);
    return () => reader.abort();
  }, [file]);

  if (file?.type?.startsWith("image/") && preview) {
    return <img src={preview} alt={file.name} className="h-16 w-16 rounded-lg object-cover" />;
  }

  if (file?.type === "application/pdf") {
    return <div className="flex h-16 w-16 items-center justify-center rounded-lg border border-rose-200 bg-rose-50 text-xs font-bold text-rose-700">PDF</div>;
  }

  return <div className="flex h-16 w-16 items-center justify-center rounded-lg border border-slate-200 bg-white text-xs font-semibold text-slate-500">FILE</div>;
};

const Action = ({ children, secondary = false, ...props }) => (
  <button
    {...props}
    className={`rounded-xl px-4 py-2.5 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${secondary ? "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50" : "bg-indigo-600 text-white shadow-sm hover:bg-indigo-700"}`}
  >
    {children}
  </button>
);

const EmployeeProfileSetup = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, updateUser } = useAuth();
  const [step, setStep] = useState(0);
  const [completion, setCompletion] = useState({ isComplete: false, missingFields: [] });
  const [basics, setBasics] = useState({ profileImage: "", profileImageFileId: "", age: "", phone: "", city: "", country: "" });
  const [pendingProfileImage, setPendingProfileImage] = useState(null);
  const [pendingProfileImagePreview, setPendingProfileImagePreview] = useState("");
  const [professional, setProfessional] = useState({ headline: "", bio: "", careerInformation: "", availability: "ACTIVELY_LOOKING" });
  const [rows, setRows] = useState({ education: [], skills: [], projects: [], certificates: [] });
  const [draft, setDraft] = useState(null);
  const [notice, setNotice] = useState(null);
  const [projectSkillDraft, setProjectSkillDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});

  // Shared User identity fields are editable in setup only when the
  // corresponding User field is empty (first-time initialization). Once
  // established, they are read-only here — Account Settings is the
  // intentional place to edit them later.
  const isSharedFieldEstablished = (field) => Boolean(user?.[field]?.trim());
  const canEditSharedField = (field) => !isSharedFieldEstablished(field);

  const refresh = useCallback(async () => {
    const [currentUserResponse, profileResponse, completionResponse, filesResponse] = await Promise.all([
      getCurrentUser(),
      getCandidateProfile(),
      getCandidateProfileCompletion(),
      listEmployeeFiles(),
    ]);

    const currentUser = currentUserResponse?.data ?? user;
    const profile = profileResponse?.data?.profile ?? {};
    const data = profile.profileData ?? {};
    const personal = data.personalInformation ?? {};
    const general = data.generalInformation ?? {};
    const certificates = profile.certificates ?? [];
    const files = filesResponse?.data ?? [];
    const profileImageFile = files.find((file) => file.category === "PROFILE_IMAGE");
    const currentProfileImage = currentUser?.profileImage || user?.profileImage || "";

    let profileImageUrl = currentProfileImage || personal.profileImage || "";
    if (profileImageFile) {
      try {
        profileImageUrl = await fetchEmployeeFileUrl(profileImageFile.id, "view");
      } catch {
        profileImageUrl = currentProfileImage || personal.profileImage || "";
      }
    }

    if (currentUser && currentUser.profileImage && !profileImageUrl) {
      profileImageUrl = currentUser.profileImage;
    }

    if (currentUser && currentUser.profileImage && currentUser.profileImage !== user?.profileImage) {
      updateUser(currentUser);
    }

    setBasics({
      profileImage: profileImageUrl,
      profileImageFileId: profileImageFile ? profileImageFile.id : "",
      age: personal.age ?? "",
      phone: personal.phone || currentUser?.phone || "",
      city: personal.city || currentUser?.city || "",
      country: personal.country || currentUser?.country || "",
    });

    setProfessional({
      headline: profile.headline ?? general.headline ?? "",
      bio: profile.bio ?? data.professionalDescription?.bio ?? "",
      careerInformation: data.careerInformation?.details ?? "",
      availability: profile.availability ?? general.availability ?? "ACTIVELY_LOOKING",
    });

    setRows({
      education: profile.education ?? [],
      skills: (profile.skills ?? []).map((skill) => ({ ...skill, certificates: certificates.filter((certificate) => certificate.skillId === skill.id) })),
      projects: profile.projects ?? [],
      certificates,
    });

    setCompletion(completionResponse?.data ?? { isComplete: false, missingFields: [] });
  }, [updateUser, user]);

  useEffect(() => {
    refresh().catch((error) => setNotice({ type: "error", text: extractApiErrorMessage(error) }));
  }, [refresh]);

  useEffect(() => {
    const fields = location.state?.missingFields;
    if (fields?.length) {
      setCompletion((current) => ({ ...current, isComplete: false, missingFields: fields }));
    }
  }, [location.state]);

  useEffect(() => () => {
    if (pendingProfileImagePreview) URL.revokeObjectURL(pendingProfileImagePreview);
  }, [pendingProfileImagePreview]);

  const requiredErrors = (section, data) => {
    const errors = {};
    const required = {
      personalInformation: [["profileImage", "Profile picture is required."], ["age", "Age is required."], ["phone", "Phone number is required."], ["city", "City is required."], ["country", "Country is required."]],
      generalInformation: [["headline", "Professional headline is required."], ["availability", "Availability is required."]],
      professionalDescription: [["bio", "Professional description is required."]],
      careerInformation: [["details", "Career information is required."]],
    }[section];

    if (required) {
      required.forEach(([field, message]) => {
        const hasProfileImage = Boolean(basics.profileImage || pendingProfileImage);
        if (section === "personalInformation" && field === "profileImage" && hasProfileImage) return;
        if (data?.[field] === undefined || data?.[field] === null || String(data[field]).trim() === "") errors[`${section}.${field}`] = message;
      });
    }
    return errors;
  };

  const rowRequiredErrors = (type, value) => {
    const required = type === "education"
      ? [["school", "School is required."]]
      : type === "skill"
        ? [["name", "Skill name is required."], ["proficiency", "Skill proficiency is required."]]
        : type === "project"
          ? [["name", "Project name is required."], ["description", "Project description is required."]]
          : [["name", "Certificate name is required."]];
    return Object.fromEntries(required.filter(([field]) => value?.[field] === undefined || value?.[field] === null || String(value[field]).trim() === "").map(([field, message]) => [`${type}.${field}`, message]));
  };

  const saveSection = async (section, data) => {
    setBusy(true);
    setNotice(null);
    const errors = requiredErrors(section, data);
    setFieldErrors((current) => ({ ...current, ...errors }));
    if (Object.keys(errors).length > 0) {
      setBusy(false);
      setNotice({ type: "error", text: Object.values(errors)[0] });
      return;
    }
    try {
      let profileData = { ...data };

      // If a profile image was selected during first-time setup, upload it
      // first and include the canonical path so the backend's
      // getUserAccountFieldUpdate can initialize User.profileImage
      // (fill-only-if-empty — never overwrites an established image).
      if (section === "personalInformation" && pendingProfileImage) {
        const result = await uploadEmployeeFile({ category: "PROFILE_IMAGE", file: pendingProfileImage });
        const uploaded = result?.data ?? result;
        const fileId = uploaded?.id ?? uploaded?.fileId;
        if (!fileId) throw new Error("Profile image upload did not return a file id.");
        profileData.profileImage = uploaded?.profileImage ?? `/api/files/${fileId}/view`;
      }

      await saveCandidateProfileSection(section, profileData);

      if (section === "personalInformation" && pendingProfileImage) {
        const previousFileId = basics.profileImageFileId;
        if (previousFileId) await deleteEmployeeFile(previousFileId);
        const refreshedUser = await getCurrentUser();
        updateUser(refreshedUser.data);
        setPendingProfileImage(null);
        setPendingProfileImagePreview("");
      }

      await refresh();
      setNotice({ type: "success", text: "Saved" });
    } catch (error) {
      setNotice({ type: "error", text: extractApiErrorMessage(error, error.message || "Unable to save this information.") });
    } finally {
      setBusy(false);
    }
  };

  const saveRow = async (type, draftValue) => {
    const errors = rowRequiredErrors(type, draftValue);
    setFieldErrors((current) => ({ ...current, ...errors }));
    if (Object.keys(errors).length > 0) {
      throw new Error(Object.values(errors)[0]);
    }
    const key = type === "skill" ? "skills" : type === "education" ? "education" : `${type}s`;
    const save = { education: saveCandidateEducation, skill: saveCandidateSkill, project: saveCandidateProject, certificate: saveCandidateCertificate }[type];
    const payload = type === "skill"
      ? {
        name: typeof draftValue?.name === "string" ? draftValue.name.trim() : "",
        category: typeof draftValue?.category === "string" ? draftValue.category.trim() : null,
        proficiency: PROFICIENCIES.includes(draftValue?.proficiency) ? draftValue.proficiency : "BEGINNER",
        yearsOfExperience: draftValue?.yearsOfExperience === "" || draftValue?.yearsOfExperience == null
          ? null
          : Number(draftValue.yearsOfExperience),
      }
      : type === "project"
        ? {
          ...draftValue,
          startDate: draftValue.startDate ? new Date(draftValue.startDate).toISOString() : null,
          endDate: draftValue.endDate ? new Date(draftValue.endDate).toISOString() : null,
        }
        : { ...draftValue };
    delete payload.skillEvidenceFile;
    delete payload.skillCertificateFile;
    delete payload.projectFile;
    delete payload.certificateFile;
    if (type === "project") delete payload.id;
    if (payload.yearsOfExperience !== undefined) {
      payload.yearsOfExperience = payload.yearsOfExperience === "" ? null : Number(payload.yearsOfExperience);
    }

    const response = await save(payload, draftValue.id);
    const item = response.data?.item ?? response.data;
    setRows((current) => ({
      ...current,
      [key]: draftValue.id ? current[key].map((row) => (row.id === draftValue.id ? item : row)) : [...current[key], item],
    }));
    return item;
  };

  const saveDraft = async (type) => {
    setBusy(true);
    setNotice(null);
    try {
      const item = await saveRow(type, draft);

      if (type === "skill") {
        if (draft.skillEvidenceFile && item.id) {
          await uploadEmployeeFile({ category: "SKILL_EVIDENCE", skillId: item.id, file: draft.skillEvidenceFile });
        }

        if (draft.skillCertificateFile && item.id) {
          const certificateName = draft.skillCertificateFile.name.replace(/\.[^/.]+$/, "") || (draft.name || "Skill certificate");
          const createdCertificate = await saveCandidateCertificate({
            name: certificateName,
            skillId: item.id,
            description: `Certificate for ${draft.name || "skill"}`,
          });
          const certificateId = createdCertificate?.data?.item?.id ?? createdCertificate?.data?.id ?? createdCertificate?.id;

          if (certificateId) {
            await uploadEmployeeFile({ category: "OTHER_CERTIFICATE", certificateId, file: draft.skillCertificateFile });
          }
        }

      }

      if (type === "certificate" && draft.certificateFile && item.id) {
        await uploadEmployeeFile({ category: "OTHER_CERTIFICATE", certificateId: item.id, file: draft.certificateFile });
      }
      if (type === "project" && draft.projectFile && item.id) {
        await uploadEmployeeFile({ category: "PROJECT_FILE", projectId: item.id, file: draft.projectFile });
      }
      setDraft(null);
      await refresh();
      setNotice({ type: "success", text: "Saved" });
    } catch (error) {
      if (type === "project") {
        setDraft((current) => current ? { ...current, id: undefined } : current);
      }
      setNotice({ type: "error", text: extractApiErrorMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  const removeRow = async (type, id) => {
    if (!window.confirm("Delete this item?")) return;
    const key = type === "skill" ? "skills" : type === "education" ? "education" : `${type}s`;
    const remove = { education: deleteCandidateEducation, skill: deleteCandidateSkill, project: deleteCandidateProject, certificate: deleteCandidateCertificate }[type];

    setBusy(true);
    try {
      await remove(id);
      setRows((current) => ({ ...current, [key]: current[key].filter((row) => row.id !== id) }));
      await refresh();
    } catch (error) {
      setNotice({ type: "error", text: extractApiErrorMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  const saveProjectSkill = async () => {
    if (!projectSkillDraft) return;
    setBusy(true);
    try {
      await saveCandidateProjectSkill(projectSkillDraft.projectId, {
        customSkillName: projectSkillDraft.customSkillName,
        proficiency: projectSkillDraft.proficiency,
        yearsOfExperience: Number(projectSkillDraft.yearsOfExperience) || 0,
      }, projectSkillDraft.id);
      setProjectSkillDraft(null);
      await refresh();
    } catch (error) {
      setNotice({ type: "error", text: extractApiErrorMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  const removeProjectSkill = async (projectId, id) => {
    if (!window.confirm("Remove this project skill?")) return;
    setBusy(true);
    try {
      await deleteCandidateProjectSkill(projectId, id);
      await refresh();
    } catch (error) {
      setNotice({ type: "error", text: extractApiErrorMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  
const handleReplaceFile = async ({ category, file, currentFileId, skillId, certificateId, projectId }) => {
    const validation = validateFileForCategory(file, category);
    if (!file || !validation.valid) {
      setNotice({ type: "error", text: validation.message });
      return;
    }
    if (currentFileId && !window.confirm("Replace this file? The existing file will be removed after the new upload succeeds.")) return;

    setBusy(true);
    setNotice(null);
    try {
      const result = await uploadEmployeeFile({ category, skillId, certificateId, projectId, file });
      const uploaded = result?.data ?? result;
      const newFileId = uploaded?.id ?? uploaded?.fileId;
      if (!newFileId) {
        throw new Error("Upload did not return a file id.");
      }
      if (currentFileId) {
        await deleteEmployeeFile(currentFileId);
      }
      await refresh();
      setNotice({ type: "success", text: "File replaced" });
    } catch (error) {
      setNotice({ type: "error", text: extractApiErrorMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  const displayedProfileImage = basics.profileImage;

  const profileImagePreview = displayedProfileImage ? (
    <img src={displayedProfileImage} alt="Profile preview" className="h-20 w-20 rounded-full object-cover" />
  ) : (
    <div className="flex h-20 w-20 items-center justify-center rounded-full bg-slate-200 text-xs text-slate-500">No photo</div>
  );

  const openAuthenticatedFile = async (file, disposition = "view") => {
    const url = await fetchEmployeeFileUrl(file.id, disposition);
    if (disposition === "view") {
      window.open(url, "_blank", "noopener,noreferrer");
      return;
    }

    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = file.originalName || file.name || "download";
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  };

  const handleDeleteFile = async (fileId) => {
    if (!window.confirm("Delete this uploaded file?")) return;
    setBusy(true);
    try {
      await deleteEmployeeFile(fileId);
      await refresh();
    } catch (error) {
      setNotice({ type: "error", text: extractApiErrorMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  const missing = completion.missingFields ?? [];
  const complete = completion.isComplete === true && missing.length === 0;
  const progress = useMemo(() => (complete ? 100 : Math.max(0, Math.round(((13 - missing.length) / 13) * 100))), [complete, missing.length]);
  const input = (value, onChange, type = "text", placeholder = "") => <input className={inputClasses} type={type} value={value ?? ""} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />;
  const select = (value, onChange, values, labels = {}) => <select className={inputClasses} value={value ?? ""} onChange={(event) => onChange(event.target.value)}>{values.map((item) => <option key={item} value={item}>{labels[item] ?? item.replaceAll("_", " ")}</option>)}</select>;
  const updateDraft = (key, value) => {
    setDraft((current) => ({ ...(current ?? {}), [key]: value }));
    setFieldErrors((current) => {
      const next = { ...current };
      delete next[`skill.${key}`];
      delete next[`education.${key}`];
      delete next[`project.${key}`];
      delete next[`certificate.${key}`];
      return next;
    });
  };

  const basicsView = (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
      <h2 className="font-display text-xl font-bold text-slate-900">Basic information</h2>
      <p className="mt-1 text-sm text-slate-500">Build the identity employers will see first.</p>
      <div className="mt-6 grid gap-5 md:grid-cols-2">
        <div className={`md:col-span-2 rounded-xl border border-slate-200 bg-slate-50 p-4 ${fieldErrors["personalInformation.profileImage"] ? "ring-1 ring-rose-300 ring-offset-2" : ""}`}>
          <p className="text-sm font-semibold text-slate-800">Profile Picture</p>
          <p className="mt-1 text-xs text-slate-500">Your shared profile picture is managed in Account Settings.</p>
          {fieldErrors["personalInformation.profileImage"] && <p className="mt-1 text-xs font-medium text-rose-600">{fieldErrors["personalInformation.profileImage"]}</p>}
          <div className="mt-4 flex flex-wrap items-center gap-4">
            {profileImagePreview}
            {canEditSharedField("profileImage") && (
              <label className="cursor-pointer rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-indigo-700 shadow-sm ring-1 ring-indigo-200">
                Choose picture
                <input
                  type="file"
                  accept={FILE_ACCEPTS.PROFILE_IMAGE}
                  className="sr-only"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    const validation = validateFileForCategory(file, "PROFILE_IMAGE");
                    if (!validation.valid) {
                      setNotice({ type: "error", text: validation.message });
                      return;
                    }
                    setPendingProfileImage(file);
                    setPendingProfileImagePreview((current) => {
                      if (current) URL.revokeObjectURL(current);
                      return URL.createObjectURL(file);
                    });
                  }}
                />
              </label>
            )}
            {pendingProfileImagePreview && (
              <img src={pendingProfileImagePreview} alt="New profile preview" className="h-20 w-20 rounded-full object-cover" />
            )}
          </div>
        </div>

        <Field label="Full name"><div className={`${inputClasses} bg-slate-50`} aria-readonly="true">{user?.fullName ?? "Your name"}</div></Field>
        <Field label="Email"><div className={`${inputClasses} bg-slate-50`} aria-readonly="true">{user?.email ?? ""}</div></Field>
        <Field label="Age" required error={fieldErrors["personalInformation.age"]}>{input(basics.age, (value) => setBasics((current) => ({ ...current, age: value })), "number", "25")}</Field>
        <Field label="Phone" required error={fieldErrors["personalInformation.phone"]}>
          {canEditSharedField("phone")
            ? input(basics.phone, (value) => setBasics((current) => ({ ...current, phone: value })), "text", "+92 300 1234567")
            : <div className={`${inputClasses} bg-slate-50`} aria-readonly="true">{basics.phone}</div>}
        </Field>
        <Field label="City" required error={fieldErrors["personalInformation.city"]}>
          {canEditSharedField("city")
            ? input(basics.city, (value) => setBasics((current) => ({ ...current, city: value })), "text", "Lahore")
            : <div className={`${inputClasses} bg-slate-50`} aria-readonly="true">{basics.city}</div>}
        </Field>
        <Field label="Country" required error={fieldErrors["personalInformation.country"]}>
          {canEditSharedField("country")
            ? input(basics.country, (value) => setBasics((current) => ({ ...current, country: value })), "text", "Pakistan")
            : <div className={`${inputClasses} bg-slate-50`} aria-readonly="true">{basics.country}</div>}
        </Field>
      </div>

      <div className="mt-6 flex justify-end">
        <Action disabled={busy} onClick={() => saveSection("personalInformation", { age: Number(basics.age), phone: basics.phone, city: basics.city, country: basics.country })}>{busy ? "Saving..." : "Save basic information"}</Action>
      </div>
    </section>
  );

  const professionalView = (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
      <h2 className="font-display text-xl font-bold text-slate-900">Professional information</h2>
      <div className="mt-6 space-y-5">
        <Field label="Professional headline" required error={fieldErrors["generalInformation.headline"]}>{input(professional.headline, (value) => setProfessional({ ...professional, headline: value }), "text", "Full Stack Developer")}</Field>
        <Field label="Professional description" required error={fieldErrors["professionalDescription.bio"]}><textarea className={`${inputClasses} min-h-32`} value={professional.bio} onChange={(event) => setProfessional({ ...professional, bio: event.target.value })} /></Field>
        <Field label="Career information" required error={fieldErrors["careerInformation.details"]}><textarea className={`${inputClasses} min-h-28`} value={professional.careerInformation} onChange={(event) => setProfessional({ ...professional, careerInformation: event.target.value })} /></Field>
        <Field label="Availability" required error={fieldErrors["generalInformation.availability"]}>{select(professional.availability, (value) => setProfessional({ ...professional, availability: value }), AVAILABILITY)}</Field>
      </div>
      <div className="mt-6 flex justify-end">
        <Action disabled={busy} onClick={async () => { await saveSection("generalInformation", { headline: professional.headline, availability: professional.availability }); await saveSection("professionalDescription", { bio: professional.bio }); await saveSection("careerInformation", { details: professional.careerInformation }); }}>{busy ? "Saving..." : "Save professional information"}</Action>
      </div>
    </section>
  );

  const editor = (type) => {
    const fields = type === "education"
      ? ["school", "degree", "fieldOfStudy", "startDate", "endDate", "grade", "description"]
      : type === "skill"
        ? ["name", "category", "yearsOfExperience"]
        : type === "project"
          ? ["name", "description", "role", "link", "startDate", "endDate"]
          : ["name", "issuer", "issueDate", "expiryDate", "credentialId", "credentialUrl", "description"];

    return (
      <div className="mt-5 rounded-xl border border-slate-200 bg-slate-50 p-4">
        <div className="grid gap-4 md:grid-cols-2">
          {fields.map((field) => (
            <Field key={field} label={labelize(field)} required={field === "school" || field === "name"} error={fieldErrors[`${type}.${field}`]}>
              {field === "description" ? (
                <textarea className={`${inputClasses} min-h-24`} value={draft?.[field] ?? ""} onChange={(event) => updateDraft(field, event.target.value)} />
              ) : (
                input(field.includes("Date") ? dateInput(draft?.[field]) : draft?.[field], (value) => updateDraft(field, field.includes("Date") ? dateValue(value) : value), field.includes("Date") ? "date" : field === "yearsOfExperience" ? "number" : "text")
              )}
            </Field>
          ))}

          {type === "skill" && (
            <>
              <Field label="Proficiency" required error={fieldErrors["skill.proficiency"]}>{select(draft?.proficiency, (value) => updateDraft("proficiency", value), PROFICIENCIES, { BEGINNER: "Beginner", INTERMEDIATE: "Intermediate", ADVANCED: "Advanced", EXPERT: "Expert" })}</Field>
              <Field label="Skill evidence file" optional>
                <input type="file" accept={FILE_ACCEPTS.PROJECT_FILE} className={inputClasses} onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  const validation = validateFileForCategory(file, "SKILL_EVIDENCE");
                  if (!validation.valid) {
                    setNotice({ type: "error", text: validation.message });
                    return;
                  }
                  updateDraft("skillEvidenceFile", file);
                }} />
              </Field>
              <Field label="Upload new certificate" optional>
                <div className="space-y-2">
                  <input type="file" accept={FILE_ACCEPTS.PROJECT_FILE} className={inputClasses} onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    const validation = validateFileForCategory(file, "OTHER_CERTIFICATE");
                    if (!validation.valid) {
                      setNotice({ type: "error", text: validation.message });
                      return;
                    }
                    updateDraft("skillCertificateFile", file);
                  }} />
                  {draft?.skillCertificateFile && <div className="flex items-center gap-3 rounded-lg border border-indigo-100 bg-indigo-50/50 p-2">
                    <LocalFilePreview file={draft.skillCertificateFile} />
                    <div className="min-w-0"><p className="text-sm font-medium text-slate-700">{draft.skillCertificateFile.name}</p><p className="text-xs text-slate-500">Ready to save with this skill</p></div>
                  </div>}
                </div>
              </Field>
            </>
          )}

          {type === "certificate" && (
            <>
              <Field label="Associated skill" optional>{select(draft?.skillId, (value) => updateDraft("skillId", value), ["", ...rows.skills.map((skill) => skill.id)], Object.fromEntries(rows.skills.map((skill) => [skill.id, skill.name])))}</Field>
              <Field label="Certificate file" optional>
                <input type="file" accept={FILE_ACCEPTS.OTHER_CERTIFICATE} className={inputClasses} onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  const validation = validateFileForCategory(file, "OTHER_CERTIFICATE");
                  if (!validation.valid) {
                    setNotice({ type: "error", text: validation.message });
                    return;
                  }
                  updateDraft("certificateFile", file);
                }} />
              </Field>
            </>
          )}

          {type === "project" && (
            <Field label="Project file" optional>
              <input type="file" accept={FILE_ACCEPTS.PROJECT_FILE} className={inputClasses} onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                const validation = validateFileForCategory(file, "PROJECT_FILE");
                if (!validation.valid) {
                  setNotice({ type: "error", text: validation.message });
                  return;
                }
                updateDraft("projectFile", file);
              }} />
            </Field>
          )}
        </div>

        <div className="mt-4 flex gap-2">
          <Action disabled={busy} onClick={() => saveDraft(type)}>{busy ? "Saving..." : type === "skill" && draft?.skillCertificateFile ? "Save certificate" : "Save"}</Action>
          <Action secondary type="button" onClick={() => setDraft(null)}>Cancel</Action>
        </div>
      </div>
    );
  };

  const collection = (type, title, description, empty) => {
    const key = type === "skill" ? "skills" : type === "education" ? "education" : `${type}s`;

    return (
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
        <h2 className="font-display text-xl font-bold text-slate-900">{title}</h2>
        <p className="mt-1 text-sm text-slate-500">{description}</p>
        <div className="mt-6 flex justify-end">
          <Action secondary onClick={() => setDraft(type === "education" ? { ...EMPTY.education } : type === "skill" ? { ...EMPTY.skill, proficiency: "BEGINNER" } : type === "project" ? { ...EMPTY.project } : { ...EMPTY.certificate })}>Add {type}</Action>
        </div>
        {draft && (type === "education" || type === "skill" || type === "project" || type === "certificate") && editor(type)}

        {rows[key].length === 0 ? (
          <div className="mt-4 rounded-xl border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">{empty}</div>
        ) : (
          <div className="mt-6 space-y-3">
            {rows[key].map((row) => (
              <div key={row.id} className="rounded-xl border border-slate-200 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="font-semibold text-slate-900">{row.name ?? row.school}</p>
                    <p className="text-sm text-slate-500">{row.proficiency ? `${row.proficiency.replaceAll("_", " ")} · ${row.yearsOfExperience ?? 0} years` : row.degree ?? row.issuer ?? row.description}</p>
                    {type === "skill" && <p className="mt-1 text-xs font-medium text-amber-700">Awaiting platform verification</p>}
                    {type === "skill" && row.certificates?.length > 0 && <p className="mt-1 text-xs text-indigo-600">Relevant certificates: {row.certificates.map((certificate) => certificate.name).join(", ")}</p>}
                  </div>
                  <div className="flex gap-2">
                    <Action secondary onClick={() => setDraft({ ...row })}>Edit</Action>
                    <Action secondary onClick={() => removeRow(type, row.id)}>Delete</Action>
                  </div>
                </div>

                {type === "skill" && row.files?.length > 0 && (
                  <div className="mt-4 space-y-2 border-t border-slate-100 pt-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Supporting evidence</p>
                    {row.files.map((file) => (
                      <div key={file.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm">
                        <FilePreview file={file} />
                        <div>
                          <p className="font-medium text-slate-700">{file.originalName}</p>
                          <p className="text-xs text-slate-500">{file.mimeType} · {formatBytes(file.fileSize)}</p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <button type="button" className="text-indigo-700 font-semibold" onClick={() => openAuthenticatedFile(file, "view")}>View</button>
                          <button type="button" className="text-slate-700 font-semibold" onClick={() => openAuthenticatedFile(file, "download")}>Download</button>
                          <label className="cursor-pointer text-indigo-700 font-semibold">Replace<input type="file" accept={FILE_ACCEPTS.SKILL_EVIDENCE} className="sr-only" onChange={(event) => handleReplaceFile({ category: "SKILL_EVIDENCE", file: event.target.files?.[0], currentFileId: file.id, skillId: row.id })} /></label>
                          <button type="button" className="text-rose-600 font-semibold" onClick={() => handleDeleteFile(file.id)}>Delete</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {type === "skill" && row.certificates?.length > 0 && (
                  <div className="mt-4 space-y-2 border-t border-slate-100 pt-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Related certificates</p>
                    {row.certificates.map((certificate) => (
                      <div key={certificate.id} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <p className="font-medium text-slate-700">{certificate.name}</p>
                            {certificate.issuer && <p className="text-xs text-slate-500">{certificate.issuer}</p>}
                          </div>
                          <div className="text-xs text-slate-500">{(certificate.files ?? []).length} document{(certificate.files ?? []).length === 1 ? "" : "s"}</div>
                        </div>
                        {(certificate.files ?? []).length > 0 ? (
                          <div className="mt-3 space-y-2">
                            {certificate.files.map((file) => (
                              <div key={file.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white px-3 py-2 text-sm">
                                <FilePreview file={file} />
                                <div>
                                  <p className="font-medium text-slate-700">{file.originalName}</p>
                                  <p className="text-xs text-slate-500">{file.mimeType} · {formatBytes(file.fileSize)}</p>
                                </div>
                                <div className="flex flex-wrap items-center gap-2">
                                  <button type="button" className="text-indigo-700 font-semibold" onClick={() => openAuthenticatedFile(file, "view")}>View</button>
                                  <button type="button" className="text-slate-700 font-semibold" onClick={() => openAuthenticatedFile(file, "download")}>Download</button>
                                  <label className="cursor-pointer text-indigo-700 font-semibold">Replace<input type="file" accept={FILE_ACCEPTS.OTHER_CERTIFICATE} className="sr-only" onChange={(event) => handleReplaceFile({ category: "OTHER_CERTIFICATE", file: event.target.files?.[0], currentFileId: file.id, certificateId: certificate.id })} /></label>
                                  <button type="button" className="text-rose-600 font-semibold" onClick={() => handleDeleteFile(file.id)}>Delete</button>
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="mt-2 text-xs text-slate-500">No certificate file uploaded yet.</p>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {type === "certificate" && row.files?.length > 0 && (
                  <div className="mt-4 space-y-2 border-t border-slate-100 pt-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Certificate file</p>
                    {row.files.map((file) => (
                      <div key={file.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm">
                        <FilePreview file={file} />
                        <div>
                          <p className="font-medium text-slate-700">{file.originalName}</p>
                          <p className="text-xs text-slate-500">{file.mimeType} · {formatBytes(file.fileSize)}</p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <button type="button" className="text-indigo-700 font-semibold" onClick={() => openAuthenticatedFile(file, "view")}>View</button>
                          <button type="button" className="text-slate-700 font-semibold" onClick={() => openAuthenticatedFile(file, "download")}>Download</button>
                          <label className="cursor-pointer text-indigo-700 font-semibold">Replace<input type="file" accept={FILE_ACCEPTS.OTHER_CERTIFICATE} className="sr-only" onChange={(event) => handleReplaceFile({ category: "OTHER_CERTIFICATE", file: event.target.files?.[0], currentFileId: file.id, certificateId: row.id })} /></label>
                          <button type="button" className="text-rose-600 font-semibold" onClick={() => handleDeleteFile(file.id)}>Delete</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {type === "project" && row.storedFiles?.length > 0 && (
                  <div className="mt-4 space-y-2 border-t border-slate-100 pt-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Project files</p>
                    {row.storedFiles.map((file) => (
                      <div key={file.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm">
                        <FilePreview file={file} />
                        <div>
                          <p className="font-medium text-slate-700">{file.originalName}</p>
                          <p className="text-xs text-slate-500">{file.mimeType} · {formatBytes(file.fileSize)}</p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <button type="button" className="text-indigo-700 font-semibold" onClick={() => openAuthenticatedFile(file, "view")}>View</button>
                          <button type="button" className="text-slate-700 font-semibold" onClick={() => openAuthenticatedFile(file, "download")}>Download</button>
                          <label className="cursor-pointer text-indigo-700 font-semibold">Replace<input type="file" accept={FILE_ACCEPTS.PROJECT_FILE} className="sr-only" onChange={(event) => handleReplaceFile({ category: "PROJECT_FILE", file: event.target.files?.[0], currentFileId: file.id, projectId: row.id })} /></label>
                          <button type="button" className="text-rose-600 font-semibold" onClick={() => handleDeleteFile(file.id)}>Delete</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    );
  };

  const review = (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
      <h2 className="font-display text-xl font-bold text-slate-900">Review profile</h2>
      <div className="mt-6 space-y-3">
        {[["Basic information", ["profileImage", "age", "phone", "city", "country"]], ["Professional information", ["headline", "bio", "careerInformation", "availability"]], ["Education", ["education"]], ["Skills", ["skills"]], ["Projects", ["projects"]], ["Skill verification", ["skillVerification"]], ["Certificates", []]].map(([label, fields]) => {
          const isComplete = fields.every((field) => !missing.includes(field));
          return (
            <div key={label} className="flex items-center justify-between rounded-xl border border-slate-200 px-4 py-3">
              <span className="text-sm font-semibold text-slate-800">{label}</span>
              <span className={isComplete ? "text-emerald-600" : "text-rose-600"}>{isComplete ? "Complete" : "Needs attention"}</span>
            </div>
          );
        })}

        <div className="rounded-xl bg-slate-50 p-4 text-sm text-slate-600">
          {complete ? "Everything required is ready." : <><strong>Still needed:</strong> {missing.map((field) => MISSING[field] ?? field).join(" · ")}</>}
        </div>

        <Action disabled={busy || !complete} onClick={async () => {
          setBusy(true);
          try {
            await markCandidateProfileComplete();
            const current = await getCurrentUser();
            updateUser(current.data);
            navigate("/employee/dashboard", { replace: true });
          } catch (error) {
            setNotice({ type: "error", text: extractApiErrorMessage(error) });
          } finally {
            setBusy(false);
          }
        }}>{busy ? "Completing..." : "Complete profile"}</Action>
      </div>
    </section>
  );

  const views = [
    basicsView,
    professionalView,
    collection("education", "Education", "At least one education record is required.", "No education added yet."),
    collection("skill", "Skills", "Add skills for assessment and verification.", "No skills added yet."),
    collection("project", "Projects", "At least one project is required.", "No projects added yet."),
    collection("certificate", "Certificates", "Optional credentials and certificate files.", "Certificates are optional."),
    review,
  ];

  return (
    <Container className="max-w-6xl py-8 sm:py-12">
      <div className="mb-8 flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wider text-indigo-600">Employee onboarding</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight text-slate-950">Build your professional passport</h1>
          <p className="mt-2 max-w-2xl text-slate-600">Save each section as you go, then unlock your dashboard when every requirement is confirmed.</p>
        </div>
        <div className="min-w-48 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between text-sm font-semibold">
            <span>Profile completion</span>
            <span className="text-indigo-600">{progress}%</span>
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100">
            <div className="h-full rounded-full bg-indigo-600 transition-all" style={{ width: `${progress}%` }} />
          </div>
        </div>
      </div>

      {notice && <div className="mb-5"><Alert variant={notice.type === "error" ? "error" : "success"}>{notice.text}</Alert></div>}

      <div className="mb-6 overflow-x-auto rounded-2xl border border-slate-200 bg-white p-2 shadow-sm">
        <div className="flex min-w-max gap-1">
          {STEPS.map((name, index) => (
            <button key={name} type="button" onClick={() => setStep(index)} className={`rounded-xl px-4 py-2.5 text-sm font-semibold ${step === index ? "bg-indigo-600 text-white" : "text-slate-500 hover:bg-slate-50"}`}>
              {index + 1}. {name}
            </button>
          ))}
        </div>
      </div>

      {views[step]}

      <div className="mt-6 flex justify-between">
        <Action secondary disabled={step === 0} onClick={() => setStep((value) => value - 1)}>Back</Action>
        {step < views.length - 1 && <Action onClick={() => setStep((value) => value + 1)}>Next section</Action>}
      </div>
    </Container>
  );
};

export default EmployeeProfileSetup;
