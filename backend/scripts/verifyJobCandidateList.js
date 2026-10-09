/* eslint-disable no-console */
// Candidate-list verification harness: the REQUIRED Candidate Excel Sheet.
//
// Run with:  npm run verify:job-candidate-list
//
// Proves:
//   A. Parser contract — >1,000 candidates → reject; duplicate emails
//      (case-insensitive) → reject; missing/invalid emails → reject;
//      unreadable files → reject; 1..1,000 valid unique emails → accepted
//      with the exact candidate count.
//   B. Start ordering — VALIDATE EVERYTHING, then the transaction:
//      * without a candidate list, Start fails 400 and leaves the job DRAFT
//        with zero quota consumption and zero AiJob rows (nothing could have
//        reached BullMQ)
//      * with a valid list, Start consumes quota exactly once, creates the
//        AiJob PENDING and delivers it to BullMQ
//      * uploading/replacing/removing a candidate list never consumes quota
//      * rejected uploads create NO rows and NO disk files
//      * the association is DRAFT-only (409 once ACTIVE) and stays linked
//        to the job when it becomes ACTIVE
//   C. Preferred Number of Candidates (OPTIONAL top-N target) — persisted on
//      the Job, clearable, structurally validated (whole number, 1..1,000),
//      never a limit (a target above the uploaded count still Starts), and
//      free: no quota, no AiJob, no queue work, no change to the AI snapshot.
//
// Convention follows scripts/verifyAiJobStage1.js (CommonJS, the application's
// own Prisma client, process.exitCode on failure, throwaway fixtures tracked
// by id and deleted in FK-safe order, platform totals printed before/after).
require("dotenv").config();

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const XLSX = require("xlsx");

const prisma = require("../src/config/prisma");
const jobService = require("../src/module/job/job.service");
const { absolutePathFor } = require("../src/module/storage/storage.service");
const {
  MAX_CANDIDATES,
  CANDIDATE_LIST_MESSAGES,
  parseCandidateListBuffer,
} = require("../src/module/job/jobCandidateList.parser");
const {
  MAX_PREFERRED_CANDIDATES,
  updateDraftSchema,
} = require("../src/module/job/job.validation");

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const SUFFIX = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
// Isolate this run's BullMQ deliveries from real workers.
process.env.AI_QUEUE_PREFIX = `candlist-${SUFFIX}`;
const aiJobQueue = require("../src/module/ai-job/aiJob.queue");
const {
  buildCandidateWorkbook,
  cleanupJobCandidateLists,
  countCandidateListLeftovers,
} = require("./jobCandidateListFixture");

// --- reporting --------------------------------------------------------------

const results = [];

const section = (title) => console.log(`\n${title}`);

const check = (label, ok, detail) => {
  results.push({ label, ok: Boolean(ok) });
  const line = `  ${ok ? "PASS" : "FAIL"}  ${label}`;
  console.log(!ok && detail ? `${line}\n        -> ${detail}` : line);
};

const summarize = (value) => JSON.stringify(value ?? null);

// Asserts that `fn()` rejects with the given HTTP status and returns the error.
const expectRejection = async (label, fn, status) => {
  let error = null;
  try {
    await fn();
  } catch (caught) {
    error = caught;
  }

  if (!error) {
    check(label, false, `expected a rejection with HTTP ${status}, but the call resolved`);
    return null;
  }

  check(label, error.status === status, `expected HTTP ${status}, got ${error.status}: ${error.message}`);
  return error;
};

// Sync variant for the parser's thrown validation errors.
const expectMessage = (label, fn, messagePrefix) => {
  try {
    fn();
    check(label, false, "expected a rejection but the parse resolved");
  } catch (error) {
    check(
      label,
      error.status === 400 && error.message.startsWith(messagePrefix),
      `${error.status}: ${error.message}`
    );
  }
};

// --- fixtures ---------------------------------------------------------------

const tracked = { userIds: [], planIds: [], subscriptionIds: [], jobIds: [] };

// A payload that satisfies every existing Start rule in
// job.service.assertJobReadyToStart.
const READY_PAYLOAD = {
  title: "Senior Backend Engineer",
  yearsExperience: 7,
  description: "Own the billing platform end to end, including ledger correctness and payment integrations.",
  analysisDays: 4,
  skills: [
    { name: "Node.js", weight: 60 },
    { name: "PostgreSQL", weight: 40 },
  ],
  tools: [{ name: "Docker" }, { name: "GitHub Actions" }],
  questions: [
    { question: "Describe the most complex database transaction you have designed." },
    { question: "How do you investigate a slow production query?" },
  ],
};

// The job service only reads user.id and user.role from the authenticated
// principal (same shortcut as the Stage 1 harness — no UserRole row needed).
const createRecruiterFixture = async (label, jobPostingLimit) => {
  const user = await prisma.user.create({
    data: {
      fullName: `CandidateList Harness ${label}`,
      email: `candlist-${label}-${SUFFIX}@example.test`,
      provider: "LOCAL",
      emailVerified: true,
      status: "ACTIVE",
    },
  });

  const plan = await prisma.subscriptionPlan.create({
    data: {
      name: `CandidateList Harness Plan ${label} ${SUFFIX}`,
      type: "RECRUITER",
      price: 0,
      billingCycle: "MONTHLY",
      jobPostingLimit,
    },
  });

  const subscription = await prisma.subscription.create({
    data: {
      planId: plan.id,
      userId: user.id,
      status: "ACTIVE",
      startDate: new Date(),
      expiryDate: new Date(Date.now() + 30 * DAY_IN_MS),
    },
  });

  tracked.userIds.push(user.id);
  tracked.planIds.push(plan.id);
  tracked.subscriptionIds.push(subscription.id);

  return { user: { id: user.id, role: "RECRUITER" }, subscription };
};

const createDraftFixture = async (recruiter, payload = READY_PAYLOAD) => {
  const draft = await jobService.createDraft(recruiter.user, payload);
  tracked.jobIds.push(draft.id);
  return draft;
};

const countAiJobs = (jobId) => prisma.aiJob.count({ where: { jobId } });
const countConsumptions = (jobId) => prisma.jobQuotaConsumption.count({ where: { jobId } });

const uniqueEmails = (count, label) =>
  Array.from(
    { length: count },
    (_, index) =>
      `cand-${label}-${index}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`
  );

// Uploads through the production service path with a per-upload file name so
// the StoredFile assertions below can be scoped exactly.
const uploadList = async (recruiter, jobId, emails, name) =>
  jobService.uploadCandidateList(recruiter.user, jobId, {
    originalname: name ?? `candidates-${SUFFIX}.xlsx`,
    mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size: 0,
    buffer: buildCandidateWorkbook(emails),
  });

const buildSheet = (rows) => {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  return XLSX.write(
    { SheetNames: ["Candidates"], Sheets: { Candidates: sheet } },
    { type: "buffer", bookType: "xlsx" }
  );
};

const fileExistsOnDisk = async (storagePath) => {
  try {
    await fs.access(absolutePathFor(storagePath));
    return true;
  } catch {
    return false;
  }
};

// --- scenario A: parser contract (no database) ------------------------------

const scenarioParser = () => {
  section("A. Parser contract — limits, duplicate emails, structure");

  const three = parseCandidateListBuffer(buildCandidateWorkbook(uniqueEmails(3, "a1")));
  check(
    "a valid 3-candidate file parses with candidateCount 3",
    three.candidateCount === 3,
    summarize(three)
  );

  const exactly1000 = parseCandidateListBuffer(buildCandidateWorkbook(uniqueEmails(1000, "a2")));
  check("exactly 1,000 candidates is accepted", exactly1000.candidateCount === 1000, summarize(exactly1000));

  expectMessage(
    "1,001 candidates are rejected with the limit message",
    () => parseCandidateListBuffer(buildCandidateWorkbook(uniqueEmails(1001, "a3"))),
    CANDIDATE_LIST_MESSAGES.LIMIT
  );

  expectMessage(
    "duplicate emails (A@EMAIL.COM vs a@email.com) are rejected, not deduplicated",
    () => parseCandidateListBuffer(buildCandidateWorkbook(["A@email.com", "a@email.com", "b@email.com"])),
    CANDIDATE_LIST_MESSAGES.DUPLICATE
  );

  expectMessage(
    "a file without an 'Email' column is rejected",
    () => parseCandidateListBuffer(buildSheet([["Name"], ["someone"]])),
    CANDIDATE_LIST_MESSAGES.EMAIL_COLUMN
  );

  expectMessage(
    "a file with no candidate rows is rejected",
    () => parseCandidateListBuffer(buildSheet([["Email"]])),
    CANDIDATE_LIST_MESSAGES.EMPTY
  );

  expectMessage(
    "an unreadable file is rejected",
    () => parseCandidateListBuffer(Buffer.from("this is not an excel workbook")),
    CANDIDATE_LIST_MESSAGES.UNREADABLE
  );

  expectMessage(
    "a row without a valid email address is rejected",
    () => parseCandidateListBuffer(buildSheet([["Email"], ["not-an-email"]])),
    CANDIDATE_LIST_MESSAGES.EMAIL_INVALID
  );

  const flexible = parseCandidateListBuffer(buildSheet([["E-Mail Address"], ["flex@example.com"]]));
  check(
    "the Email column header is matched case/format-insensitively",
    flexible.candidateCount === 1,
    summarize(flexible)
  );

  const padded = parseCandidateListBuffer(
    buildSheet([
      ["Email", "Name"],
      ["pad@example.com", "Pad"],
      [null, null],
      [null, "   "],
    ])
  );
  check(
    "fully-empty rows are skipped, not counted as candidates",
    padded.candidateCount === 1,
    summarize(padded)
  );
};

// --- scenario B: Start gating (the quota contract) --------------------------

const scenarioStartGating = async (recruiter) => {
  section("B. Start gating — validate everything, then the transaction");

  const draft = await createDraftFixture(recruiter);

  const requiredError = await expectRejection(
    "Start without a candidate list is rejected with 400",
    () => jobService.startJob(recruiter.user, draft.id),
    400
  );
  check(
    "the rejection carries the recruiter-facing message",
    requiredError?.message === CANDIDATE_LIST_MESSAGES.REQUIRED,
    summarize(requiredError?.message)
  );
  const draftRow = await prisma.job.findUnique({ where: { id: draft.id } });
  check("the job stays DRAFT", draftRow?.status === "DRAFT", `status=${draftRow?.status}`);
  check("zero quota was consumed", (await countConsumptions(draft.id)) === 0);
  check(
    "zero AiJob rows were created (so nothing could reach BullMQ)",
    (await countAiJobs(draft.id)) === 0
  );

  const uploaded = await uploadList(recruiter, draft.id, uniqueEmails(1000, "b3"));
  check(
    "the 1,000-candidate upload is accepted",
    uploaded?.candidateCount === 1000,
    summarize({ count: uploaded?.candidateCount })
  );
  const association = await prisma.jobCandidateList.findUnique({
    where: { jobId: draft.id },
    include: { file: true },
  });
  check(
    "the upload is durably associated with the job (StoredFile category JOB_CANDIDATE_LIST)",
    Boolean(association) &&
      association.candidateCount === 1000 &&
      association.file?.category === "JOB_CANDIDATE_LIST",
    summarize({ id: association?.id, category: association?.file?.category })
  );
  check(
    "the uploaded file content exists in the shared storage root",
    await fileExistsOnDisk(association.file.storagePath)
  );
  check("uploading did not consume quota", (await countConsumptions(draft.id)) === 0);

  const started = await jobService.startJob(recruiter.user, draft.id);
  check(
    "Start succeeds once the candidate list is attached",
    started.job?.status === "ACTIVE" && started.aiJob?.status === "PENDING",
    summarize({ job: started.job?.status, aiJob: started.aiJob?.status })
  );
  check("quota was consumed exactly once, by Start", (await countConsumptions(draft.id)) === 1);
  const aiJob = await prisma.aiJob.findFirst({ where: { jobId: draft.id } });
  check("the AiJob is PENDING", aiJob?.status === "PENDING", `status=${aiJob?.status}`);
  const delivery = await aiJobQueue.findQueuedAiJob(aiJob.id);
  check("the AiJob was delivered to BullMQ", Boolean(delivery), summarize(delivery?.id));

  await expectRejection(
    "starting again is rejected with 409",
    () => jobService.startJob(recruiter.user, draft.id),
    409
  );

  await expectRejection(
    "replacing the candidate list after Start is rejected with 409",
    () => uploadList(recruiter, draft.id, uniqueEmails(2, "b6"), `b6-${SUFFIX}.xlsx`),
    409
  );
  await expectRejection(
    "removing the candidate list after Start is rejected with 409",
    () => jobService.deleteCandidateList(recruiter.user, draft.id),
    409
  );

  const detail = await jobService.getJobForUser(recruiter.user, draft.id);
  check(
    "the job detail exposes client-safe candidate-list metadata (no storagePath)",
    detail?.candidateList?.candidateCount === 1000 &&
      Boolean(detail.candidateList.file?.originalName) &&
      !("storagePath" in (detail.candidateList.file ?? {})),
    summarize(detail?.candidateList)
  );
};

// --- scenario C: upload validation & replace/remove lifecycle ---------------

const scenarioUploadValidation = async (recruiter) => {
  section("C. Upload validation — rejected files persist nothing; replace/remove");

  const draft = await createDraftFixture(recruiter);

  const limitError = await expectRejection(
    "uploading 1,001 candidates is rejected with 400",
    () => uploadList(recruiter, draft.id, uniqueEmails(1001, "c1"), `c1-${SUFFIX}.xlsx`),
    400
  );
  check(
    "the limit rejection carries the recruiter-facing message",
    limitError?.message === CANDIDATE_LIST_MESSAGES.LIMIT,
    summarize(limitError?.message)
  );
  check(
    "a rejected upload created no association row",
    (await prisma.jobCandidateList.count({ where: { jobId: draft.id } })) === 0
  );
  check(
    "a rejected upload created no StoredFile row",
    (await prisma.storedFile.count({ where: { originalName: `c1-${SUFFIX}.xlsx` } })) === 0
  );
  check("a rejected upload did not consume quota", (await countConsumptions(draft.id)) === 0);

  const duplicateError = await expectRejection(
    "uploading duplicate emails is rejected with 400",
    () =>
      uploadList(
        recruiter,
        draft.id,
        ["dup@Email.com", "DUP@email.com", "ok@example.com"],
        `c2-${SUFFIX}.xlsx`
      ),
    400
  );
  check(
    "the duplicate rejection carries the recruiter-facing message",
    Boolean(duplicateError?.message.startsWith(CANDIDATE_LIST_MESSAGES.DUPLICATE)),
    summarize(duplicateError?.message)
  );
  check(
    "still no association row after the duplicate rejection",
    (await prisma.jobCandidateList.count({ where: { jobId: draft.id } })) === 0
  );

  await uploadList(recruiter, draft.id, uniqueEmails(5, "c3a"), `c3a-${SUFFIX}.xlsx`);
  const first = await prisma.jobCandidateList.findUnique({
    where: { jobId: draft.id },
    include: { file: true },
  });
  check(
    "the first valid upload is accepted (5 candidates)",
    Boolean(first) && first.candidateCount === 5,
    summarize({ count: first?.candidateCount })
  );
  const second = await uploadList(recruiter, draft.id, uniqueEmails(3, "c3b"), `c3b-${SUFFIX}.xlsx`);
  check(
    "replacing the list updates the candidate count",
    second?.candidateCount === 3,
    summarize({ count: second?.candidateCount })
  );
  const afterReplace = await prisma.jobCandidateList.findUnique({
    where: { jobId: draft.id },
    include: { file: true },
  });
  check(
    "the association now points at the replacement file",
    afterReplace.fileId !== first.fileId &&
      afterReplace.file.originalName === `c3b-${SUFFIX}.xlsx`,
    summarize({ fileId: afterReplace.fileId, name: afterReplace.file.originalName })
  );
  check(
    "the replaced StoredFile row was deleted",
    (await prisma.storedFile.count({ where: { id: first.fileId } })) === 0
  );
  check(
    "the replaced file content was removed from disk",
    !(await fileExistsOnDisk(first.file.storagePath))
  );

  await jobService.deleteCandidateList(recruiter.user, draft.id);
  check(
    "removing the list deletes the association row",
    (await prisma.jobCandidateList.count({ where: { jobId: draft.id } })) === 0
  );
  check(
    "removing the list deletes the StoredFile row",
    (await prisma.storedFile.count({ where: { originalName: `c3b-${SUFFIX}.xlsx` } })) === 0
  );
  await expectRejection(
    "Start fails again after the list was removed",
    () => jobService.startJob(recruiter.user, draft.id),
    400
  );

  await uploadList(recruiter, draft.id, uniqueEmails(4, "c5"), `c5-${SUFFIX}.xlsx`);
  const started = await jobService.startJob(recruiter.user, draft.id);
  check(
    "the recruiter can fix the list and start successfully",
    started.job?.status === "ACTIVE" && (await countConsumptions(draft.id)) === 1,
    summarize({ job: started.job?.status })
  );
};

// --- scenario D: Preferred Number of Candidates (optional top-N target) -----
//
// The preference is draft data with very different semantics from the
// candidate-list ceiling: it is OPTIONAL, it is a prioritization TARGET (top-N
// by relevance later) and it never limits/deletes candidates. This scenario
// proves persistence, clearing, structural validation and — critically — that
// nothing about it touches quota, AiJob rows or the AI request snapshot.

const scenarioPreferredCandidateCount = async (recruiter) => {
  section("D. Preferred Number of Candidates — optional, persisted, free");

  // Omitted -> null.
  const omitted = await createDraftFixture(recruiter);
  const omittedRow = await prisma.job.findUnique({ where: { id: omitted.id } });
  check(
    "omitting the preference stores null and returns null",
    omittedRow?.preferredCandidateCount === null && omitted.preferredCandidateCount === null,
    summarize({ stored: omittedRow?.preferredCandidateCount, api: omitted.preferredCandidateCount })
  );

  // Provided on create.
  const withValue = await createDraftFixture(recruiter, {
    ...READY_PAYLOAD,
    preferredCandidateCount: 20,
  });
  check(
    "a draft created with a preferred number persists it",
    withValue.preferredCandidateCount === 20,
    summarize({ value: withValue.preferredCandidateCount })
  );
  check("setting it consumed no quota", (await countConsumptions(withValue.id)) === 0);
  check("setting it created no AiJob", (await countAiJobs(withValue.id)) === 0);

  // Update: set, clear, and leave-untouched semantics.
  const setLater = await jobService.updateDraft(recruiter.user, omitted.id, {
    preferredCandidateCount: 50,
  });
  check(
    "updateDraft sets the preferred number",
    setLater.preferredCandidateCount === 50,
    summarize({ value: setLater.preferredCandidateCount })
  );
  const cleared = await jobService.updateDraft(recruiter.user, omitted.id, {
    preferredCandidateCount: null,
  });
  check(
    "updateDraft clears it when sent as null",
    cleared.preferredCandidateCount === null,
    summarize({ value: cleared.preferredCandidateCount })
  );
  const untouched = await jobService.updateDraft(recruiter.user, withValue.id, {
    title: "Senior Backend Engineer (v2)",
  });
  check(
    "omitting it on update leaves the stored value untouched",
    untouched.preferredCandidateCount === 20,
    summarize({ value: untouched.preferredCandidateCount })
  );
  check(
    "draft edits of the preference consumed no quota",
    (await countConsumptions(omitted.id)) === 0 && (await countConsumptions(withValue.id)) === 0
  );

  // Structural validation (zod, the same schema the routes use).
  const invalidCases = [
    { value: 0, label: "zero" },
    { value: -5, label: "a negative value" },
    { value: 2.5, label: "a decimal" },
    { value: "abc", label: "a non-numeric value" },
    { value: "20", label: "a numeric string" },
    { value: MAX_PREFERRED_CANDIDATES + 1, label: "a value above the 1,000 ceiling" },
  ];
  for (const { value, label } of invalidCases) {
    const parsed = updateDraftSchema.safeParse({ preferredCandidateCount: value });
    check(
      `the draft schema rejects ${label}`,
      !parsed.success,
      parsed.success ? `accepted ${summarize(value)}` : undefined
    );
  }
  check(
    "the draft schema accepts an omitted value",
    updateDraftSchema.safeParse({}).success
  );
  check(
    "the draft schema accepts null (explicit no preference)",
    updateDraftSchema.safeParse({ preferredCandidateCount: null }).success
  );
  check(
    "the draft schema accepts the 1,000 ceiling itself",
    updateDraftSchema.safeParse({ preferredCandidateCount: MAX_PREFERRED_CANDIDATES }).success
  );

  // The preference is a TARGET, not a limit: 20 preferred over a 5-row list
  // must Start cleanly (the opposite of the candidate-list ceiling rule).
  const targetDraft = await createDraftFixture(recruiter, {
    ...READY_PAYLOAD,
    preferredCandidateCount: 20,
  });
  await uploadList(recruiter, targetDraft.id, uniqueEmails(5, "d5"), `d5-${SUFFIX}.xlsx`);
  const started = await jobService.startJob(recruiter.user, targetDraft.id);
  check(
    "a preference above the uploaded candidate count does not block Start",
    started.job?.status === "ACTIVE",
    summarize({ job: started.job?.status })
  );
  check(
    "that Start consumed quota exactly once (preference is not a limit)",
    (await countConsumptions(targetDraft.id)) === 1
  );
  const aiJob = await prisma.aiJob.findFirst({ where: { jobId: targetDraft.id } });
  check(
    "the preference survives into the ACTIVE job",
    (await prisma.job.findUnique({ where: { id: targetDraft.id } })).preferredCandidateCount === 20
  );
  check(
    "the AI request snapshot is unchanged by the preference (contract preserved)",
    Boolean(aiJob) && !("preferredCandidateCount" in (aiJob.requestPayload ?? {})),
    summarize(Object.keys(aiJob?.requestPayload ?? {}))
  );
};

// --- scenario E: candidate list preview (view + compact) ------------------

// --- scenario E: candidate list preview (view + compact) ------------------

const scenarioPreview = async (recruiter) => {
  section("E. Candidate list preview — view, compact, authorization, no quota");

  // A job with a small candidate list.
  const draft = await createDraftFixture(recruiter);
  const e1Emails = uniqueEmails(7, "e1");
  const small = await uploadList(recruiter, draft.id, e1Emails, `e1-${SUFFIX}.xlsx`);
  check(
    "the upload returns candidateCount 7",
    small.candidateCount === 7,
    summarize({ count: small.candidateCount })
  );

  // Read-only preview through the production API path.
  const preview = await jobService.getCandidateListPreview(recruiter.user, draft.id);
  check(
    "preview exposes fileName, candidateCount and rows",
    Boolean(preview.fileName) && preview.candidateCount === 7 && Array.isArray(preview.rows),
    summarize({ fileName: preview.fileName, candidateCount: preview.candidateCount, rowCount: preview.rows.length })
  );
  check(
    "preview rows carry name and email",
    preview.rows.every((row) => typeof row.name === "string" || row.name == null) &&
      preview.rows.every((row) => typeof row.email === "string"),
    summarize(preview.rows.slice(0, 2))
  );
  check(
    "preview returns the first 5 rows by default (compact card)",
    preview.rows.length === 5,
    summarize({ returned: preview.rows.length })
  );
  check(
    "preview rows are the first 5 candidates of the 7",
    preview.rows.every((row, index) => {
      const email = e1Emails[index];
      return row.email === email || (row.name != null && row.email === email);
    }),
    summarize({ rows: preview.rows.map((r) => r.email) })
  );

  // A 1,000-row file must NOT expose all 1,000 rows in the compact preview.
  const bigDraft = await createDraftFixture(recruiter);
  const bigEmails = uniqueEmails(1000, "e2");
  await uploadList(recruiter, bigDraft.id, bigEmails, `e2-${SUFFIX}.xlsx`);
  const bigPreview = await jobService.getCandidateListPreview(recruiter.user, bigDraft.id);
  check(
    "a 1,000-row file returns a compact 5-row preview, not all 1,000",
    bigPreview.candidateCount === 1000 && bigPreview.rows.length === 5,
    summarize({ candidateCount: bigPreview.candidateCount, rowsReturned: bigPreview.rows.length })
  );

  // The View modal reads the SAME file through the SAME endpoint with an
  // explicit ?limit=1000 — it must return the full list, not the compact 5.
  const fullView = await jobService.getCandidateListPreview(
    recruiter.user,
    bigDraft.id,
    MAX_CANDIDATES
  );
  check(
    "the View read (limit=1000) returns all 1,000 rows",
    fullView.candidateCount === 1000 && fullView.rows.length === 1000,
    summarize({ candidateCount: fullView.candidateCount, rowsReturned: fullView.rows.length })
  );
  check(
    "the View read returns the candidates in file order",
    fullView.rows[0]?.email === bigEmails[0] &&
      fullView.rows[999]?.email === bigEmails[999],
    summarize({ first: fullView.rows[0]?.email, last: fullView.rows[999]?.email })
  );
  check(
    "the View read created no AiJob and consumed no quota",
    (await countAiJobs(bigDraft.id)) === 0 && (await countConsumptions(bigDraft.id)) === 0,
    summarize({
      aiJobs: await countAiJobs(bigDraft.id),
      consumptions: await countConsumptions(bigDraft.id),
    })
  );

  // The limit query parameter caps rows.
  const capped = await jobService.getCandidateListPreview(recruiter.user, draft.id, 2);
  check(
    "the limit parameter caps returned rows",
    capped.rows.length === 2 && capped.candidateCount === 7,
    summarize({ rows: capped.rows.length, count: capped.candidateCount })
  );

  // Replace updates the preview.
  const replaced = await uploadList(recruiter, draft.id, uniqueEmails(3, "e3"), `e3-${SUFFIX}.xlsx`);
  const afterReplace = await jobService.getCandidateListPreview(recruiter.user, draft.id);
  check(
    "preview reflects the replacement file",
    afterReplace.candidateCount === 3 && afterReplace.fileName.endsWith(".xlsx"),
    summarize({ candidateCount: afterReplace.candidateCount, fileName: afterReplace.fileName })
  );

  // Delete removes the preview (no candidate list — getCandidateListPreview throws REQUIRED).
  await jobService.deleteCandidateList(recruiter.user, draft.id);
  const listsAfterDelete = await prisma.jobCandidateList.count({ where: { jobId: draft.id } });
  check(
    "deleting the list removes the association row",
    listsAfterDelete === 0,
    summarize({ lists: listsAfterDelete })
  );

  // Authorization: a different recruiter cannot preview another job's file.
  // Use a job that still HAS a candidate list so the ownership check is reached
  // (a job without a list throws REQUIRED first).
  const protectedJob = await createDraftFixture(recruiter);
  await uploadList(recruiter, protectedJob.id, uniqueEmails(2, "e-prot"), `e-prot-${SUFFIX}.xlsx`);
  const other = await createRecruiterFixture("other-preview", 5);
  await expectRejection(
    "a different recruiter cannot preview another job's candidate list",
    () => jobService.getCandidateListPreview(other.user, protectedJob.id),
    403
  );

  // Upload/replace/view/delete NEVER create an AiJob or consume quota.
  const fresh = await createDraftFixture(recruiter);
  await uploadList(recruiter, fresh.id, uniqueEmails(3, "e4"), `e4-${SUFFIX}.xlsx`);
  await jobService.getCandidateListPreview(recruiter.user, fresh.id);
  await jobService.deleteCandidateList(recruiter.user, fresh.id);
  check(
    "upload + preview + delete created no AiJob",
    (await countAiJobs(fresh.id)) === 0,
    summarize({ aiJobs: await countAiJobs(fresh.id) })
  );
  check(
    "upload + preview + delete consumed no quota",
    (await countConsumptions(fresh.id)) === 0,
    summarize({ consumptions: await countConsumptions(fresh.id) })
  );

  // One file per job at the database level: uploading a second file is a
  // REPLACE, not a second active association.
  await uploadList(recruiter, fresh.id, uniqueEmails(4, "e5a"), `e5a-${SUFFIX}.xlsx`);
  const afterFirst = await prisma.jobCandidateList.findUnique({
    where: { jobId: fresh.id },
    include: { file: true },
  });
  check(
    "a job has exactly one active candidate-list association after upload",
    Boolean(afterFirst) && afterFirst.candidateCount === 4,
    summarize({ candidateCount: afterFirst?.candidateCount })
  );
  const assocCountAfterFirst = await prisma.jobCandidateList.count({ where: { jobId: fresh.id } });
  check(
    "one job never has two active candidate-list rows",
    assocCountAfterFirst === 1,
    summarize({ associations: assocCountAfterFirst })
  );
  await uploadList(recruiter, fresh.id, uniqueEmails(6, "e5b"), `e5b-${SUFFIX}.xlsx`);
  const afterSecond = await prisma.jobCandidateList.findUnique({
    where: { jobId: fresh.id },
    include: { file: true },
  });
  check(
    "a replacement updates the single association (no second row)",
    Boolean(afterSecond) && afterSecond.candidateCount === 6,
    summarize({ candidateCount: afterSecond?.candidateCount })
  );
  const assocCountAfterSecond = await prisma.jobCandidateList.count({ where: { jobId: fresh.id } });
  check(
    "still exactly one association after replacement",
    assocCountAfterSecond === 1,
    summarize({ associations: assocCountAfterSecond })
  );
};


// --- cleanup & report --------------------------------------------------------

const snapshotTotals = async () => ({
  user: await prisma.user.count(),
  job: await prisma.job.count(),
  aiJob: await prisma.aiJob.count(),
  jobQuotaConsumption: await prisma.jobQuotaConsumption.count(),
  storedFile: await prisma.storedFile.count(),
  jobCandidateList: await prisma.jobCandidateList.count(),
});

// Deletes exactly what this harness created, in FK-safe order: candidate lists
// (JobCandidateList → StoredFile) before job rows (Restrict FKs), AiJob and
// JobQuotaConsumption before Job, Job before User. Scoped to tracked ids.
const cleanup = async () => {
  const removed = {};

  if (tracked.jobIds.length > 0) {
    const rows = await prisma.aiJob.findMany({
      where: { jobId: { in: tracked.jobIds } },
      select: { id: true },
    });
    for (const row of rows) {
      const delivery = await aiJobQueue.findQueuedAiJob(row.id);
      if (delivery) await delivery.remove();
    }
    Object.assign(removed, await cleanupJobCandidateLists(prisma, tracked.jobIds));
    removed.aiJob = (await prisma.aiJob.deleteMany({ where: { jobId: { in: tracked.jobIds } } })).count;
    removed.jobQuotaConsumption = (
      await prisma.jobQuotaConsumption.deleteMany({ where: { jobId: { in: tracked.jobIds } } })
    ).count;
    removed.job = (await prisma.job.deleteMany({ where: { id: { in: tracked.jobIds } } })).count;
  }
  if (tracked.subscriptionIds.length > 0) {
    removed.subscription = (
      await prisma.subscription.deleteMany({ where: { id: { in: tracked.subscriptionIds } } })
    ).count;
  }
  if (tracked.planIds.length > 0) {
    removed.subscriptionPlan = (
      await prisma.subscriptionPlan.deleteMany({ where: { id: { in: tracked.planIds } } })
    ).count;
  }
  if (tracked.userIds.length > 0) {
    removed.user = (await prisma.user.deleteMany({ where: { id: { in: tracked.userIds } } })).count;
  }

  return removed;
};

const countLeftovers = async () => {
  const [jobs, aiJobs, consumptions, subscriptions, plans, users] = await Promise.all([
    prisma.job.count({ where: { id: { in: tracked.jobIds } } }),
    prisma.aiJob.count({ where: { jobId: { in: tracked.jobIds } } }),
    prisma.jobQuotaConsumption.count({ where: { jobId: { in: tracked.jobIds } } }),
    prisma.subscription.count({ where: { id: { in: tracked.subscriptionIds } } }),
    prisma.subscriptionPlan.count({ where: { id: { in: tracked.planIds } } }),
    prisma.user.count({ where: { id: { in: tracked.userIds } } }),
  ]);

  return (
    jobs + aiJobs + consumptions + subscriptions + plans + users +
    (await countCandidateListLeftovers(prisma, tracked.jobIds))
  );
};

const finish = async (before) => {
  section("Cleanup — deleting every row this harness created");

  try {
    console.log(`  deleted: ${summarize(await cleanup())}`);
    check("no harness fixture row is left behind", (await countLeftovers()) === 0);
  } catch (error) {
    check("no harness fixture row is left behind", false, error.message);
  }

  const after = await snapshotTotals();
  console.log(`\nplatform totals at start: ${summarize(before)}`);
  console.log(`platform totals at end:   ${summarize(after)}`);
  check(
    "the database was not reset (every pre-existing row count held or grew)",
    Object.keys(before).every((table) => after[table] >= before[table]),
    summarize({ before, after })
  );

  const failed = results.filter((entry) => !entry.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);

  if (failed.length > 0) {
    console.log("FAILED CHECKS:");
    failed.forEach((entry) => console.log(`  - ${entry.label}`));
    process.exitCode = 1;
    return;
  }

  console.log(
    "Candidate list contract verified: required Excel sheet, <= 1,000 unique-email candidates, validated BEFORE quota."
  );
};

const run = async () => {
  console.log("Candidate list verification harness");
  console.log(`run id: ${SUFFIX}`);
  console.log(
    "contract: Candidate Excel Sheet REQUIRED at Start; <= 1,000 candidates; duplicate emails rejected; all validation BEFORE quota; preferred candidate count optional top-N target"
  );

  const before = await snapshotTotals();
  console.log(`platform totals at start: ${summarize(before)}`);

  try {
    scenarioParser();
    const recruiter = await createRecruiterFixture("main", 5);
    await scenarioStartGating(recruiter);
    await scenarioUploadValidation(recruiter);
    await scenarioPreferredCandidateCount(recruiter);
    await scenarioPreview(recruiter);
  } catch (error) {
    console.error("\nUNEXPECTED harness error:", error);
    check("every scenario ran without an unexpected error", false, error.message);
  } finally {
    await finish(before);
  }
};

run()
  .catch((error) => {
    console.error("Harness failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await aiJobQueue.closeAiJobQueue();
    await prisma.$disconnect();
  });
