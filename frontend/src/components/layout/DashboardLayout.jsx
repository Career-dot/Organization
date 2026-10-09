import { useEffect, useRef, useState } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import Container from "../ui/Container";
import { useAuth } from "../../hooks/useAuth";
import {
  fetchEmployeeFileUrl,
  getCurrentUser,
  getEmployeeNotifications,
  markEmployeeNotificationRead,
} from "../../services/authService";
import { LockIcon, LogoutIcon, UsersIcon } from "../ui/icons";
import { resolveOnboardingPath } from "../../utils/onboarding";
import { extractApiErrorMessage } from "../../utils/apiError";
import { CandidateActivationDialog } from "../ui/BecomeCandidateAction";

const ROLE_LABELS = {
  EMPLOYEE: "Candidate",
  RECRUITER: "Recruiter",
  ORG_ADMIN: "Organization Admin",
  SUPER_ADMIN: "Platform Admin",
};

const profileImageUrl = (value) => {
  if (!value) return "";
  if (/^https?:\/\//i.test(value) || value.startsWith("blob:")) return value;
  return value.startsWith("/") ? new URL(value, import.meta.env.VITE_API_URL).toString() : value;
};

const persistedFileId = (value) => value?.match(/\/files\/([^/]+)\/(?:view|download)(?:\?.*)?$/)?.[1] ?? "";

const DashboardLayout = () => {
  const { user, logout, switchRole, updateUser } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [loadedAvatar, setLoadedAvatar] = useState({ source: "", url: "" });
  const [menuOpen, setMenuOpen] = useState(false);
  const [switchOpen, setSwitchOpen] = useState(false);
  const [switchingRole, setSwitchingRole] = useState(false);
  const [switchAccountModalOpen, setSwitchAccountModalOpen] = useState(false);
  const [selectedAccountRole, setSelectedAccountRole] = useState("");
  const [selectionRequired, setSelectionRequired] = useState(false);
  // Surface switch failures in the existing Switch Account UI — a rejected
  // switch (e.g. 403 "Selected role is not valid for this account" when the
  // requested role is not currently usable) must never be a silent no-op.
  const [switchError, setSwitchError] = useState(null);
  const [candidateActivationOpen, setCandidateActivationOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [notifOpen, setNotifOpen] = useState(false);
  const menuRef = useRef(null);
  const notifRef = useRef(null);

  useEffect(() => {
    if (user?.role === "EMPLOYEE" || user?.activeRole === "EMPLOYEE") {
      getEmployeeNotifications()
        .then((res) => setNotifications(res?.data?.notifications || []))
        .catch(() => {});
    }
  }, [user?.role, user?.activeRole, location.pathname]);

  useEffect(() => {
    let active = true;
    let fetchedUrl = "";
    const savedImage = user?.profileImage;
    const fileId = persistedFileId(savedImage);

    if (!fileId) return undefined;

    fetchEmployeeFileUrl(fileId, "view")
      .then((url) => {
        fetchedUrl = url;
        if (active) setLoadedAvatar({ source: savedImage, url });
        else URL.revokeObjectURL(url);
      })
      .catch(() => {});

    return () => {
      active = false;
      if (fetchedUrl) URL.revokeObjectURL(fetchedUrl);
    };
  }, [user?.profileImage]);

  const savedImage = user?.profileImage;
  const fileId = persistedFileId(savedImage);
  const avatarSrc = fileId
    ? loadedAvatar.source === savedImage ? loadedAvatar.url : ""
    : profileImageUrl(savedImage);

  useEffect(() => {
    if (!menuOpen) return undefined;

    const handlePointerDown = (event) => {
      if (!menuRef.current?.contains(event.target)) {
        setMenuOpen(false);
        setSwitchOpen(false);
      }
    };
    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        setSwitchOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  const activeAccountRole = user?.activeRole || user?.role;
  const availableAccountRoles = Array.isArray(user?.accounts) && user.accounts.length > 0
    ? user.accounts.map(({ role }) => role)
    : activeAccountRole
      ? [activeAccountRole]
      : [];
  const availableRoles = [...new Set(availableAccountRoles.filter((role) => role !== "SUPER_ADMIN"))];
  const candidateActivated = user?.roles?.includes("EMPLOYEE");
  const isOrganizationRecruiter = user?.accounts?.some(
    ({ role, scope }) => role === "RECRUITER" && scope === "organization"
  );

  // Accounts this user could still ACTIVATE, as opposed to the ones already
  // present in `availableAccountRoles` above. Supplied by the backend
  // (getActivationRoles -> getAllowedActivationRoles in role-policy.js) so the
  // frontend never re-implements the role policy. Kept conceptually separate
  // from `candidateActivated`: that answers "does the Candidate account already
  // exist?", this answers "could the Candidate account still be activated?".
  const activationRoles = Array.isArray(user?.activationRoles)
    ? user.activationRoles
    : [];

  const hasRecruiterAccount = availableAccountRoles.includes("RECRUITER");
  const hasOrgAdminAccount = availableAccountRoles.includes("ORG_ADMIN");

  // A candidate may hold AT MOST ONE of RECRUITER / ORG_ADMIN — the backend
  // role-policy rejects the EMPLOYEE+RECRUITER+ORG_ADMIN combination and the
  // purchase guards (resolveOwnerContext) 403 the second activation. A fresh
  // candidate (no secondary role yet) uses Switch Account purely to PICK the
  // next account type, so only the activation choices are listed; once one is
  // held, the list shows the existing switchable accounts (Candidate plus the
  // held role) and the other role can never appear.
  //
  // The branches below are deliberately unchanged in what they already covered;
  // the last one only gained the Candidate ACTIVATION entry, so a professional
  // account that does not own the Candidate account yet can still reach it
  // (previously EMPLOYEE was unreachable there by construction, which is the
  // regression this restores).
  const switchAccountRoles = isOrganizationRecruiter && !candidateActivated
    ? ["RECRUITER", "EMPLOYEE"]
    : availableAccountRoles.includes("EMPLOYEE")
    ? [
        ...(hasRecruiterAccount || hasOrgAdminAccount ? ["EMPLOYEE"] : []),
        ...(hasRecruiterAccount ? ["RECRUITER"] : []),
        ...(hasOrgAdminAccount ? ["ORG_ADMIN"] : []),
        ...(!hasRecruiterAccount && !hasOrgAdminAccount ? ["RECRUITER", "ORG_ADMIN"] : []),
      ]
    : [
        ...availableRoles.filter((role) => role === "RECRUITER" || role === "ORG_ADMIN"),
        // Only the Candidate activation belongs here: RECRUITER / ORG_ADMIN
        // activations keep using their existing purchase/subscription paths,
        // and the backend policy already excludes them for an account that
        // holds the other one (RECRUITER + ORG_ADMIN is forbidden).
        ...activationRoles.filter((role) => role === "EMPLOYEE"),
      ];

  const handleRoleChange = async (event) => {
    const requestedRole = event?.target?.value ?? event;
    setSwitchingRole(true);
    setSwitchError(null);
    try {
      const nextUser = await switchRole(requestedRole);
      const currentUserResponse = await getCurrentUser();
      const currentUser = {
        ...currentUserResponse.data,
        role: nextUser.role,
        activeRole: nextUser.role,
      };
      updateUser(currentUser);
      setMenuOpen(false);
      setSwitchOpen(false);
      setSwitchAccountModalOpen(false);
      navigate(resolveOnboardingPath(currentUser), { replace: true });
    } catch (roleChangeError) {
      // The backend rejected this switch (e.g. the requested role is not
      // currently usable — 403 "Selected role is not valid for this
      // account"). Keep the modal open and show why, instead of returning
      // silently.
      setSwitchError(
        extractApiErrorMessage(
          roleChangeError,
          "Unable to switch to this account right now. Please try again."
        )
      );
      return;
    } finally {
      setSwitchingRole(false);
    }
  };

  const handleSwitchAccountContinue = async () => {
    if (!selectedAccountRole) {
      setSelectionRequired(true);
      return;
    }

    const targetRole = selectedAccountRole;
    const isActivatedRole = availableRoles.includes(targetRole);

    if (targetRole === "EMPLOYEE" && !candidateActivated) {
      setSwitchAccountModalOpen(false);
      setCandidateActivationOpen(true);
      return;
    }

    if (isActivatedRole) {
      await handleRoleChange(targetRole);
      return;
    }

    if (targetRole === "ORG_ADMIN") {
      const organizationName = window.prompt("Organization name")?.trim();
      if (!organizationName) return;
      navigate("/organization/subscription", {
        state: { targetRole, organizationName },
      });
      setSwitchAccountModalOpen(false);
      return;
    }

    navigate("/recruiter/subscription", {
      state: { targetRole },
    });
    setSwitchAccountModalOpen(false);
  };

  const handleLogout = async () => {
    await logout();
    navigate("/", { replace: true });
  };

  const isEmployeeDashboard = location.pathname === "/employee/dashboard";
  const settingsPath = "/account/settings";

  const openAccountMenu = () => {
    setMenuOpen((current) => !current);
    setSwitchOpen(false);
  };

  const openSwitchAccount = () => {
    setSelectedAccountRole("");
    setSelectionRequired(false);
    setSwitchError(null);
    setSwitchOpen(true);
    setSwitchAccountModalOpen(true);
  };

  const closeSwitchAccount = () => {
    setSwitchOpen(false);
    setSwitchAccountModalOpen(false);
    setSwitchError(null);
  };

  const openSettings = () => {
    setMenuOpen(false);
    setSwitchOpen(false);
    navigate(settingsPath);
  };

  return (
    <>
      <CandidateActivationDialog
        open={candidateActivationOpen}
        onClose={() => setCandidateActivationOpen(false)}
      />
      {switchAccountModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 px-4" onClick={closeSwitchAccount}>
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
            <h2 className="font-display text-2xl font-bold text-slate-900">Switch Account</h2>
            <p className="mt-2 text-sm text-slate-500">Choose one account to continue.</p>

            <div className="mt-6 space-y-3">
              {switchAccountRoles.map((role) => {
                  const option = {
                    role,
                    title:
                      role === "EMPLOYEE"
                        ? "Candidate"
                        : isOrganizationRecruiter && role === "RECRUITER"
                        ? "Organization Recruiter"
                        : role === "ORG_ADMIN"
                        ? "Org Admin"
                        : ROLE_LABELS[role] ?? role,
                    description:
                      role === "RECRUITER"
                        ? isOrganizationRecruiter ? "Organization recruitment workspace" : "Recruitment workspace"
                        : role === "ORG_ADMIN"
                        ? "Organization workspace"
                        : "Candidate workspace",
                  };
                  const isSelected = selectedAccountRole === option.role;

                  return (
                    <label
                      key={option.role}
                      className={`flex cursor-pointer items-start gap-3 rounded-2xl border p-4 transition ${isSelected ? "border-indigo-500 bg-indigo-50 ring-1 ring-indigo-500" : "border-slate-200 bg-white hover:border-slate-300"}`}
                    >
                      <input
                        type="radio"
                        name="switch-account-selection"
                        value={option.role}
                        checked={isSelected}
                        onChange={() => {
                          setSelectedAccountRole(option.role);
                          setSelectionRequired(false);
                          setSwitchError(null);
                        }}
                        className="mt-1 h-4 w-4 border-slate-300 text-indigo-600 focus:ring-indigo-500"
                      />
                      <span className="flex-1">
                        <span className="block text-base font-semibold text-slate-900">{option.title}</span>
                        <span className="mt-1 block text-sm text-slate-500">{option.description}</span>
                      </span>
                    </label>
                  );
                })}
            </div>

            {selectionRequired && (
              <p className="mt-3 text-sm text-rose-600" role="alert">
                Choose an account to continue.
              </p>
            )}

            {switchError && (
              <p className="mt-3 text-sm text-rose-600" role="alert">
                {switchError}
              </p>
            )}

            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={closeSwitchAccount}
                className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSwitchAccountContinue}
                disabled={switchingRole}
                className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-indigo-300"
              >
                {switchingRole ? "Processing..." : "Continue"}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex min-h-screen flex-col bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <Container className="flex h-16 items-center justify-between">
          <Link to="/" className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-cyan-400 text-sm font-bold text-white">
              VS
            </span>
            <span className="font-display text-base font-semibold text-slate-900">
              Verified Skills Passport
            </span>
          </Link>

          <div className="flex items-center gap-3">
            {user && (user.role === "EMPLOYEE" || user.activeRole === "EMPLOYEE") && (
              <div ref={notifRef} className="relative">
                <button
                  type="button"
                  onClick={() => {
                    setNotifOpen((prev) => !prev);
                    setMenuOpen(false);
                  }}
                  className="relative flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-50 focus:outline-none"
                  aria-label="Notifications"
                >
                  <span className="text-base">🔔</span>
                  {notifications.filter((n) => !n.isRead).length > 0 && (
                    <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-rose-500 text-[10px] font-bold text-white">
                      {notifications.filter((n) => !n.isRead).length > 9
                        ? "9+"
                        : notifications.filter((n) => !n.isRead).length}
                    </span>
                  )}
                </button>

                {notifOpen && (
                  <div className="absolute right-0 top-full z-40 mt-2 w-80 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl">
                    <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/80 px-4 py-3">
                      <span className="font-display text-sm font-bold text-slate-900">Notifications</span>
                      {notifications.filter((n) => !n.isRead).length > 0 && (
                        <span className="text-xs font-semibold text-indigo-600">
                          {notifications.filter((n) => !n.isRead).length} unread
                        </span>
                      )}
                    </div>

                    <div className="max-h-80 overflow-y-auto divide-y divide-slate-100">
                      {notifications.length === 0 ? (
                        <div className="p-4 text-center text-xs text-slate-500">No notifications yet</div>
                      ) : (
                        notifications.map((item) => (
                          <div
                            key={item.id}
                            onClick={async () => {
                              if (!item.isRead) {
                                try {
                                  await markEmployeeNotificationRead(item.id);
                                  setNotifications((prev) =>
                                    prev.map((n) => (n.id === item.id ? { ...n, isRead: true } : n))
                                  );
                                } catch (err) {
                                  console.warn("Unable to mark notification read", err);
                                }
                              }
                              setNotifOpen(false);
                              // Verification completion notifications are static/informational
                              if (item.type === "VERIFICATION_RESULT" || item.link?.includes("/verify/")) {
                                return;
                              }
                              if (item.link) {
                                navigate(item.link);
                              } else {
                                navigate("/employee/skills");
                              }
                            }}
                            className={`cursor-pointer p-3.5 text-left transition hover:bg-slate-50 ${
                              !item.isRead ? "bg-indigo-50/40 font-medium" : ""
                            }`}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <p className="text-xs font-bold text-slate-900">{item.title}</p>
                              {!item.isRead && (
                                <span className="h-2 w-2 flex-none rounded-full bg-indigo-600" />
                              )}
                            </div>
                            <p className="mt-1 text-xs text-slate-600 leading-relaxed">{item.message}</p>
                            <p className="mt-1.5 text-[10px] text-slate-400">
                              {new Date(item.createdAt).toLocaleTimeString([], {
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </p>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {user && (
              <div ref={menuRef} className="relative">
                <button
                  type="button"
                  onClick={openAccountMenu}
                  aria-expanded={menuOpen}
                  aria-haspopup="menu"
                  className="flex items-center gap-2 rounded-xl p-1.5 text-left transition hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
                >
                  <div className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-full border border-slate-200 bg-slate-100 text-xs font-bold text-slate-700">
                    {avatarSrc ? (
                      <img src={avatarSrc} alt={user.fullName || user.email} className="h-full w-full object-cover" />
                    ) : (
                      (user.fullName || user.email || "A").charAt(0).toUpperCase()
                    )}
                  </div>
                  <span className="hidden max-w-40 truncate text-sm text-slate-600 sm:inline">
                    {user.fullName ?? user.email}
                  </span>
                  <span aria-hidden="true" className={`text-xs text-slate-400 transition-transform ${menuOpen ? "rotate-180" : ""}`}>▾</span>
                </button>

                {menuOpen && (
                  <div className="absolute right-0 top-full z-30 mt-2 w-72 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl" role="menu">
                    <div className="border-b border-slate-100 bg-slate-50/80 px-4 py-4">
                      <div className="flex items-center gap-3">
                        <div className="flex h-11 w-11 flex-none items-center justify-center overflow-hidden rounded-full border border-slate-200 bg-white text-sm font-bold text-slate-700">
                          {avatarSrc ? <img src={avatarSrc} alt="" className="h-full w-full object-cover" /> : (user.fullName || user.email || "A").charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-slate-900">{user.fullName || user.email}</p>
                          <p className="truncate text-xs text-slate-500">{user.email}</p>
                          <p className="mt-1 text-xs font-medium text-indigo-600">{ROLE_LABELS[user.role] ?? user.role}</p>
                        </div>
                      </div>
                    </div>

                    <div className="p-2">
                      <button type="button" role="menuitem" onClick={openSettings} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
                        <LockIcon className="h-4 w-4 text-slate-500" />
                        Account Settings
                      </button>
                      <button type="button" role="menuitem" aria-expanded={switchOpen} onClick={openSwitchAccount} className="flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
                        <span className="flex items-center gap-3"><UsersIcon className="h-4 w-4 text-slate-500" />Switch Account</span>
                        <span aria-hidden="true" className={`text-xs text-slate-400 transition-transform ${switchOpen ? "rotate-180" : ""}`}>▾</span>
                      </button>

                      <div className="my-2 border-t border-slate-100" />
                      <button type="button" role="menuitem" onClick={handleLogout} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
                        <LogoutIcon className="h-4 w-4 text-slate-500" />
                        Logout
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
            {!isEmployeeDashboard && <button
              type="button"
              onClick={handleLogout}
              className="text-sm font-medium text-slate-600 hover:text-slate-900"
            >
              Logout
            </button>}
          </div>
        </Container>
      </header>

      <main className="flex-1">
        <Outlet />
      </main>
    </div>
    </>
  );
};

export default DashboardLayout;
