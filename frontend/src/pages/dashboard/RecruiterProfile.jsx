import { useEffect, useState } from "react";
import DashboardShell from "../../components/ui/DashboardShell";
import Alert from "../../components/ui/Alert";
import Button from "../../components/ui/Button";
import FormField, { inputClasses } from "../../components/ui/FormField";
import { RECRUITER_NAV_ITEMS } from "../../constants/recruiterNav";
import {
  getRecruiterProfile,
  saveRecruiterProfile,
} from "../../services/authService";
import { extractApiErrorMessage } from "../../utils/apiError";

// Reuses the EXISTING recruiter profile API only (GET/PUT
// /auth/recruiter/profile) -- the same endpoint and the same RecruiterProfile
// row that /recruiter/profile-setup (first-time onboarding) writes to. There
// is no second profile model and no duplicated storage.
//
// Professional recruiter information only. Shared account identity (full name,
// email, phone, city, country, profile image) and company/business contact
// details belong to Account Settings at /account/settings and are deliberately
// NOT read or written here.
//
// Field mapping onto the existing RecruiterProfile columns:
//   Years of Experience     -> yearsExperience (Int?)
//   Recruiter Description   -> bio            (String?)
//   Hiring Fields / Domains -> specialties    (String?)
//   Roles They Hire For     -> NO COLUMN EXISTS YET (see the form below)
const cardClasses =
  "rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7";
const disabledInputClasses = `${inputClasses} disabled:bg-slate-50 disabled:text-slate-400`;

const EMPTY_FORM = { yearsExperience: "", bio: "", specialties: "" };

// Mirrors how RecruiterProfileSetup.jsx seeds its own form: an absent value
// becomes "" so it can be edited in a controlled input.
const toFormState = (profile = {}) => ({
  yearsExperience: profile.yearsExperience ?? "",
  bio: profile.bio ?? "",
  specialties: profile.specialties ?? "",
});

const RecruiterProfile = () => {
  const [form, setForm] = useState(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(null);
  const [errors, setErrors] = useState({});

  useEffect(() => {
    let mounted = true;

    getRecruiterProfile()
      .then((response) => {
        if (mounted) setForm(toFormState(response.data?.profile));
      })
      .catch((error) => {
        if (mounted)
          setNotice({
            type: "error",
            text: extractApiErrorMessage(
              error,
              "Unable to load your recruiter profile. Please try again."
            ),
          });
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, []);

  const updateField = (field, value) => {
    setForm((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: "" }));
  };

  const validate = () => {
    const nextErrors = {};

    if (
      form.yearsExperience !== "" &&
      (!Number.isInteger(Number(form.yearsExperience)) ||
        Number(form.yearsExperience) < 0 ||
        Number(form.yearsExperience) > 100)
    ) {
      nextErrors.yearsExperience = "Years of experience must be between 0 and 100.";
    }

    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const handleSubmit = async (event) => {
    event.preventDefault();

    if (!validate()) {
      setNotice({ type: "error", text: "Please review the highlighted fields." });
      return;
    }

    // Same serialization convention the setup page uses: strings are trimmed
    // to null when empty, and yearsExperience is sent as a Number or null
    // (the backend validates it as z.number().int().min(0).max(100)).
    // Only these three keys are sent, so the backend leaves every other
    // RecruiterProfile column (and shared User identity) untouched.
    const payload = {
      yearsExperience:
        form.yearsExperience === "" ? null : Number(form.yearsExperience),
      bio: form.bio.trim() || null,
      specialties: form.specialties.trim() || null,
    };

    setSaving(true);
    setNotice(null);
    try {
      const response = await saveRecruiterProfile(payload);
      setForm(toFormState(response.data?.profile));
      setNotice({ type: "success", text: "Your recruiter profile has been saved." });
    } catch (error) {
      setNotice({
        type: "error",
        text: extractApiErrorMessage(
          error,
          "We couldn't save your recruiter profile. Please try again."
        ),
      });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <DashboardShell
        roleLabel="Recruiter"
        title="Recruiter Profile"
        description="The professional recruiting information that describes how you hire and the roles you recruit for."
        navItems={RECRUITER_NAV_ITEMS}
      >
        <p className="text-sm text-slate-500">Loading your recruiter profile...</p>
      </DashboardShell>
    );
  }

  return (
    <DashboardShell
      roleLabel="Recruiter"
      title="Recruiter Profile"
      description="The professional recruiting information that describes how you hire and the roles you recruit for."
      navItems={RECRUITER_NAV_ITEMS}
    >
      <form onSubmit={handleSubmit} className="space-y-6">
        {notice && <Alert variant={notice.type}>{notice.text}</Alert>}

        <section className={cardClasses}>
          <h2 className="font-display text-lg font-bold text-slate-900">
            Professional details
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Recruiter-specific information only. Your account identity and
            company contact details are managed in Account Settings.
          </p>

          <div className="mt-6 grid gap-5 md:grid-cols-2">
            <FormField
              label="Years of Experience"
              id="yearsExperience"
              error={errors.yearsExperience}
            >
              <input
                id="yearsExperience"
                type="number"
                min={0}
                max={100}
                placeholder="5"
                className={inputClasses}
                value={form.yearsExperience}
                onChange={(event) => updateField("yearsExperience", event.target.value)}
              />
            </FormField>

            <FormField label="Hiring Fields / Domains" id="specialties">
              <input
                id="specialties"
                maxLength={2000}
                placeholder="Software Engineering, AI / ML, Product"
                className={inputClasses}
                value={form.specialties}
                onChange={(event) => updateField("specialties", event.target.value)}
              />
              <p className="mt-1.5 text-xs text-slate-500">
                Separate hiring fields or domains with commas.
              </p>
            </FormField>
          </div>

          {/* "Roles They Hire For" has no persistence yet: RecruiterProfile has
              no column for it, recruiterProfileSchema has no field for it, and
              saveRecruiterProfile has no writable entry for it. It is shown
              read-only rather than silently stored inside specialties or any
              other unrelated field. Enabling it needs an approved Prisma change. */}
          <div className="mt-5">
            <FormField label="Roles They Hire For" id="rolesTheyHireFor">
              <input
                id="rolesTheyHireFor"
                disabled
                readOnly
                value=""
                placeholder="Not available yet"
                className={disabledInputClasses}
              />
              <p className="mt-1.5 text-xs text-slate-500">
                Not editable yet — saving this field is pending a separate
                schema decision.
              </p>
            </FormField>
          </div>
        </section>

        <section className={cardClasses}>
          <h2 className="font-display text-lg font-bold text-slate-900">
            Recruiter description
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Briefly describe your recruiting experience, the industries you work
            with, and the types of professionals you recruit.
          </p>

          <div className="mt-5">
            <FormField label="Recruiter Description" id="bio">
              <textarea
                id="bio"
                maxLength={5000}
                placeholder="Tell candidates and organizations about your recruiting experience, industries you work with, and the types of professionals you recruit."
                className={`${inputClasses} min-h-32`}
                value={form.bio}
                onChange={(event) => updateField("bio", event.target.value)}
              />
            </FormField>
          </div>
        </section>

        <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-slate-500">
            These details are also shown as a summary on your recruiter dashboard.
          </p>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving..." : "Save Changes"}
          </Button>
        </div>
      </form>
    </DashboardShell>
  );
};

export default RecruiterProfile;
