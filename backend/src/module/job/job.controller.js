const jobService = require("./job.service");
const jobCandidateReferenceService = require("./jobCandidateReference.service");

const LIST_DEFAULT_LIMIT = 10;
const LIST_MAX_LIMIT = 50;

// Query params arrive as strings; clamp to sane bounds.
const parsePagination = (query) => {
  const page = Math.max(Number.parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(
    Math.max(Number.parseInt(query.limit, 10) || LIST_DEFAULT_LIMIT, 1),
    LIST_MAX_LIMIT
  );
  return { page, limit, skip: (page - 1) * limit, take: limit };
};

const sendErrorResponse = (res, context, error) => {
  let status = error.status || 500;
  let message = error.message || "Something went wrong";

  if (error.code === "P2002") {
    // Unique violation — e.g. case-variant duplicate names slipping past the
    // zod duplicate check into JobSkill/JobTool @@unique([jobId, name]).
    status = 409;
    message = "Duplicate skill or tool names are not allowed on a job";
  } else if (error.code === "P2025") {
    status = 404;
    message = "Job not found";
  }

  if (status >= 500) {
    console.error(`[job] ${context}:`, error);
    message = "Something went wrong while processing your request";
  } else {
    console.error(`[job] ${context}: ${status} ${message}`);
  }

  return res.status(status).json({ success: false, message });
};

const createJob = async (req, res) => {
  try {
    const job = await jobService.createDraft(req.user, req.body);

    return res.status(201).json({
      success: true,
      message: "Job draft created successfully",
      data: job,
    });
  } catch (error) {
    return sendErrorResponse(res, "createJob", error);
  }
};

const updateJob = async (req, res) => {
  try {
    const job = await jobService.updateDraft(req.user, req.params.jobId, req.body);

    return res.status(200).json({
      success: true,
      message: "Job draft updated successfully",
      data: job,
    });
  } catch (error) {
    return sendErrorResponse(res, "updateJob", error);
  }
};

const getJob = async (req, res) => {
  try {
    const job = await jobService.getJobForUser(req.user, req.params.jobId);

    return res.status(200).json({
      success: true,
      message: "Job retrieved successfully",
      data: job,
    });
  } catch (error) {
    return sendErrorResponse(res, "getJob", error);
  }
};

const listMyJobs = async (req, res) => {
  try {
    const pagination = parsePagination(req.query);
    const { jobs, total } = await jobService.listJobsForUser(req.user, pagination);

    return res.status(200).json({
      success: true,
      message: "Jobs retrieved successfully",
      data: jobs,
      pagination: {
        page: pagination.page,
        limit: pagination.limit,
        total,
        totalPages: Math.max(Math.ceil(total / pagination.limit), 1),
      },
    });
  } catch (error) {
    return sendErrorResponse(res, "listMyJobs", error);
  }
};

const listOrganizationJobs = async (req, res) => {
  try {
    const pagination = parsePagination(req.query);
    const { jobs, total } = await jobService.listOrganizationJobs(
      req.user,
      req.params.organizationId,
      pagination
    );

    return res.status(200).json({
      success: true,
      message: "Organization jobs retrieved successfully",
      data: jobs,
      pagination: {
        page: pagination.page,
        limit: pagination.limit,
        total,
        totalPages: Math.max(Math.ceil(total / pagination.limit), 1),
      },
    });
  } catch (error) {
    return sendErrorResponse(res, "listOrganizationJobs", error);
  }
};

const getRecruiterLimits = async (req, res) => {
  try {
    const limits = await jobService.getJobLimits(req.user);

    return res.status(200).json({
      success: true,
      message: "Job limits retrieved successfully",
      data: limits,
    });
  } catch (error) {
    return sendErrorResponse(res, "getRecruiterLimits", error);
  }
};

const getOrganizationLimits = async (req, res) => {
  try {
    const limits = await jobService.getOrganizationLimits(req.user, req.params.organizationId);

    return res.status(200).json({
      success: true,
      message: "Job limits retrieved successfully",
      data: limits,
    });
  } catch (error) {
    return sendErrorResponse(res, "getOrganizationLimits", error);
  }
};

const startJob = async (req, res) => {
  try {
    const result = await jobService.startJob(req.user, req.params.jobId);

    return res.status(200).json({
      success: true,
      message: "Job started successfully",
      data: result.job,
      // Stage 1: the durable AI record created in the same transaction as the
      // quota consumption. Its status is PENDING until a future worker stage
      // processes it; nothing is queued yet.
      aiJob: result.aiJob,
      limits: result.limits,
    });
  } catch (error) {
    return sendErrorResponse(res, "startJob", error);
  }
};

const closeJob = async (req, res) => {
  try {
    const job = await jobService.closeJobAsRecruiter(req.user, req.params.jobId);

    return res.status(200).json({
      success: true,
      message: "Job closed successfully",
      data: job,
    });
  } catch (error) {
    return sendErrorResponse(res, "closeJob", error);
  }
};

// Candidate Excel Sheet (draft attachment). The file arrives as multipart
// field "file" (validated by the multer wrapper in job.routes.js); the service
// parses/validates content BEFORE persisting anything, so a rejected file
// leaves no rows, no disk writes and — like every draft action — no quota
// change.
const uploadJobCandidateList = async (req, res) => {
  try {
    const candidateList = await jobService.uploadCandidateList(
      req.user,
      req.params.jobId,
      req.file
    );

    return res.status(201).json({
      success: true,
      message: "Candidate list uploaded successfully",
      data: candidateList,
    });
  } catch (error) {
    return sendErrorResponse(res, "uploadJobCandidateList", error);
  }
};

const deleteJobCandidateList = async (req, res) => {
  try {
    await jobService.deleteCandidateList(req.user, req.params.jobId);

    return res.status(200).json({
      success: true,
      message: "Candidate list removed successfully",
      data: { deleted: true },
    });
  } catch (error) {
    return sendErrorResponse(res, "deleteJobCandidateList", error);
  }
};

// Read-only compact preview of the job's candidate list (name + email, capped).
// GET /job/:jobId/candidate-list?limit= — no file body, no quota, no AiJob,
// no enqueue. Authorization is job ownership (RECRUITER); the stored file's
// storagePath is never returned to the client.
const getCandidateListPreview = async (req, res) => {
  try {
    const limit = req.query.limit != null ? Number(req.query.limit) : undefined;
    const preview = await jobService.getCandidateListPreview(
      req.user,
      req.params.jobId,
      limit
    );

    return res.status(200).json({
      success: true,
      data: preview,
    });
  } catch (error) {
    return sendErrorResponse(res, "getCandidateListPreview", error);
  }
};

// Recruiter candidate workflow — the job's persisted candidate list with the
// backend-authoritative IN SYSTEM / NOT IN SYSTEM classification and each
// candidate's EXISTING verified skill score (display only). Pure read: no
// verification is recalculated, no AI is called, no quota is consumed.
// Authorization is job ownership (RECRUITER / ORG_ADMIN of the owning org).
const listJobCandidates = async (req, res) => {
  try {
    const result = await jobService.listJobCandidates(req.user, req.params.jobId, {
      limit: req.query.limit,
    });

    return res.status(200).json({
      success: true,
      message: "Job candidates retrieved successfully",
      data: result,
    });
  } catch (error) {
    return sendErrorResponse(res, "listJobCandidates", error);
  }
};

// Manual candidate addition. The recruiter submits ONLY candidate fields (name,
// email, LinkedIn, GitHub, preferred role, skills, skill notes) — the strict
// route schema rejects any extra key, so a client-supplied status/classification
// is never an authority. The backend normalizes the address, persists the SAME
// job-scoped candidate reference an Excel row creates, and returns the SAME safe
// candidate DTO the list returns, carrying the classification the backend
// actually determined.
const addManualJobCandidate = async (req, res) => {
  try {
    const result = await jobCandidateReferenceService.addManualCandidateReference(
      req.user,
      req.params.jobId,
      req.body
    );

    return res.status(201).json({
      success: true,
      message: result.created
        ? result.candidate.systemStatus === "IN_SYSTEM"
          ? "Candidate added — the platform already has this candidate"
          : "Candidate added — this candidate is not yet in the platform"
        : "This candidate was already in the list — their existing details were kept",
      data: result,
    });
  } catch (error) {
    return sendErrorResponse(res, "addManualJobCandidate", error);
  }
};

// ---------------------------------------------------------------------------
// AI workflow: clarification questions → assessment → link
// ---------------------------------------------------------------------------

const updateClarificationQuestions = async (req, res) => {
  try {
    const result = await jobService.updateClarificationQuestions(req.user, req.params.jobId, req.body);

    return res.status(200).json({
      success: true,
      message: "Clarification questions updated successfully",
      data: result,
    });
  } catch (error) {
    return sendErrorResponse(res, "updateClarificationQuestions", error);
  }
};

const continueClarifications = async (req, res) => {
  try {
    const result = await jobService.continueClarifications(req.user, req.params.jobId);

    return res.status(202).json({
      success: true,
      message: "Clarification stage continued — assessment generation has been queued",
      data: result.job,
      aiJob: result.aiJob,
      clarificationsApprovedAt: result.clarificationsApprovedAt,
    });
  } catch (error) {
    return sendErrorResponse(res, "continueClarifications", error);
  }
};

const updateAssessment = async (req, res) => {
  try {
    const result = await jobService.updateAssessment(req.user, req.params.jobId, req.body);

    return res.status(200).json({
      success: true,
      message: "Assessment updated successfully",
      data: result.assessment,
    });
  } catch (error) {
    return sendErrorResponse(res, "updateAssessment", error);
  }
};

const deleteAssessment = async (req, res) => {
  try {
    await jobService.deleteAssessment(req.user, req.params.jobId);

    return res.status(200).json({
      success: true,
      message: "Assessment deleted successfully",
      data: { deleted: true },
    });
  } catch (error) {
    return sendErrorResponse(res, "deleteAssessment", error);
  }
};

const finalizeAssessment = async (req, res) => {
  try {
    const result = await jobService.finalizeAssessment(req.user, req.params.jobId);

    return res.status(200).json({
      success: true,
      message: "Assessment finalized — the assessment link is ready",
      data: result.assessment,
      finalized: result.finalized,
    });
  } catch (error) {
    return sendErrorResponse(res, "finalizeAssessment", error);
  }
};

// Candidate-facing read of a finalized assessment by its opaque public link
// segment. No authentication: the link is the capability, and the service
// returns only candidate-safe fields (no recruiter data, no AiJob internals).
const getAssessmentForCandidate = async (req, res) => {
  try {
    const assessment = await jobService.getAssessmentForCandidate(req.params.publicId);

    return res.status(200).json({
      success: true,
      message: "Assessment retrieved successfully",
      data: assessment,
    });
  } catch (error) {
    return sendErrorResponse(res, "getAssessmentForCandidate", error);
  }
};

// Recruiter ACTIVATE over a FINALIZED assessment — the "open for invitations"
// confirmation. Authenticated + job-owned; idempotent on repeat.
const activateAssessment = async (req, res) => {
  try {
    const result = await jobService.activateAssessment(req.user, req.params.jobId);

    return res.status(200).json({
      success: true,
      message: result.activated
        ? "Assessment activated — invitations are now enabled"
        : "Assessment is already active",
      data: result.assessment,
      activated: result.activated,
    });
  } catch (error) {
    return sendErrorResponse(res, "activateAssessment", error);
  }
};

// Candidate step 1: request the email-verification code for THIS assessment.
// Generic 403 on every failure path (never reveals which emails are invited).
const requestAssessmentEmailVerification = async (req, res) => {
  try {
    const result = await jobService.requestAssessmentEmailVerification(
      req.params.publicId,
      req.body.email
    );

    return res.status(200).json({
      success: true,
      message: result.alreadyVerified
        ? "This email is already verified"
        : "A verification code has been sent to this email",
      data: result,
    });
  } catch (error) {
    return sendErrorResponse(res, "requestAssessmentEmailVerification", error);
  }
};

// Candidate step 2: confirm the emailed code. Success flips the invitation to
// EMAIL_VERIFIED server-side. Generic 403 on every failure path.
const confirmAssessmentEmailVerification = async (req, res) => {
  try {
    const result = await jobService.confirmAssessmentEmailVerification(
      req.params.publicId,
      req.body.email,
      req.body.token
    );

    return res.status(200).json({
      success: true,
      message: "Email verified — you are authorized to proceed",
      data: result,
    });
  } catch (error) {
    return sendErrorResponse(res, "confirmAssessmentEmailVerification", error);
  }
};

// THE invitation action — the recruiter clicks Invite on one row of THEIR OWN
// candidate list. The request carries only the job id and that row's identity
// (an Excel row id for an imported row, or the job-scoped candidate-reference id
// for one added manually); the service resolves the email from persisted data
// itself, so the frontend can never submit an arbitrary address as the
// authoritative identity. There is no email-list variant of this endpoint by
// design. Authorization and the FINALIZED + ACTIVATED assessment preconditions
// are enforced in the service.
const inviteJobCandidate = async (req, res) => {
  try {
    const result = await jobService.inviteJobCandidate(
      req.user,
      req.params.jobId,
      req.params.candidateId
    );

    // Honest, duplicate-aware reporting. The re-invite branch deliberately says
    // "already sent" rather than implying a second email went out, and it never
    // calls the invitation email a "verification code" — the code belongs to the
    // separate, later verification email.
    const message =
      result.invitation.status === "EMAIL_VERIFIED"
        ? "Candidate is already email verified — no invitation email was needed"
        : result.emailSent
          ? result.invitationReactivated
            ? "Invitation window refreshed and a new invitation email was sent"
            : "Invitation sent"
          : result.emailSuppressedAsDuplicate
            ? "Candidate was already invited and already emailed — no duplicate invitation was created"
            : "Invitation is already in place — no email was needed";

    return res.status(200).json({
      success: true,
      message,
      data: result,
    });
  } catch (error) {
    return sendErrorResponse(res, "inviteJobCandidate", error);
  }
};

// Verification report read for ONE candidate of the recruiter's own job. Only
// identity params travel (jobId + referenceId): ownership, job-scoping of the
// reference and the IN_SYSTEM requirement are all enforced in the service, and
// the response carries only the safe stored verification projection.
const getCandidateVerificationReport = async (req, res) => {
  try {
    const report = await jobService.getCandidateVerificationReport(
      req.user,
      req.params.jobId,
      req.params.referenceId
    );

    return res.status(200).json({
      success: true,
      message: "Verification report retrieved successfully",
      data: report,
    });
  } catch (error) {
    return sendErrorResponse(res, "getCandidateVerificationReport", error);
  }
};

module.exports = {
  createJob,
  updateJob,
  getJob,
  listMyJobs,
  listOrganizationJobs,
  getRecruiterLimits,
  getOrganizationLimits,
  startJob,
  closeJob,
  uploadJobCandidateList,
  deleteJobCandidateList,
  getCandidateListPreview,
  listJobCandidates,
  addManualJobCandidate,
  updateClarificationQuestions,
  continueClarifications,
  updateAssessment,
  deleteAssessment,
  finalizeAssessment,
  getAssessmentForCandidate,
  activateAssessment,
  inviteJobCandidate,
  getCandidateVerificationReport,
  requestAssessmentEmailVerification,
  confirmAssessmentEmailVerification,
};
