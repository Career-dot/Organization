# JOB SYSTEM - TRACE REPORT

## FINDING: JOB SYSTEM DOES NOT EXIST YET

After thorough trace of the entire codebase, the job posting/listing system is **NOT IMPLEMENTED**.

---

## DETAILED TRACE FINDINGS

### Frontend - Job Posting UI
**Status**: ❌ DOES NOT EXIST

Searched: `frontend/src/**` for job/posting keywords
- Result: Only 1 match in RecruiterProfileSetup.jsx (just mentions "jobTitle" field)
- No job posting UI components
- No job creation forms
- No job listing pages

---

### Backend - Job Routes/Controllers/Services
**Status**: ❌ DOES NOT EXIST

Routes in `backend/src/app.js`:
```javascript
app.use("/api/auth", authRoutes);
app.use("/api/subscriptions", subscriptionRoutes);
app.use("/api/organization", organizationRoutes);
app.use("/api/admin", adminRoutes);
// NO JOB ROUTES
```

Modules checked:
- `backend/src/module/recruiter/` → EMPTY folder
- `backend/src/module/` → No "job" module exists
- `backend/src/routes/index.js` → EMPTY

No job controller, service, repository, or validation logic exists.

---

### Database - Job Model
**Status**: ❌ DOES NOT EXIST

Prisma schema (`backend/prisma/schema.prisma`) contains:
- ✅ User
- ✅ Role, UserRole
- ✅ EmployeeProfile
- ✅ RecruiterProfile
- ✅ Organization, OrganizationMembership
- ✅ Subscription, SubscriptionPlan
- ✅ Authentication tables (RefreshToken, LoginSession, etc.)
- ❌ **NO Job model**
- ❌ **NO JobPosting model**
- ❌ **NO JobApplication model**

---

### Subscription Plans - Job Limit Configuration
**Status**: ✅ STRUCTURE EXISTS, BUT INCOMPLETE

SubscriptionPlan model has:
```prisma
model SubscriptionPlan {
  id String @id @default(cuid())
  name String
  type SubscriptionType  // RECRUITER or ORGANIZATION
  price Decimal
  billingCycle String    // MONTHLY, YEARLY
  maxUsers Int?          // only for organization plans
  description String?
  // ❌ NO jobPostingLimit field
  // ❌ NO maxJobsPerMonth field
}
```

**Issue**: SubscriptionPlan model does NOT have fields to store job-posting limits. Would need:
- `jobPostingLimit` (for individual recruiter subscriptions)
- And/or the 10 job/month limit for org recruiters is hardcoded elsewhere (it isn't)

---

### Organization Recruiter Limit
**Status**: ❌ NOT IMPLEMENTED

Currently no monthly job limit tracked for organization recruiters.
- No `JobPosting` model to track created jobs
- No date-based filtering logic
- No job count enforcement

---

## WHAT WOULD BE NEEDED TO IMPLEMENT JOB SYSTEM

To implement job posting with the limits you specified, we would need:

### 1. Database Migration (NEW Prisma models)
```prisma
model JobPosting {
  id String @id @default(cuid())
  
  # Recruiter or organization that posted this job
  recruiterId String?  # for independent recruiters
  recruiter User? @relation(...)
  
  organizationId String?  # for org recruiters
  organization Organization? @relation(...)
  
  # Job details
  title String
  description String
  location String?
  salaryMin Decimal?
  salaryMax Decimal?
  jobType String?  # FULL_TIME, PART_TIME, CONTRACT, etc.
  
  # Status
  status String @default("ACTIVE")  # ACTIVE, DRAFT, CLOSED, ARCHIVED
  
  # Timestamps
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  expiresAt DateTime?  # for auto-expiring listings
}
```

### 2. SubscriptionPlan Enhancement
Add field to store job posting limit:
```prisma
model SubscriptionPlan {
  # ... existing fields ...
  jobPostingLimit Int?  # NULL means unlimited (for non-recruiter plans)
}
```

### 3. Backend Job Module
- `backend/src/module/job/job.routes.js`
- `backend/src/module/job/job.controller.js`
- `backend/src/module/job/job.service.js`
- `backend/src/module/job/job.repository.js`
- `backend/src/module/job/job.validation.js`
- Middleware to check job creation limits

### 4. Frontend Job Pages/Components
- Job creation form
- Job listing page for independent recruiters
- Job listing page for organization recruiters
- Job details view
- Job management UI

### 5. API Endpoints (needed)
```
POST   /api/job                           # Create job
GET    /api/job                           # List jobs (for current recruiter/org)
GET    /api/job/:id                       # Get job details
PATCH  /api/job/:id                       # Update job
DELETE /api/job/:id                       # Delete/close job
GET    /api/job/limits/remaining          # Get job posting limits
```

---

## CURRENT SUBSCRIPTION PLAN STATE

Query to check existing subscription plans (if any):
```sql
SELECT id, name, type, price, billingCycle, maxUsers FROM "SubscriptionPlan";
```

Currently, we don't know:
- What subscription plans exist in the database
- What their job limits should be (if any)
- Whether any have different limits per type (RECRUITER vs ORGANIZATION)

---

## BUSINESS RULES TO IMPLEMENT (once system is built)

### 1. Independent Recruiter
- ✅ Can create jobs up to their subscription plan's `jobPostingLimit`
- ✅ Limit enforced on backend
- ✅ Cannot bypass via refresh/logout/login/API
- ✅ Subscription must be active and usable

### 2. Organization Recruiter
- ✅ Can create max 10 jobs per calendar month
- ✅ Limit resets on 1st of each month
- ✅ Limit enforced on backend
- ✅ Cannot bypass via refresh/logout/login/API
- ✅ Organization subscription must be active

---

## NEXT STEPS DECISION POINT

**Question for you:**

Do you want me to:

**Option A**: Build the complete job posting system from scratch with:
- Prisma Job model (migration)
- SubscriptionPlan enhancement (migration)
- Backend job routes/controller/service
- Limit enforcement logic (independent + monthly org limits)
- Frontend job posting UI
- Test all 7 scenarios

**Option B**: Create a minimal stub implementation just to test the business logic structure (database-only, no UI yet)?

**Option C**: Point you to existing third-party documentation/example if job posting was supposed to be in a different module I missed?

---

## WHAT I'VE VERIFIED DOES EXIST (won't touch per your instructions)

✅ Authentication system (Phase 0 fix)
✅ Role switching system
✅ Subscription system (but needs `jobPostingLimit` field)
✅ Organization membership & permissions system
✅ RecruiterProfile model
✅ Authorization middleware (checkSubscription)
✅ Rate limiting middleware
