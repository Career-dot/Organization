import { useCallback, useEffect, useState } from "react";
import { AuthContext } from "./auth-context";
import { registerAuthStateSync } from "../services/apiClient";
import {
  getCurrentUser,
  logout as requestLogout,
  switchRole as requestSwitchRole,
  updateAccount as requestUpdateAccount,
} from "../services/authService";
import {
  clearAuthSession,
  clearLegacyAuthStorage,
  getAuthSession,
  setAccessToken,
  setActiveContext,
  setAuthSession,
  setStoredUser,
} from "../services/authSession";

// Every browser tab owns its own sessionStorage. Hydration verifies that
// tab-local cache against /auth/me before routing, so a cached role is never
// treated as authoritative.
export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(() => {
    const initialSession = getAuthSession();
    console.debug("[auth-trace] AuthContext initial state", {
      user: initialSession.user,
      sessionStorageUserRoles: initialSession.user?.roles,
      sessionStorageActiveRole: initialSession.activeRole,
      sessionStorageActiveAccount: initialSession.activeAccount,
    });
    return initialSession.user;
  });
  const [isHydrating, setIsHydrating] = useState(true);

  useEffect(() => {
    let mounted = true;
    const unregisterAuthStateSync = registerAuthStateSync((refreshedUser) => {
      if (mounted) setUser(refreshedUser);
    });
    const session = getAuthSession();

    // Prevent legacy global credentials from ever re-entering the new flow.
    clearLegacyAuthStorage();

    const hydrate = async () => {
      if (!session.accessToken || !session.sessionSelector || !session.user) {
        if (mounted) {
          setUser(null);
          setIsHydrating(false);
        }
        return;
      }

      try {
        const response = await getCurrentUser();
        const authoritativeUser = response.data;
        console.debug("[auth-trace] /auth/me response", {
          user: authoritativeUser,
          roles: authoritativeUser?.roles,
          role: authoritativeUser?.role,
          activeRole: authoritativeUser?.activeRole,
        });

        // /me now resolves an authoritative role against USABLE accounts
        // (authoritativeUser.role agrees with authoritativeUser.accounts).
        // Reconciliation, backend state first:
        // 1. Prefer the tab-scoped session activeRole only while it is still
        //    a usable account (preserves the in-session context across page
        //    refresh, e.g. Candidate+Recruiter staying on Recruiter).
        // 2. Otherwise use the backend role — demoting to the first usable
        //    account if the persisted role is no longer one (defensive: the
        //    backend already resolves the same way).
        // 3. An EMPTY usable set is a legitimate PAYMENT onboarding state —
        //    the backend role is kept so the payment page resolves; there is
        //    no usable account to demote to.
        const accounts = Array.isArray(authoritativeUser.accounts)
          ? authoritativeUser.accounts
          : [];
        const usableRoles = accounts
          .map(({ role: accountRole }) => accountRole)
          .filter(Boolean);
        const backendRole = authoritativeUser.role ?? null;
        const stableCurrentRole =
          (session.activeRole && usableRoles.includes(session.activeRole)
            ? session.activeRole
            : null) ??
          (backendRole && accounts.length > 0 && !usableRoles.includes(backendRole)
            ? usableRoles[0] ?? backendRole
            : backendRole);

        const hydratedUser = {
          ...authoritativeUser,
          role: stableCurrentRole,
          activeRole: stableCurrentRole,
        };

        setStoredUser(hydratedUser);
        setActiveContext({
          role: stableCurrentRole,
          account: authoritativeUser.accounts?.find(({ role }) => role === stableCurrentRole) ?? null,
        });

        if (mounted) {
          setUser(hydratedUser);
          console.debug("[auth-trace] AuthContext after /auth/me", {
            user: hydratedUser,
            roles: hydratedUser?.roles,
            role: hydratedUser?.role,
            activeRole: hydratedUser?.activeRole,
          });
        }
      } catch {
        clearAuthSession();
        if (mounted) {
          setUser(null);
        }
      } finally {
        if (mounted) {
          setIsHydrating(false);
        }
      }
    };

    hydrate();

    return () => {
      mounted = false;
      unregisterAuthStateSync();
    };
  }, []);

  const login = useCallback((nextUser, accessToken, sessionSelector) => {
    if (!accessToken || !sessionSelector) {
      throw new Error("Login response did not include an authentication session");
    }

    const activeRole = nextUser?.role || nextUser?.activeRole || null;
    const activeAccount =
      nextUser?.accounts?.find(({ role }) => role === activeRole) ?? null;

    setAuthSession({
      accessToken,
      user: nextUser,
      sessionSelector,
      activeRole,
      activeAccount,
    });
    setUser({ ...nextUser, role: activeRole, activeRole });
  }, []);

  const updateUser = useCallback((nextUser) => {
    const activeRole = nextUser?.role || nextUser?.activeRole || null;
    const activeAccount =
      nextUser?.accounts?.find(({ role }) => role === activeRole) ?? null;

    setStoredUser({ ...nextUser, role: activeRole, activeRole });
    setActiveContext({ role: activeRole, account: activeAccount });
    setUser({ ...nextUser, role: activeRole, activeRole });
  }, []);

  const switchRole = useCallback(async (role) => {
    const response = await requestSwitchRole(role);
    const nextUser = response.data.user;
    const nextRole = nextUser?.role || role;
    const nextAccount =
      nextUser?.accounts?.find(({ role: candidateRole }) => candidateRole === nextRole) ?? null;

    setAccessToken(response.data.accessToken);
    setStoredUser({ ...nextUser, role: nextRole, activeRole: nextRole });
    setActiveContext({ role: nextRole, account: nextAccount });
    setUser({ ...nextUser, role: nextRole, activeRole: nextRole });

    return { ...nextUser, role: nextRole, activeRole: nextRole };
  }, []);

  const updateAccountDetails = useCallback(async (payload) => {
    await requestUpdateAccount(payload);
    const refreshed = await getCurrentUser();
    const authoritativeUser = refreshed.data;
    const activeRole =
      user?.role && authoritativeUser?.roles?.includes(user.role)
        ? user.role
        : authoritativeUser?.role ?? user?.role ?? null;
    const hydratedUser = {
      ...authoritativeUser,
      role: activeRole,
      activeRole,
    };

    setStoredUser(hydratedUser);
    setActiveContext({
      role: activeRole,
      account: authoritativeUser?.accounts?.find(({ role }) => role === activeRole) ?? null,
    });
    setUser(hydratedUser);

    return hydratedUser;
  }, [user]);

  const logout = useCallback(async () => {
    await requestLogout();
    setUser(null);
  }, []);

  const value = {
    user,
    isAuthenticated: Boolean(user),
    isHydrating,
    login,
    updateUser,
    updateAccountDetails,
    switchRole,
    logout,
  };

  return (
    <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
  );
};
