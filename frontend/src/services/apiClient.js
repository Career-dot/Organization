import axios from "axios";
import {
  clearAuthSession,
  getAuthSession,
  setAccessToken,
  setActiveContext,
  setStoredUser,
} from "./authSession";

const API_URL = import.meta.env.VITE_API_URL;

if (!API_URL) {
  throw new Error("VITE_API_URL is not configured");
}

// Exported for the few callers that must build a URL outside axios (the
// realtime SSE stream in services/realtimeService.js) so the base URL keeps
// exactly one definition.
export { API_URL };

const apiClient = axios.create({
  baseURL: API_URL,
  withCredentials: true,
});

const SESSION_BOUND_AUTH_PATHS = ["/auth/refresh", "/auth/logout"];
const REFRESH_EXCLUDED_PATHS = ["/auth/login", "/auth/refresh", "/auth/logout"];

const isSessionBoundAuthRequest = (url) =>
  SESSION_BOUND_AUTH_PATHS.some((path) => url?.includes(path));

let authStateSync = null;

export const registerAuthStateSync = (callback) => {
  authStateSync = callback;
  return () => {
    if (authStateSync === callback) authStateSync = null;
  };
};

apiClient.interceptors.request.use((config) => {
  const { accessToken, sessionSelector } = getAuthSession();
  config.headers = config.headers ?? {};

  if (accessToken) {
    config.headers.Authorization = `Bearer ${accessToken}`;
  }

  if (sessionSelector && isSessionBoundAuthRequest(config.url)) {
    config.headers["X-Auth-Session"] = sessionSelector;
  }

  return config;
});

// Each tab has a distinct JavaScript environment, making this guard tab-local.
let refreshPromise = null;

const refreshAccessToken = () => {
  if (!refreshPromise) {
    const { sessionSelector, activeRole, user } = getAuthSession();
    const refreshRoleHint = user?.role || activeRole || null;

    if (!sessionSelector) {
      return Promise.reject(new Error("Authentication session is missing"));
    }

    refreshPromise = axios
      .post(`${API_URL}/auth/refresh`, null, {
        withCredentials: true,
        headers: {
          "X-Auth-Session": sessionSelector,
          ...(refreshRoleHint && { "X-Active-Role": refreshRoleHint }),
        },
      })
      .then((response) => {
        const accessToken = response.data?.data?.accessToken;
        const refreshedUser = response.data?.data?.user;
        console.debug("[auth-trace] Axios refresh response", {
          user: refreshedUser,
          roles: refreshedUser?.roles,
          role: refreshedUser?.role,
          activeRole: refreshedUser?.activeRole,
        });

        if (!accessToken) {
          throw new Error("Refresh response did not include an access token");
        }

        setAccessToken(accessToken);
        if (refreshedUser) {
          // The backend refresh now resolves the role against USABLE accounts
          // before shipping it. Reconciliation, backend state first: keep the
          // backend-resolved role, demoting to the first usable account only
          // if a stale session hint is no longer one (defensive — the backend
          // already resolves the same way). An EMPTY usable set is a
          // legitimate PAYMENT onboarding state — the role is kept so the
          // payment page resolves; there is no usable account to demote to.
          const accounts = Array.isArray(refreshedUser.accounts)
            ? refreshedUser.accounts
            : [];
          const usableRoles = accounts
            .map(({ role: accountRole }) => accountRole)
            .filter(Boolean);
          const backendRole =
            refreshedUser.role || refreshRoleHint || user?.role || activeRole;
          const nextRole =
            accounts.length > 0 && !usableRoles.includes(backendRole)
              ? usableRoles[0] ?? backendRole
              : backendRole;
          const nextAccount =
            accounts.find(({ role }) => role === nextRole) ?? null;

          setStoredUser({ ...refreshedUser, role: nextRole, activeRole: nextRole });
          setActiveContext({ role: nextRole, account: nextAccount });
          authStateSync?.({ ...refreshedUser, role: nextRole, activeRole: nextRole });
          const refreshedSession = getAuthSession();
          console.debug("[auth-trace] sessionStorage after Axios refresh", {
            user: refreshedSession.user,
            roles: refreshedSession.user?.roles,
            activeRole: refreshedSession.activeRole,
            activeAccount: refreshedSession.activeAccount,
          });
        }
        return accessToken;
      })
      .finally(() => {
        refreshPromise = null;
      });
  }

  return refreshPromise;
};

const handleSessionExpired = () => {
  clearAuthSession();

  if (typeof window !== "undefined" && window.location.pathname !== "/login") {
    window.location.assign("/login");
  }
};

// ---------------------------------------------------------------------------
// Server-side must-change-password enforcement (see middleware/authenticate.js).
//
// The backend answers 403 + code "PASSWORD_CHANGE_REQUIRED" for any protected
// endpoint while User.mustChangePassword is true. That is a *different* state
// from an expired session, and it must be handled differently:
//
//   * Do NOT call clearAuthSession() and do NOT redirect to /login. The user is
//     still fully authenticated and still holds a valid access token + refresh
//     cookie — they NEED that live session to call POST /api/auth/change-password,
//     which is one of the four endpoints the gate deliberately allows. Logging
//     them out would strand them: they would have to log in again with the very
//     temporary password we are trying to retire.
//
//   * Do NOT route through the 401 refresh path below. The token is perfectly
//     valid; refreshing it would mint a new token that is still equally blocked,
//     which both wastes a rotation and hides the real reason from the user.
//
// Instead we send them to the existing /change-password route, which re-renders
// the current session. Because the gate allows /api/auth/me and
// /api/auth/change-password, that page keeps working, and after a successful
// change it re-fetches /me and lets the normal onboarding routing take over
// (see pages/auth/ChangePassword.jsx).
//
// Loop protection: `passwordChangeRedirectPending` is module-scoped, so a burst
// of parallel in-flight requests (React StrictMode double-effects, several
// components mounting at once) triggers at most ONE navigation. The flag is
// cleared on page load, and the pathname check means a user already sitting on
// /change-password is never re-navigated.
// ---------------------------------------------------------------------------
const PASSWORD_CHANGE_REQUIRED_CODE = "PASSWORD_CHANGE_REQUIRED";
const CHANGE_PASSWORD_PATH = "/change-password";

let passwordChangeRedirectPending = false;

const handlePasswordChangeRequired = () => {
  if (typeof window === "undefined") return;

  if (passwordChangeRedirectPending) return;
  if (window.location.pathname === CHANGE_PASSWORD_PATH) return;

  passwordChangeRedirectPending = true;
  window.location.assign(CHANGE_PASSWORD_PATH);
};

apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const { config, response } = error;

    if (!response || !config) {
      return Promise.reject(error);
    }

    // Handled FIRST, before the 401 logic below: a blocked-by-password-change
    // response is a 403, and the session behind it is still valid.
    if (
      response.status === 403 &&
      response.data?.code === PASSWORD_CHANGE_REQUIRED_CODE
    ) {
      handlePasswordChangeRequired();
      return Promise.reject(error);
    }

    if (response.status !== 401) {
      return Promise.reject(error);
    }

    const isExcluded = REFRESH_EXCLUDED_PATHS.some((path) => config.url?.includes(path));
    const hadAuthHeader = Boolean(config.headers?.Authorization);

    if (isExcluded || !hadAuthHeader || config._retry) {
      return Promise.reject(error);
    }

    config._retry = true;

    try {
      const accessToken = await refreshAccessToken();
      config.headers.Authorization = `Bearer ${accessToken}`;
      return apiClient(config);
    } catch (refreshError) {
      handleSessionExpired();
      return Promise.reject(refreshError);
    }
  }
);

export default apiClient;
