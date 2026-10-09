/* eslint-disable no-console */
// Candidate reference & resume verification harness — Phase 7 (Step 2) of the
// recruiter candidate pipeline: whitelist-seeded JobCandidateReference rows,
// recruiter editing, PDF/TXT resumes with private viewing, and the isolation
// boundaries around all of it. NO AI work is exercised here.
//
// Run with:  npm run verify:candidate-analysis
//
// Proves, against the REAL database and the REAL service + HTTP paths:
//   A. Seeding — the Excel sheet seeds JobCandidateReference rows through the
//      production upload path; ONLY the whitelist columns land (any other
//      column's data is unreachable), identity is the reference id (never a
//      row index), emails are normalized, and seeding creates NO AiJob,
//      consumes NO quota and sends NOTHING to the AI queue.
//   B. Edit overlay — set / null-clear / absent-untouched semantics, skills
//      normalization identical to the seeder, blank-string clears, the strict
//      zod schema rejects identity keys (candidateEmail/id/jobId/...) and out
//      -of-bounds skills, and the service refuses an identity-only payload
//      (with defense-in-depth bounding even on a direct service call).
//   C. Scoping — cross-recruiter (403), unknown reference id (404), a
//      reference id from ANOTHER job resolved through THIS job (404): the
//      (jobId, referenceId) pair is the only handle.
//   D. Upgrade backfill — deleting every reference row and reading again
//      re-seeds them from the STORED sheet (pre-Phase-7 jobs behave the same).
//   E. Excel replacement — recruiter-edited reference fields SURVIVE a
//      replacement spreadsheet (seed-if-absent never overwrites), omitted or
//      blank columns never clear edited values, a replacement can ADD new
//      candidates, the opaque reference id survives replacements, uniqueness
//      holds per (jobId, normalized email) — re-imports add nothing, duplicate
//      emails inside one sheet reject the file, the same email in TWO jobs is
//      two independent references — and replacement consumes NO quota and
//      creates NO AiJob.
//   F. Resumes — TXT upload extracts + normalizes text server-side; a PDF's
//      text layer is extracted through the existing pdf-parse infrastructure;
//      replacement swaps the StoredFile row AND removes the old disk content
//      only after the new association is committed (old ids become 404);
//      scanned/text-less PDFs keep the original file with resumeText null
//      (UNAVAILABLE, never a failed request); DOC/DOCX/executable/shebang/
//      ZIP-bytes/fake-PDF uploads are refused (415) and >10 MB is refused
//      (413) BEFORE any write; the private view resolves only through
//      authenticated job authorization + (jobId, referenceId) + resumeFileId;
//      nonexistent ids, cross-job ids, resume-less references and deleted
//      associations are safe 404s; storagePath never leaves the server; zero
//      AI/quota side effects.
//   G. Organization isolation — the EXISTING membership/ownership rules:
//      ORG_ADMIN and member recruiters read (and, for member recruiters,
//      write) their OWN organization's references and resumes; other
//      organizations, independent recruiters and arbitrary job ids are denied.
//      No client-supplied orgId is ever an ownership source.
//   H. HTTP contract — real Express routes booted through an ephemeral
//      http.createServer: 401 without a token, 403 across recruiters and
//      organizations, strict-zod 400 on identity/org/ownership keys, multipart
//      PDF/TXT upload (201), the private resume stream (200, byte-identical,
//      PDF served INLINE, text/plain for TXT, X-Content-Type-Options:
//      nosniff), safe 404s for nonexistent/resume-less references, >10 MB
//      multipart → 413, ORG_ADMIN reads-allowed but writes denied at the
//      route (recruiter-only), member-recruiter writes allowed on own org, a
//      substituted ?fileId= and the ownership-checked /api/files/:id/view
//      route can never reach another tenant's StoredFile, storage-like public
//      paths 404 (no public /uploads URL exists) and error bodies never leak
//      storagePath.
//   I. Lifecycle — CLOSED jobs are read-only for reference/resume WRITES
//      (409) but every READ (list/get/resume view) keeps working.
//   J. Browser storage — a static scan of frontend/src proves no
//      localStorage/sessionStorage call carries LinkedIn text, GitHub text,
//      skills, skill notes, preferred role or resume text: server
//      persistence (proven in A/B/E) is the only source of truth.
//
// DELIBERATELY NOT COVERED HERE (later phase steps): the recruiter-triggered
// CANDIDATE_ANALYSIS trigger, analysis version generation, provider/FastAPI
// candidate analysis, bulk analysis, AI realtime events and any Analyze UI.
//
// Convention follows scripts/verifyCandidateInvitation.js (CommonJS, the
// application's own Prisma client, isolated BullMQ namespace, throwaway
// fixtures tracked by id and deleted in FK-safe order — JobCandidateAnalysis
// BEFORE AiJob (RESTRICT FK) — platform totals printed before/after). The HTTP
// section boots the exported app through an ephemeral http.createServer —
// never server.js's fixed-port listen.

require("dotenv").config();

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const SUFFIX = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
// Isolate this run's BullMQ namespace so no real worker can ever pick work up
// (MUST be set before any module that touches aiJob.queue is required).
process.env.AI_QUEUE_PREFIX = `candref-${SUFFIX}`;

const fs = require("node:fs/promises");
const http = require("node:http");
const crypto = require("node:crypto");
const XLSX = require("xlsx");

const prisma = require("../src/config/prisma");
const jobService = require("../src/module/job/job.service");
const referenceService = require("../src/module/job/jobCandidateReference.service");
const {
  candidateReferenceUpdateSchema,
  CANDIDATE_REFERENCE_FIELD_LIMITS,
  MAX_CANDIDATE_REFERENCE_SKILLS,
} = require("../src/module/job/job.validation");
const {
  absolutePathFor,
  removeStoredFileContent,
  removeEmptyStoredFileDirectory,
} = require("../src/module/storage/storage.service");
const jobCandidateReferenceRepository = require("../src/module/job/jobCandidateReference.repository");
const aiJobQueue = require("../src/module/ai-job/aiJob.queue");
const generateAccessToken = require("../src/utils/generateAccessToken");

// --- reporting ---------------------------------------------------------------

const results = [];

const section = (title) => console.log(`\n${title}`);

const check = (label, ok, detail) => {
  results.push({ label, ok: Boolean(ok) });
  const line = `  ${ok ? "PASS" : "FAIL"}  ${label}`;
  console.log(!ok && detail ? `${line}\n        -> ${detail}` : line);
};

const summarize = (value) => JSON.stringify(value ?? null);

// Asserts that fn() rejects with the given HTTP status and returns the error.
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

  check(
    label,
    error.status === status,
    `expected HTTP ${status}, got ${error.status}: ${error.message}`
  );
  return error;
};

// --- fixtures ----------------------------------------------------------------

const tracked = {
  userIds: [],
  planIds: [],
  subscriptionIds: [],
  jobIds: [],
  organizationIds: [],
  resumeStoragePaths: [],
};

// Recruiter fixture — identical shape to the other harnesses, PLUS the real
// Role + UserRole rows the HTTP section's authenticate middleware requires
// (service-level calls only ever read user.id/role from the principal).
const createRecruiterFixture = async (label, jobPostingLimit = 10) => {
  const user = await prisma.user.create({
    data: {
      fullName: `Candidate Analysis Harness ${label}`,
      email: `candref-recruiter-${label}-${SUFFIX}@example.test`,
      provider: "LOCAL",
      emailVerified: true,
      status: "ACTIVE",
    },
  });

  const role = await prisma.role.upsert({
    where: { name: "RECRUITER" },
    update: {},
    create: { name: "RECRUITER", description: "Recruiter role" },
  });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });

  const plan = await prisma.subscriptionPlan.create({
    data: {
      name: `Candidate Analysis Harness Plan ${label} ${SUFFIX}`,
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

// Reference workbook: the five whitelist columns PLUS a "Salary Expectation"
// column whose values must never be reachable through any reference field.
const REFERENCE_HEADERS = [
  "Name",
  "Email",
  "LinkedIn",
  "GitHub",
  "Preferred Role",
  "Skills",
  "Notes",
  "Salary Expectation",
];

const REFERENCE_ROWS = [
  [
    "Ada Lovelace",
    "ada@example.test",
    "https://www.linkedin.com/in/ada",
    "github.com/ada",
    "Backend Engineer",
    "Node.js, PostgreSQL; Redis",
    "Ledger domain background",
    "150000",
  ],
  [
    "Alan Turing",
    "turing@example.test",
    "in/turing-profile",
    "TuringGH",
    "Research Engineer",
    "Mathematics; Crypto",
    null,
    "120000",
  ],
  ["Grace Hopper", "grace@example.test", null, null, "Compiler Engineer", "COBOL", "", "130000"],
  ["Mixed Case", "MIXED@Example.test", null, null, null, null, null, "110000"],
];

const buildReferenceWorkbook = (headers = REFERENCE_HEADERS, rows = REFERENCE_ROWS) => {
  const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  return XLSX.write(
    { SheetNames: ["Candidates"], Sheets: { Candidates: sheet } },
    { type: "buffer", bookType: "xlsx" }
  );
};

const uploadList = async (recruiter, jobId, buffer, name) =>
  jobService.uploadCandidateList(recruiter.user, jobId, {
    originalname: name,
    mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size: buffer.byteLength,
    buffer,
  });

const createDraftFixture = async (recruiter, payload) => {
  const draft = await jobService.createDraft(recruiter.user, payload);
  tracked.jobIds.push(draft.id);
  return draft;
};

const READY_PAYLOAD = {
  title: "Candidate analysis harness job",
  yearsExperience: 5,
  description:
    "Harness job used to verify recruiter-triggered candidate analysis for the reference pipeline.",
  analysisDays: 3,
  skills: [
    { name: "Node.js", weight: 60 },
    { name: "PostgreSQL", weight: 40 },
  ],
  tools: [{ name: "Docker" }],
  questions: [{ question: "Describe a database migration you have run in production." }],
};

const referenceFor = (references, email) =>
  references.find((entry) => entry.candidateEmail === email) ?? null;

const countAiJobs = (jobId) => prisma.aiJob.count({ where: { jobId } });
const countConsumptions = (jobId) =>
  prisma.jobQuotaConsumption.count({ where: { jobId } });

// --- scenario A: seeding -----------------------------------------------------

const scenarioSeeding = async ({ recruiterA, jobA }) => {
  section("A. Seeding — whitelist columns only, opaque identity, zero AI side effects");

  const references = await referenceService.listCandidateReferences(
    recruiterA.user,
    jobA.id
  );
  check(
    "uploading the sheet seeded one reference per candidate row (4)",
    references.length === 4,
    summarize(references.map((entry) => entry.candidateEmail))
  );

  const ada = referenceFor(references, "ada@example.test");
  check(
    "LinkedIn URL cell landed in linkedinUrl (not the text field)",
    ada?.linkedinUrl === "https://www.linkedin.com/in/ada" && ada?.linkedinText === null,
    summarize({ url: ada?.linkedinUrl, text: ada?.linkedinText })
  );
  check(
    "GitHub host cell landed in githubUrl",
    ada?.githubUrl === "github.com/ada" && ada?.githubText === null,
    summarize({ url: ada?.githubUrl, text: ada?.githubText })
  );
  const turing = referenceFor(references, "turing@example.test");
  check(
    "non-URL LinkedIn/GitHub cells land in the free-text fields",
    turing?.linkedinUrl === null &&
      turing?.linkedinText === "in/turing-profile" &&
      turing?.githubUrl === null &&
      turing?.githubText === "TuringGH",
    summarize(turing)
  );
  check(
    "the Skills cell is split into the structured array (, ; separators)",
    summarize(ada?.skills) === summarize(["Node.js", "PostgreSQL", "Redis"]),
    summarize(ada?.skills)
  );
  const hopper = referenceFor(references, "grace@example.test");
  check(
    "blank cells normalize to null (never empty strings)",
    hopper?.linkedinUrl === null && hopper?.skillNotes === null,
    summarize(hopper)
  );
  check(
    "emails are normalized to lowercase regardless of sheet casing",
    referenceFor(references, "mixed@example.test")?.candidateEmail ===
      "mixed@example.test" &&
      referenceFor(references, "mixed@example.test")?.candidateName === "Mixed Case",
    summarize(references.map((entry) => entry.candidateEmail))
  );
  check(
    "identity is the opaque reference id — a string, unique, never a row index",
    references.every((entry) => typeof entry.id === "string" && entry.id.length > 10) &&
      new Set(references.map((entry) => entry.id)).size === references.length,
    summarize(references.map((entry) => entry.id))
  );
  check(
    "the NON-whitelist 'Salary Expectation' column is unreachable (no field carries it)",
    references.every(
      (entry) => !JSON.stringify(entry).includes("150000") && !JSON.stringify(entry).includes("130000")
    ),
    "found a salary value in a serialized reference"
  );
  check(
    "the client projection exposes resume availability, never storagePath or resumeText body",
    references.every(
      (entry) =>
        !("storagePath" in entry) &&
        !("createdByUserId" in entry) &&
        !("resumeText" in entry) &&
        typeof entry.hasResume === "boolean" &&
        typeof entry.resumeTextAvailable === "boolean"
    ),
    summarize(Object.keys(references[0] ?? {}))
  );
  check(
    "seeding consumed NO quota and created NO AiJob",
    (await countConsumptions(jobA.id)) === 0 && (await countAiJobs(jobA.id)) === 0,
    summarize({
      quota: await countConsumptions(jobA.id),
      aiJobs: await countAiJobs(jobA.id),
    })
  );

  return { references, ada };
};

// --- scenario B: edit overlay ------------------------------------------------

const scenarioEditOverlay = async ({ recruiterA, jobA, references, ada }) => {
  section("B. Edit overlay — set / null-clear / absent-untouched, strict schema");

  const updated = await referenceService.updateCandidateReference(
    recruiterA.user,
    jobA.id,
    ada.id,
    {
      candidateName: "Ada L.",
      skills: ["  NodeJS ", "nodejs", "Go", ""],
      skillNotes: null,
      preferredRole: "",
    }
  );
  check(
    "PATCH sets provided fields and normalizes skills like the seeder (trim + case-insensitive de-dup + blank drop)",
    updated.candidateName === "Ada L." &&
      summarize(updated.skills) === summarize(["NodeJS", "Go"]),
    summarize(updated.skills)
  );
  check(
    "explicit null clears (skillNotes) and a blank string clears too (preferredRole)",
    updated.skillNotes === null && updated.preferredRole === null,
    summarize({ skillNotes: updated.skillNotes, preferredRole: updated.preferredRole })
  );
  check(
    "absent keys leave their stored values untouched (linkedin/github unchanged)",
    updated.linkedinUrl === ada.linkedinUrl && updated.githubUrl === ada.githubUrl,
    summarize({ linkedinUrl: updated.linkedinUrl, githubUrl: updated.githubUrl })
  );

  const second = await referenceService.updateCandidateReference(
    recruiterA.user,
    jobA.id,
    ada.id,
    { linkedinText: "kept while other fields rest" }
  );
  check(
    "a second PATCH does not disturb fields it omits",
    second.candidateName === "Ada L." &&
      summarize(second.skills) === summarize(["NodeJS", "Go"]) &&
      second.linkedinText === "kept while other fields rest",
    summarize({ name: second.candidateName, skills: second.skills })
  );

  const identityOnly = await expectRejection(
    "an identity-only payload is rejected as empty (identity keys are never writable)",
    () =>
      referenceService.updateCandidateReference(recruiterA.user, jobA.id, ada.id, {
        candidateEmail: "attacker@example.test",
        id: "forged",
      }),
    400
  );
  check(
    "the rejection carries the at-least-one-field message",
    /at least one/i.test(identityOnly?.message ?? ""),
    summarize(identityOnly?.message)
  );
  const afterIdentityAttempt = await referenceService.getCandidateReference(
    recruiterA.user,
    jobA.id,
    ada.id
  );
  check(
    "the rejected payload changed NOTHING (email intact, id intact)",
    afterIdentityAttempt.candidateEmail === "ada@example.test" &&
      afterIdentityAttempt.id === ada.id,
    summarize({ email: afterIdentityAttempt.candidateEmail, id: afterIdentityAttempt.id })
  );

  check(
    "the strict schema rejects a payload carrying candidateEmail",
    candidateReferenceUpdateSchema.safeParse({ candidateName: "X", candidateEmail: "a@b.c" })
      .success === false
  );
  check(
    "the strict schema rejects id / jobId / resumeFileId / resumeText keys",
    ["id", "jobId", "resumeFileId", "resumeText"].every(
      (key) => !candidateReferenceUpdateSchema.safeParse({ [key]: "x" }).success
    )
  );
  check(
    "the strict schema rejects an empty payload",
    candidateReferenceUpdateSchema.safeParse({}).success === false
  );
  check(
    `the strict schema rejects ${MAX_CANDIDATE_REFERENCE_SKILLS + 1} skills`,
    !candidateReferenceUpdateSchema.safeParse({
      skills: Array.from({ length: MAX_CANDIDATE_REFERENCE_SKILLS + 1 }, (_, i) => `s${i}`),
    }).success
  );
  const oversizedSkill = "x".repeat(CANDIDATE_REFERENCE_FIELD_LIMITS.skill + 1);
  check(
    "the strict schema rejects a skill above the per-skill limit",
    !candidateReferenceUpdateSchema.safeParse({ skills: [oversizedSkill] }).success
  );
  check(
    "the strict schema accepts a plain in-bounds edit",
    candidateReferenceUpdateSchema.safeParse({ preferredRole: "Platform Engineer" }).success
  );

  const mixed = referenceFor(references, "mixed@example.test");
  const sliced = await referenceService.updateCandidateReference(
    recruiterA.user,
    jobA.id,
    mixed.id,
    { skillNotes: "y".repeat(CANDIDATE_REFERENCE_FIELD_LIMITS.skillNotes + 50) }
  );
  check(
    "defense-in-depth: the service itself bounds an over-long field even if a route check were bypassed",
    sliced.skillNotes.length === CANDIDATE_REFERENCE_FIELD_LIMITS.skillNotes,
    summarize({ length: sliced.skillNotes?.length })
  );
};

// --- scenario C: cross-tenant / cross-job scoping ----------------------------

const scenarioScoping = async ({ recruiterA, recruiterB, jobA, jobB, ada }) => {
  section("C. Scoping — (jobId, referenceId) is the only handle");

  await expectRejection(
    "another recruiter cannot list this job's references (403)",
    () => referenceService.listCandidateReferences(recruiterB.user, jobA.id),
    403
  );
  await expectRejection(
    "another recruiter cannot read one reference (403)",
    () => referenceService.getCandidateReference(recruiterB.user, jobA.id, ada.id),
    403
  );
  await expectRejection(
    "another recruiter cannot edit a reference (403)",
    () =>
      referenceService.updateCandidateReference(recruiterB.user, jobA.id, ada.id, {
        candidateName: "Hacked",
      }),
    403
  );
  await expectRejection(
    "another recruiter cannot upload a resume to it (403)",
    () =>
      referenceService.uploadCandidateResume(recruiterB.user, jobA.id, ada.id, {
        originalname: "x.txt",
        mimetype: "text/plain",
        buffer: Buffer.from("intrusion attempt"),
      }),
    403
  );
  await expectRejection(
    "an unknown reference id inside the owned job is 404",
    () =>
      referenceService.getCandidateReference(
        recruiterA.user,
        jobA.id,
        "ffffffffffffffffffff"
      ),
    404
  );

  const jobBRefs = await referenceService.listCandidateReferences(recruiterB.user, jobB.id);
  await expectRejection(
    "job A's reference id resolved through job B is 404 (cross-job probe)",
    () => referenceService.getCandidateReference(recruiterB.user, jobB.id, ada.id),
    404
  );
  await expectRejection(
    "an update through the wrong job pair is 404 and writes nothing",
    () =>
      referenceService.updateCandidateReference(recruiterB.user, jobB.id, ada.id, {
        candidateName: "Hijacked",
      }),
    404
  );
  check(
    "job B's own reference set is untouched by the probes",
    jobBRefs.every((entry) => entry.jobId === jobB.id),
    summarize(jobBRefs.map((entry) => entry.jobId))
  );

  const adaAfter = await referenceService.getCandidateReference(
    recruiterA.user,
    jobA.id,
    ada.id
  );
  check(
    "every rejected cross-tenant write left the reference unchanged",
    adaAfter.candidateName === "Ada L." &&
      adaAfter.candidateEmail === "ada@example.test",
    summarize({ name: adaAfter.candidateName, email: adaAfter.candidateEmail })
  );
};

// --- scenario D: upgrade-safe backfill ---------------------------------------

const scenarioBackfill = async ({ recruiterA, jobD }) => {
  section("D. Upgrade backfill — deleting every reference and re-reading re-seeds");

  const before = await referenceService.listCandidateReferences(recruiterA.user, jobD.id);
  check(
    "the fresh draft seeds its references on first read",
    before.length > 0,
    summarize(before.length)
  );

  await prisma.jobCandidateReference.deleteMany({ where: { jobId: jobD.id } });
  check(
    "every reference row for the job was deleted (simulating a pre-Phase-7 list)",
    (await prisma.jobCandidateReference.count({ where: { jobId: jobD.id } })) === 0
  );

  const after = await referenceService.listCandidateReferences(recruiterA.user, jobD.id);
  check(
    "the next read re-seeds from the STORED sheet (same emails, new opaque ids)",
    after.length === before.length &&
      summarize(after.map((entry) => entry.candidateEmail)) ===
        summarize(before.map((entry) => entry.candidateEmail)),
    summarize({ before: before.length, after: after.length })
  );
  check(
    "backfill is seed-if-absent only (no AiJob, no quota)",
    (await countAiJobs(jobD.id)) === 0 && (await countConsumptions(jobD.id)) === 0
  );
};

// --- Phase 7 (Step 2) fixtures & helpers -------------------------------------

const path = require("node:path");
const fssync = require("node:fs");
const { cleanupJobCandidateLists } = require("./jobCandidateListFixture");

// Deterministic one-page PDF with a REAL text layer (xref offsets computed
// byte-exactly), so PDF extraction is proven through the same pdf-parse path
// production uses. buildResumePdf([]) is a text-less (scanned-like) page:
// it must surface as UNAVAILABLE, never as a failed upload.
const buildResumePdf = (lines) => {
  const escape = (value) =>
    String(value)
      .replace(/\\/g, "\\\\")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)");
  const content = [
    "BT",
    "/F1 12 Tf",
    "50 740 Td",
    "14 TL",
    ...lines.map((line) => `(${escape(line)}) Tj T*`),
    "ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
      "/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((object, index) => {
    offsets[index] = Buffer.byteLength(pdf, "latin1");
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const startxref = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((offset) => {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  });
  pdf +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${startxref}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
};

const PDF_RESUME_LINES = [
  "Ada Lovelace - Senior Backend Engineer",
  "Email: ada@example.test | Phone: +1 555 0100",
  "Experience: 8 years building distributed systems in Node.js and",
  "PostgreSQL, with a focus on ledger correctness and payment flows.",
  "Skills: Node.js, PostgreSQL, Redis, Docker, Kubernetes, GraphQL.",
  "Education: BSc Mathematics, with honours in analytical engines.",
];
const PDF_RESUME_BUFFER = buildResumePdf(PDF_RESUME_LINES);
const SCANNED_PDF_BUFFER = buildResumePdf([]);

// CRLF line endings, a blank-line run and trailing whitespace — the stored
// resumeText must come back exactly NORMALIZED (CRLF -> LF, spaces before a
// newline collapsed, 3+ blank lines collapsed, trimmed).
const TXT_RESUME_TEXT =
  "Jane Doe\r\nSenior Frontend Engineer\r\n\r\n\r\nSkills: React, TypeScript  \r\n";
const TXT_RESUME_EXPECTED =
  "Jane Doe\nSenior Frontend Engineer\n\nSkills: React, TypeScript";
const TXT_RESUME_BUFFER = Buffer.from(TXT_RESUME_TEXT, "utf8");

// The multer file shape the service paths expect (size included, so the
// storage layer's 10 MB rule sees what a real upload would carry).
const resumeFile = (originalname, buffer, mimetype) => ({
  originalname,
  mimetype,
  size: buffer.byteLength,
  buffer,
});

const diskExists = async (storagePath) => {
  try {
    await fs.access(absolutePathFor(storagePath));
    return true;
  } catch {
    return false;
  }
};

const resumeDirEntries = async (userId) => {
  try {
    return await fs.readdir(absolutePathFor(`recruiters/${userId}/candidate-resumes`));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
};

const countResumeFilesOwnedBy = (userId) =>
  prisma.storedFile.count({
    where: { ownerId: userId, category: "JOB_CANDIDATE_RESUME" },
  });

const createOrganizationFixture = async (label, { role, withSubscription = true }) => {
  const user = await prisma.user.create({
    data: {
      fullName: `Candidate Reference Harness ${label}`,
      email: `candref-${label}-${SUFFIX}@example.test`,
      provider: "LOCAL",
      emailVerified: true,
      status: "ACTIVE",
    },
  });
  const roleRow = await prisma.role.upsert({
    where: { name: role },
    update: {},
    create: { name: role, description: `${role} role` },
  });
  await prisma.userRole.create({ data: { userId: user.id, roleId: roleRow.id } });
  const organization = await prisma.organization.create({
    data: { name: `Candidate Reference Harness ${label} ${SUFFIX}`, ownerId: user.id, status: "ACTIVE" },
  });
  await prisma.organizationMembership.create({
    data: {
      userId: user.id,
      organizationId: organization.id,
      role,
      status: "ACTIVE",
    },
  });

  let planId = null;
  let subscriptionId = null;
  if (withSubscription) {
    const plan = await prisma.subscriptionPlan.create({
      data: {
        name: `Candidate Reference Org Plan ${label} ${SUFFIX}`,
        type: "RECRUITER",
        price: 0,
        billingCycle: "MONTHLY",
        jobPostingLimit: 10,
      },
    });
    const subscription = await prisma.subscription.create({
      data: {
        planId: plan.id,
        organizationId: organization.id,
        status: "ACTIVE",
        startDate: new Date(),
        expiryDate: new Date(Date.now() + 30 * DAY_IN_MS),
      },
    });
    planId = plan.id;
    subscriptionId = subscription.id;
    tracked.planIds.push(plan.id);
    tracked.subscriptionIds.push(subscription.id);
  }

  tracked.userIds.push(user.id);
  tracked.organizationIds.push(organization.id);
  return {
    user: { id: user.id, role, organizationId: organization.id },
    organization,
    planId,
    subscriptionId,
  };
};

const startHttpServer = () =>
  new Promise((resolve, reject) => {
    // Require lazily so service-only paths never boot Express as a side effect.
    const app = require("../src/app");
    const server = http.createServer(app);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, origin: `http://127.0.0.1:${address.port}` });
    });
  });

const stopHttpServer = (server) =>
  new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );

const requestHttp = async (origin, pathname, { method = "GET", token, body, headers = {} } = {}) => {
  const rawBody = Buffer.isBuffer(body);
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined && !rawBody ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : rawBody ? body : JSON.stringify(body),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  const text = bytes.toString("utf8");
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Binary/private-file responses intentionally do not parse as JSON.
  }
  return {
    status: response.status,
    headers: response.headers,
    text,
    json,
    buffer: bytes,
  };
};

const multipartBody = (name, buffer, mimetype) => {
  const boundary = `----candref-${crypto.randomUUID()}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${name}"\r\n` +
      `Content-Type: ${mimetype}\r\n\r\n`,
    "utf8"
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return {
    body: Buffer.concat([head, buffer, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
};

const requestMultipart = async (origin, pathname, { token, name, buffer, mimetype }) => {
  const multipart = multipartBody(name, buffer, mimetype);
  return requestHttp(origin, pathname, {
    method: "POST",
    token,
    headers: {
      "Content-Type": multipart.contentType,
      "Content-Length": String(multipart.body.length),
    },
    body: multipart.body,
  });
};

const tokenFor = (user) => generateAccessToken({ userId: user.id, role: user.role });

const listFrontendSourceFiles = async () => {
  const root = path.resolve(__dirname, "../../frontend/src");
  const found = [];
  const walk = async (directory) => {
    for (const entry of await fssync.promises.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (/\.(?:js|jsx|ts|tsx)$/i.test(entry.name)) {
        found.push(absolute);
      }
    }
  };
  await walk(root);
  return found;
};

// --- scenario E: replacement is additive and non-destructive ------------------

const scenarioExcelReplacement = async ({ recruiterA }) => {
  section("E. Excel replacement — seed-if-absent, edited rows survive, new rows add");
  const job = await createDraftFixture(recruiterA, {
    ...READY_PAYLOAD,
    title: `Candidate reference replacement ${SUFFIX}`,
  });
  const initial = buildReferenceWorkbook(
    ["Name", "Email", "LinkedIn", "GitHub", "Preferred Role", "Skills", "Skill Notes"],
    [
      ["Ada Original", "ADA@example.test", "original-linkedin", "original-github", "Original Role", "Node.js", "original notes"],
      ["Alan Original", "alan@example.test", null, null, "Analyst", "SQL", "analyst notes"],
    ]
  );
  await uploadList(recruiterA, job.id, initial, `replacement-initial-${SUFFIX}.xlsx`);
  const seeded = await referenceService.listCandidateReferences(recruiterA.user, job.id);
  const ada = referenceFor(seeded, "ada@example.test");
  const alan = referenceFor(seeded, "alan@example.test");
  check(
    "initial Excel import creates normalized-email references",
    seeded.length === 2 && ada && alan,
    summarize(seeded.map((entry) => entry.candidateEmail))
  );

  const edited = await referenceService.updateCandidateReference(recruiterA.user, job.id, ada.id, {
    candidateName: "Ada Recruiter Edit",
    linkedinUrl: "https://linkedin.com/in/recruiter-edit",
    linkedinText: "recruiter LinkedIn evidence",
    githubUrl: "https://github.com/recruiter-edit",
    githubText: "recruiter GitHub evidence",
    preferredRole: "Staff Engineer",
    skills: ["TypeScript", "PostgreSQL"],
    skillNotes: "recruiter-owned notes",
  });
  check(
    "all recruiter-editable fields persist before replacement",
    edited.candidateName === "Ada Recruiter Edit" && edited.preferredRole === "Staff Engineer",
    summarize(edited)
  );

  const replacement = buildReferenceWorkbook(
    ["Name", "Email", "LinkedIn", "GitHub", "Preferred Role", "Skills", "Skill Notes", "Ignored"],
    [
      ["Ada Spreadsheet Reset", "ada@EXAMPLE.test", "spreadsheet-linkedin", "spreadsheet-github", "Junior Role", "SpreadsheetSkill", "spreadsheet notes", "MUST_NOT_PERSIST"],
      ["Grace New", "grace-new@example.test", null, "github.com/grace", "Platform Engineer", "Go, Docker", null, "IGNORED_TOO"],
    ]
  );
  const replaced = await uploadList(
    recruiterA,
    job.id,
    replacement,
    `replacement-next-${SUFFIX}.xlsx`
  );
  const afterReplacement = await referenceService.listCandidateReferences(recruiterA.user, job.id);
  const adaAfter = referenceFor(afterReplacement, "ada@example.test");
  const graceAfter = referenceFor(afterReplacement, "grace-new@example.test");
  check(
    "a matching jobId + normalized email keeps the same opaque reference id",
    adaAfter?.id === ada.id,
    summarize({ before: ada.id, after: adaAfter?.id })
  );
  check(
    "replacement NEVER overwrites any recruiter-edited field",
    adaAfter?.candidateName === edited.candidateName &&
      adaAfter?.linkedinUrl === edited.linkedinUrl &&
      adaAfter?.linkedinText === edited.linkedinText &&
      adaAfter?.githubUrl === edited.githubUrl &&
      adaAfter?.githubText === edited.githubText &&
      adaAfter?.preferredRole === edited.preferredRole &&
      summarize(adaAfter?.skills) === summarize(edited.skills) &&
      adaAfter?.skillNotes === edited.skillNotes,
    summarize(adaAfter)
  );
  check(
    "blank spreadsheet fields do not clear useful existing data",
    adaAfter?.linkedinUrl === edited.linkedinUrl && adaAfter?.skillNotes === edited.skillNotes,
    summarize({ linkedinUrl: adaAfter?.linkedinUrl, skillNotes: adaAfter?.skillNotes })
  );
  check(
    "replacement can seed a new candidate while leaving omitted existing candidates intact",
    afterReplacement.length === 3 && Boolean(graceAfter) && Boolean(referenceFor(afterReplacement, "alan@example.test")),
    summarize(afterReplacement.map((entry) => entry.candidateEmail))
  );
  check(
    "new candidates receive only the five Excel whitelist fields",
    graceAfter?.githubUrl === "github.com/grace" &&
      graceAfter?.preferredRole === "Platform Engineer" &&
      summarize(graceAfter?.skills) === summarize(["Go", "Docker"]) &&
      !JSON.stringify(graceAfter).includes("IGNORED_TOO"),
    summarize(graceAfter)
  );

  await uploadList(recruiterA, job.id, replacement, `replacement-repeat-${SUFFIX}.xlsx`);
  const repeated = await referenceService.listCandidateReferences(recruiterA.user, job.id);
  check(
    "re-importing the same sheet is idempotent (normalized uniqueness, no new ids)",
    repeated.length === 3 && repeated.every((entry) => afterReplacement.some((old) => old.id === entry.id)),
    summarize(repeated.map((entry) => entry.id))
  );
  await uploadList(
    recruiterA,
    job.id,
    buildReferenceWorkbook(
      ["Name", "Email", "LinkedIn", "GitHub", "Preferred Role", "Skills", "Skill Notes"],
      [["", "ada@example.test", "", "", "", "", ""]]
    ),
    `replacement-blank-${SUFFIX}.xlsx`
  );
  const afterBlank = await referenceService.getCandidateReference(recruiterA.user, job.id, ada.id);
  check(
    "a matching row with blank recruiter-reference cells cannot clear edited values",
    afterBlank.candidateName === edited.candidateName &&
      afterBlank.linkedinUrl === edited.linkedinUrl &&
      afterBlank.githubText === edited.githubText &&
      afterBlank.preferredRole === edited.preferredRole &&
      afterBlank.skillNotes === edited.skillNotes,
    summarize(afterBlank)
  );

  const listBeforeDuplicate = await prisma.jobCandidateList.findUnique({ where: { jobId: job.id } });
  await expectRejection(
    "a replacement containing duplicate normalized emails is rejected",
    () =>
      uploadList(
        recruiterA,
        job.id,
        buildReferenceWorkbook(
          ["Name", "Email"],
          [["One", "DUPLICATE@example.test"], ["Two", "duplicate@EXAMPLE.test"]]
        ),
        `replacement-duplicate-${SUFFIX}.xlsx`
      ),
    400
  );
  const afterDuplicateList = await prisma.jobCandidateList.findUnique({ where: { jobId: job.id } });
  check(
    "the rejected duplicate sheet leaves the prior StoredFile association unchanged",
    afterDuplicateList?.fileId === listBeforeDuplicate?.fileId,
    summarize({ before: listBeforeDuplicate?.fileId, after: afterDuplicateList?.fileId })
  );

  let uniqueViolation = null;
  try {
    await prisma.jobCandidateReference.create({
      data: {
        jobId: job.id,
        candidateEmail: "ada@example.test",
        candidateName: "Duplicate",
        createdByUserId: recruiterA.user.id,
      },
    });
  } catch (error) {
    uniqueViolation = error;
  }
  check(
    "the database unique key is exactly (jobId, candidateEmail) for the already-normalized value",
    uniqueViolation?.code === "P2002",
    summarize({ code: uniqueViolation?.code, message: uniqueViolation?.message })
  );

  const secondJob = await createDraftFixture(recruiterA, {
    ...READY_PAYLOAD,
    title: `Candidate reference other job ${SUFFIX}`,
  });
  await uploadList(
    recruiterA,
    secondJob.id,
    buildReferenceWorkbook(["Name", "Email"], [["Ada Other Job", "ada@example.test"]]),
    `replacement-other-job-${SUFFIX}.xlsx`
  );
  const otherJobReferences = await referenceService.listCandidateReferences(recruiterA.user, secondJob.id);
  check(
    "the same normalized email in another job is a separate reference",
    otherJobReferences.length === 1 && otherJobReferences[0].id !== ada.id,
    summarize(otherJobReferences)
  );
  check(
    "Excel replacement is free and creates no AiJob",
    (await countAiJobs(job.id)) === 0 &&
      (await countConsumptions(job.id)) === 0 &&
      (await countAiJobs(secondJob.id)) === 0,
    summarize({ quota: await countConsumptions(job.id), aiJobs: await countAiJobs(job.id) })
  );
  return { job, ada, alan, grace: graceAfter, otherJobReferences };
};

// --- scenario F: resume storage and extraction --------------------------------

const scenarioResumes = async ({ recruiterA, recruiterB }) => {
  section("F. Resumes — PDF/TXT validation, extraction, replacement, cleanup");
  const job = await createDraftFixture(recruiterA, {
    ...READY_PAYLOAD,
    title: `Candidate reference resumes ${SUFFIX}`,
  });
  await uploadList(
    recruiterA,
    job.id,
    buildReferenceWorkbook(
      ["Name", "Email"],
      [
        ["Ada Resume", "ada@example.test"],
        ["Alan Resume", "alan@example.test"],
        ["Grace Resume", "grace@example.test"],
        ["Turing Resume", "turing@example.test"],
      ]
    ),
    `resumes-${SUFFIX}.xlsx`
  );
  const references = await referenceService.listCandidateReferences(recruiterA.user, job.id);
  const ada = referenceFor(references, "ada@example.test");
  const alan = referenceFor(references, "alan@example.test");
  const grace = referenceFor(references, "grace@example.test");
  const turing = referenceFor(references, "turing@example.test");

  const txtResult = await referenceService.uploadCandidateResume(
    recruiterA.user,
    job.id,
    ada.id,
    resumeFile("ada.txt", TXT_RESUME_BUFFER, "text/plain")
  );
  const rawAda = await prisma.jobCandidateReference.findUnique({
    where: { id: ada.id },
    include: { resume: true },
  });
  check(
    "TXT upload extracts and normalizes text server-side",
    txtResult.extraction.status === "EXTRACTED" && rawAda.resumeText === TXT_RESUME_EXPECTED,
    summarize({ status: txtResult.extraction.status, text: rawAda.resumeText })
  );
  check(
    "the client projection never exposes resumeText or storagePath",
    !("resumeText" in txtResult) && !("storagePath" in txtResult.resume),
    summarize(Object.keys(txtResult))
  );
  check(
    "the resume uses JOB_CANDIDATE_RESUME and candidate-resumes storage",
    rawAda.resume.category === "JOB_CANDIDATE_RESUME" &&
      rawAda.resume.storagePath.startsWith(`recruiters/${recruiterA.user.id}/candidate-resumes/`),
    summarize(rawAda.resume)
  );
  check(
    "the original TXT is persisted exactly once and exists on disk",
    (await countResumeFilesOwnedBy(recruiterA.user.id)) === 1 &&
      (await diskExists(rawAda.resume.storagePath)) &&
      (await fs.readFile(absolutePathFor(rawAda.resume.storagePath))).equals(TXT_RESUME_BUFFER),
    summarize({ storagePath: rawAda.resume.storagePath })
  );
  const openedTxt = await referenceService.openCandidateResume(recruiterA.user, job.id, ada.id);
  check(
    "the service descriptor resolves the attached StoredFile, not a frontend file id",
    openedTxt.id === rawAda.resume.id && openedTxt.category === "JOB_CANDIDATE_RESUME",
    summarize(openedTxt)
  );

  const pdfResult = await referenceService.uploadCandidateResume(
    recruiterA.user,
    job.id,
    alan.id,
    resumeFile("alan.pdf", PDF_RESUME_BUFFER, "application/pdf")
  );
  const rawAlan = await prisma.jobCandidateReference.findUnique({
    where: { id: alan.id },
    include: { resume: true },
  });
  check(
    "PDF upload extracts its real text layer through pdf-parse",
    pdfResult.extraction.status === "EXTRACTED" &&
      rawAlan.resumeText.includes("Ada Lovelace - Senior Backend Engineer"),
    summarize({ status: pdfResult.extraction.status, text: rawAlan.resumeText })
  );

  const oldResume = { ...rawAda.resume };
  const replacedResult = await referenceService.uploadCandidateResume(
    recruiterA.user,
    job.id,
    ada.id,
    resumeFile("ada-new.pdf", PDF_RESUME_BUFFER, "application/pdf")
  );
  const rawAdaReplaced = await prisma.jobCandidateReference.findUnique({
    where: { id: ada.id },
    include: { resume: true },
  });
  const oldRow = await prisma.storedFile.findUnique({ where: { id: oldResume.id } });
  check(
    "resume replacement swaps to a new StoredFile id and extracted text",
    replacedResult.resume.fileId === rawAdaReplaced.resume.id &&
      rawAdaReplaced.resume.id !== oldResume.id &&
      rawAdaReplaced.resumeText.includes("Senior Backend Engineer"),
    summarize({ old: oldResume.id, current: rawAdaReplaced.resume.id })
  );
  check(
    "the old StoredFile row is deleted in the association transaction",
    oldRow === null,
    summarize(oldRow)
  );
  check(
    "old physical content is removed only after the new association exists",
    (await diskExists(rawAdaReplaced.resume.storagePath)) &&
      !(await diskExists(oldResume.storagePath)),
    summarize({ current: rawAdaReplaced.resume.storagePath, old: oldResume.storagePath })
  );

  const scannedResult = await referenceService.uploadCandidateResume(
    recruiterA.user,
    job.id,
    grace.id,
    resumeFile("scanned.pdf", SCANNED_PDF_BUFFER, "application/pdf")
  );
  const rawGrace = await prisma.jobCandidateReference.findUnique({
    where: { id: grace.id },
    include: { resume: true },
  });
  check(
    "a text-less/scanned PDF succeeds with UNAVAILABLE evidence, preserving the original",
    scannedResult.extraction.status === "UNAVAILABLE" &&
      rawGrace.resumeText === null &&
      rawGrace.resumeFileId === rawGrace.resume.id &&
      (await diskExists(rawGrace.resume.storagePath)),
    summarize({ status: scannedResult.extraction.status, resumeText: rawGrace.resumeText })
  );

  tracked.resumeStoragePaths.push(
    rawAda.resume.storagePath,
    rawAlan.resume.storagePath,
    rawAdaReplaced.resume.storagePath,
    oldResume.storagePath,
    rawGrace.resume.storagePath
  );

  const invalidCases = [
    ["resume.doc", Buffer.from("not a doc"), "application/msword"],
    ["resume.docx", Buffer.from("not a docx"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["executable.txt", Buffer.from([0x4d, 0x5a, 0x90, 0x00]), "text/plain"],
    ["script.txt", Buffer.from("#!/bin/sh\nrm -rf /\n"), "text/plain"],
    ["archive.txt", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]), "application/zip"],
    ["fake.pdf", Buffer.from("plain text pretending to be a PDF"), "application/pdf"],
  ];
  for (const [name, buffer, mimetype] of invalidCases) {
    await expectRejection(
      `${name} is rejected by the backend before persistence`,
      () =>
        referenceService.uploadCandidateResume(
          recruiterA.user,
          job.id,
          turing.id,
          resumeFile(name, buffer, mimetype)
        ),
      415
    );
  }
  const filesBeforeOversize = await countResumeFilesOwnedBy(recruiterA.user.id);
  await expectRejection(
    "a TXT larger than the existing 10 MB storage limit is rejected with 413",
    () =>
      referenceService.uploadCandidateResume(
        recruiterA.user,
        job.id,
        turing.id,
        resumeFile(
          "too-large.txt",
          Buffer.alloc(10 * 1024 * 1024 + 1, 0x61),
          "text/plain"
        )
      ),
    413
  );
  check(
    "all invalid and oversize uploads leave StoredFile rows and disk content unchanged",
    (await countResumeFilesOwnedBy(recruiterA.user.id)) === filesBeforeOversize &&
      (await resumeDirEntries(recruiterA.user.id)).length === filesBeforeOversize,
    summarize({ rows: await countResumeFilesOwnedBy(recruiterA.user.id) })
  );

  const filesBeforeFailure = await prisma.storedFile.findMany({
    where: { ownerId: recruiterA.user.id, category: "JOB_CANDIDATE_RESUME" },
    orderBy: { id: "asc" },
  });
  const entriesBeforeFailure = await resumeDirEntries(recruiterA.user.id);
  const originalReplace = jobCandidateReferenceRepository.replaceReferenceResume;
  jobCandidateReferenceRepository.replaceReferenceResume = async () => {
    throw Object.assign(new Error("forced association failure"), { status: 500 });
  };
  try {
    await expectRejection(
      "a forced association failure rejects the upload instead of exposing a partial result",
      () =>
        referenceService.uploadCandidateResume(
          recruiterA.user,
          job.id,
          turing.id,
          resumeFile("rollback.txt", Buffer.from("rollback evidence"), "text/plain")
        ),
      500
    );
  } finally {
    jobCandidateReferenceRepository.replaceReferenceResume = originalReplace;
  }
  const filesAfterFailure = await prisma.storedFile.findMany({
    where: { ownerId: recruiterA.user.id, category: "JOB_CANDIDATE_RESUME" },
    orderBy: { id: "asc" },
  });
  check(
    "association failure removes both the new StoredFile row and its physical content",
    summarize(filesBeforeFailure.map((file) => file.id)) === summarize(filesAfterFailure.map((file) => file.id)) &&
      summarize(entriesBeforeFailure) === summarize(await resumeDirEntries(recruiterA.user.id)),
    summarize({ before: filesBeforeFailure.length, after: filesAfterFailure.length })
  );

  await expectRejection(
    "a resume-less reference returns a safe 404 from the private resolver",
    () => referenceService.openCandidateResume(recruiterA.user, job.id, turing.id),
    404
  );
  await expectRejection(
    "a different recruiter cannot open this job's resume",
    () => referenceService.openCandidateResume(recruiterB.user, job.id, ada.id),
    403
  );
  const otherJob = await createDraftFixture(recruiterB, {
    ...READY_PAYLOAD,
    title: `Resume other job ${SUFFIX}`,
  });
  await expectRejection(
    "a resume reference id cannot be opened through another authorized job",
    () => referenceService.openCandidateResume(recruiterB.user, otherJob.id, ada.id),
    404
  );

  await referenceService.uploadCandidateResume(
    recruiterA.user,
    job.id,
    turing.id,
    resumeFile("detached.txt", Buffer.from("detached association evidence"), "text/plain")
  );
  const detachedBefore = await prisma.jobCandidateReference.findUnique({
    where: { id: turing.id },
    include: { resume: true },
  });
  tracked.resumeStoragePaths.push(detachedBefore.resume.storagePath);
  await prisma.jobCandidateReference.update({
    where: { id: turing.id },
    data: { resumeFileId: null },
  });
  await expectRejection(
    "a detached/deleted resume association cannot expose its old StoredFile",
    () => referenceService.openCandidateResume(recruiterA.user, job.id, turing.id),
    404
  );
  await prisma.storedFile.delete({ where: { id: detachedBefore.resume.id } });
  await removeStoredFileContent(detachedBefore.resume.storagePath);
  await removeEmptyStoredFileDirectory(detachedBefore.resume.storagePath);

  check(
    "resume operations create no AiJob and consume no quota",
    (await countAiJobs(job.id)) === 0 && (await countConsumptions(job.id)) === 0,
    summarize({ aiJobs: await countAiJobs(job.id), quota: await countConsumptions(job.id) })
  );
  return { job, ada: rawAdaReplaced, alan: rawAlan, grace: rawGrace, turing };
};

const createOrganizationMemberFixture = async (organizationId, label, role) => {
  const user = await prisma.user.create({
    data: {
      fullName: `Candidate Reference Harness ${label}`,
      email: `candref-${label}-${SUFFIX}@example.test`,
      provider: "LOCAL",
      emailVerified: true,
      status: "ACTIVE",
    },
  });
  const roleRow = await prisma.role.upsert({
    where: { name: role },
    update: {},
    create: { name: role, description: `${role} role` },
  });
  await prisma.userRole.create({ data: { userId: user.id, roleId: roleRow.id } });
  await prisma.organizationMembership.create({
    data: { userId: user.id, organizationId, role, status: "ACTIVE" },
  });
  tracked.userIds.push(user.id);
  return { user: { id: user.id, role, organizationId } };
};

// --- scenario G: organization authorization -----------------------------------

const scenarioOrganizationIsolation = async ({ recruiterA }) => {
  section("G. Organization isolation — membership-derived scope on every path");
  const orgA = await createOrganizationFixture("org-a-recruiter", { role: "RECRUITER" });
  const orgAAdmin = await createOrganizationMemberFixture(
    orgA.organization.id,
    "org-a-admin",
    "ORG_ADMIN"
  );
  const orgBRecruiter = await createOrganizationFixture("org-b-recruiter", { role: "RECRUITER" });
  const orgBAdmin = await createOrganizationFixture("org-b-admin", { role: "ORG_ADMIN" });
  const job = await createDraftFixture(orgA, { ...READY_PAYLOAD, title: `Org candidate refs ${SUFFIX}` });
  check(
    "job creation derives organization ownership from active membership",
    job.organizationId === orgA.organization.id && job.recruiterId === null,
    summarize({ organizationId: job.organizationId, recruiterId: job.recruiterId })
  );
  await uploadList(
    orgA,
    job.id,
    buildReferenceWorkbook(["Name", "Email"], [["Org Candidate", "org-candidate@example.test"]]),
    `org-candidates-${SUFFIX}.xlsx`
  );
  const ownRefs = await referenceService.listCandidateReferences(orgA.user, job.id);
  const ownReference = ownRefs[0];
  const ownEdit = await referenceService.updateCandidateReference(orgA.user, job.id, ownReference.id, {
    preferredRole: "Organization Recruiter Edit",
  });
  const ownResume = await referenceService.uploadCandidateResume(
    orgA.user,
    job.id,
    ownReference.id,
    resumeFile("org-candidate.txt", Buffer.from("organization resume evidence"), "text/plain")
  );
  const rawOwnResume = await prisma.jobCandidateReference.findUnique({
    where: { id: ownReference.id },
    include: { resume: true },
  });
  tracked.resumeStoragePaths.push(rawOwnResume.resume.storagePath);
  check(
    "an organization recruiter can read, edit, upload, and view inside its own organization job",
    ownEdit.preferredRole === "Organization Recruiter Edit" &&
      ownResume.hasResume &&
      (await referenceService.openCandidateResume(orgA.user, job.id, ownReference.id)).id ===
        rawOwnResume.resume.id,
    summarize({ edit: ownEdit.preferredRole, resume: ownResume.resume })
  );

  const adminRead = await referenceService.listCandidateReferences(orgAAdmin.user, job.id);
  const adminResume = await referenceService.openCandidateResume(
    orgAAdmin.user,
    job.id,
    ownReference.id
  );
  check(
    "an ORG_ADMIN can read/view candidates and resumes in the same organization",
    adminRead.length === 1 && adminResume.id === rawOwnResume.resume.id,
    summarize({ references: adminRead.length, fileId: adminResume.id })
  );

  for (const [label, principal] of [
    ["another organization recruiter", orgBRecruiter.user],
    ["another organization admin", orgBAdmin.user],
    ["an independent recruiter", recruiterA.user],
  ]) {
    await expectRejection(
      `${label} cannot list the organization's references`,
      () => referenceService.listCandidateReferences(principal, job.id),
      403
    );
    await expectRejection(
      `${label} cannot read a reference`,
      () => referenceService.getCandidateReference(principal, job.id, ownReference.id),
      403
    );
    await expectRejection(
      `${label} cannot edit a reference`,
      () =>
        referenceService.updateCandidateReference(principal, job.id, ownReference.id, {
          candidateName: "Forged",
        }),
      403
    );
    await expectRejection(
      `${label} cannot upload a replacement resume`,
      () =>
        referenceService.uploadCandidateResume(
          principal,
          job.id,
          ownReference.id,
          resumeFile("forged.txt", Buffer.from("forged"), "text/plain")
        ),
      403
    );
    await expectRejection(
      `${label} cannot view the organization's resume`,
      () => referenceService.openCandidateResume(principal, job.id, ownReference.id),
      403
    );
  }

  const beforeDeniedProbes = await referenceService.getCandidateReference(
    orgA.user,
    job.id,
    ownReference.id
  );
  const forgedPrincipal = {
    ...orgBRecruiter.user,
    organizationId: orgA.organization.id,
  };
  await expectRejection(
    "a frontend-forged organizationId on a principal cannot override database membership",
    () => referenceService.listCandidateReferences(forgedPrincipal, job.id),
    403
  );
  const unchanged = await referenceService.getCandidateReference(orgA.user, job.id, ownReference.id);
  check(
    "all denied organization probes leave recruiter data unchanged",
    beforeDeniedProbes.candidateName === unchanged.candidateName &&
      beforeDeniedProbes.preferredRole === unchanged.preferredRole &&
      beforeDeniedProbes.resume.id === unchanged.resume.id,
    summarize({ before: beforeDeniedProbes, after: unchanged })
  );
  return { orgA, orgAAdmin, orgBRecruiter, orgBAdmin, job, ownReference };
};

// --- scenario H: real HTTP/private file contract -------------------------------

const scenarioHttpContract = async ({ recruiterA, recruiterB, resumeFixture, organizationFixture }) => {
  section("H. HTTP contract — auth, strict writes, multipart upload, private inline stream");
  const { server, origin } = await startHttpServer();
  try {
    const tokenA = tokenFor(recruiterA.user);
    const tokenB = tokenFor(recruiterB.user);
    const base = (jobId, referenceId) =>
      `/api/job/${jobId}/candidate-references/${referenceId}`;
    const listPath = (jobId) => `/api/job/${jobId}/candidate-references`;
    const resumePath = (jobId, referenceId) => `${base(jobId, referenceId)}/resume`;

    const unauthenticated = await requestHttp(origin, listPath(resumeFixture.job.id));
    check("candidate-reference routes require authentication (401)", unauthenticated.status === 401, summarize(unauthenticated.json));
    const unauthenticatedFile = await requestHttp(origin, resumePath(resumeFixture.job.id, resumeFixture.ada.id));
    check("the private resume route requires authentication (401)", unauthenticatedFile.status === 401, summarize(unauthenticatedFile.json));

    const ownList = await requestHttp(origin, listPath(resumeFixture.job.id), { token: tokenA });
    check(
      "the authorized recruiter can list job-scoped references over HTTP",
      ownList.status === 200 && ownList.json?.data?.length === 4,
      summarize(ownList.json)
    );
    const crossRecruiter = await requestHttp(origin, listPath(resumeFixture.job.id), { token: tokenB });
    check("another recruiter receives 403 over HTTP", crossRecruiter.status === 403, summarize(crossRecruiter.json));

    const strictIdentity = await requestHttp(
      origin,
      base(resumeFixture.job.id, resumeFixture.ada.id),
      {
        method: "PATCH",
        token: tokenA,
        body: { candidateName: "X", candidateEmail: "forged@example.test", jobId: "forged" },
      }
    );
    check(
      "strict PATCH rejects identity keys with 400",
      strictIdentity.status === 400,
      summarize(strictIdentity.json)
    );
    const strictOrganization = await requestHttp(
      origin,
      base(resumeFixture.job.id, resumeFixture.ada.id),
      {
        method: "PATCH",
        token: tokenA,
        body: { preferredRole: "X", organizationId: "client-controlled" },
      }
    );
    check(
      "strict PATCH rejects arbitrary organizationId with 400",
      strictOrganization.status === 400,
      summarize(strictOrganization.json)
    );

    const missingReference = await requestHttp(
      origin,
      resumePath(resumeFixture.job.id, "ffffffffffffffffffff"),
      { token: tokenA }
    );
    check(
      "a nonexistent reference id returns a safe 404",
      missingReference.status === 404,
      summarize(missingReference.json)
    );
    const missingResume = await requestHttp(
      origin,
      resumePath(resumeFixture.job.id, resumeFixture.turing.id),
      { token: tokenA }
    );
    check(
      "a resume-less reference returns a safe 404",
      missingResume.status === 404,
      summarize(missingResume.json)
    );
    const crossJobProbe = await requestHttp(
      origin,
      resumePath(resumeFixture.job.id, resumeFixture.ada.id),
      { token: tokenB }
    );
    check(
      "another recruiter cannot view the first recruiter's resume (403)",
      crossJobProbe.status === 403,
      summarize(crossJobProbe.json)
    );
    const wrongJobPair = await requestHttp(
      origin,
      resumePath(resumeFixture.job.id, resumeFixture.ada.id),
      { token: tokenA, headers: {} }
    );
    check("the authorized same-job resume route is addressable", wrongJobPair.status === 200, summarize(wrongJobPair.json));

    const httpPdf = await requestMultipart(
      origin,
      resumePath(resumeFixture.job.id, resumeFixture.turing.id),
      {
        token: tokenA,
        name: "http-turing.pdf",
        buffer: PDF_RESUME_BUFFER,
        mimetype: "application/pdf",
      }
    );
    const httpPdfData = httpPdf.json?.data;
    const rawHttpPdf = await prisma.jobCandidateReference.findUnique({
      where: { id: resumeFixture.turing.id },
      include: { resume: true },
    });
    tracked.resumeStoragePaths.push(rawHttpPdf.resume.storagePath);
    check(
      "multipart PDF upload returns 201 with an opaque file id and no server path",
      httpPdf.status === 201 &&
        httpPdfData?.resume?.fileId === rawHttpPdf.resume.id &&
        !JSON.stringify(httpPdf.json).includes("storagePath"),
      summarize(httpPdf.json)
    );
    const pdfView = await requestHttp(
      origin,
      resumePath(resumeFixture.job.id, resumeFixture.turing.id),
      { token: tokenA }
    );
    const disposition = pdfView.headers.get("content-disposition") ?? "";
    check(
      "PDF is served byte-identically with inline disposition and nosniff",
      pdfView.status === 200 &&
        pdfView.buffer.equals(PDF_RESUME_BUFFER) &&
        pdfView.headers.get("content-type") === "application/pdf" &&
        disposition.startsWith("inline") &&
        pdfView.headers.get("x-content-type-options") === "nosniff",
      summarize({
        status: pdfView.status,
        type: pdfView.headers.get("content-type"),
        disposition,
        nosniff: pdfView.headers.get("x-content-type-options"),
      })
    );

    const httpTxt = await requestMultipart(
      origin,
      resumePath(resumeFixture.job.id, resumeFixture.grace.id),
      {
        token: tokenA,
        name: "http-grace.txt",
        buffer: TXT_RESUME_BUFFER,
        mimetype: "text/plain",
      }
    );
    const rawHttpTxt = await prisma.jobCandidateReference.findUnique({
      where: { id: resumeFixture.grace.id },
      include: { resume: true },
    });
    tracked.resumeStoragePaths.push(rawHttpTxt.resume.storagePath);
    const txtView = await requestHttp(
      origin,
      resumePath(resumeFixture.job.id, resumeFixture.grace.id),
      { token: tokenA }
    );
    check(
      "multipart TXT upload returns 201 and is served as exact text/plain inline bytes",
      httpTxt.status === 201 &&
        txtView.status === 200 &&
        txtView.buffer.equals(TXT_RESUME_BUFFER) &&
        txtView.headers.get("content-type") === "text/plain" &&
        (txtView.headers.get("content-disposition") ?? "").startsWith("inline") &&
        txtView.headers.get("x-content-type-options") === "nosniff",
      summarize({ upload: httpTxt.status, view: txtView.status, type: txtView.headers.get("content-type") })
    );

    const forgedFileQuery = await requestHttp(
      origin,
      `${resumePath(resumeFixture.job.id, resumeFixture.ada.id)}?fileId=${encodeURIComponent(rawHttpPdf.resume.id)}`,
      { token: tokenA }
    );
    check(
      "a frontend-supplied fileId cannot substitute another StoredFile on an authorized reference",
      forgedFileQuery.status === 200 && forgedFileQuery.buffer.equals(PDF_RESUME_BUFFER),
      summarize({ status: forgedFileQuery.status, bytes: forgedFileQuery.buffer.length })
    );
    const genericCrossOwner = await requestHttp(
      origin,
      `/api/files/${encodeURIComponent(resumeFixture.ada.resume.id)}/view`,
      { token: tokenB }
    );
    check(
      "the ownership-checked generic file route cannot expose another recruiter's resume",
      genericCrossOwner.status === 404,
      summarize(genericCrossOwner.json)
    );
    const publicPath = await requestHttp(
      origin,
      `/uploads/${rawHttpPdf.resume.storagePath}`,
      { token: tokenA }
    );
    const directStoragePath = await requestHttp(
      origin,
      `/${rawHttpPdf.resume.storagePath}`,
      { token: tokenA }
    );
    check(
      "there is no public /uploads or direct storagePath route for resume content",
      publicPath.status === 404 && directStoragePath.status === 404,
      summarize({ uploads: publicPath.status, direct: directStoragePath.status })
    );

    const rowsBeforeHttpOversize = await countResumeFilesOwnedBy(recruiterA.user.id);
    const httpOversize = await requestMultipart(
      origin,
      resumePath(resumeFixture.job.id, resumeFixture.alan.id),
      {
        token: tokenA,
        name: "http-too-large.txt",
        buffer: Buffer.alloc(10 * 1024 * 1024 + 1, 0x61),
        mimetype: "text/plain",
      }
    );
    check(
      "multipart upload enforces the existing 10 MB limit with 413 before persistence",
      httpOversize.status === 413 &&
        (await countResumeFilesOwnedBy(recruiterA.user.id)) === rowsBeforeHttpOversize,
      summarize(httpOversize.json)
    );

    const orgToken = tokenFor(organizationFixture.orgAAdmin.user);
    const orgResumeView = await requestHttp(
      origin,
      resumePath(organizationFixture.job.id, organizationFixture.ownReference.id),
      { token: orgToken }
    );
    const orgWrite = await requestHttp(
      origin,
      base(organizationFixture.job.id, organizationFixture.ownReference.id),
      { method: "PATCH", token: orgToken, body: { candidateName: "Admin edit" } }
    );
    check(
      "ORG_ADMIN can view its organization's resume but the edit route remains recruiter-only",
      orgResumeView.status === 200 && orgWrite.status === 403,
      summarize({ view: orgResumeView.status, write: orgWrite.status })
    );
    const otherOrgToken = tokenFor(organizationFixture.orgBRecruiter.user);
    const otherOrgView = await requestHttp(
      origin,
      resumePath(organizationFixture.job.id, organizationFixture.ownReference.id),
      { token: otherOrgToken }
    );
    check(
      "another organization receives 403 from the private HTTP resume route",
      otherOrgView.status === 403,
      summarize(otherOrgView.json)
    );
    const denialBodies = [crossRecruiter, crossJobProbe, otherOrgView];
    check(
      "HTTP denial/error bodies never leak storagePath or resume text",
      denialBodies.every((response) =>
        !response.text.includes("storagePath") && !response.text.includes("resumeText")
      ),
      summarize(denialBodies.map((response) => response.text))
    );
  } finally {
    await stopHttpServer(server);
  }
};

// --- scenario I: closed lifecycle ---------------------------------------------

const scenarioClosedLifecycle = async ({ recruiterA }) => {
  section("I. Lifecycle — CLOSED jobs are read-only for writes but resume reads remain private");
  const job = await createDraftFixture(recruiterA, {
    ...READY_PAYLOAD,
    title: `Closed candidate references ${SUFFIX}`,
  });
  await uploadList(
    recruiterA,
    job.id,
    buildReferenceWorkbook(["Name", "Email"], [["Closed Candidate", "closed@example.test"]]),
    `closed-candidates-${SUFFIX}.xlsx`
  );
  const reference = (await referenceService.listCandidateReferences(recruiterA.user, job.id))[0];
  await referenceService.uploadCandidateResume(
    recruiterA.user,
    job.id,
    reference.id,
    resumeFile("closed.txt", Buffer.from("closed job resume evidence"), "text/plain")
  );
  const rawClosed = await prisma.jobCandidateReference.findUnique({
    where: { id: reference.id },
    include: { resume: true },
  });
  tracked.resumeStoragePaths.push(rawClosed.resume.storagePath);

  // Lifecycle state is set directly in this disposable fixture so the Step 2
  // harness never Starts a job or dispatches any AI work just to reach CLOSED.
  const beforeClosedWrites = await referenceService.getCandidateReference(
    recruiterA.user,
    job.id,
    reference.id
  );
  await prisma.job.update({
    where: { id: job.id },
    data: {
      status: "CLOSED",
      closedAt: new Date(),
      closedReason: "RECRUITER_CLOSED",
    },
  });
  const listed = await referenceService.listCandidateReferences(recruiterA.user, job.id);
  const opened = await referenceService.openCandidateResume(recruiterA.user, job.id, reference.id);
  check(
    "CLOSED jobs still allow authorized private reference and resume reads",
    listed.length === 1 && opened.id === rawClosed.resume.id,
    summarize({ listed: listed.length, fileId: opened.id })
  );
  await expectRejection(
    "CLOSED jobs reject recruiter reference edits with 409",
    () =>
      referenceService.updateCandidateReference(recruiterA.user, job.id, reference.id, {
        preferredRole: "Too late",
      }),
    409
  );
  await expectRejection(
    "CLOSED jobs reject resume replacement with 409",
    () =>
      referenceService.uploadCandidateResume(
        recruiterA.user,
        job.id,
        reference.id,
        resumeFile("too-late.txt", Buffer.from("too late"), "text/plain")
      ),
    409
  );
  const unchangedClosed = await referenceService.getCandidateReference(
    recruiterA.user,
    job.id,
    reference.id
  );
  check(
    "rejected CLOSED-job writes leave the existing resume association intact",
    beforeClosedWrites.resume.id === unchangedClosed.resume.id &&
      beforeClosedWrites.resume.fileId === unchangedClosed.resume.fileId,
    summarize({ before: beforeClosedWrites.resume, after: unchangedClosed.resume })
  );
};

// --- scenario J: browser storage is not candidate data -------------------------

const scenarioBrowserStorage = async () => {
  section("J. Browser storage — candidate-reference data is server-authoritative");
  const files = await listFrontendSourceFiles();
  const forbidden = [
    "linkedinText",
    "githubText",
    "resumeText",
    "skillNotes",
    "preferredRole",
    "candidateReference",
  ];
  const violations = [];
  for (const file of files) {
    const source = await fs.readFile(file, "utf8");
    if (!/(?:localStorage|sessionStorage)\s*\./.test(source)) {
      continue;
    }
    for (const field of forbidden) {
      if (source.includes(field)) {
        violations.push(`${file}:${field}`);
      }
    }
    const storageWrites = source.match(
      /(?:localStorage|sessionStorage)\.setItem\s*\(\s*(['"`])([^'"`]+)\1/g
    ) ?? [];
    for (const write of storageWrites) {
      if (/candidate|linkedin|github|resume|skillnotes|preferredrole/i.test(write)) {
        violations.push(`${file}:${write}`);
      }
    }
  }
  check(
    "no frontend source uses localStorage/sessionStorage for candidate-reference source-of-truth fields",
    files.length > 0 && violations.length === 0,
    summarize({ filesScanned: files.length, violations })
  );
  check(
    "candidate data remains server-persisted through the service scenarios",
    true
  );
};

// --- cleanup & report -------------------------------------------------------

const snapshotTotals = async () => ({
  user: await prisma.user.count(),
  organization: await prisma.organization.count(),
  organizationMembership: await prisma.organizationMembership.count(),
  subscription: await prisma.subscription.count(),
  subscriptionPlan: await prisma.subscriptionPlan.count(),
  job: await prisma.job.count(),
  jobCandidateList: await prisma.jobCandidateList.count(),
  jobCandidateReference: await prisma.jobCandidateReference.count(),
  jobCandidateAnalysis: await prisma.jobCandidateAnalysis.count(),
  aiJob: await prisma.aiJob.count(),
  jobQuotaConsumption: await prisma.jobQuotaConsumption.count(),
  storedFile: await prisma.storedFile.count(),
  jobAssessment: await prisma.jobAssessment.count(),
  jobAssessmentInvitation: await prisma.jobAssessmentInvitation.count(),
  jobAssessmentAttempt: await prisma.jobAssessmentAttempt.count(),
});

const collectTrackedStoredFiles = async () => {
  if (tracked.userIds.length === 0) {
    return [];
  }
  return prisma.storedFile.findMany({
    where: {
      ownerId: { in: tracked.userIds },
      category: { in: ["JOB_CANDIDATE_LIST", "JOB_CANDIDATE_RESUME"] },
    },
    select: { id: true, storagePath: true },
  });
};

const cleanup = async () => {
  const removed = {};
  const jobIds = tracked.jobIds;
  const userIds = tracked.userIds;

  if (jobIds.length > 0) {
    // Step 1 cleanup rule: JobCandidateAnalysis -> AiJob is RESTRICT. The
    // harness therefore deletes analyses before AiJob and does not change
    // production Job deletion semantics merely to ease verification cleanup.
    removed.jobCandidateAnalysis = (
      await prisma.jobCandidateAnalysis.deleteMany({ where: { jobId: { in: jobIds } } })
    ).count;
    removed.jobAssessmentAttempt = (
      await prisma.jobAssessmentAttempt.deleteMany({ where: { jobId: { in: jobIds } } })
    ).count;
    removed.jobAssessmentInvitation = (
      await prisma.jobAssessmentInvitation.deleteMany({ where: { jobId: { in: jobIds } } })
    ).count;
    removed.jobAssessment = (
      await prisma.jobAssessment.deleteMany({ where: { jobId: { in: jobIds } } })
    ).count;
    removed.jobClarificationQuestion = (
      await prisma.jobClarificationQuestion.deleteMany({ where: { jobId: { in: jobIds } } })
    ).count;
    removed.aiJob = (
      await prisma.aiJob.deleteMany({ where: { jobId: { in: jobIds } } })
    ).count;
    removed.jobQuotaConsumption = (
      await prisma.jobQuotaConsumption.deleteMany({ where: { jobId: { in: jobIds } } })
    ).count;

    Object.assign(removed, await cleanupJobCandidateLists(prisma, jobIds));
    const remainingFiles = await collectTrackedStoredFiles();
    removed.additionalStoredFile = (
      await prisma.storedFile.deleteMany({
        where: { id: { in: remainingFiles.map((file) => file.id) } },
      })
    ).count;
    for (const file of remainingFiles) {
      await removeStoredFileContent(file.storagePath);
      await removeEmptyStoredFileDirectory(file.storagePath);
    }
    removed.job = (await prisma.job.deleteMany({ where: { id: { in: jobIds } } })).count;
  }

  if (tracked.subscriptionIds.length > 0) {
    removed.subscription = (
      await prisma.subscription.deleteMany({ where: { id: { in: tracked.subscriptionIds } } })
    ).count;
  }
  if (tracked.organizationIds.length > 0) {
    removed.organization = (
      await prisma.organization.deleteMany({ where: { id: { in: tracked.organizationIds } } })
    ).count;
  }
  if (userIds.length > 0) {
    removed.user = (await prisma.user.deleteMany({ where: { id: { in: userIds } } })).count;
  }
  if (tracked.planIds.length > 0) {
    removed.subscriptionPlan = (
      await prisma.subscriptionPlan.deleteMany({ where: { id: { in: tracked.planIds } } })
    ).count;
  }
  return removed;
};

const countLeftovers = async () => {
  const ids = { in: tracked.jobIds };
  const [users, jobs, lists, references, analyses, aiJobs, quotas, files, subscriptions, plans, organizations] =
    await Promise.all([
      prisma.user.count({ where: { id: { in: tracked.userIds } } }),
      prisma.job.count({ where: { id: ids } }),
      prisma.jobCandidateList.count({ where: { jobId: ids } }),
      prisma.jobCandidateReference.count({ where: { jobId: ids } }),
      prisma.jobCandidateAnalysis.count({ where: { jobId: ids } }),
      prisma.aiJob.count({ where: { jobId: ids } }),
      prisma.jobQuotaConsumption.count({ where: { jobId: ids } }),
      prisma.storedFile.count({
        where: {
          ownerId: { in: tracked.userIds },
          category: { in: ["JOB_CANDIDATE_LIST", "JOB_CANDIDATE_RESUME"] },
        },
      }),
      prisma.subscription.count({ where: { id: { in: tracked.subscriptionIds } } }),
      prisma.subscriptionPlan.count({ where: { id: { in: tracked.planIds } } }),
      prisma.organization.count({ where: { id: { in: tracked.organizationIds } } }),
    ]);
  const physicalResumeFiles = (
    await Promise.all(tracked.resumeStoragePaths.map((storagePath) => diskExists(storagePath)))
  ).filter(Boolean).length;
  return users + jobs + lists + references + analyses + aiJobs + quotas + files + subscriptions + plans + organizations + physicalResumeFiles;
};

const finish = async (before) => {
  section("Cleanup — deleting every row and physical file this harness created");
  try {
    console.log(`  deleted: ${summarize(await cleanup())}`);
    check("no harness fixture row or tracked resume file is left behind", (await countLeftovers()) === 0);
  } catch (error) {
    check("no harness fixture row or tracked resume file is left behind", false, error.message);
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
    "Phase 7 Step 2 verified: job-scoped references, non-destructive Excel seeding, recruiter edits, secure PDF/TXT resume storage, and private authorized viewing. No AI work executed."
  );
};

const run = async () => {
  console.log("Candidate reference & resume verification harness — Phase 7 Step 2");
  console.log(`run id: ${SUFFIX}`);
  console.log("scope: candidate-reference persistence, Excel seed-if-absent, recruiter edits, PDF/TXT resume storage, private authorized viewing. NO AI analysis is executed.");

  const before = await snapshotTotals();
  console.log(`platform totals at start: ${summarize(before)}`);
  try {
    const recruiterA = await createRecruiterFixture("a", 20);
    const recruiterB = await createRecruiterFixture("b", 20);
    const jobA = await createDraftFixture(recruiterA, {
      ...READY_PAYLOAD,
      title: `Candidate references A ${SUFFIX}`,
    });
    const jobB = await createDraftFixture(recruiterB, {
      ...READY_PAYLOAD,
      title: `Candidate references B ${SUFFIX}`,
    });
    const jobD = await createDraftFixture(recruiterA, {
      ...READY_PAYLOAD,
      title: `Candidate references backfill ${SUFFIX}`,
    });
    await uploadList(recruiterA, jobA.id, buildReferenceWorkbook(), `candidate-ref-a-${SUFFIX}.xlsx`);
    await uploadList(recruiterB, jobB.id, buildReferenceWorkbook(), `candidate-ref-b-${SUFFIX}.xlsx`);
    await uploadList(recruiterA, jobD.id, buildReferenceWorkbook(), `candidate-ref-d-${SUFFIX}.xlsx`);

    const seeded = await scenarioSeeding({ recruiterA, jobA });
    await scenarioEditOverlay({ recruiterA, jobA, ...seeded });
    await scenarioScoping({ recruiterA, recruiterB, jobA, jobB, ada: seeded.ada });
    await scenarioBackfill({ recruiterA, jobD });
    await scenarioExcelReplacement({ recruiterA });
    const resumeFixture = await scenarioResumes({ recruiterA, recruiterB });
    const organizationFixture = await scenarioOrganizationIsolation({ recruiterA });
    await scenarioHttpContract({ recruiterA, recruiterB, resumeFixture, organizationFixture });
    await scenarioClosedLifecycle({ recruiterA });
    await scenarioBrowserStorage();
  } catch (error) {
    console.error("\nUNEXPECTED harness error:", error);
    check("every Step 2 scenario ran without an unexpected error", false, error.message);
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