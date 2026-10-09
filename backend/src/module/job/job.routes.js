const express = require("express");
const multer = require("multer");

const authenticate = require("../../middleware/authenticate");
const authorize = require("../../middleware/authorize");
const validate = require("../../middleware/validate");
const { MAX_FILE_SIZE } = require("../storage/storage.service");
const jobController = require("./job.controller");
const jobAssessmentAttemptController = require("./jobAssessmentAttempt.controller");
const jobCandidateReferenceController = require("./jobCandidateReference.controller");
const jobOverviewController = require("./jobOverview.controller");
const {
  createDraftSchema,
  updateDraftSchema,
  clarificationQuestionsSchema,
  assessmentUpdateSchema,
  candidateReferenceUpdateSchema,
  manualCandidateCreateSchema,
} = require("./job.validation");

const router = express.Router();

// Candidate Excel Sheet upload: in-memory multipart handling with the storage
// module's size cap, and the same multer-error envelope the storage routes use
// ({ success, message } with 413 for oversized files).
const candidateListUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
});

const receiveCandidateListUpload = (req, res, next) => {
  candidateListUpload.single("file")(req, res, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError) {
      const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
      return res.status(status).json({ success: false, message: error.message });
    }
    return res.status(400).json({ success: false, message: error.message || "Invalid multipart upload" });
  });
};

// Every job route requires a valid access token.
router.use(authenticate);

// NOTE: literal segments ("/recruiter/...", "/organization/...") MUST be
// registered before GET "/:jobId", otherwise Express treats them as a jobId.

// --- Recruiter views (independent + organization recruiters) ---------------
router.get("/recruiter/jobs", authorize("RECRUITER"), jobController.listMyJobs);
router.get("/recruiter/limits", authorize("RECRUITER"), jobController.getRecruiterLimits);

// --- Organization-scoped views (recruiter or org admin of their OWN org) ---
// The :organizationId parameter is verified against the caller's ACTIVE
// membership in the service — it is never an ownership source (D8).
router.get(
  "/organization/:organizationId/jobs",
  authorize("RECRUITER", "ORG_ADMIN"),
  jobController.listOrganizationJobs
);
router.get(
  "/organization/:organizationId/limits",
  authorize("RECRUITER", "ORG_ADMIN"),
  jobController.getOrganizationLimits
);

// --- Recruiter READ-ONLY Jobs overview (Phase 8) ----------------------------
// Three narrowly-scoped reads: the job list, one job's details card, and that
// job's paginated candidates. Everything else about a job already has an
// endpoint above/below and is deliberately NOT re-exposed here.
//
// ORDERING IS LOAD-BEARING: "/overview/jobs" and "/overview/:jobId" are literal
// prefixes, so they MUST be registered before GET "/:jobId" below — otherwise
// Express would treat the string "overview" as a jobId.
//
// READ-ONLY: GET only. This feature adds no POST/PATCH/DELETE, so it cannot
// mutate a Job, its description/requirements/assessment, a candidate, a
// preferred/selected state, a score or a report.
//
// AUTHORIZATION: the route adds the RECRUITER role gate; the service then
// re-resolves ownership from the authenticated principal and resolves the job
// through the EXISTING requireAuthorizedJob chain. Frontend hiding is never the
// authorization boundary.
//
// The two REPORT reads are intentionally NOT redefined here. They already exist,
// are already job+reference scoped, and are reused unchanged:
//   GET /:jobId/candidate-references/:referenceId/analysis   (candidate analysis)
//   GET /:jobId/candidates/:referenceId/verification-report  (existing platform)
router.get("/overview/jobs", authorize("RECRUITER"), jobOverviewController.listOverviewJobs);
router.get(
  "/overview/:jobId",
  authorize("RECRUITER", "ORG_ADMIN"),
  jobOverviewController.getOverviewJob
);
router.get(
  "/overview/:jobId/candidates",
  authorize("RECRUITER", "ORG_ADMIN"),
  jobOverviewController.listOverviewCandidates
);

// --- Job creation & lifecycle (recruiter actions) ---------------------------
// Ownership (recruiterId vs organizationId) is derived server-side from the
// authenticated user and their ACTIVE membership; the request body can never
// set it (zod strips unknown keys). There is no second-door organization
// creation route (D8).
router.post("/", authorize("RECRUITER"), validate(createDraftSchema), jobController.createJob);
router.get("/:jobId", authorize("RECRUITER", "ORG_ADMIN"), jobController.getJob);
router.patch("/:jobId", authorize("RECRUITER"), validate(updateDraftSchema), jobController.updateJob);
router.post("/:jobId/candidate-list", authorize("RECRUITER"), receiveCandidateListUpload, jobController.uploadJobCandidateList);
router.get("/:jobId/candidate-list", authorize("RECRUITER"), jobController.getCandidateListPreview);
// Recruiter candidate workflow (Phase 1): the same persisted candidate list,
// classified IN SYSTEM / NOT IN SYSTEM by the backend, with the candidate's
// EXISTING verified skill score for display. Read-only; ownership enforced by
// the service through the job (the frontend can never classify a candidate).
router.get(
  "/:jobId/candidates",
  authorize("RECRUITER", "ORG_ADMIN"),
  jobController.listJobCandidates
);
// Manual candidate addition — the recruiter adds a candidate the uploaded sheet
// does not contain. The request carries the SAME candidate evidence an imported
// Excel row carries (name, LinkedIn/GitHub URL + text, preferred role, skills and
// skill notes) and nothing else: manualCandidateCreateSchema is .strict(), so a
// client-supplied `status` / `systemStatus` / `candidateUserId` is REJECTED rather
// than trusted. The backend normalizes the address, persists the job-scoped
// candidate reference through the SAME seed-if-absent transaction the sheet uses
// (under @@unique([jobId, candidateEmail])) and classifies it through the exact
// same authoritative classifier the Excel path uses, so a manually added
// candidate is indistinguishable from an imported one downstream. The resume is
// NOT in this body — it goes through the existing private resume upload below.
// Recruiter-only, like every other candidate write. No User is created or modified.
router.post(
  "/:jobId/candidates",
  authorize("RECRUITER"),
  validate(manualCandidateCreateSchema),
  jobController.addManualJobCandidate
);
router.delete("/:jobId/candidate-list", authorize("RECRUITER"), jobController.deleteJobCandidateList);

// --- Candidate references & resumes (Phase 7, Step 2) -----------------------
// The whitelist-seeded JobCandidateReference rows for ONE job, the recruiter
// edit overlay, the PDF/TXT resume upload + private stream, and the
// job-scoped candidate reference data. Reads allow ORG_ADMIN of the owning
// org (same as GET /:jobId/candidates); every reference write is recruiter-only, and
// ownership/organization scoping + (jobId, referenceId) resolution all happen
// in the service — a reference id from another job simply does not resolve.
// Phase 7 Step 5 exposes the recruiter-only manual analysis trigger and the
// recruiter/org-admin-safe analysis read beneath these job-scoped references.
//
// The resume upload reuses the SAME in-memory multer wrapper as the candidate
// list upload (field "file", 10 MB cap, { success, message } envelope); the
// PDF/TXT-only content rules are enforced in the service before any persistence.
router.get(
  "/:jobId/candidate-references",
  authorize("RECRUITER", "ORG_ADMIN"),
  jobCandidateReferenceController.listCandidateReferences
);
router.get(
  "/:jobId/candidate-references/:referenceId",
  authorize("RECRUITER", "ORG_ADMIN"),
  jobCandidateReferenceController.getCandidateReference
);
router.patch(
  "/:jobId/candidate-references/:referenceId",
  authorize("RECRUITER"),
  validate(candidateReferenceUpdateSchema),
  jobCandidateReferenceController.updateCandidateReference
);
router.post(
  "/:jobId/candidate-references/:referenceId/resume",
  authorize("RECRUITER"),
  receiveCandidateListUpload,
  jobCandidateReferenceController.uploadCandidateResume
);
router.get(
  "/:jobId/candidate-references/:referenceId/resume",
  authorize("RECRUITER", "ORG_ADMIN"),
  jobCandidateReferenceController.viewCandidateResume
);
// There is deliberately NO recruiter-initiated candidate-analysis POST here.
// Analysis is started by the SYSTEM the moment an assessment attempt reaches a
// terminal state (jobAssessmentAttempt.service -> runAutomaticCandidateAnalysis),
// so the recruiter surface stays read-only and cannot race that trigger. The only
// analysis route left is the status read below.
router.get(
  "/:jobId/candidate-references/:referenceId/analysis",
  authorize("RECRUITER", "ORG_ADMIN"),
  jobCandidateReferenceController.getCandidateAnalysis
);

router.post("/:jobId/start", authorize("RECRUITER"), jobController.startJob);
router.post("/:jobId/close", authorize("RECRUITER"), jobController.closeJob);

// --- AI workflow (recruiter actions, authorization via job ownership) -------
// Every route below is a free workflow action: viewing/editing clarification
// questions, continuing to assessment generation and CRUD over the generated
// assessment consume ZERO quota — only the existing Start flow consumes a job
// slot. Reads go through GET /:jobId (recruiter or ORG_ADMIN of their org);
// writes are recruiter-only, mirroring start/close.
router.patch(
  "/:jobId/clarification-questions",
  authorize("RECRUITER"),
  validate(clarificationQuestionsSchema),
  jobController.updateClarificationQuestions
);
router.post("/:jobId/clarifications/continue", authorize("RECRUITER"), jobController.continueClarifications);
router.patch(
  "/:jobId/assessment",
  authorize("RECRUITER"),
  validate(assessmentUpdateSchema),
  jobController.updateAssessment
);
router.post("/:jobId/assessment/finalize", authorize("RECRUITER"), jobController.finalizeAssessment);
router.delete("/:jobId/assessment", authorize("RECRUITER"), jobController.deleteAssessment);

// --- Candidate assessment status (Phase 3 read, wired in Phase 4) -----------
// The recruiter's persisted attempt lifecycle per candidate email for ONE owned
// job — status + the PERSISTED Phase 6 assessment score only (no answers, no
// question content, no answer keys). Same ownership model as GET /:jobId/
// candidates, and the exact projection the realtime candidate list reconciles
// against after every event.
router.get(
  "/:jobId/assessment/attempts",
  authorize("RECRUITER", "ORG_ADMIN"),
  jobAssessmentAttemptController.listJobCandidateAttempts
);

// --- Activation & invitations (recruiter actions) ----------------------------
// Activation is the recruiter's explicit confirmation that the FINALIZED
// assessment is open for invitations; only then may candidates be invited.
// Free workflow action (no quota), authenticated + job-owned.
router.post("/:jobId/assessment/activate", authorize("RECRUITER"), jobController.activateAssessment);

// THE invitation action. The recruiter clicks Invite on a row of THEIR OWN
// candidate list — the only place an invitation is ever created. The request
// carries just the row identity and NEVER an email: the backend re-resolves the
// address from persisted candidate data inside the authorized job, so no
// arbitrary address can be submitted as the authoritative identity. Both
// candidate-entry paths are served by this one route: an Excel-imported row is
// addressed by its stable sheet rowId, and a manually added candidate (which
// has no spreadsheet row) by its job-scoped candidate-referenceId. Same
// recruiter-only write policy, ownership model, activation preconditions and
// JobAssessmentInvitation system as before. Free action: no quota, no AiJob.
//
// There is deliberately NO email-list invitation route and no email-only
// invitation form anywhere in the product: a recruiter never types an address
// to invite someone.
router.post(
  "/:jobId/candidates/:candidateId/invite",
  authorize("RECRUITER"),
  jobController.inviteJobCandidate
);

// Verification report — ON-DEMAND recruiter read, triggered only by the
// "View Report" action on an IN SYSTEM row of the candidate table. The report
// is never pushed to the browser and never embedded in the list response.
// Read-only: ownership, (jobId, referenceId) resolution and the IN_SYSTEM
// requirement are enforced in the service; the response contains only the safe
// stored verification projection (no resume, no invitation/attempt data, no
// candidate analysis, no raw account rows).
router.get(
  "/:jobId/candidates/:referenceId/verification-report",
  authorize("RECRUITER", "ORG_ADMIN"),
  jobController.getCandidateVerificationReport
);

module.exports = router;
