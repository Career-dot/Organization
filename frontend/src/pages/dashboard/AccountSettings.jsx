import { useEffect, useRef, useState } from "react";
import Container from "../../components/ui/Container";
import Button from "../../components/ui/Button";
import FormField, { inputClasses } from "../../components/ui/FormField";
import SettingsPanel from "../../components/ui/SettingsPanel";
import { useAuth } from "../../hooks/useAuth";
import {
  deleteEmployeeFile,
  fetchEmployeeFileUrl,
  getRecruiterProfile,
  saveRecruiterProfile,
  updateAccountDetails as updateAccountDetailsService,
  uploadEmployeeFile,
} from "../../services/authService";

const getInitialFromUser = (fullName, email) =>
  (fullName || email || "A").charAt(0).toUpperCase();

const persistedFileId = (value) => value?.match(/\/files\/([^/]+)\/(?:view|download)(?:\?.*)?$/)?.[1] ?? "";

const AccountSettings = () => {
  const { user, updateAccountDetails: updateAccountDetailsFromContext } = useAuth();
  const updateAccountDetails = updateAccountDetailsFromContext ?? updateAccountDetailsService;
  const isOrganizationRecruiter = user?.accounts?.some(
    ({ role, scope }) => role === "RECRUITER" && scope === "organization"
  );
  const canEditRecruiterProfile = user?.role === "RECRUITER" && !isOrganizationRecruiter;
  const fileInputRef = useRef(null);
  const [form, setForm] = useState({
    fullName: user?.fullName ?? "",
    profileImage: user?.profileImage ?? "",
    phone: user?.phone ?? "",
    city: user?.city ?? "",
    country: user?.country ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const [pendingImageUrl, setPendingImageUrl] = useState("");
  const [pendingProfileFile, setPendingProfileFile] = useState(null);
  const [pendingDeleteImage, setPendingDeleteImage] = useState(false);
  const [loadedAvatar, setLoadedAvatar] = useState({ source: "", url: "" });
  const [notice, setNotice] = useState(null);
  const [recruiterProfile, setRecruiterProfile] = useState({
    companyName: "",
    businessEmail: "",
    businessPhone: "",
    companyWebsite: "",
  });

  useEffect(() => {
    let active = true;
    let fetchedUrl = "";
    const savedImage = form.profileImage || user?.profileImage || "";
    const fileId = persistedFileId(savedImage);

    if (!fileId) {
      return undefined;
    }

    fetchEmployeeFileUrl(fileId, "view")
      .then((url) => {
        fetchedUrl = url;
        if (active) setLoadedAvatar({ source: savedImage, url });
      })
      .catch(() => {
        if (active) setLoadedAvatar({ source: "", url: "" });
      });

    return () => {
      active = false;
      if (fetchedUrl) URL.revokeObjectURL(fetchedUrl);
    };
  }, [form.profileImage, user?.profileImage]);

  useEffect(() => {
    if (!canEditRecruiterProfile) return undefined;

    let active = true;
    getRecruiterProfile()
      .then((response) => {
        if (!active) return;
        const profile = response.data?.profile ?? {};
        setRecruiterProfile({
          companyName: profile.companyName ?? "",
          businessEmail: profile.businessEmail ?? "",
          businessPhone: profile.businessPhone ?? "",
          companyWebsite: profile.companyWebsite ?? "",
        });
      })
      .catch((error) => {
        if (active) setNotice({ type: "error", text: error?.response?.data?.message ?? "Unable to load recruiter company information." });
      });

    return () => {
      active = false;
    };
  }, [canEditRecruiterProfile]);

  useEffect(() => {
    return () => {
      if (pendingImageUrl) URL.revokeObjectURL(pendingImageUrl);
    };
  }, [pendingImageUrl]);

  const savedAvatarValue = form.profileImage || user?.profileImage || "";
  const fileId = persistedFileId(savedAvatarValue);
  const avatarSource = pendingImageUrl || (pendingDeleteImage ? "" : fileId && loadedAvatar.source === savedAvatarValue ? loadedAvatar.url : "") || (!fileId && savedAvatarValue ? savedAvatarValue : "");
  const avatarInitial = getInitialFromUser(form.fullName, user?.email);

  const handleChange = (field, value) => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  const handleRecruiterChange = (field, value) => {
    setRecruiterProfile((current) => ({ ...current, [field]: value }));
  };

  const saveRecruiterProfileDetails = async () => {
    const recruiterResponse = await saveRecruiterProfile(recruiterProfile);
    const savedProfile = recruiterResponse.data?.profile ?? recruiterProfile;
    setRecruiterProfile({
      companyName: savedProfile.companyName ?? "",
      businessEmail: savedProfile.businessEmail ?? "",
      businessPhone: savedProfile.businessPhone ?? "",
      companyWebsite: savedProfile.companyWebsite ?? "",
    });
  };

  const handleProfileImageChange = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setPendingDeleteImage(false);
    setPendingProfileFile(file);
    setPendingImageUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      const preview = URL.createObjectURL(file);
      return preview;
    });
    setNotice(null);
    event.target.value = "";
  };

  const handleDeleteProfileImage = () => {
    if (!form.profileImage && !user?.profileImage && !pendingImageUrl) return;

    setPendingDeleteImage(true);
    setPendingProfileFile(null);
    setPendingImageUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return "";
    });
    setNotice(null);
  };

  const handleSubmit = async (event) => {
    console.log("[AccountSettings] handleSubmit RUNNING", { pendingProfileFile, pendingDeleteImage });
    event.preventDefault();
    setSaving(true);
    setNotice(null);

    try {
      let finalUser = null;
      let nextProfileImage = user?.profileImage ?? form.profileImage ?? "";

      if (pendingProfileFile) {
        console.log("[AccountSettings] ABOUT TO UPLOAD", pendingProfileFile);
        const uploadedFile = await uploadEmployeeFile({ category: "PROFILE_IMAGE", file: pendingProfileFile });
        // uploadEmployeeFile returns the full response body ({ success, data }),
        // so read the StoredFile payload from `.data` (same convention as
        // Recruiter/OrganizationProfileSetup) and reuse the exact versioned
        // profileImage URL returned by the backend.
        const uploadData = uploadedFile?.data ?? uploadedFile;
        const uploadedFileId = uploadData?.id ?? null;
        nextProfileImage =
          uploadData?.profileImage ??
          uploadData?.url ??
          (uploadedFileId ? `/api/files/${uploadedFileId}/view` : nextProfileImage);
      }

      if (pendingDeleteImage) {
        const storedImageId = persistedFileId(user?.profileImage || form.profileImage || "");
        if (storedImageId) {
          await deleteEmployeeFile(storedImageId);
        }
        nextProfileImage = "";
      }

      const payload = {
        fullName: form.fullName,
        phone: form.phone,
        city: form.city,
        country: form.country,
      };

      if (pendingProfileFile) {
        payload.profileImage = nextProfileImage;
      }

      if (pendingDeleteImage && !pendingProfileFile) {
        payload.profileImage = "";
      }

      console.log("[AccountSettings] ABOUT TO UPDATE ACCOUNT", payload);
      finalUser = await updateAccountDetails(payload);

      if (canEditRecruiterProfile) {
        await saveRecruiterProfileDetails();
      }

      if (pendingProfileFile || pendingDeleteImage) {
        setForm((current) => ({
          ...current,
          profileImage: finalUser?.profileImage ?? nextProfileImage ?? current.profileImage,
        }));
      }

      setPendingProfileFile(null);
      setPendingDeleteImage(false);
      setPendingImageUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return "";
      });

      console.log("[AccountSettings] PERSISTENCE SUCCESS");
      setNotice({ type: "success", text: "Account information saved successfully." });
    } catch (error) {
      const message = error?.response?.data?.message ?? "Unable to save your account information.";
      setNotice({ type: "error", text: message });
    } finally {
      setSaving(false);
      setImageBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <Container className="max-w-5xl py-10">
        <div className="mb-8">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">
            Account
          </p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight text-slate-950">
            Account Settings
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-slate-600">
            Manage your shared account profile, contact details, and security settings.
          </p>
        </div>

        <div className="space-y-6">
          <form onSubmit={handleSubmit} className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-4">
                <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-full border border-slate-200 bg-slate-100 text-lg font-bold text-slate-700">
                  {avatarSource ? (
                    <img src={avatarSource} alt={form.fullName || user?.email || "Profile"} className="h-full w-full object-cover" />
                  ) : (
                    avatarInitial
                  )}
                </div>
                <div>
                  <p className="text-lg font-semibold text-slate-900">Basic Information</p>
                  <p className="text-sm text-slate-600">This is your shared User identity used across all roles.</p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
                  className="hidden"
                  onChange={handleProfileImageChange}
                />
                <button
                  type="button"
                  className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={imageBusy}
                >
                  {imageBusy ? "Saving..." : "Change Image"}
                </button>
                <button
                  type="button"
                  className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-700 transition hover:bg-rose-100"
                  onClick={handleDeleteProfileImage}
                  disabled={imageBusy || (!user?.profileImage && !form.profileImage && !pendingImageUrl && !pendingProfileFile)}
                >
                  Delete Image
                </button>
              </div>
            </div>

            {notice && (
              <div className={`mb-5 rounded-xl border px-3 py-2 text-sm ${notice.type === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-rose-200 bg-rose-50 text-rose-700"}`}>
                {notice.text}
              </div>
            )}

            <div className="grid gap-5 md:grid-cols-2">
              <FormField label="Full name" id="fullName">
                <input
                  id="fullName"
                  className={inputClasses}
                  value={form.fullName}
                  onChange={(event) => handleChange("fullName", event.target.value)}
                />
              </FormField>

              <FormField label="Email" id="email">
                <input
                  id="email"
                  type="email"
                  className={`${inputClasses} bg-slate-50`}
                  value={user?.email ?? ""}
                  readOnly
                  aria-readonly="true"
                />
              </FormField>

              <FormField label="Phone" id="phone">
                <input
                  id="phone"
                  className={inputClasses}
                  value={form.phone}
                  onChange={(event) => handleChange("phone", event.target.value)}
                />
              </FormField>

              <FormField label="City" id="city">
                <input
                  id="city"
                  className={inputClasses}
                  value={form.city}
                  onChange={(event) => handleChange("city", event.target.value)}
                />
              </FormField>

              <div className="md:col-span-2">
                <FormField label="Country" id="country">
                  <input
                    id="country"
                    className={inputClasses}
                    value={form.country}
                    onChange={(event) => handleChange("country", event.target.value)}
                  />
                </FormField>
              </div>
            </div>

            <div className="mt-6 flex justify-end">
              <Button type="submit" disabled={saving}>
                {saving ? "Saving..." : "Save changes"}
              </Button>
            </div>
          </form>

          {canEditRecruiterProfile && (
            <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <div className="mb-6">
                <p className="text-lg font-semibold text-slate-900">Company Information</p>
                <p className="mt-1 text-sm text-slate-600">Manage the company and agency information on your RecruiterProfile.</p>
              </div>
              <div className="grid gap-5 md:grid-cols-2">
                <FormField label="Company name" id="companyName">
                  <input id="companyName" className={inputClasses} value={recruiterProfile.companyName} onChange={(event) => handleRecruiterChange("companyName", event.target.value)} />
                </FormField>
                <FormField label="Business email" id="businessEmail">
                  <input id="businessEmail" type="email" className={inputClasses} value={recruiterProfile.businessEmail} onChange={(event) => handleRecruiterChange("businessEmail", event.target.value)} />
                </FormField>
                <FormField label="Business phone" id="businessPhone">
                  <input id="businessPhone" className={inputClasses} value={recruiterProfile.businessPhone} onChange={(event) => handleRecruiterChange("businessPhone", event.target.value)} />
                </FormField>
                <FormField label="Company website" id="companyWebsite">
                  <input id="companyWebsite" type="url" className={inputClasses} value={recruiterProfile.companyWebsite} onChange={(event) => handleRecruiterChange("companyWebsite", event.target.value)} />
                </FormField>
              </div>
              <p className="mt-5 text-xs text-slate-500">Save changes in the Basic Information section to update your profile and company information together.</p>
              <div className="mt-6 flex justify-end">
                <Button type="button" disabled={saving} onClick={async () => {
                  setSaving(true);
                  setNotice(null);
                  try {
                    await saveRecruiterProfileDetails();
                    setNotice({ type: "success", text: "Company information saved successfully." });
                  } catch (error) {
                    setNotice({ type: "error", text: error?.response?.data?.message ?? "Unable to save company information." });
                  } finally {
                    setSaving(false);
                  }
                }}>
                  {saving ? "Saving..." : "Save Changes"}
                </Button>
              </div>
            </section>
          )}

          <SettingsPanel />
        </div>
      </Container>
    </div>
  );
};

export default AccountSettings;
