# AI Skill Verification Platform — Project Blueprint

**Status:** SOURCE OF TRUTH. Established 2026-08-13.

**Repository layout:** monorepo root at `D:\AI-Skill-Verification-Platform\` containing `backend/` (Node/Express/Prisma API), `frontend/` (React/Vite), `AI-service/` (empty — not yet started), and `database/` (empty — no standalone contents; schema lives in `backend/prisma`).

This document governs all architectural, database, security, authentication, subscription, dashboard, AI, and workflow decisions on this project. Before any significant change:

1. Read this file.
2. Inspect the actual code (do not assume the blueprint reflects current reality).
3. Inspect `backend/prisma/schema.prisma` and `backend/prisma/migrations/`.
4. Identify affected APIs, middleware, dashboards, security rules, and database structures.
5. For destructive, architectural, authentication, authorization, subscription, or database changes: explain the impact and get explicit approval BEFORE modifying anything.

If a requested feature conflicts with this blueprint: do NOT modify code first. Explain the conflict, identify affected models/APIs/middleware/dashboards/security rules, propose the safest implementation, and wait for approval.

---

## 1. PRODUCT PURPOSE

An AI Skill Verification and Hiring Assessment Platform — not a traditional job portal.

Candidates build verified professional profiles, claim skills with evidence, and take assessments. AI evaluates skill reliability by cross-referencing resume, LinkedIn, GitHub, projects, and claimed experience. Recruiters post jobs, search/match candidates (registered or external), shortlist, and request AI interviews. Organizations manage recruiter teams under a shared subscription with scoped permissions.

Three dashboard experiences: **Candidate (Employee)**, **Recruiter**, **Organization Admin**. Organization recruiters use the recruiter dashboard but operate under organization subscription/membership/permissions rather than their own.

## 2. USER TYPES

Global roles (`RoleName` enum): `EMPLOYEE`, `RECRUITER`, `ORG_ADMIN`, `SUPER_ADMIN`.

A RECRUITER is either:
- **Independent** — own personal `Subscription` (`userId`-owned).
- **Organization recruiter** — belongs to an org via `OrganizationMembership`, uses the org's `Subscription` (`organizationId`-owned), has org-scoped `permissions`.

`SUPER_ADMIN` manages the **platform** (organizations, subscriptions, plans, independent recruiters, audit logs) — never an individual organization's own recruiters, which stay exclusively `ORG_ADMIN`'s responsibility. See §22a for the full SUPER_ADMIN architecture (added Phase 6, 2026-08-13).

Public registration must NEVER allow creating `SUPER_ADMIN`. There is no in-app role-mutation endpoint that can assign it either — the only way a `SUPER_ADMIN` account is ever created is the offline bootstrap script (§22a).

## 3–7. DASHBOARDS (Candidate / Recruiter / External-candidate flow / Shortlisting / Organization)

Full target scope: candidate profile + skills + evidence + verification scoring + notifications + public-limited search; recruiter job creation + candidate matching + shortlisting + interview requests (registered via notification, external via emailed link); organization admin recruiter management + permissions + reporting.

**Candidate search must expose only intentionally public/limited fields** (e.g. verified status, availability, headline, main skills) — never private data merely because a profile exists.

**Recruiters must never freely browse all registered candidates' private information** — access must be scoped/authorized, not blanket.

See §23 for what of this is actually built today (almost none of §3–7 beyond auth/dashboard scaffolding).

## 8. ORGANIZATION SUBSCRIPTION PLANS

All MONTHLY only. Do not add annual plans without explicit request.

| Plan | Price/mo | type | maxUsers |
|---|---|---|---|
| Recruiter Pro | $25 | RECRUITER | null |
| Organization 10 | $270 | ORGANIZATION | 10 |
| Organization 25 | $625 | ORGANIZATION | 25 |
| Organization 50 | $1,250 | ORGANIZATION | 50 |

## 9. INDIVIDUAL RECRUITER SUBSCRIPTION

Independent recruiter → personal `Subscription` (Recruiter Pro, $25/mo). Must not access paid recruiter dashboard functionality without a usable subscription.

## 10. SUBSCRIPTION ACCESS RULE

A subscription is **usable** when `status` is `ACTIVE` or `TRIAL` AND (`expiryDate` is NULL OR in the future).

- Independent `RECRUITER` → own subscription.
- Organization recruiter (any role, via ACTIVE membership) → **always** the organization's subscription, never a personal one.
- `ORG_ADMIN` → organization subscription.
- `SUPER_ADMIN` → billing bypass.
- `EMPLOYEE` → no subscription requirement.

Personal recruiter subscription must NEVER override an expired organization subscription.

## 11. SUBSCRIPTION DATABASE OWNERSHIP

`Subscription` belongs to exactly one owner: `userId` XOR `organizationId`, never both, never neither. Enforced by the PostgreSQL CHECK constraint `Subscription_ownership_check` (migration `20260810090245_enforce_subscription_ownership`), since Prisma's schema language cannot express CHECK constraints. **Do not remove or weaken this constraint.**

## 12. INVITED ORGANIZATION RECRUITER FLOW

ORG_ADMIN provisions a recruiter (email, full name, initial permissions). System creates an immediately-`ACTIVE`, `emailVerified` user with a server-generated cryptographically-random temporary password (never stored in plaintext, never logged, never returned to the caller — emailed once). `mustChangePassword = true` until the recruiter changes it themselves; any real password-set path (change-password, forgot/reset) clears the flag.

## 13. AUTHENTICATION SECURITY — REQUEST PIPELINE

Frontend route protection is UX only. The backend is the real security boundary.

```
REQUEST → authenticate → authorize(role) → checkSubscription → permission check → controller
```

- Missing/invalid auth → 401
- Wrong role → 403
- Subscription unusable → 402
- Missing permission → 403

## 14. AUTHENTICATION FEATURES

Password hashing, email verification, password reset, refresh tokens, login sessions, login-attempt tracking + account lock, password history, `lastPasswordChanged`, `twoFactorEnabled` (field only), `mustChangePassword`, soft delete (`isDeleted`), auth providers (`LOCAL`/`GOOGLE`/`GITHUB`/`LINKEDIN` — only LOCAL implemented), user lifecycle statuses.

Never: store plaintext passwords, return password hashes / refresh-token hashes / reset tokens / verification-token hashes to the frontend.

## 15. AUTHORIZATION MODEL

Three distinct, non-interchangeable concepts:
- **Global role** — `UserRole` → `Role.name` (`RoleName`).
- **Organization role** — `OrganizationMembership.role`.
- **Feature permission** — `OrganizationMembership.permissions` (string array; currently `CANDIDATE_VIEW`, `CANDIDATE_EVALUATE`, `CANDIDATE_REPORT`, `CANDIDATE_HIRE`, `CANDIDATE_EXPORT`), meaningful only for RECRUITER memberships.

## 16. SECURITY DEVELOPMENT RULES (MANDATORY, NEVER)

- Never modify an already-applied migration or hand-edit `migration.sql` post-apply.
- Never `prisma migrate reset` without explicit approval.
- Never delete database data to work around a dev error.
- Never change DB structure without explaining impact first.
- Never add a migration just to fix a checksum mismatch.
- Never trust frontend route protection as backend security.
- Never allow public `SUPER_ADMIN` registration.
- Never store plaintext passwords.
- Never bypass controller authorization for convenience.
- Never let a recruiter grant itself organization permissions.
- Never let an organization recruiter use a personal subscription to bypass the org's subscription.
- Never expose private candidate data merely because the candidate exists.

## 17. DATABASE/MIGRATION SAFETY

Before any schema change: inspect current schema → determine necessity → explain exact change + affected tables/data + migration impact → get approval for anything destructive/high-risk. Never reset without explicit approval. On checksum mismatch: inspect `_prisma_migrations`, compare structurally, prefer non-destructive Prisma resolution — never blind edits.

## 18. DEVELOPMENT WORKFLOW

```
AUDIT → PLAN → FILES TO CHANGE → DB IMPACT → SECURITY IMPACT → APPROVAL → IMPLEMENT → TEST → REGRESSION TEST → REPORT EXACT CHANGES
```

No silent scope expansion. No unrequested extra migrations/files/tests. Clean up temporary test data after testing.

## 19. AI SYSTEM (planned, not yet built)

Candidate skill verification, resume/LinkedIn/GitHub/project analysis, job-candidate matching, skill reliability scoring, AI interviews, interview result generation. AI output is decision-support only — never claim it proves truthfulness. Use terms like *evidence consistency*, *verification confidence*, *reliability score*, *job relevance*, *evidence match* — never present AI conclusions as absolute fact.

## 20. NOTIFICATION SYSTEM (planned, not yet built)

Candidate: interview/test requests, system updates. Recruiter: interview completed/started, results available. Organization: reports (later).

## 21. TECH STACK

- Backend: Node.js, Express, CommonJS, PostgreSQL, Prisma ORM.
- Frontend: React (Vite).
- Auth: JWT access token (`Authorization: Bearer`) + refresh token in an HttpOnly cookie (`/api/auth` path-scoped). Frontend silently refreshes on 401 (single-flight, no rotation yet — added 2026-08-13).
- Rate limiting: `express-rate-limit` (added 2026-08-13), in-memory store, route-specific limiters on auth-sensitive endpoints (`backend/src/middleware/rateLimit.js`).
- Email: SMTP-based service (verification, password reset, org recruiter credentials) — live Gmail SMTP in this dev environment.
- Database: PostgreSQL.

Do not introduce another framework/library without explaining why.

## 22. CURRENT PRISMA SCHEMA (as of 2026-08-13, Phase 6)

Models: `User`, `Role`, `UserRole`, `EmployeeProfile`, `RecruiterProfile`, `Organization`, `OrganizationMembership`, `RefreshToken`, `EmailVerificationToken`, `PasswordResetToken`, `LoginSession`, `PasswordHistory`, `SubscriptionPlan`, `Subscription`, `AuditLog` (added Phase 6).

Applied migrations:
1. `20260730074640_complete_auth_system`
2. `20260810060022_add_subscription_system`
3. `20260810090245_enforce_subscription_ownership` — adds `Subscription_ownership_check` CHECK constraint.
4. `20260812055658_add_organization_membership_permissions`
5. `20260812082836_add_must_change_password`
6. `20260813094112_add_audit_log` — adds the `AuditLog` model + a `User.auditLogs` back-relation. Purely additive: one new table, no existing table/column/row touched. Required because SUPER_ADMIN's privileged platform actions (Phase 6) need an audit trail, and no audit/log model existed before this.

The 2026-08-13 security hardening phase (logout, refresh flow, rate limiting, `maxUsers` enforcement, password reuse) required zero schema changes. Phase 6 (SUPER_ADMIN platform administration) required exactly one, additive migration (`add_audit_log`) — everything else in Phase 6 reused existing columns/relations/enums.

No candidate skills, evidence, jobs, interviews, or notifications models exist yet.

## 22a. SUPER_ADMIN PLATFORM ADMINISTRATION (added Phase 6, 2026-08-13)

**Core principle:** `SUPER_ADMIN` manages the platform; `ORG_ADMIN` manages their own organization. `SUPER_ADMIN` never directly manages an individual organization's recruiters — that stays exclusively `ORG_ADMIN`'s, through the existing `/api/organization/*` routes, untouched by Phase 6.

**Login:** No second authentication system. `SUPER_ADMIN` logs in through the exact same `POST /api/auth/login` → `authenticate` → JWT pipeline every other role uses. `resolveSubscriptionAccess` already gave it an unconditional billing bypass before Phase 6; nothing about login itself changed.

**Bootstrap (the only way a SUPER_ADMIN account is ever created):** `npm run bootstrap:super-admin` (`backend/scripts/bootstrapSuperAdmin.js`), run manually and locally by the operator — never an HTTP endpoint, never run automatically on server startup. Reads `SUPER_ADMIN_BOOTSTRAP_EMAIL` / `SUPER_ADMIN_BOOTSTRAP_PASSWORD` from the local environment (never committed, never hardcoded anywhere — not in source, seed.js, frontend, or this document). Validates email format and password strength via the existing `validatePasswordStrength` (now exported from `auth.service.js` for this reuse). Idempotent: if a `SUPER_ADMIN` already exists anywhere on the platform, the script exits 0 having made no change — it is not a way to create additional admins. Hashes via the existing `hashPassword` (bcrypt cost 12), creates the user `ACTIVE` + `emailVerified: true` (the operator vouches for it, same reasoning as organization-recruiter provisioning), records `PasswordHistory`. Never prints, returns, or stores the plaintext password.

**Authorization:** every `/api/admin/*` route uses `authenticate` + `authorize("SUPER_ADMIN")`, no exceptions, no `checkSubscription` (SUPER_ADMIN already bypasses subscription entirely). The actor is always `req.user.id`, never a client-supplied ID.

**Organization administration** (`/api/admin/organizations*`): list (all organizations, aggregate-only), create (atomically creates the `Organization` + its initial `ORG_ADMIN` `User`/`UserRole`/`OrganizationMembership`, mirroring self-registration's `ORG_ADMIN` branch exactly — new org starts `PENDING_VERIFICATION`, membership starts `INVITED`, both flip to `ACTIVE` only via a real subscription purchase, never a SUPER_ADMIN shortcut around that), detail, and status transitions (`ACTIVE` ⇄ `SUSPENDED` only — `PENDING_VERIFICATION` is never an admin-settable target in either direction). **Load-bearing fix made alongside this**: `resolveSubscriptionAccess` (subscription.service.js) previously never checked `Organization.status` at all — a "suspended" organization had zero actual access-control effect. It now also checks `organization.status !== "SUSPENDED"`, so suspending an organization immediately blocks every member's access via the existing `checkSubscription` middleware, verified live (suspend → 402 → reactivate → access restored), with a regression check confirming unrelated pre-existing organizations were unaffected.

**Subscription administration** (`/api/admin/organizations/:id/subscription*`): view, extend/renew (pushes `expiryDate` one billing cycle forward from whichever is later — the current `expiryDate` or now — and reactivates the subscription), cancel (`status: CANCELLED`). All administrative database-state overrides — **never a real charge**; `paymentGateway`/`simulatedGateway.js` is never invoked from this path. Independent-recruiter subscriptions are viewable (via `/api/admin/recruiters`) but have no platform-administrable extend/cancel actions in this phase.

**Independent recruiter administration** (`/api/admin/recruiters*`): list/detail/suspend/reactivate only — **creation is deliberately deferred** (no independent-recruiter lifecycle/billing flow has been designed yet). "Independent" is derived server-side identically everywhere in this module: `RECRUITER` role AND no `ACTIVE` `OrganizationMembership` — the same operational definition `resolveSubscriptionAccess` already used before Phase 6, not a new or separately-maintained one. An organization recruiter's ID can never resolve through these endpoints (404, not 403 — confirmed by test, including the reverse: attempting to suspend an organization recruiter via this endpoint is rejected and leaves their status unchanged).

**Plan management** (`/api/admin/plans*`): list (all plans, including inactive — distinct from the public, active-only `GET /api/subscriptions/plans`), create, update (price/`maxUsers`/description/`isActive`; `type` is deliberately not updatable post-creation — changing it would retroactively change what any existing subscription referencing that plan economically means, and would break `loadPurchasablePlan`'s type-matching for future purchases). `billingCycle` is pinned to `"MONTHLY"` — no annual plans without an explicit future decision, matching §8.

**Known, deliberately-accepted limitation — historical pricing:** `Subscription` stores no price/limit snapshot at purchase time, only a live `planId` reference. Editing a plan's price or `maxUsers` here changes the **live catalog only** — it does **not** retroactively change what any already-purchased `Subscription` "cost." This was flagged, not silently worked around: adding a `Subscription`-level price-snapshot field is a legitimate future migration (needed for real historical billing accuracy) but was explicitly not implemented in Phase 6, since it wasn't required to satisfy any stated Phase 6 responsibility.

**Audit logging:** `AuditLog` (actorUserId, action, targetType, targetId, metadata JSON, ipAddress, createdAt). Written via a single explicit `writeAuditLog(tx, ...)` helper — never a generic request-logging middleware — called from inside the same database transaction as the privileged mutation it records, so a rolled-back action never leaves an orphaned audit row and a successful action can never silently skip being logged. Actions logged: `ORGANIZATION_CREATED`, `ORGANIZATION_STATUS_CHANGED`, `ORGANIZATION_SUBSCRIPTION_EXTENDED`, `ORGANIZATION_SUBSCRIPTION_CANCELLED`, `RECRUITER_STATUS_CHANGED`, `SUBSCRIPTION_PLAN_CREATED`, `SUBSCRIPTION_PLAN_UPDATED`, `SUBSCRIPTION_PLAN_ACTIVATED`, `SUBSCRIPTION_PLAN_DEACTIVATED`. Never stores passwords, hashes, tokens, or other secrets — verified by test. `GET /api/admin/audit-logs` supports filtering (`action`/`targetType`/`targetId`/`actorUserId`) and pagination (`limit`, clamped 1–200, default 50; `offset`) — the one admin list that genuinely needs it, since audit rows are unbounded-growth data unlike organizations/plans.

**Dashboard** (`GET /api/admin/dashboard`): platform-wide aggregates (total users, employees, org admins, recruiters split organization-vs-independent, organization status counts, subscription status distribution) via direct DB `count`/`groupBy` aggregates — no N+1, no loading full rows to filter in Node. Consolidates and replaces the earlier, narrower `GET /api/admin/organizations/stats` (removed — nothing depended on it, no admin frontend existed before Phase 6).

**Frontend:** `/admin/dashboard`, `/admin/organizations`, `/admin/subscriptions`, `/admin/recruiters`, `/admin/plans`, `/admin/audit-logs` — a dedicated `ROLES.SUPER_ADMIN`-gated route group (`ProtectedRoutes allowedRoles={[ROLES.SUPER_ADMIN]}`), reusing the existing `DashboardShell`/`DashboardLayout`/`Button`/`Alert`/`FormField`/`ConfirmDialog` components exactly as the other role dashboards do, but with their own distinct pages/nav (`roleLabel="Platform Admin"`) — never a renamed copy of `OrganizationDashboard`, and organization recruiter management never appears in this navigation.

---

## 23. CURRENT IMPLEMENTATION STATUS

*(Update this section after every feature is implemented and verified — this is the living part of the blueprint.)*

### Fully implemented and verified against code

- **Auth core**: register (role ∈ EMPLOYEE/RECRUITER/ORG_ADMIN only, SUPER_ADMIN explicitly blocked in both zod schema and service), email verification (hashed tokens, 24h expiry), login (lockout after 5 failed attempts / 15min, bcrypt-style hash compare via `comparePassword`), JWT access token + HttpOnly refresh-token cookie, refresh endpoint, forgot/reset password (hashed single-use tokens, 1h expiry, enumeration-safe responses), authenticated change-password (clears `mustChangePassword`), `/api/auth/me` onboarding-state endpoint.
- **Request pipeline**: `authenticate` → `authorize(role)` → `checkSubscription` wired correctly on every organization and subscription-gated route, in the correct order, returning 401/403/402 as specified.
- **Subscription engine**: usability rule (`ACTIVE`/`TRIAL` + unexpired), owner resolution (independent recruiter vs. organization vs. bypass for SUPER_ADMIN vs. denied for EMPLOYEE), organization-recruiter correctly forced onto the org's subscription (personal purchase explicitly blocked with 403), checkout/payment flow via a signed short-lived JWT "checkout token" + simulated payment gateway (`simulatedGateway.js` — always succeeds, no real provider wired).
- **Subscription ownership CHECK constraint**: present in the DB exactly as specified, not weakened.
- **Organization recruiter provisioning**: cryptographically random 12-char temp password (`crypto.randomInt`, ambiguous chars excluded, satisfies the same complexity policy as normal registration), hashed before storage, emailed once, immediately-ACTIVE + emailVerified account, `mustChangePassword=true`. Email-send failure is surfaced via an `emailSent` flag rather than silently swallowed or falsely reported.
- **Organization permission model**: `setRecruiterPermissions` is reachable only through `authorize("ORG_ADMIN")` + `resolveAdminOrganization(user)`, which derives the caller's own organization server-side from an ACTIVE `ORG_ADMIN` membership — a recruiter has no route that can reach this handler, so self-granting permissions is not possible in the current code. Permission values are whitelist-validated against `ALLOWED_RECRUITER_PERMISSIONS`.
- **SUPER_ADMIN provisioning**: role exists in `Role` (via seed), but no seed or code path creates a SUPER_ADMIN *user* — must be provisioned manually/out-of-band, consistent with "never allow public SUPER_ADMIN registration."
- **Seeded subscription plans**: match blueprint pricing/type/maxUsers exactly.
- **Three dashboard shells + role-gated frontend routing**: `ProtectedRoutes.jsx` checks `isAuthenticated` + `allowedRoles` and redirects — correctly documented in-code as UX-only, not a security boundary (backend independently enforces via the middleware pipeline above).
- **Candidate search visibility model**: no candidate search exists yet, so the "public-limited fields only" rule has nothing to violate today (see Missing).
- **Logout / refresh-token revocation, frontend silent-refresh, auth rate limiting, `maxUsers` seat enforcement, password reuse prevention**: all implemented and runtime-tested 2026-08-13 — see "Security hardening phase" below for detail.

### Security hardening phase (completed 2026-08-13)

Five focused gaps identified in the 2026-08-13 audit were closed, in this order, each implemented/tested/reported individually and approved phase-by-phase:

1. **Logout / refresh-token revocation** — `POST /api/auth/logout` (unauthenticated by design, idempotent): hashes the presented refresh-token cookie, revokes the matching `RefreshToken` row via the previously-dead `revokeRefreshToken`, and clears the cookie via `res.clearCookie` with the same options `login` sets it with (now a shared `REFRESH_COOKIE_OPTIONS` constant, so set/clear can't drift apart). Frontend `logout()` (in `AuthContext`/`authService`) is now async, calls the endpoint, and clears `localStorage` regardless of the call's outcome. No schema/migration change — reused the existing `RefreshToken.revoked` field.
2. **Frontend refresh flow (no rotation)** — `apiClient.js` gained a response interceptor: on a 401 from a request that carried a Bearer token (and isn't `/login`, `/refresh`, or `/logout` itself), it calls `/api/auth/refresh` once via a single-flight guard (concurrent 401s share one in-flight refresh), retries the original request once, and on refresh failure clears local auth state and hard-redirects to `/login`. Backend `/api/auth/refresh` behavior is unchanged. **Refresh-token rotation was explicitly deferred** — not implemented this phase, pending a separate rotation-specific recommendation and approval.
3. **Auth rate limiting** — `express-rate-limit` (new dependency) via a reusable `backend/src/middleware/rateLimit.js` factory, applied per-route: `login` 10/15min, `refresh` 30/15min, `logout` 20/15min, `forgot-password` 5/hr, `reset-password` 10/15min, `resend-verification` 5/hr, `change-password` 10/15min. In-memory store (documented as needing a shared store like Redis once horizontally scaled — not implemented, not needed yet).
4. **`SubscriptionPlan.maxUsers` enforcement** — recruiter provisioning and `REMOVED→ACTIVE` reactivation now check the org's live plan `maxUsers` against its current `ACTIVE` `RECRUITER` count (ORG_ADMIN never counted — confirmed this matches the existing `countRecruiterMembershipsByStatus` role filter, not a new rule) before writing, inside a transaction that row-locks the `Organization` first (`SELECT ... FOR UPDATE`) so concurrent requests for the same org can't both slip through. No migration — reused existing columns/relations (`findLatestOrganizationSubscription` now `include`s `plan`).
5. **Password reuse prevention** — `assertPasswordNotReused` (last 5 passwords, `PASSWORD_HISTORY_DEPTH` constant) applied to `resetPassword` and authenticated `changePassword`. **Fixed the pre-existing recording gap**: `updateUserPassword` previously never wrote to `PasswordHistory` at all — it now does, and prunes to the last 5 rows per user. Registration and initial recruiter provisioning unchanged (nothing to compare yet). Recruiter credential *reset* records history + prunes but deliberately has **no reuse check** (server-generated random password, not user-chosen — a check there has no real security value).

All five were verified with real runtime tests against a live dev server + dev database (not just static review) — see conversation history for the full per-phase test tables. Two real gaps surfaced only during testing, both were my own test-script bugs (not application defects) and are noted for completeness, not as outstanding issues.

### Partially implemented

- **LoginSession**: rows are created on every login, but nothing reads them back (no "your active sessions" UI/API, no per-session revocation — logout revokes the one refresh token presented, not all of a user's sessions).
- **twoFactorEnabled**: schema field exists, defaults false, no 2FA flow implemented anywhere.
- **RecruiterProfile / EmployeeProfile**: stub rows created at registration; only `companyName`/`jobTitle`/`businessEmail`/`linkedInUrl`/`companyWebsite` (recruiter) and `headline`/`bio`/`availability` (employee) exist — no resume, skills, projects, education, experience, GitHub fields yet, despite the blueprint's full candidate-profile scope.
- **Organization**: model + admin recruiter-management CRUD (now including seat-limit enforcement) exist; org-level reporting/analytics (§7) does not.

### Missing entirely (present in blueprint, absent in code)

- Candidate skills/claims, evidence, resume management, LinkedIn/GitHub integration.
- Skill testing engine, experience-based test generation, scoring.
- AI verification engine (resume/LinkedIn/GitHub/project consistency, reliability scoring).
- Candidate search/matching (registered candidates cannot be searched by recruiters at all yet).
- Recruiter job system (no `Job` model, no job CRUD).
- Candidate shortlisting.
- Registered-candidate interview flow (in-platform notification-driven).
- External/unregistered-candidate flow (resume+LinkedIn+GitHub+email intake, AI relevance scoring, emailed interview link).
- Notification center (candidate or recruiter side) — no `Notification` model exists.
- AI interview engine and result generation.
- Organization analytics/hiring reports.
- Production payment gateway + webhooks (currently 100%-simulated, always-succeeds gateway).
- Refresh-token rotation (deliberately deferred — see Security hardening phase above; plain non-rotating refresh flow is implemented).
- Per-session revocation ("log out of all devices" / active-sessions UI) — `LoginSession` rows exist but aren't read back; logout revokes only the one refresh token presented.
- `AI-service/` and `database/` directories are empty — no code has been started there.

### Contradictions between blueprint and code

- None found at the architectural level — everything actually built matches the blueprint's stated rules precisely (subscription ownership logic, request pipeline, temp-password handling, SUPER_ADMIN exclusion, permission self-grant prevention). The gap is entirely "not yet built," not "built differently than specified."
- Minor blueprint imprecision: §14 lists `twoFactorEnabled` as existing "authentication security infrastructure" — the field exists but no 2FA logic does. §22 lists `PasswordHistory` similarly — populated but not enforced. Both are now called out explicitly above so future work doesn't assume they're functional.

### Security concerns found during the original audit — resolved 2026-08-13

1. ~~No logout / refresh-token revocation path.~~ **Resolved** — see Security hardening phase above.
2. ~~Password reuse is not prevented.~~ **Resolved** — see Security hardening phase above.
3. **Simulated payment gateway always succeeds** (`simulatedGateway.js`) — still true, out of scope for this hardening phase. Correct for current dev stage, but must never be reachable in a production build; no env-based guard currently prevents it from being wired in production. Worth a build-time check before go-live.
4. ~~No rate limiting.~~ **Resolved** — see Security hardening phase above.
5. **CORS** is configured with a single `FRONTEND_URL` origin + `credentials: true`, which is correct and matches the cookie-based refresh-token design — no issue, noting for completeness.

None of these were ever exploitable in a way that exposed private candidate data or let a recruiter self-escalate permissions — the rules in §16 were, and remain, correctly enforced.

### Remaining/new security notes as of 2026-08-13

- **Refresh-token rotation** was deliberately deferred (see Security hardening phase above) — a stolen-and-later-reused refresh token is revocable via logout but not yet *detectable* as theft the way rotation would make it. Pending a separate recommendation + approval.
- **No per-session/"all devices" revocation** — logout revokes only the one refresh token presented in the request; a user logged in on multiple devices logging out on one doesn't affect the others. `LoginSession` rows exist but aren't surfaced or actionable.
- **`express-rate-limit`'s in-memory store** resets on server restart and doesn't share counts across instances — fine for the current single-instance architecture, will need a shared store (e.g. Redis) before horizontal scaling.
- Simulated payment gateway (unchanged, see above).

## 24. SECURITY STATUS

**DEVELOPMENT / HARDENED FOR AUTH+SESSION+ORG-SEAT+PASSWORD-POLICY. STILL NOT PRODUCTION READY.**

What's hardened: the auth + authorization + subscription request pipeline, organization permission boundaries, subscription ownership integrity, temp-password handling, **logout/session revocation, rate limiting on all auth-sensitive endpoints, organization recruiter seat limits, and password reuse policy** (all added 2026-08-13).

What's not: refresh-token rotation (deferred), per-session revocation, real payment gateway, and — because the actual candidate/job/AI features don't exist yet — the authorization rules that will need to protect *those* features (candidate data exposure, job-scoped candidate matching, interview access) are entirely unwritten. A dedicated security audit is still required before production, as the blueprint already states.

## 25. SAFEST NEXT DEVELOPMENT PHASE

The 2026-08-13 security hardening phase (logout, refresh flow, rate limiting, seat limits, password reuse) is complete, tested, and reported. Per the blueprint's own build order and what's actually in place: authentication, authorization, subscription access control, and this hardening pass are done and verified. The safest next step is **candidate profile expansion** (extending `EmployeeProfile` with the full field set: resume, skills, projects, education, experience, GitHub/LinkedIn links), since:

- It has no security/authorization complexity beyond what already exists (`authenticate` + owner-scoped access to one's own profile).
- It's a prerequisite for every later phase (skills engine, AI verification, search/matching all read from this data).
- It doesn't touch subscription, payment, or organization boundaries, so it's low-risk relative to the hardening already done.

Before starting it: confirm the exact profile field list with the user (the blueprint names categories — "Experience," "Education," "Projects" — but not concrete schema shapes), since that's a database-modeling decision this document defers rather than making silently.

---

## FINAL RULE

This document is the architectural source of truth. For every new feature request: check this blueprint → check actual code → check actual Prisma schema → check existing migrations → check existing security architecture → report affected models/APIs/middleware/dashboards/security rules and whether DB/security changes are required → get approval → implement → test (including security boundaries) → report exact changes → update §23 (CURRENT IMPLEMENTATION STATUS) if it changed.

Do not invent features or architecture not described here without discussing them first.
