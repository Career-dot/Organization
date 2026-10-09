# Auth/Session State Persistence Issue - Root Cause Analysis

## PROBLEM SUMMARY
After logout/login or page refresh, previous user/role/dashboard state can appear or the dashboard may display an incorrect role.

## ROOT CAUSE IDENTIFIED

### Issue #1: INCOMPLETE TOKEN REFRESH (Primary)
**Location**: `backend/src/module/auth/auth.service.js` → `refreshAccessToken()` function

The `/auth/refresh` endpoint returns ONLY the new access token and refresh token:
```javascript
return {
  accessToken: generateAccessToken({ userId: user.id, role }),
  refreshToken: nextRefreshToken,
};
```

It does NOT return the updated user object (unlike `loginUser` and `switchRole` which both return the full user object).

**Impact**:
- Frontend's `apiClient.js` only updates sessionStorage's accessToken via `setAccessToken(accessToken)`
- Frontend's sessionStorage.user remains stale/outdated from the previous session
- On next hydration or API call, stale user data is used to determine role and onboarding state
- The X-Active-Role header sent during subsequent refreshes uses stale sessionStorage.user.role

### Issue #2: RACE CONDITION IN LOGOUT (Secondary)
**Location**: `frontend/src/context/AuthContext.jsx` → `logout()` callback

```javascript
const logout = useCallback(async () => {
  await requestLogout();  // Clears sessionStorage in finally block
  setUser(null);          // React state cleared after sessionStorage cleared
}, []);
```

Timeline issue:
1. `clearAuthSession()` clears sessionStorage async
2. `setUser(null)` updates React state
3. During this gap, if an API call is in-flight or components re-render, old sessionStorage data might be read

### Issue #3: HYDRATION VULNERABILITY (Secondary)
**Location**: `frontend/src/context/AuthContext.jsx` → `useEffect` in AuthProvider

The initial state initialization reads from potentially stale sessionStorage:
```javascript
const [user, setUser] = useState(() => getAuthSession().user);
```

If sessionStorage.user contains data from a previous login before the hydration call to `/auth/me` completes, components might briefly display the old user's data.

---

## AFFECTED FLOW SEQUENCES

### Scenario A: Switch Role → Refresh → Wrong Role After Refresh
1. User logs in as Candidate → sessionStorage has `user: {role: "EMPLOYEE"}`
2. User switches to Recruiter → sessionStorage updated to `user: {role: "RECRUITER"}`, new accessToken
3. Access token expires, API call triggers refresh
4. `/auth/refresh` returns new accessToken only, NOT updated user object
5. sessionStorage.user remains `{role: "RECRUITER"}` but is untouched
6. On next hydration, if the token was generated with wrong role data, API calls may use wrong role

### Scenario B: Logout → Login → Previous User's State Appears
1. User A logs in → sessionStorage has User A's data
2. User A logs out → `clearAuthSession()` called, sessionStorage cleared
3. BUT: Between logout and next login, if a component renders, it might read old sessionStorage
4. User B logs in → sessionStorage updated with User B's data
5. If User B has same role as User A, an old dashboard component might still be mounted/visible

---

## MINIMAL FIX REQUIRED (Phase 0)

### Fix #1: Make `/auth/refresh` Return Complete User Data
**File**: `backend/src/module/auth/auth.service.js`

In `refreshAccessToken()` function, change return statement from:
```javascript
return {
  accessToken: generateAccessToken({ userId: user.id, role }),
  refreshToken: nextRefreshToken,
};
```

To:
```javascript
return {
  accessToken: generateAccessToken({ userId: user.id, role }),
  refreshToken: nextRefreshToken,
  user: {
    id: user.id,
    fullName: user.fullName,
    email: user.email,
    role,
    status: user.status,
    mustChangePassword: user.mustChangePassword,
    onboarding: await getOnboardingState(user.id, role, user.mustChangePassword),
    roles: getAvailableAccounts(user).map(({ role: accountRole }) => accountRole),
    accounts: getAvailableAccounts(user),
  },
};
```

### Fix #2: Update Frontend to Handle Refreshed User Data
**File**: `frontend/src/services/apiClient.js`

In `refreshAccessToken()` function, after successful refresh:
```javascript
.then((response) => {
  const accessToken = response.data?.data?.accessToken;
  const user = response.data?.data?.user;

  if (!accessToken) {
    throw new Error("Refresh response did not include an access token");
  }

  setAccessToken(accessToken);
  if (user) {
    setStoredUser(user);  // NEW: Update user object too
  }
  return accessToken;
})
```

### Fix #3: Ensure Logout Completely Clears Client State
**File**: `frontend/src/context/AuthContext.jsx`

Modify logout to ensure synchronous clearing:
```javascript
const logout = useCallback(async () => {
  try {
    await requestLogout();
  } finally {
    // requestLogout() calls clearAuthSession() in finally block
    // Ensure React state is cleared only after sessionStorage is cleared
    setUser(null);
  }
}, []);
```

(Already correct, but verify in testing)

### Fix #4: Ensure clearAuthSession() is Bulletproof
**File**: `frontend/src/services/authSession.js`

Verify the function removes ALL keys and no others remain:
```javascript
export const clearAuthSession = () => {
  // Remove the three auth keys
  sessionStorage.removeItem(AUTH_SESSION_KEYS.accessToken);
  sessionStorage.removeItem(AUTH_SESSION_KEYS.user);
  sessionStorage.removeItem(AUTH_SESSION_KEYS.sessionSelector);
  
  // Defensive: remove any legacy keys that might exist
  sessionStorage.removeItem("auth.accessToken");
  sessionStorage.removeItem("auth.user");
  sessionStorage.removeItem("auth.sessionSelector");
};
```

---

## VERIFICATION TEST SCENARIOS

After applying fixes, validate:

**A. Candidate login → Candidate dashboard → refresh → still Candidate**
- Login as Candidate
- Navigate to Candidate dashboard
- Force page refresh (F5 or Ctrl+R)
- Verify: Dashboard still shows Candidate, role is correct

**B. Candidate → Recruiter → refresh → still Recruiter**
- Login as Candidate
- Switch role to Recruiter
- Force page refresh
- Verify: Dashboard shows Recruiter, role is correct in sessionStorage

**C. Recruiter → Candidate → refresh → still Candidate**
- Login as Recruiter
- Switch role to Candidate (if available)
- Force page refresh
- Verify: Dashboard shows Candidate, role is correct

**D. Logout → login as another user → previous state must not appear**
- Login as User A with role X
- Logout completely
- Login as User B with role Y
- Verify: Dashboard shows User B's data, User A's data/role never appears
- Check DevTools: sessionStorage should be completely cleared on logout

**E. Close/reopen/refresh → role from authenticated session only**
- Login as User A
- Open DevTools, note sessionStorage keys
- Close tab/refresh browser
- Reopen
- Verify: User A still logged in, role matches current authentication

**F. Invalid/expired token → clear session and redirect**
- Login successfully
- Manually corrupt access token in DevTools sessionStorage
- Make API call
- Verify: 401 error, session cleared, redirect to login

---

## EXPECTED OUTCOME

After Phase 0 fixes:
- ✅ Logout completely clears ALL client-side auth state (sessionStorage + React state)
- ✅ Login initializes state ONLY from new authenticated user
- ✅ Refresh updates BOTH token AND user object in sessionStorage
- ✅ Role never changes to previous user's role after refresh
- ✅ Route guards redirect based on CURRENT authenticated user's role
- ✅ Candidate ↔ Recruiter / ORG Admin switching works exactly as before
- ✅ No automatic Candidate accounts added (preserves existing behavior)
- ✅ Subscriptions, payments, dashboards unchanged
