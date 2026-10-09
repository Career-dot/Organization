import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
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
  uploadEmployeeFile,
} from "../../services/authService";
import {
  getOrganizationSummary,
  updateOrganizationProfile,
} from "../../services/organizationService";

const WRITABLE_FIELDS = ["website", "businessEmail"];
const REQUIRED_FIELD_COUNT = 10;
const EMPTY_PROFILE = Object.fromEntries(WRITABLE_FIELDS.map((field) => [field, ""]));

const fileIdFromPath = (value) => value?.match(/\/files\/([^/]+)\/(?:view|download)$/)?.[1] ?? "";

const inputField = (profile, updateField, field, label, options = {}) => (
  <FormField key={field} label={label} id={field} error={options.error}>
    <input
      id={field}
      type={options.type ?? "text"}
      required={options.required}
      placeholder={options.placeholder}
      className={inputClasses}
      value={profile[field] ?? ""}
      onChange={(event) => updateField(field, event.target.value)}
    />
  </FormField>
);

const OrganizationProfileSetup = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, updateUser } = useAuth();
  const isOrganizationSettings = location.search === "?settings=1" || user?.onboarding?.nextStep === "DASHBOARD";
  const [profile, setProfile] = useState(EMPTY_PROFILE);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(null);
  const [errors, setErrors] = useState({});
  const [organizationName, setOrganizationName] = useState("");
  const [personal, setPersonal] = useState({
    profileImage: "",
    phone: "",
    city: "",
    country: "",
  });
  const [pendingProfileImage, setPendingProfileImage] = useState(null);
  const [pendingProfileImagePreview, setPendingProfileImagePreview] = useState("");
  const [removeProfileImage, setRemoveProfileImage] = useState(false);
  const [pendingOrganizationLogo, setPendingOrganizationLogo] = useState(null);
  const [pendingOrganizationLogoPreview, setPendingOrganizationLogoPreview] = useState("");
  const [removeOrganizationLogo, setRemoveOrganizationLogo] = useState(false);
  const [organizationLogo, setOrganizationLogo] = useState("");
  const [organizationLogoPreview, setOrganizationLogoPreview] = useState("");
  const [profileImagePreview, setProfileImagePreview] = useState("");

  // Shared User identity fields are editable in setup only when the
  // corresponding User field is empty (first-time initialization). Once
  // established, they are read-only here — Account Settings is the
  // intentional place to edit them later.
  const isSharedFieldEstablished = (field) => Boolean(user?.[field]?.trim());
  const canEditSharedField = (field) => !isSharedFieldEstablished(field);

  useEffect(() => {
    let mounted = true;

    Promise.all([getOrganizationSummary(), getCurrentUser()])
      .then(([organizationResponse, userResponse]) => {
        if (!mounted) return;
        const org = organizationResponse.data;
        const currentUser = userResponse.data;
        setOrganizationName(org.name || "");
        setProfile(
          Object.fromEntries(
            WRITABLE_FIELDS.map((field) => [field, org[field] ?? ""])
          )
        );
        setOrganizationLogo(org.organizationLogo || "");
        setPersonal({
          profileImage: currentUser.profileImage || "",
          phone: currentUser.phone || "",
          city: currentUser.city || "",
          country: currentUser.country || "",
        });
        updateUser(currentUser);
      })
      .catch((error) => {
        if (mounted) {
          setNotice({
            type: "error",
            text: extractApiErrorMessage(
              error,
              "Unable to load your organization profile. Please try again."
            ),
          });
        }
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [updateUser]);

  useEffect(() => () => {
    if (pendingProfileImagePreview) URL.revokeObjectURL(pendingProfileImagePreview);
    if (pendingOrganizationLogoPreview) URL.revokeObjectURL(pendingOrganizationLogoPreview);
    if (organizationLogoPreview) URL.revokeObjectURL(organizationLogoPreview);
  }, [pendingProfileImagePreview, pendingOrganizationLogoPreview, organizationLogoPreview]);

  useEffect(() => {
    let mounted = true;
    const imageIds = [
      [personal.profileImage, setProfileImagePreview],
      [organizationLogo, setOrganizationLogoPreview],
    ];
    const urls = [];

    Promise.all(imageIds.map(async ([pathValue, setPreview]) => {
      const fileId = fileIdFromPath(pathValue);
      if (!fileId) {
        setPreview("");
        return;
      }
      try {
        const url = await fetchEmployeeFileUrl(fileId, "view");
        urls.push(url);
        if (mounted) setPreview(url);
        else URL.revokeObjectURL(url);
      } catch {
        if (mounted) setPreview("");
      }
    }));

    return () => {
      mounted = false;
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [personal.profileImage, organizationLogo]);

  const updateField = (field, value) => {
    setProfile((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: "" }));
  };

  const updatePersonalField = (field, value) => {
    setPersonal((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: "" }));
  };

  const selectFile = (event, field) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/") || file.size > 2 * 1024 * 1024) {
      setErrors((current) => ({ ...current, [field]: "Choose an image under 2 MB." }));
      return;
    }
    setErrors((current) => ({ ...current, [field]: "" }));
    if (field === "profileImage") {
      setPendingProfileImage(file);
      setPendingProfileImagePreview((current) => {
        if (current) URL.revokeObjectURL(current);
        return URL.createObjectURL(file);
      });
      setRemoveProfileImage(false);
    }
    if (field === "organizationLogo") {
      setPendingOrganizationLogo(file);
      setPendingOrganizationLogoPreview((current) => {
        if (current) URL.revokeObjectURL(current);
        return URL.createObjectURL(file);
      });
      setRemoveOrganizationLogo(false);
    }
  };

  const validate = () => {
    const nextErrors = {};

    if (!organizationName.trim()) {
      nextErrors.organizationName = "Organization name is required.";
    } else if (organizationName.trim().length < 2) {
      nextErrors.organizationName = "Organization name must be at least 2 characters.";
    }

    if (!profile.website.trim()) {
      nextErrors.website = "Website URL is required.";
    } else if (!/^https?:\/\//.test(profile.website)) {
      nextErrors.website = "Website must start with http:// or https://";
    }

    if (!profile.businessEmail.trim()) {
      nextErrors.businessEmail = "Business email is required.";
    } else if (!/^\S+@\S+\.\S+$/.test(profile.businessEmail)) {
      nextErrors.businessEmail = "Please enter a valid business email.";
    }

    if (!isOrganizationSettings) {
      if (canEditSharedField("profileImage") && !personal.profileImage && !pendingProfileImage && !removeProfileImage) nextErrors.profileImage = "Profile picture is required.";
      if (!user?.fullName?.trim()) nextErrors.fullName = "Full name is required on the authenticated User.";
      if (!user?.email?.trim()) nextErrors.email = "Email is required on the authenticated User.";
      if (canEditSharedField("phone") && !personal.phone.trim()) nextErrors.phone = "Phone number is required.";
      if (canEditSharedField("city") && !personal.city.trim()) nextErrors.city = "City is required.";
      if (canEditSharedField("country") && !personal.country.trim()) nextErrors.country = "Country is required.";
    }
    if (!organizationLogo && !pendingOrganizationLogo && !removeOrganizationLogo) nextErrors.organizationLogo = "Organization logo is required.";

    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const completedFields = [
    organizationName,
    profile.website,
    profile.businessEmail,
    removeOrganizationLogo ? "" : organizationLogo || pendingOrganizationLogo,
    ...(isOrganizationSettings ? [] : [
      removeProfileImage ? "" : personal.profileImage || pendingProfileImage,
      user?.fullName,
      user?.email,
      canEditSharedField("phone") ? personal.phone : user?.phone,
      canEditSharedField("city") ? personal.city : user?.city,
      canEditSharedField("country") ? personal.country : user?.country,
    ]),
  ].filter((value) => String(value ?? "").trim()).length;
  const requiredFieldCount = isOrganizationSettings ? 4 : REQUIRED_FIELD_COUNT;
  const isComplete = completedFields === requiredFieldCount;
  const progress = Math.round((completedFields / requiredFieldCount) * 100);

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!validate()) {
      setNotice({ type: "error", text: "Please review the highlighted fields." });
      return;
    }

    const payload = Object.fromEntries(
      WRITABLE_FIELDS.map((field) => [field, profile[field].trim() || null])
    );
    payload.name = organizationName.trim();

    setSaving(true);
    setNotice(null);
    try {
      const previousProfileImageId = fileIdFromPath(personal.profileImage);
      const previousOrganizationLogoId = fileIdFromPath(organizationLogo);

      if (!isOrganizationSettings && pendingProfileImage) {
        const uploaded = await uploadEmployeeFile({ category: "PROFILE_IMAGE", file: pendingProfileImage });
        const file = uploaded?.data ?? uploaded;
        setPersonal((current) => ({ ...current, profileImage: file.profileImage || `/api/files/${file.id}/view` }));
      } else if (!isOrganizationSettings && removeProfileImage && previousProfileImageId) {
        await deleteEmployeeFile(previousProfileImageId);
      }

      if (pendingOrganizationLogo) {
        const uploaded = await uploadEmployeeFile({ category: "ORGANIZATION_DOCUMENT", file: pendingOrganizationLogo });
        const file = uploaded?.data ?? uploaded;
        setOrganizationLogo(`/api/files/${file.id}/view`);
        if (previousOrganizationLogoId) await deleteEmployeeFile(previousOrganizationLogoId);
      } else if (removeOrganizationLogo && previousOrganizationLogoId) {
        await deleteEmployeeFile(previousOrganizationLogoId);
      }

      // Shared User identity fields (phone, city, country, profileImage) are
      // sent through the protected updateOrganizationProfile endpoint, which
      // uses getUserAccountFieldUpdate (fill-only-if-empty) — established
      // shared identity is never overwritten here. fullName/email are NOT
      // sent: they are registration-owned and remain read-only in setup.
      if (!isOrganizationSettings) {
        if (canEditSharedField("phone")) payload.phone = personal.phone;
        if (canEditSharedField("city")) payload.city = personal.city;
        if (canEditSharedField("country")) payload.country = personal.country;
        if (canEditSharedField("profileImage") && personal.profileImage) {
          payload.profileImage = personal.profileImage;
        }
      }

      const response = await updateOrganizationProfile(payload);

      let currentUser;
      try {
        currentUser = await getCurrentUser();
        updateUser(currentUser.data);
      } catch (refreshError) {
        const isUnauthorized = refreshError.response?.status === 401;
        setNotice({
          type: "success",
          text: isUnauthorized
            ? "Organization profile was saved, but your authenticated session expired. Please sign in again."
            : "Organization profile was saved, but the latest account information could not be refreshed.",
        });
        return;
      }

      setProfile(
        Object.fromEntries(
          WRITABLE_FIELDS.map((field) => [field, response.data?.[field] ?? ""])
        )
      );
      setPendingProfileImage(null);
      setPendingOrganizationLogo(null);
      setPendingProfileImagePreview("");
      setPendingOrganizationLogoPreview("");
      setRemoveProfileImage(false);
      setRemoveOrganizationLogo(false);

      const savedIsComplete = isOrganizationSettings || currentUser.data?.onboarding?.nextStep === "DASHBOARD";
      setNotice({
        type: "success",
        text: "Organization profile saved successfully.",
      });

      if (savedIsComplete) {
        navigate("/organization/dashboard", { replace: true });
      }
    } catch (error) {
      setNotice({
        type: "error",
        text: extractApiErrorMessage(
          error,
          "We couldn't save your changes. Please try again."
        ),
      });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Container className="max-w-4xl py-16">
        <p className="text-sm text-slate-500">
          Loading your organization profile...
        </p>
      </Container>
    );
  }

  return (
    <Container className="max-w-4xl py-8 sm:py-12">
      <div className="mb-8 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wider text-indigo-600">
            Organization onboarding
          </p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight text-slate-950">
            Complete your organization profile
          </h1>
          <p className="mt-2 max-w-2xl text-slate-600">
            Tell us about your organization so candidates and recruiters can
            understand who you are.
          </p>
        </div>
        <div className="min-w-52 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between text-sm font-semibold text-slate-700">
            <span>Profile completion</span>
            <span className="text-indigo-600">{progress}%</span>
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full bg-indigo-600 transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="mt-2 text-xs text-slate-500">
            {completedFields}/{REQUIRED_FIELD_COUNT} required fields complete
          </p>
        </div>
      </div>

      {notice && (
        <div className="mb-5">
          <Alert variant={notice.type === "error" ? "error" : "success"}>
            {notice.text}
          </Alert>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-5">
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="font-display text-xl font-bold text-slate-900">
                Organization Information
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                Tell people what your organization does and how to reach you.
              </p>
            </div>
            <span className="rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700">
              Required
            </span>
          </div>
          <div className="mt-6 grid gap-5 md:grid-cols-2">
            <FormField label="Organization name" id="organizationName">
              <input
                id="organizationName"
                className={inputClasses}
                value={organizationName}
                onChange={(event) => {
                  setOrganizationName(event.target.value);
                  setErrors((current) => ({ ...current, organizationName: "" }));
                }}
              />
              {errors.organizationName && <p className="mt-1.5 text-xs text-rose-600">{errors.organizationName}</p>}
            </FormField>
            <div />
            {inputField(profile, updateField, "website", "Website URL", {
              required: true,
              type: "url",
              placeholder: "https://company.com",
              error: errors.website,
            })}
            {inputField(profile, updateField, "businessEmail", "Business email", {
              required: true,
              type: "email",
              placeholder: "info@company.com",
              error: errors.businessEmail,
            })}
            <FormField label="Organization Logo" id="organizationLogo" error={errors.organizationLogo}>
              {(organizationLogoPreview || pendingOrganizationLogoPreview) && <img src={pendingOrganizationLogoPreview || organizationLogoPreview} alt="Organization logo preview" className="mb-3 h-16 w-16 rounded-lg object-cover" />}
              <input id="organizationLogo" type="file" accept="image/*" className={inputClasses} onChange={(event) => selectFile(event, "organizationLogo")} />
              {(organizationLogo || pendingOrganizationLogoPreview) && <button type="button" className="mt-2 text-sm font-semibold text-rose-600" onClick={() => { setPendingOrganizationLogo(null); setPendingOrganizationLogoPreview(""); setRemoveOrganizationLogo(true); }}>Remove organization logo</button>}
            </FormField>
          </div>
          {(errors.website || errors.businessEmail) && (
            <p className="mt-2 text-sm text-red-600">
              {errors.website || errors.businessEmail}
            </p>
          )}
        </section>

        {!isOrganizationSettings && <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
          <div>
            <h2 className="font-display text-xl font-bold text-slate-900">Org Admin Basic Information</h2>
            <p className="mt-1 text-sm text-slate-500">These details belong to your shared User identity and are also used by your Candidate account.</p>
          </div>
          <div className="mt-6 grid gap-5 md:grid-cols-2">
            <FormField label="Profile Picture" id="profileImage" error={errors.profileImage}>
              {(profileImagePreview || pendingProfileImagePreview) && <img src={pendingProfileImagePreview || profileImagePreview} alt="Personal profile preview" className="mb-3 h-16 w-16 rounded-full object-cover" />}
              {canEditSharedField("profileImage") && <input id="profileImage" type="file" accept="image/*" className={inputClasses} onChange={(event) => selectFile(event, "profileImage")} />}
              {canEditSharedField("profileImage") && (personal.profileImage || pendingProfileImagePreview) && <button type="button" className="mt-2 text-sm font-semibold text-rose-600" onClick={() => { setPendingProfileImage(null); setPendingProfileImagePreview(""); setRemoveProfileImage(true); }}>Remove personal picture</button>}
            </FormField>
            <FormField label="Full Name" id="adminFullName" error={errors.fullName}>
              <input id="adminFullName" className={`${inputClasses} bg-slate-100`} value={user?.fullName ?? ""} readOnly aria-readonly="true" />
            </FormField>
            <FormField label="Email" id="adminEmail" error={errors.email}>
              <input id="adminEmail" type="email" className={`${inputClasses} bg-slate-100`} value={user?.email ?? ""} readOnly aria-readonly="true" />
            </FormField>
            <FormField label="Phone Number" id="adminPhone" error={errors.phone}>
              {canEditSharedField("phone")
                ? <input id="adminPhone" className={inputClasses} value={personal.phone} onChange={(event) => updatePersonalField("phone", event.target.value)} />
                : <input id="adminPhone" className={`${inputClasses} bg-slate-100`} value={personal.phone} readOnly aria-readonly="true" />}
            </FormField>
            <FormField label="City" id="adminCity" error={errors.city}>
              {canEditSharedField("city")
                ? <input id="adminCity" className={inputClasses} value={personal.city} onChange={(event) => updatePersonalField("city", event.target.value)} />
                : <input id="adminCity" className={`${inputClasses} bg-slate-100`} value={personal.city} readOnly aria-readonly="true" />}
            </FormField>
            <FormField label="Country" id="adminCountry" error={errors.country}>
              {canEditSharedField("country")
                ? <input id="adminCountry" className={inputClasses} value={personal.country} onChange={(event) => updatePersonalField("country", event.target.value)} />
                : <input id="adminCountry" className={`${inputClasses} bg-slate-100`} value={personal.country} readOnly aria-readonly="true" />}
            </FormField>
          </div>
        </section>}

        <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p
            className={`text-sm font-medium ${
              isComplete ? "text-emerald-700" : "text-slate-500"
            }`}
          >
            {isComplete
              ? "Your organization profile is complete."
              : isOrganizationSettings
                ? "Update your organization information and save your changes."
                : "Complete all required organization and personal information to continue."}
          </p>
          <Button type="submit" disabled={saving}>
            {saving
              ? "Saving..."
              : isComplete
                ? "Continue to Organization Dashboard"
                : "Save profile"}
          </Button>
        </div>
      </form>
    </Container>
  );
};

export default OrganizationProfileSetup;
