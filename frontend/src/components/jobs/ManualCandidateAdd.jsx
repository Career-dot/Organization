import { useRef, useState } from "react";
import Button from "../ui/Button";
import Spinner from "../ui/Spinner";
import { PlusIcon } from "../ui/icons";
import { addManualJobCandidate, uploadCandidateResume } from "../../services/jobService";
import { extractApiErrorMessage } from "../../utils/apiError";

// Manual addition is the recruiter's backup for a candidate the uploaded Excel
// list does not contain - and it is a PEER of that import, not a lesser path. So
// this form collects the SAME evidence an imported row carries, and the backend
// persists it through the SAME job-scoped JobCandidateReference seed-if-absent
// transaction the sheet uses. A manually added candidate and an imported one are
// indistinguishable downstream: same reference, same IN SYSTEM / NOT IN SYSTEM
// classification from the same shared classifier, same invitation, and the same
// automatic analysis once their assessment closes.
//
// Every field except the email is optional and maps 1:1 onto an imported column.
// The resume is NOT part of this body: it travels through the EXISTING private
// PDF/TXT resume upload, using the referenceId this endpoint returns, and only
// when the backend reports the reference as newly created - so an address
// already in the job keeps its existing reference, resume and recruiter edits.
//
// The browser only POSTs the typed evidence and renders what comes back. It does
// not fetch users, compare emails, or cache a classification; nothing here is a
// client-side authority and nothing is written to browser storage.
// The candidate EVIDENCE collected by this form — the SAME five fields the Excel
// sheet carries: Name, Email, Resume (below), LinkedIn and GitHub.
//
// Skills, skill notes and preferred role are deliberately NOT collected here:
// requirements like those belong to the JOB, not to the candidate, and a
// candidate record must not duplicate the job's own requirement set. The
// backend still accepts those keys for backwards compatibility, but this
// surface never sends them.
const FIELDS = [
  { key: "email", label: "Email (required)", type: "email", span: 2, required: true, placeholder: "candidate@example.com" },
  { key: "name", label: "Full name", placeholder: "Jane Doe" },
  { key: "linkedinUrl", label: "LinkedIn URL", placeholder: "https://linkedin.com/in/..." },
  { key: "githubUrl", label: "GitHub URL", placeholder: "https://github.com/..." },
  { key: "linkedinText", label: "LinkedIn text", control: "textarea", span: 2, placeholder: "Profile headline or summary" },
  { key: "githubText", label: "GitHub text", control: "textarea", span: 2, placeholder: "Repositories, contributions or profile summary" },
];

const EMPTY_FORM = Object.fromEntries(FIELDS.map((field) => [field.key, ""]));
const ManualCandidateAdd = ({ jobId, onAdded }) => {
  const [form, setForm] = useState(EMPTY_FORM);
  const [resume, setResume] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const fileInputRef = useRef(null);

  const setField = (key) => (event) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  const submit = async (event) => {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    setNotice(null);
    setSubmitting(true);

    // Only the five candidate evidence fields are submitted: name, email,
    // LinkedIn and GitHub here, plus the resume through the existing private
    // upload below. Skills / skill notes / preferred role are Job requirements
    // and are never part of a candidate record.
    const payload = {
      email: form.email.trim(),
      name: form.name.trim() || null,
      linkedinUrl: form.linkedinUrl.trim() || null,
      linkedinText: form.linkedinText.trim() || null,
      githubUrl: form.githubUrl.trim() || null,
      githubText: form.githubText.trim() || null,
    };

    try {
      const response = await addManualJobCandidate(jobId, payload);
      const result = response?.data ?? null;
      const saved = result?.candidate ?? null;
      const created = result?.created === true;
      const referenceId = saved?.referenceId ?? null;

      // The message only restates the status the BACKEND determined; it never
      // derives one. `created: false` means the reference already existed and
      // its stored details were deliberately kept.
      const label = saved?.email ?? payload.email;
      setNotice(
        !created
          ? `${label} was already in this job's candidate list - their existing details were kept.`
          : saved?.systemStatus === "IN_SYSTEM"
          ? `Added ${label} - the platform already has this candidate.`
          : `Added ${label} - this candidate is not in the platform yet.`
      );

      // Attach the resume only to a reference this call actually created, so an
      // existing candidate's stored resume is never replaced as a side effect.
      if (resume && created && referenceId) {
        try {
          await uploadCandidateResume(jobId, referenceId, resume);
          setNotice((current) => `${current} Resume attached.`);
        } catch (resumeError) {
          // The candidate is already persisted, so a rejected resume must not be
          // reported as a failed add. It is surfaced on its own so the recruiter
          // can retry the file without re-adding the candidate.
          setError(extractApiErrorMessage(
            resumeError,
            "The candidate was added, but the resume could not be uploaded."
          ));
        }
      }

      setForm(EMPTY_FORM);
      setResume(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      // Re-read the authoritative list so the row and its counts come from the
      // server, never from a locally constructed row.
      onAdded?.();
    } catch (caught) {
      setError(extractApiErrorMessage(caught, "The candidate could not be added."));
    } finally {
      setSubmitting(false);
    }
  };

  const inputClass =
    "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 disabled:cursor-not-allowed disabled:opacity-60";
  const labelClass =
    "block text-xs font-semibold uppercase tracking-wide text-slate-600";
  return (
    <form
      onSubmit={submit}
      className="mt-4 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-4"
    >
      <h3 className={`${labelClass} text-sm`}>Add candidate manually</h3>
      <p className="mt-1 text-xs text-slate-500">
        Add a candidate the uploaded Excel list does not contain. This creates the same
        candidate record an imported row does — name, email, resume and links — and the
        platform decides which of the two candidate columns it belongs in by whether that
        email already belongs to a candidate account. Skills and role requirements belong
        to the job, not to the candidate.
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {FIELDS.map((field) => {
          const isTextarea = field.control === "textarea";
          const id = `manual-candidate-${field.key}`;
          return (
            <div key={field.key} className={field.span === 2 ? "sm:col-span-2" : ""}>
              <label htmlFor={id} className={labelClass}>
                {field.label}
              </label>
              {isTextarea ? (
                <textarea
                  id={id}
                  name={field.key}
                  rows={2}
                  placeholder={field.placeholder}
                  value={form[field.key]}
                  disabled={submitting}
                  onChange={setField(field.key)}
                  className={`${inputClass} mt-1 resize-y`}
                />
              ) : (
                <input
                  id={id}
                  name={field.key}
                  type={field.type || "text"}
                  required={field.required || undefined}
                  autoComplete="off"
                  placeholder={field.placeholder}
                  value={form[field.key]}
                  disabled={submitting}
                  onChange={setField(field.key)}
                  className={`${inputClass} mt-1`}
                />
              )}
              {field.hint && (
                <p className="mt-1 text-[11px] text-slate-500">{field.hint}</p>
              )}
            </div>
          );
        })}
        <div className="sm:col-span-2">
          <label htmlFor="manual-candidate-resume" className={labelClass}>
            Resume (PDF or TXT)
          </label>
          <input
            ref={fileInputRef}
            id="manual-candidate-resume"
            name="resume"
            type="file"
            accept=".pdf,.txt,application/pdf,text/plain"
            disabled={submitting}
            onChange={(event) => setResume(event.target.files?.[0] ?? null)}
            className="mt-1 block w-full text-xs text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-white file:px-3 file:py-2 file:text-xs file:font-semibold file:text-slate-700 hover:file:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
          />
          <p className="mt-1 text-[11px] text-slate-500">
            Optional. Stored privately against this candidate only, through the
            same resume system an imported candidate uses. If the candidate is
            already in this job, their existing resume is left untouched.
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={submitting || form.email.trim() === ""}>
          {submitting ? <Spinner className="h-4 w-4" /> : <PlusIcon className="h-4 w-4" />}
          {submitting ? "Adding..." : "Add candidate"}
        </Button>
      </div>

      {notice && <p className="mt-2 text-xs text-emerald-700">{notice}</p>}
      {error && <p className="mt-2 text-xs text-rose-700">{error}</p>}
    </form>
  );
};

export default ManualCandidateAdd;



