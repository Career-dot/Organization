import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import Container from "../../components/ui/Container";
import Alert from "../../components/ui/Alert";
import Button from "../../components/ui/Button";
import FormField, { inputClasses } from "../../components/ui/FormField";
import { useAuth } from "../../hooks/useAuth";
import { extractApiErrorMessage } from "../../utils/apiError";
import {
  deleteEmployeeFile,
  fetchEmployeeFileUrl,
  getCurrentUser,
  getRecruiterProfile,
  saveRecruiterProfile,
  uploadEmployeeFile,
} from "../../services/authService";
import { getOrganizationBranding } from "../../services/organizationService";

const WRITABLE_FIELDS = [
  "companyName",
  "jobTitle",
  "businessEmail",
  "businessPhone",
  "linkedInUrl",
  "companyWebsite",
  "bio",
  "location",
  "yearsExperience",
  "specialties",
];

const EMPTY_PROFILE = Object.fromEntries(WRITABLE_FIELDS.map((field) => [field, field === "yearsExperience" ? "" : ""]));
const OPTIONAL_FIELDS = ["businessEmail", "businessPhone", "linkedInUrl", "companyWebsite", "location", "yearsExperience", "specialties", "bio"];

const inputField = (profile, updateField, field, label, options = {}) => (
  <FormField key={field} label={label} id={field} error={options.error}>
    <input
      id={field}
      type={options.type ?? "text"}
      min={options.type === "number" ? 0 : undefined}
      max={options.type === "number" ? 100 : undefined}
      required={options.required}
      placeholder={options.placeholder}
      className={inputClasses}
      value={profile[field] ?? ""}
      onChange={(event) => updateField(field, event.target.value)}
    />
  </FormField>
);

const persistedFileId = (value) => value?.match(/\/files\/([^/]+)\/(?:view|download)(?:\?.*)?$/)?.[1] ?? "";

const RecruiterProfileSetup = () => {
  const navigate = useNavigate();
  const { user, updateUser } = useAuth();
  const isOrganizationRecruiter = user?.accounts?.some(
    ({ role, scope }) => role === "RECRUITER" && scope === "organization"
  );
  const [profile, setProfile] = useState(EMPTY_PROFILE);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(null);
  const [errors, setErrors] = useState({});
  const [profileAvatarUrl, setProfileAvatarUrl] = useState("");
  const [basicInformation, setBasicInformation] = useState({
    fullName: user?.fullName ?? "",
    phone: user?.phone ?? "",
    city: user?.city ?? "",
    country: user?.country ?? "",
  });
  const [pendingProfileFile, setPendingProfileFile] = useState(null);
  const [pendingProfileImagePreview, setPendingProfileImagePreview] = useState("");
  const [pendingDeleteImage, setPendingDeleteImage] = useState(false);
  const [organizationBranding, setOrganizationBranding] = useState(null);
  const [organizationLogoPreview, setOrganizationLogoPreview] = useState("");

  // Shared User identity fields are editable in setup only when the
  // corresponding User field is empty (first-time initialization). Once
  // established, they are read-only here — Account Settings is the
  // intentional place to edit them later.
  const isSharedFieldEstablished = (field) => Boolean(user?.[field]?.trim());
  const canEditSharedField = (field) => !isSharedFieldEstablished(field);

  useEffect(() => {
    let mounted = true;
    let objectUrl = "";
    let organizationObjectUrl = "";
    const savedImage = user?.profileImage || "";
    const fileId = persistedFileId(savedImage);

    if (fileId) {
      fetchEmployeeFileUrl(fileId, "view")
        .then((url) => {
          objectUrl = url;
          if (mounted) setProfileAvatarUrl(url);
        })
        .catch(() => {
          if (mounted) setProfileAvatarUrl("");
        });
    }

    const profileRequest = getRecruiterProfile();
    const brandingRequest = isOrganizationRecruiter
      ? getOrganizationBranding()
      : Promise.resolve(null);
    const userRequest = getCurrentUser();

    Promise.all([profileRequest, brandingRequest, userRequest])
      .then(([response, brandingResponse, userResponse]) => {
        if (!mounted) return;
        const freshUser = userResponse?.data;
        if (freshUser) {
          updateUser(freshUser);
        }
        const currentUserData = freshUser ?? user;
        const current = response.data?.profile ?? {};
        setProfile(Object.fromEntries(WRITABLE_FIELDS.map((field) => [field, current[field] ?? ""])));
        setBasicInformation({
          fullName: currentUserData?.fullName ?? "",
          phone: currentUserData?.phone ?? "",
          city: currentUserData?.city ?? "",
          country: currentUserData?.country ?? "",
        });
        if (currentUserData?.profileImage) {
          const freshFileId = persistedFileId(currentUserData.profileImage);
          if (freshFileId && freshFileId !== fileId) {
            fetchEmployeeFileUrl(freshFileId, "view")
              .then((url) => {
                if (mounted) setProfileAvatarUrl(url);
              })
              .catch(() => {});
          }
        }
        if (brandingResponse) {
          const branding = brandingResponse.data ?? null;
          setOrganizationBranding(branding);
          const logoId = branding?.organizationLogo?.match(/\/files\/([^/]+)\/view$/)?.[1];
          if (logoId) {
            fetchEmployeeFileUrl(logoId, "view").then((url) => {
              organizationObjectUrl = url;
              if (mounted) setOrganizationLogoPreview(url);
              else URL.revokeObjectURL(url);
            }).catch(() => {});
          }
        }
      })
      .catch((error) => {
        if (mounted) setNotice({ type: "error", text: extractApiErrorMessage(error, "Unable to load your recruiter profile. Please try again.") });
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => {
      mounted = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      if (organizationObjectUrl) URL.revokeObjectURL(organizationObjectUrl);
    };
  }, [isOrganizationRecruiter, updateUser, user?.city, user?.country, user?.fullName, user?.phone, user?.profileImage]);

  const profileAvatarSource = persistedFileId(user?.profileImage || "") ? profileAvatarUrl : "";

  const updateField = (field, value) => {
    setProfile((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: "" }));
  };

  const updateBasicInformation = (field, value) => {
    setBasicInformation((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: "" }));
  };

  const handleProfileImageChange = (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/") || file.size > 2 * 1024 * 1024) {
      setErrors((current) => ({ ...current, profileImage: "Choose an image under 2 MB." }));
      return;
    }
    setPendingProfileFile(file);
    setPendingDeleteImage(false);
    setErrors((current) => ({ ...current, profileImage: "" }));
    setPendingProfileImagePreview((current) => {
      if (current) URL.revokeObjectURL(current);
      return URL.createObjectURL(file);
    });
  };

  const handleProfileImageRemove = () => {
    if (!user?.profileImage && !pendingProfileImagePreview) return;
    setPendingProfileFile(null);
    setPendingDeleteImage(true);
    setPendingProfileImagePreview((current) => {
      if (current) URL.revokeObjectURL(current);
      return "";
    });
  };

  const validate = () => {
    const nextErrors = {};
    if (!isOrganizationRecruiter && !profile.companyName.trim()) nextErrors.companyName = "Company or agency name is required.";
    if (!profile.jobTitle.trim()) nextErrors.jobTitle = "Job title is required.";
    if (canEditSharedField("phone") && !basicInformation.phone.trim()) nextErrors.phone = "Phone number is required.";
    if (canEditSharedField("city") && !basicInformation.city.trim()) nextErrors.city = "City is required.";
    if (canEditSharedField("country") && !basicInformation.country.trim()) nextErrors.country = "Country is required.";
    if (canEditSharedField("profileImage") && !user?.profileImage && !pendingProfileFile) nextErrors.profileImage = "Profile picture is required.";
    if (profile.businessEmail && !/^\S+@\S+\.\S+$/.test(profile.businessEmail)) nextErrors.businessEmail = "Please enter a valid business email.";
    if (profile.linkedInUrl && !/^https?:\/\//i.test(profile.linkedInUrl)) nextErrors.linkedInUrl = "Please enter a valid LinkedIn URL.";
    if (profile.companyWebsite && !/^https?:\/\//i.test(profile.companyWebsite)) nextErrors.companyWebsite = "Please enter a valid company website URL.";
    if (profile.yearsExperience !== "" && (!Number.isInteger(Number(profile.yearsExperience)) || Number(profile.yearsExperience) < 0 || Number(profile.yearsExperience) > 100)) {
      nextErrors.yearsExperience = "Years of experience must be between 0 and 100.";
    }
    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const isComplete = Boolean(profile.companyName.trim() && profile.jobTitle.trim());
  const completedRequired = [profile.companyName, profile.jobTitle].filter((value) => value.trim()).length;
  const completedOptional = OPTIONAL_FIELDS.filter((field) => String(profile[field] ?? "").trim()).length;
  const progress = Math.round((completedRequired / 2) * 100);

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!validate()) {
      setNotice({ type: "error", text: "Please review the highlighted fields." });
      return;
    }

    const payload = Object.fromEntries(WRITABLE_FIELDS.map((field) => [
      field,
      field === "yearsExperience"
        ? (profile[field] === "" ? null : Number(profile[field]))
        : profile[field].trim() || null,
    ]));

    if (canEditSharedField("phone")) payload.phone = basicInformation.phone;
    if (canEditSharedField("city")) payload.city = basicInformation.city;
    if (canEditSharedField("country")) payload.country = basicInformation.country;

    setSaving(true);
    setNotice(null);
    try {
      if (pendingProfileFile) {
        const uploaded = await uploadEmployeeFile({ category: "PROFILE_IMAGE", file: pendingProfileFile });
        const file = uploaded?.data ?? uploaded;
        payload.profileImage = file.profileImage || `/api/files/${file.id}/view`;
      }

      const response = await saveRecruiterProfile(payload);

      if (pendingProfileFile) {
        const previousProfileImageId = persistedFileId(user?.profileImage);
        if (previousProfileImageId) await deleteEmployeeFile(previousProfileImageId);
      }

      const currentUser = await getCurrentUser();
      updateUser(currentUser.data);
      setPendingProfileFile(null);
      setPendingDeleteImage(false);
      setPendingProfileImagePreview((current) => {
        if (current) URL.revokeObjectURL(current);
        return "";
      });
      const savedProfile = response.data?.profile ?? profile;
      setProfile(Object.fromEntries(WRITABLE_FIELDS.map((field) => [field, savedProfile[field] ?? ""])));
      const savedIsComplete = response.data?.isComplete === true || currentUser.data?.onboarding?.nextStep === "DASHBOARD";
      setNotice({ type: "success", text: "Recruiter profile saved successfully." });
      if (savedIsComplete) navigate("/recruiter/dashboard", { replace: true });
    } catch (error) {
      setNotice({ type: "error", text: extractApiErrorMessage(error, "We couldn't save your changes. Please try again.") });
    } finally {
      setSaving(false);
    }
  };

  const handleOrganizationRecruiterSubmit = async (event) => {
    event.preventDefault();
    const nextErrors = {};
    if (canEditSharedField("fullName") && !basicInformation.fullName.trim()) nextErrors.fullName = "Full name is required.";
    if (canEditSharedField("phone") && !basicInformation.phone.trim()) nextErrors.phone = "Phone number is required.";
    if (canEditSharedField("city") && !basicInformation.city.trim()) nextErrors.city = "City is required.";
    if (canEditSharedField("country") && !basicInformation.country.trim()) nextErrors.country = "Country is required.";
    if (canEditSharedField("profileImage") && !user?.profileImage && !pendingProfileFile) nextErrors.profileImage = "Profile picture is required.";
    if (!profile.jobTitle.trim()) nextErrors.jobTitle = "Job title is required.";
    if (profile.linkedInUrl && !/^https?:\/\//i.test(profile.linkedInUrl)) nextErrors.linkedInUrl = "Please enter a valid LinkedIn URL.";
    if (profile.yearsExperience !== "" && (!Number.isInteger(Number(profile.yearsExperience)) || Number(profile.yearsExperience) < 0 || Number(profile.yearsExperience) > 100)) nextErrors.yearsExperience = "Years of experience must be between 0 and 100.";
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setSaving(true);
    setNotice(null);
    try {
      // Build the recruiter profile payload. Shared User identity fields
      // (phone, city, country, profileImage) are sent through the protected
      // saveRecruiterProfile endpoint, which uses getUserAccountFieldUpdate
      // (fill-only-if-empty) — established shared identity is never
      // overwritten here. fullName is NOT sent: it is registration-owned.
      const recruiterPayload = {
        jobTitle: profile.jobTitle,
        linkedInUrl: profile.linkedInUrl,
        bio: profile.bio,
        location: profile.location,
        yearsExperience: profile.yearsExperience === "" ? null : Number(profile.yearsExperience),
        specialties: profile.specialties,
      };

      if (canEditSharedField("phone")) recruiterPayload.phone = basicInformation.phone;
      if (canEditSharedField("city")) recruiterPayload.city = basicInformation.city;
      if (canEditSharedField("country")) recruiterPayload.country = basicInformation.country;

      if (pendingProfileFile) {
        const uploaded = await uploadEmployeeFile({ category: "PROFILE_IMAGE", file: pendingProfileFile });
        const file = uploaded?.data ?? uploaded;
        recruiterPayload.profileImage = file.profileImage || `/api/files/${file.id}/view`;
      }

      const recruiterResponse = await saveRecruiterProfile(recruiterPayload);

      if (pendingProfileFile) {
        const previousProfileImageId = persistedFileId(user?.profileImage);
        if (previousProfileImageId) await deleteEmployeeFile(previousProfileImageId);
      }

      const currentUser = await getCurrentUser();
      updateUser(currentUser.data);
      setPendingProfileFile(null);
      setPendingDeleteImage(false);
      setPendingProfileImagePreview((current) => {
        if (current) URL.revokeObjectURL(current);
        return "";
      });
      const savedIsComplete = recruiterResponse.data?.isComplete === true || currentUser.data?.onboarding?.nextStep === "DASHBOARD";
      setNotice({ type: "success", text: "Recruiter profile saved successfully." });
      if (savedIsComplete) navigate("/recruiter/dashboard", { replace: true });
    } catch (error) {
      setNotice({ type: "error", text: extractApiErrorMessage(error, "Unable to save your recruiter profile.") });
    } finally {
      setSaving(false);
    }
  };


  if (loading) {
    return <Container className="max-w-4xl py-16"><p className="text-sm text-slate-500">Loading your recruiter profile...</p></Container>;
  }

  const orgRecruiterView = (
    <form onSubmit={handleOrganizationRecruiterSubmit} className="space-y-5">
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
        <h2 className="font-display text-xl font-bold text-slate-900">Profile Picture</h2>
        <div className="mt-5 flex flex-wrap items-center gap-4">
          {!pendingDeleteImage && (pendingProfileImagePreview || profileAvatarUrl) ? <img src={pendingProfileImagePreview || profileAvatarUrl} alt="Profile preview" className="h-20 w-20 rounded-full object-cover" /> : <div className="flex h-20 w-20 items-center justify-center rounded-full bg-slate-200 text-xs text-slate-500">No photo</div>}
          {canEditSharedField("profileImage") && !pendingProfileFile ? <label className="cursor-pointer rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-indigo-700 shadow-sm ring-1 ring-indigo-200">Choose picture<input type="file" accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" className="sr-only" onChange={handleProfileImageChange} /></label> : null}
          {canEditSharedField("profileImage") && pendingProfileFile ? <button type="button" className="text-sm font-semibold text-rose-600" onClick={handleProfileImageRemove}>Remove Image</button> : null}
          {canEditSharedField("profileImage") && (user?.profileImage || pendingProfileImagePreview) && !pendingDeleteImage && <button type="button" className="text-sm font-semibold text-rose-600" onClick={handleProfileImageRemove}>Remove Image</button>}
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
        <h2 className="font-display text-xl font-bold text-slate-900">Basic Information</h2>
        <div className="mt-6 grid gap-5 md:grid-cols-2">
          <FormField label="Full name" id="orgRecruiterFullName" error={errors.fullName}>
            {canEditSharedField("fullName")
              ? <input id="orgRecruiterFullName" className={inputClasses} value={basicInformation.fullName} onChange={(event) => updateBasicInformation("fullName", event.target.value)} />
              : <input id="orgRecruiterFullName" className={`${inputClasses} bg-slate-100`} value={basicInformation.fullName} readOnly aria-readonly="true" />}
          </FormField>
          <FormField label="Email" id="orgRecruiterEmail"><input id="orgRecruiterEmail" type="email" className={`${inputClasses} bg-slate-100`} value={user?.email ?? ""} readOnly aria-readonly="true" /></FormField>
          <FormField label="Phone" id="orgRecruiterPhone" error={errors.phone}>
            {canEditSharedField("phone")
              ? <input id="orgRecruiterPhone" className={inputClasses} value={basicInformation.phone} onChange={(event) => updateBasicInformation("phone", event.target.value)} />
              : <input id="orgRecruiterPhone" className={`${inputClasses} bg-slate-100`} value={basicInformation.phone} readOnly aria-readonly="true" />}
          </FormField>
          <FormField label="City" id="orgRecruiterCity" error={errors.city}>
            {canEditSharedField("city")
              ? <input id="orgRecruiterCity" className={inputClasses} value={basicInformation.city} onChange={(event) => updateBasicInformation("city", event.target.value)} />
              : <input id="orgRecruiterCity" className={`${inputClasses} bg-slate-100`} value={basicInformation.city} readOnly aria-readonly="true" />}
          </FormField>
          <FormField label="Country" id="orgRecruiterCountry" error={errors.country}>
            {canEditSharedField("country")
              ? <input id="orgRecruiterCountry" className={inputClasses} value={basicInformation.country} onChange={(event) => updateBasicInformation("country", event.target.value)} />
              : <input id="orgRecruiterCountry" className={`${inputClasses} bg-slate-100`} value={basicInformation.country} readOnly aria-readonly="true" />}
          </FormField>
          {inputField(profile, updateField, "jobTitle", "Job title", { required: true, placeholder: "Technical Recruiter", error: errors.jobTitle })}
          {inputField(profile, updateField, "location", "Location", { placeholder: "Lahore, Pakistan" })}
          {inputField(profile, updateField, "linkedInUrl", "LinkedIn profile", { placeholder: "https://linkedin.com/in/your-name", error: errors.linkedInUrl })}
          {inputField(profile, updateField, "yearsExperience", "Years of experience", { type: "number", placeholder: "5", error: errors.yearsExperience })}
          <FormField label="Specialties" id="orgRecruiterSpecialties"><input id="orgRecruiterSpecialties" className={inputClasses} value={profile.specialties} onChange={(event) => updateField("specialties", event.target.value)} /></FormField>
          <FormField label="Bio" id="orgRecruiterBio"><textarea id="orgRecruiterBio" className={`${inputClasses} min-h-32 md:col-span-2`} value={profile.bio} onChange={(event) => updateField("bio", event.target.value)} /></FormField>
        </div>
        <div className="mt-6 flex justify-end"><Button type="submit" disabled={saving}>{saving ? "Saving..." : "Save"}</Button></div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
        <h2 className="font-display text-xl font-bold text-slate-900">Company Information</h2>
        <p className="mt-1 text-sm text-slate-500">Organization information is supplied by your active organization membership.</p>
        <div className="mt-6 grid gap-5 md:grid-cols-2">
          <FormField label="Organization name" id="orgName"><input id="orgName" className={`${inputClasses} bg-slate-100`} value={organizationBranding?.name ?? ""} readOnly aria-readonly="true" /></FormField>
          <FormField label="Organization logo" id="orgLogo"><div className="flex h-11 items-center gap-3 rounded-xl border border-slate-300 bg-slate-100 px-3">{organizationLogoPreview ? <img src={organizationLogoPreview} alt="Organization logo" className="h-8 w-8 rounded object-cover" /> : <span className="text-sm text-slate-500">No logo available</span>}<span className="text-xs text-slate-500">Read-only</span></div></FormField>
        </div>
      </section>
    </form>
  );

  return (
    <Container className="max-w-4xl py-8 sm:py-12">
      <div className="mb-8 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wider text-indigo-600">Recruiter onboarding</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight text-slate-950">Build your recruiter profile</h1>
          <p className="mt-2 max-w-2xl text-slate-600">Complete your professional profile so candidates and organizations can understand who you are.</p>
        </div>
        <div className="min-w-52 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between text-sm font-semibold text-slate-700"><span>Profile completion</span><span className="text-indigo-600">{progress}%</span></div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-indigo-600 transition-all" style={{ width: `${progress}%` }} /></div>
          <p className="mt-2 text-xs text-slate-500">{completedRequired}/2 required fields complete · {completedOptional} optional details added</p>
        </div>
      </div>

      {notice && <div className="mb-5"><Alert variant={notice.type === "error" ? "error" : "success"}>{notice.text}</Alert></div>}

      {isOrganizationRecruiter ? orgRecruiterView : (
      <form onSubmit={handleSubmit} className="space-y-5">
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
          <div className="flex items-start justify-between gap-4"><div><h2 className="font-display text-xl font-bold text-slate-900">Professional information</h2><p className="mt-1 text-sm text-slate-500">Tell people what you do and who you represent.</p></div><span className="rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700">Required</span></div>
          <div className="mt-6 grid gap-5 md:grid-cols-2">
            <FormField label="Shared account identity" id="canonicalName">
              <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 p-2.5">
                <div className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-full bg-indigo-100 text-sm font-bold text-indigo-700">
                  {!pendingDeleteImage && (pendingProfileImagePreview || profileAvatarSource) ? (
                    <img src={pendingProfileImagePreview || profileAvatarSource} alt={user?.fullName || user?.email || "Profile"} className="h-full w-full object-cover" />
                  ) : (
                    (user?.fullName || user?.email || "A").slice(0, 1).toUpperCase()
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div id="canonicalName" className="text-sm font-semibold text-slate-900">{user?.fullName || user?.email}</div>
                  <p className="mt-1 text-xs text-slate-500">
                    {canEditSharedField("profileImage")
                      ? "Upload a profile picture for your canonical account."
                      : "This identity is shared with your main account and cannot be changed here."}
                  </p>
                  {canEditSharedField("profileImage") && (
                    <div className="mt-2 flex items-center gap-3">
                      {!pendingProfileFile ? (
                        <label className="cursor-pointer rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-indigo-700 shadow-sm ring-1 ring-indigo-200">
                          Choose picture
                          <input type="file" accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" className="sr-only" onChange={handleProfileImageChange} />
                        </label>
                      ) : (
                        <button type="button" className="text-xs font-semibold text-rose-600" onClick={handleProfileImageRemove}>
                          Remove Image
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
              {errors.profileImage && <p className="mt-2 text-sm text-red-600">{errors.profileImage}</p>}
            </FormField>
            <div />
            <FormField label="Full name" id="independentRecruiterFullName">
              <input
                id="independentRecruiterFullName"
                className={`${inputClasses} bg-slate-100 text-slate-700`}
                value={user?.fullName || user?.email || ""}
                readOnly
                aria-readonly="true"
              />
            </FormField>
            <FormField label="Email" id="independentRecruiterEmail">
              <input
                id="independentRecruiterEmail"
                type="email"
                className={`${inputClasses} bg-slate-100 text-slate-700`}
                value={user?.email ?? ""}
                readOnly
                aria-readonly="true"
              />
            </FormField>
            <FormField label="Phone" id="independentRecruiterPhone" error={errors.phone}>
              {canEditSharedField("phone") ? (
                <input
                  id="independentRecruiterPhone"
                  className={inputClasses}
                  value={basicInformation.phone}
                  placeholder="+92 300 1234567"
                  onChange={(event) => updateBasicInformation("phone", event.target.value)}
                />
              ) : (
                <input
                  id="independentRecruiterPhone"
                  className={`${inputClasses} bg-slate-100 text-slate-700`}
                  value={user?.phone || ""}
                  readOnly
                  aria-readonly="true"
                />
              )}
            </FormField>
            <FormField label="City" id="independentRecruiterCity" error={errors.city}>
              {canEditSharedField("city") ? (
                <input
                  id="independentRecruiterCity"
                  className={inputClasses}
                  value={basicInformation.city}
                  placeholder="Lahore"
                  onChange={(event) => updateBasicInformation("city", event.target.value)}
                />
              ) : (
                <input
                  id="independentRecruiterCity"
                  className={`${inputClasses} bg-slate-100 text-slate-700`}
                  value={user?.city || ""}
                  readOnly
                  aria-readonly="true"
                />
              )}
            </FormField>
            <FormField label="Country" id="independentRecruiterCountry" error={errors.country}>
              {canEditSharedField("country") ? (
                <input
                  id="independentRecruiterCountry"
                  className={inputClasses}
                  value={basicInformation.country}
                  placeholder="Pakistan"
                  onChange={(event) => updateBasicInformation("country", event.target.value)}
                />
              ) : (
                <input
                  id="independentRecruiterCountry"
                  className={`${inputClasses} bg-slate-100 text-slate-700`}
                  value={user?.country || ""}
                  readOnly
                  aria-readonly="true"
                />
              )}
            </FormField>
            <div />
            {!isOrganizationRecruiter && inputField(profile, updateField, "companyName", "Company / Agency", { required: true, placeholder: "ABC Technologies", error: errors.companyName })}
            {inputField(profile, updateField, "jobTitle", "Job title", { required: true, placeholder: "Technical Recruiter", error: errors.jobTitle })}
            {inputField(profile, updateField, "location", "Location", { placeholder: "Lahore, Pakistan" })}
          </div>
          {errors.companyName && <p className="mt-2 text-sm text-red-600">{errors.companyName}</p>}
          {errors.jobTitle && <p className="mt-2 text-sm text-red-600">{errors.jobTitle}</p>}
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
          <h2 className="font-display text-xl font-bold text-slate-900">Business contact</h2>
          <p className="mt-1 max-w-2xl text-sm text-slate-500">Your business contact information is separate from your main account contact information. Use your organization&apos;s professional email and phone here.</p>
          <div className="mt-6 grid gap-5 md:grid-cols-2">
            {!isOrganizationRecruiter && inputField(profile, updateField, "businessEmail", "Business email", { type: "email", placeholder: "recruiting@company.com", error: errors.businessEmail })}
            {!isOrganizationRecruiter && inputField(profile, updateField, "businessPhone", "Business phone", { placeholder: "+92 300 1234567" })}
            {inputField(profile, updateField, "linkedInUrl", "LinkedIn profile", { placeholder: "https://linkedin.com/in/your-name", error: errors.linkedInUrl })}
            {!isOrganizationRecruiter && inputField(profile, updateField, "companyWebsite", "Company website", { placeholder: "https://company.com", error: errors.companyWebsite })}
          </div>
          {(errors.businessEmail || errors.linkedInUrl || errors.companyWebsite) && <p className="mt-2 text-sm text-red-600">{errors.businessEmail || errors.linkedInUrl || errors.companyWebsite}</p>}
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
          <h2 className="font-display text-xl font-bold text-slate-900">Experience &amp; expertise</h2>
          <p className="mt-1 text-sm text-slate-500">Help candidates understand the markets and roles you know best.</p>
          <div className="mt-6 grid gap-5 md:grid-cols-2">
            {inputField(profile, updateField, "yearsExperience", "Years of experience", { type: "number", placeholder: "5", error: errors.yearsExperience })}
            <FormField label="Specialties" id="specialties"><input id="specialties" className={inputClasses} value={profile.specialties} placeholder="Software Engineering, AI / ML, Product" onChange={(event) => updateField("specialties", event.target.value)} /><p className="mt-1.5 text-xs text-slate-500">Separate specialties with commas.</p></FormField>
            <FormField label="Bio" id="bio"><textarea id="bio" className={`${inputClasses} min-h-32 md:col-span-2`} value={profile.bio} placeholder="Tell candidates and organizations briefly about your recruiting experience, industries you work with, and the types of professionals you recruit." onChange={(event) => updateField("bio", event.target.value)} /></FormField>
          </div>
        </section>

        <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className={`text-sm font-medium ${isComplete ? "text-emerald-700" : "text-slate-500"}`}>{isComplete ? "Your recruiter profile is complete." : "Company / Agency and Job title are required to continue."}</p>
          <Button type="submit" disabled={saving}>{saving ? "Saving..." : isComplete ? "Continue to Recruiter Dashboard" : "Save profile"}</Button>
        </div>
      </form>
      )}
    </Container>
  );
};

export default RecruiterProfileSetup;
