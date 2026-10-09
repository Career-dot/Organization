/* eslint-disable no-console */
// Shared Candidate Excel Sheet fixture for the verification harnesses.
//
// Making the candidate list REQUIRED at Start means every harness that calls
// jobService.startJob needs a valid candidate list attached first. This module
// builds real .xlsx buffers with the `xlsx` package and attaches them through
// the production service path (jobService.uploadCandidateList), so the
// harnesses exercise the same upload/validation code the API uses — including
// the storage write and the JobCandidateList association.
//
// Cleanup contract: harnesses call cleanupJobCandidateLists(prisma, jobIds)
// BEFORE deleting job rows (the JobCandidateList.jobId FK is Restrict), and
// include countCandidateListLeftovers(...) in their leftover checks. Disk
// content removal is best effort; rows are always deleted first.
const XLSX = require("xlsx");
const jobService = require("../src/module/job/job.service");
const {
  removeStoredFileContent,
  removeEmptyStoredFileDirectory,
} = require("../src/module/storage/storage.service");

// Per-run label so leftover checks count ONLY files this harness run created
// (each harness process gets its own suffix, like the row fixtures do).
const HARNESS_CANDIDATE_FILE_LABEL = `harness-candidates-${Date.now()}-${Math.random()
  .toString(36)
  .slice(2, 8)}`;

// Builds an .xlsx buffer with a single "Email" column and one row per email.
const buildCandidateWorkbook = (emails) => {
  const sheet = XLSX.utils.aoa_to_sheet([["Email"], ...emails.map((email) => [email])]);
  return XLSX.write(
    { SheetNames: ["Candidates"], Sheets: { Candidates: sheet } },
    { type: "buffer", bookType: "xlsx" }
  );
};

const candidateEmail = (index) =>
  `stage-candidate-${index}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;

// Attaches a valid candidate list through the production upload path. The
// file shape mirrors what multer would deliver (buffer + original name + any
// mime); uploadCandidateList normalizes the mimetype from the extension.
const attachJobCandidateList = async (recruiter, jobId, { count = 2 } = {}) => {
  const emails = Array.from({ length: count }, (_, index) => candidateEmail(index));
  const buffer = buildCandidateWorkbook(emails);
  return jobService.uploadCandidateList(recruiter.user, jobId, {
    originalname: `${HARNESS_CANDIDATE_FILE_LABEL}.xlsx`,
    mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size: buffer.byteLength,
    buffer,
  });
};

// FK-safe removal of every candidate-list row, StoredFile row and disk file
// for the given jobs. MUST run before job deletion (jobId FK is Restrict).
const cleanupJobCandidateLists = async (prisma, jobIds) => {
  const removed = { jobCandidateList: 0, storedFile: 0 };
  if (jobIds.length === 0) {
    return removed;
  }
  const lists = await prisma.jobCandidateList.findMany({
    where: { jobId: { in: jobIds } },
    include: { file: { select: { id: true, storagePath: true } } },
  });
  if (lists.length === 0) {
    return removed;
  }
  const storagePaths = lists.map((row) => row.file?.storagePath).filter(Boolean);
  removed.jobCandidateList = (
    await prisma.jobCandidateList.deleteMany({ where: { jobId: { in: jobIds } } })
  ).count;
  removed.storedFile = (
    await prisma.storedFile.deleteMany({ where: { id: { in: lists.map((row) => row.fileId) } } })
  ).count;
  for (const storagePath of storagePaths) {
    try {
      await removeStoredFileContent(storagePath);
      await removeEmptyStoredFileDirectory(storagePath);
    } catch (error) {
      console.error(`  candidate list file cleanup issue: ${error.message}`);
    }
  }
  return removed;
};

// Leftover check for the cleanup assertion: candidate-list rows for the
// harness jobs plus any StoredFile this run's label created (catches orphaned
// files whose association row was already removed).
const countCandidateListLeftovers = async (prisma, jobIds) => {
  const [lists, files] = await Promise.all([
    jobIds.length === 0
      ? Promise.resolve(0)
      : prisma.jobCandidateList.count({ where: { jobId: { in: jobIds } } }),
    prisma.storedFile.count({
      where: {
        category: "JOB_CANDIDATE_LIST",
        originalName: `${HARNESS_CANDIDATE_FILE_LABEL}.xlsx`,
      },
    }),
  ]);
  return lists + files;
};

module.exports = {
  HARNESS_CANDIDATE_FILE_LABEL,
  buildCandidateWorkbook,
  candidateEmail,
  attachJobCandidateList,
  cleanupJobCandidateLists,
  countCandidateListLeftovers,
};
