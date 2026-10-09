export const AUTH_SESSION_KEYS = {
  accessToken: "auth.v2.accessToken",
  user: "auth.v2.user",
  sessionSelector: "auth.v2.sessionSelector",
  activeRole: "auth.v2.activeRole",
  activeAccount: "auth.v2.activeAccount",
};

export const getAuthSession = () => {
  try {
    const accessToken = sessionStorage.getItem(AUTH_SESSION_KEYS.accessToken);
    const sessionSelector = sessionStorage.getItem(AUTH_SESSION_KEYS.sessionSelector);
    const rawUser = sessionStorage.getItem(AUTH_SESSION_KEYS.user);
    const rawActiveAccount = sessionStorage.getItem(AUTH_SESSION_KEYS.activeAccount);
    const activeRole = sessionStorage.getItem(AUTH_SESSION_KEYS.activeRole);
    const user = rawUser ? JSON.parse(rawUser) : null;
    const activeAccount = rawActiveAccount ? JSON.parse(rawActiveAccount) : null;

    return {
      accessToken,
      sessionSelector,
      user,
      activeRole,
      activeAccount,
    };
  } catch {
    return {
      accessToken: null,
      sessionSelector: null,
      user: null,
      activeRole: null,
      activeAccount: null,
    };
  }
};

export const setAuthSession = ({
  accessToken,
  user,
  sessionSelector,
  activeRole,
  activeAccount,
}) => {
  sessionStorage.setItem(AUTH_SESSION_KEYS.accessToken, accessToken);
  sessionStorage.setItem(AUTH_SESSION_KEYS.user, JSON.stringify(user));
  sessionStorage.setItem(AUTH_SESSION_KEYS.sessionSelector, sessionSelector);

  if (activeRole) {
    sessionStorage.setItem(AUTH_SESSION_KEYS.activeRole, activeRole);
  } else {
    sessionStorage.removeItem(AUTH_SESSION_KEYS.activeRole);
  }

  if (activeAccount) {
    sessionStorage.setItem(AUTH_SESSION_KEYS.activeAccount, JSON.stringify(activeAccount));
  } else {
    sessionStorage.removeItem(AUTH_SESSION_KEYS.activeAccount);
  }
};

export const setAccessToken = (accessToken) => {
  sessionStorage.setItem(AUTH_SESSION_KEYS.accessToken, accessToken);
};

export const setStoredUser = (user) => {
  sessionStorage.setItem(AUTH_SESSION_KEYS.user, JSON.stringify(user));
};

export const setActiveContext = ({ role, account }) => {
  if (role) {
    sessionStorage.setItem(AUTH_SESSION_KEYS.activeRole, role);
  } else {
    sessionStorage.removeItem(AUTH_SESSION_KEYS.activeRole);
  }

  if (account) {
    sessionStorage.setItem(AUTH_SESSION_KEYS.activeAccount, JSON.stringify(account));
  } else {
    sessionStorage.removeItem(AUTH_SESSION_KEYS.activeAccount);
  }
};

export const clearAuthSession = () => {
  // Remove v2 auth keys
  sessionStorage.removeItem(AUTH_SESSION_KEYS.accessToken);
  sessionStorage.removeItem(AUTH_SESSION_KEYS.user);
  sessionStorage.removeItem(AUTH_SESSION_KEYS.sessionSelector);
  sessionStorage.removeItem(AUTH_SESSION_KEYS.activeRole);
  sessionStorage.removeItem(AUTH_SESSION_KEYS.activeAccount);
  
  // Defensive: remove any legacy keys that might exist from previous versions
  sessionStorage.removeItem("auth.accessToken");
  sessionStorage.removeItem("auth.user");
  sessionStorage.removeItem("auth.sessionSelector");
  sessionStorage.removeItem("auth.activeRole");
  sessionStorage.removeItem("auth.activeAccount");
};

// A one-way cleanup for the legacy, browser-wide authentication state. New
// authentication state is never written to localStorage.
export const clearLegacyAuthStorage = () => {
  localStorage.removeItem("accessToken");
  localStorage.removeItem("user");
};
