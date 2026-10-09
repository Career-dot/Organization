import { useEffect, useState } from "react";
import DashboardShell from "../../components/ui/DashboardShell";
import Alert from "../../components/ui/Alert";
import Button from "../../components/ui/Button";
import FormField, { inputClasses } from "../../components/ui/FormField";
import { getCandidateProfile, saveCandidateProfileSection } from "../../services/authService";
import { EMPLOYEE_NAV_ITEMS } from "../../constants/employeeNav";

const AVAILABILITY = [
  ["ACTIVELY_LOOKING", "Actively looking"],
  ["OPEN_TO_OPPORTUNITIES", "Open to opportunities"],
  ["EMPLOYED_NOT_LOOKING", "Employed, not looking"],
  ["FREELANCE_AVAILABLE", "Freelance available"],
];

const normalizeRoles = (value) => {
  if (Array.isArray(value)) return value.filter((role) => typeof role === "string" && role.trim()).map((role) => role.trim());
  return typeof value === "string" && value.trim() ? [value.trim()] : [];
};

const EmployeeProfile = () => {
  const [form, setForm] = useState({ headline: "", bio: "", careerInformation: "", availability: "ACTIVELY_LOOKING", preferredRoles: [] });
  const [roleDraft, setRoleDraft] = useState("");
  const [roleExperiences, setRoleExperiences] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let mounted = true;
    getCandidateProfile()
      .then((response) => {
        const profile = response?.data?.profile ?? {};
        const data = profile.profileData ?? {};
        if (!mounted) return;
        setForm({
          headline: profile.headline ?? data.generalInformation?.headline ?? "",
          bio: profile.bio ?? data.professionalDescription?.bio ?? "",
          careerInformation: data.careerInformation?.details ?? "",
          availability: profile.availability ?? data.generalInformation?.availability ?? "ACTIVELY_LOOKING",
          preferredRoles: normalizeRoles(data.jobPreferences?.preferredRole),
        });
        setRoleExperiences(data.jobPreferences?.preferredRoleExperience ?? {});
      })
      .catch(() => mounted && setError("Unable to load your profile information."))
      .finally(() => mounted && setLoading(false));
    return () => { mounted = false; };
  }, []);

  const addRole = () => {
    const role = roleDraft.trim();
    if (!role || form.preferredRoles.includes(role)) return;
    setForm((current) => ({ ...current, preferredRoles: [...current.preferredRoles, role] }));
    setRoleDraft("");
  };

  const removeRole = (role) => {
    setForm((current) => ({ ...current, preferredRoles: current.preferredRoles.filter((item) => item !== role) }));
    setRoleExperiences((current) => {
      const updated = { ...current };
      delete updated[role];
      return updated;
    });
  };

  const updateRoleExperience = (role, value) => {
    const years = value === "" ? "" : Math.min(80, Math.max(0, parseInt(value, 10) || 0));
    setRoleExperiences((current) => ({
      ...current,
      [role]: value === "" ? "" : years,
    }));
  };

  const save = async (event) => {
    event.preventDefault();
    setSaving(true); setError(""); setNotice("");
    try {
      await saveCandidateProfileSection("generalInformation", { headline: form.headline.trim(), availability: form.availability });
      await saveCandidateProfileSection("professionalDescription", { bio: form.bio.trim() });
      await saveCandidateProfileSection("careerInformation", { details: form.careerInformation.trim() });
      await saveCandidateProfileSection("jobPreferences", { 
        preferredRole: form.preferredRoles,
        preferredRoleExperience: roleExperiences,
      });
      setNotice("Profile and career information saved.");
    } catch (requestError) {
      setError(requestError.response?.data?.message ?? "Unable to save your profile information.");
    } finally { setSaving(false); }
  };

  if (loading) return <div className="p-10 text-sm text-slate-500">Loading profile information...</div>;

  return (
    <DashboardShell roleLabel="Candidate" title="Profile & Career" description="Shape the professional information that belongs to your Candidate profile." navItems={EMPLOYEE_NAV_ITEMS}>
      <form className="space-y-6" onSubmit={save}>
        {error && <Alert variant="error">{error}</Alert>}
        {notice && <Alert variant="success">{notice}</Alert>}
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="font-display text-lg font-bold text-slate-900">Professional information</h2>
          <div className="mt-5 space-y-5">
            <FormField label="Professional headline"><input className={inputClasses} value={form.headline} onChange={(event) => setForm({ ...form, headline: event.target.value })} /></FormField>
            <FormField label="About / description"><textarea className={`${inputClasses} min-h-32`} value={form.bio} onChange={(event) => setForm({ ...form, bio: event.target.value })} /></FormField>
            <FormField label="Career information"><textarea className={`${inputClasses} min-h-28`} value={form.careerInformation} onChange={(event) => setForm({ ...form, careerInformation: event.target.value })} /></FormField>
            <FormField label="Availability"><select className={inputClasses} value={form.availability} onChange={(event) => setForm({ ...form, availability: event.target.value })}>{AVAILABILITY.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></FormField>
          </div>
        </section>
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="font-display text-lg font-bold text-slate-900">Preferred roles</h2>
          <p className="mt-1 text-sm text-slate-500">Career preferences, separate from your account roles.</p>
          <div className="mt-5 flex flex-wrap gap-4">
            {form.preferredRoles.map((role) => (
              <span key={role} className="inline-flex items-center gap-2 rounded-full bg-indigo-50 px-3 py-1.5 text-sm font-medium text-indigo-700">
                {role}
                <span className="flex items-center gap-1">
                  <input
                    type="number"
                    min="0"
                    max="80"
                    className="w-16 rounded border border-slate-300 bg-white px-2 py-1 text-sm text-slate-700 text-center"
                    value={roleExperiences[role] ?? ""}
                    onChange={(event) => updateRoleExperience(role, event.target.value)}
                    aria-label={`Years of experience for ${role}`}
                  />
                  <span className="text-slate-500">years</span>
                </span>
                <button type="button" className="text-indigo-500 hover:text-indigo-900" aria-label={`Remove ${role}`} onClick={() => removeRole(role)}>×</button>
              </span>
            ))}
          </div>
          <div className="mt-4 flex flex-col gap-2 sm:flex-row"><input className={inputClasses} value={roleDraft} placeholder="Add a preferred role" onChange={(event) => setRoleDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addRole(); } }} /><Button type="button" variant="outline" onClick={addRole}>Add role</Button></div>
        </section>
        <div className="flex justify-end"><Button type="submit" disabled={saving}>{saving ? "Saving..." : "Save Changes"}</Button></div>
      </form>
    </DashboardShell>
  );
};

export default EmployeeProfile;
