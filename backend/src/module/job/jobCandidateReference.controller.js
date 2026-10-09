const fs = require("fs");
const jobCandidateReferenceService = require("./jobCandidateReference.service");
const { absolutePathFor } = require("../storage/storage.service");

// Same error envelope as job.controller.js ({ success, message }, contextual
// log line, generic 5xx body) — kept local because job.controller's mapper is
// module-private (thin-controller pattern used across this codebase).
const sendErrorResponse = (res, context, error) => {
  let status = error.status || 500;
  let message = error.message || "Something went wrong";

  if (error.code === "P2002") {
    status = 409;
    message = "This candidate already has an analysis in progress";
  } else if (error.code === "P2025") {
    status = 404;
    message = "Candidate reference not found";
  }

  if (status >= 500) {
    console.error(`[job] ${context}:`, error);
    message = "Something went wrong while processing your request";
  } else {
    console.error(`[job] ${context}: ${status} ${message}`);
  }

  return res.status(status).json({ success: false, message });
};

// GET /job/:jobId/candidate-references — the job's whitelist-seeded reference
// rows (with the upgrade-safe backfill). Ownership enforced in the service.
const listCandidateReferences = async (req, res) => {
  try {
    if (req.query?.projection === "analysis") {
      const identities = await jobCandidateReferenceService.listCandidateReferenceIdentities(
        req.user,
        req.params.jobId
      );
      return res.status(200).json({
        success: true,
        message: "Candidate reference identities retrieved successfully",
        data: identities,
      });
    }
    const references = await jobCandidateReferenceService.listCandidateReferences(
      req.user,
      req.params.jobId
    );

    return res.status(200).json({
      success: true,
      message: "Candidate references retrieved successfully",
      data: references,
    });
  } catch (error) {
    return sendErrorResponse(res, "listCandidateReferences", error);
  }
};

const getCandidateReference = async (req, res) => {
  try {
    const reference = await jobCandidateReferenceService.getCandidateReference(
      req.user,
      req.params.jobId,
      req.params.referenceId
    );

    return res.status(200).json({
      success: true,
      message: "Candidate reference retrieved successfully",
      data: reference,
    });
  } catch (error) {
    return sendErrorResponse(res, "getCandidateReference", error);
  }
};

// PATCH — recruiter edit overlay. The body was already validated by the strict
// candidateReferenceUpdateSchema (identity keys rejected, absent = skip,
// null = clear); the service maps only the whitelisted fields.
const updateCandidateReference = async (req, res) => {
  try {
    const reference = await jobCandidateReferenceService.updateCandidateReference(
      req.user,
      req.params.jobId,
      req.params.referenceId,
      req.body
    );

    return res.status(200).json({
      success: true,
      message: "Candidate reference updated successfully",
      data: reference,
    });
  } catch (error) {
    return sendErrorResponse(res, "updateCandidateReference", error);
  }
};

// POST — resume upload (PDF/TXT only, validated in the service BEFORE any
// persistence). Multipart field "file", same multer wrapper as the candidate
// list upload (10 MB cap, { success, message } error envelope).
const uploadCandidateResume = async (req, res) => {
  try {
    const result = await jobCandidateReferenceService.uploadCandidateResume(
      req.user,
      req.params.jobId,
      req.params.referenceId,
      req.file
    );

    return res.status(201).json({
      success: true,
      message: "Candidate resume uploaded successfully",
      data: result,
    });
  } catch (error) {
    return sendErrorResponse(res, "uploadCandidateResume", error);
  }
};

// GET — private resume stream. The service has already authorized the caller
// against the job and resolved the reference's StoredFile; this handler only
// maps that descriptor onto the response (mirrors storage.controller's
// sendFile: content headers + sendFile, missing disk content → 404).
const viewCandidateResume = async (req, res) => {
  try {
    const file = await jobCandidateReferenceService.openCandidateResume(
      req.user,
      req.params.jobId,
      req.params.referenceId
    );
    const filePath = absolutePathFor(file.storagePath);
    await fs.promises.access(filePath, fs.constants.R_OK);

    res.setHeader("Content-Type", file.mimeType);
    res.setHeader("Content-Length", file.fileSize);
    // Never let a browser MIME-sniff a stored resume (especially a .txt stream)
    // into something executable: the bytes are served exactly as typed, inline.
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${encodeURIComponent(file.originalName)}"`
    );
    return res.sendFile(filePath);
  } catch (error) {
    return sendErrorResponse(
      res,
      "viewCandidateResume",
      error.code === "ENOENT"
        ? Object.assign(new Error("File content is missing"), { status: 404 })
        : error
    );
  }
};

// There is no recruiter-triggered candidate-analysis handler: the SYSTEM starts
// analysis on the terminal assessment lifecycle, so nothing here may enqueue an
// AiJob. What remains is the read-only status read the dashboard reconciles
// against, served from the rows the automatic pipeline already persisted.
const getCandidateAnalysis = async (req, res) => {
  try {
    const rawVersion = req.query?.version;
    let version = null;
    if (rawVersion !== undefined && rawVersion !== "") {
      version = Number(rawVersion);
      if (!Number.isInteger(version) || version < 1) {
        return res.status(422).json({
          success: false,
          message: "Analysis version must be a positive integer",
        });
      }
    }
    const analysis = await jobCandidateReferenceService.getCandidateAnalysis(
      req.user,
      req.params.jobId,
      req.params.referenceId,
      version
    );
    return res.status(200).json({
      success: true,
      message: "Candidate analysis retrieved successfully",
      data: analysis,
    });
  } catch (error) {
    return sendErrorResponse(res, "getCandidateAnalysis", error);
  }
};

module.exports = {
  listCandidateReferences,
  getCandidateReference,
  updateCandidateReference,
  uploadCandidateResume,
  viewCandidateResume,
  getCandidateAnalysis,

};