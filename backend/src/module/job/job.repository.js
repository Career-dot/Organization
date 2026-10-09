const prisma = require("../../config/prisma");
const crypto = require("node:crypto");
const {
  AI_JOB_OPERATION,
  AI_JOB_STATUS,
  buildAssessmentGenerationPayload,
  buildJobAnalysisPayload,
  createAiJob,
} = require("../ai-job/aiJob.repository");
// Phase 7 — seed-if-absent rows for JobCandidateReference, shared with the
// reference repository so the seed shape has exactly ONE definition. That
// module requires only prisma, so there is no require cycle here.
const { buildReferenceSeedData } = require("./jobCandidateReference.repository");

// Prisma enum values are referenced as plain strings on purpose: the allowed
// values are frozen by the migrated database schema (JobStatus and
// JobClosedReason enums), not by application state.
const JOB_STATUS = {
  DRAFT: "DRAFT",
  ACTIVE: "ACTIVE",
  CLOSED: "CLOSED",
};

const JOB_CLOSED_REASON = {
  SYSTEM_EXPIRED: "SYSTEM_EXPIRED",
  RECRUITER_CLOSED: "RECRUITER_CLOSED",
};

const OWNER_SELECTS = {
  recruiter: { select: { id: true, fullName: true, email: true } },
  organization: { select: { id: true, name: true } },
};

const JOB_DETAIL_INCLUDE = {
  skills: { orderBy: { sortOrder: "asc" } },
  tools: { orderBy: { sortOrder: "asc" } },
  questions: { orderBy: { sortOrder: "asc" } },
  responsibilities: { orderBy: { sortOrder: "asc" } },
  educationRequirements: { orderBy: { sortOrder: "asc" } },
  quotaConsumption: true,
  // Client-safe candidate-list projection: metadata only. storagePath and the
  // StoredFile bookkeeping never reach the client through this include.
  candidateList: {
    select: {
      id: true,
      candidateCount: true,
      createdAt: true,
      file: { select: { id: true, originalName: true, mimeType: true, fileSize: true } },
    },
  },
  // AI workflow state. aiJobs is a narrow projection (the service never sends
  // requestPayload/result/raw rows to clients); the clarification rows and the
  // materialized assessment ARE the client-facing copies of the AI output.
  aiJobs: {
    select: { id: true, operation: true, status: true, lastError: true, completedAt: true },
  },
  clarificationQuestions: { orderBy: { sortOrder: "asc" } },
  assessment: { include: { questions: { orderBy: { sortOrder: "asc" } } } },
  ...OWNER_SELECTS,
};

const JOB_LIST_INCLUDE = {
  _count: { select: { skills: true, tools: true, questions: true } },
  ...OWNER_SELECTS,
};

// Repository-layer failure that needs an HTTP status. Mirrors the small local
// helper pattern used by subscription.service.js / organization.service.js
// (no shared ApiError class exists in this codebase).
const failure = (status, message) => Object.assign(new Error(message), { status });

const childCreateData = {
  skills: (items) =>
    items.map((item, index) => ({ name: item.name, weight: item.weight, sortOrder: index })),
  tools: (items) => items.map((item, index) => ({ name: item.name, sortOrder: index })),
  questions: (items) => items.map((item, index) => ({ question: item.question, sortOrder: index })),
  // Phase 2 — structured requirement children. sortOrder is derived from array
  // position here, never trusted from the client (the zod row schemas strip it).
  responsibilities: (items) => items.map((item, index) => ({ text: item.text, sortOrder: index })),
  educationRequirements: (items) =>
    items.map((item, index) => ({ text: item.text, sortOrder: index })),
};

async function createJobWithChildren({
  data,
  skills = [],
  tools = [],
  questions = [],
  responsibilities = [],
  educationRequirements = [],
}) {
  return prisma.job.create({
    data: {
      ...data,
      skills: { create: childCreateData.skills(skills) },
      tools: { create: childCreateData.tools(tools) },
      questions: { create: childCreateData.questions(questions) },
      responsibilities: { create: childCreateData.responsibilities(responsibilities) },
      educationRequirements: {
        create: childCreateData.educationRequirements(educationRequirements),
      },
    },
    include: JOB_DETAIL_INCLUDE,
  });
}

// Replace-strategy child updates: each provided collection is deleted and
// recreated inside the same transaction, which sidesteps the
// @@unique([jobId, name]) constraints on JobSkill/JobTool when a recruiter
// renames or reorders entries. Collections left undefined are untouched.
async function updateJobWithChildren(jobId, scalarData, children) {
  return prisma.$transaction(async (tx) => {
    if (Object.keys(scalarData).length > 0) {
      await tx.job.update({ where: { id: jobId }, data: scalarData });
    }

    if (children.skills !== undefined) {
      await tx.jobSkill.deleteMany({ where: { jobId } });
      if (children.skills.length > 0) {
        await tx.jobSkill.createMany({
          data: childCreateData.skills(children.skills).map((item) => ({ ...item, jobId })),
        });
      }
    }

    if (children.tools !== undefined) {
      await tx.jobTool.deleteMany({ where: { jobId } });
      if (children.tools.length > 0) {
        await tx.jobTool.createMany({
          data: childCreateData.tools(children.tools).map((item) => ({ ...item, jobId })),
        });
      }
    }

    if (children.questions !== undefined) {
      await tx.jobQuestion.deleteMany({ where: { jobId } });
      if (children.questions.length > 0) {
        await tx.jobQuestion.createMany({
          data: childCreateData.questions(children.questions).map((item) => ({ ...item, jobId })),
        });
      }
    }
    // Phase 2 — same replace semantics for the new structured requirement
    // collections (present, even [], replaces wholesale in one transaction;
    // absent leaves them untouched).
    if (children.responsibilities !== undefined) {
      await tx.jobResponsibility.deleteMany({ where: { jobId } });
      if (children.responsibilities.length > 0) {
        await tx.jobResponsibility.createMany({
          data: childCreateData.responsibilities(children.responsibilities).map(
            (item) => ({ ...item, jobId })
          ),
        });
      }
    }
    if (children.educationRequirements !== undefined) {
      await tx.jobEducationRequirement.deleteMany({ where: { jobId } });
      if (children.educationRequirements.length > 0) {
        await tx.jobEducationRequirement.createMany({
          data: childCreateData.educationRequirements(children.educationRequirements).map(
            (item) => ({ ...item, jobId })
          ),
        });
      }
    }

    return tx.job.findUnique({ where: { id: jobId }, include: JOB_DETAIL_INCLUDE });
  });
}

async function findJobById(jobId) {
  return prisma.job.findUnique({
    where: { id: jobId },
    include: JOB_DETAIL_INCLUDE,
  });
}

async function listJobsByRecruiter(recruiterId, { skip, take }) {
  const [jobs, total] = await prisma.$transaction([
    prisma.job.findMany({
      where: { recruiterId },
      include: JOB_LIST_INCLUDE,
      orderBy: { createdAt: "desc" },
      skip,
      take,
    }),
    prisma.job.count({ where: { recruiterId } }),
  ]);
  return { jobs, total };
}

async function listJobsByOrganization(organizationId, { skip, take }) {
  const [jobs, total] = await prisma.$transaction([
    prisma.job.findMany({
      where: { organizationId },
      include: JOB_LIST_INCLUDE,
      orderBy: { createdAt: "desc" },
      skip,
      take,
    }),
    prisma.job.count({ where: { organizationId } }),
  ]);
  return { jobs, total };
}
// ---------------------------------------------------------------------------
// Quota & subscription reads
// ---------------------------------------------------------------------------

async function countQuotaConsumptions(subscriptionId) {
  return prisma.jobQuotaConsumption.count({ where: { subscriptionId } });
}

// resolveSubscriptionAccess returns subscriptions WITHOUT the plan included
// for independent recruiters (a known asymmetry in the subscription module we
// are not allowed to change), so Start/limits re-fetch the subscription
// together with its plan by id before reading jobPostingLimit.
async function getSubscriptionWithPlan(subscriptionId) {
  return prisma.subscription.findUnique({
    where: { id: subscriptionId },
    include: { plan: true },
  });
}

// ---------------------------------------------------------------------------
// Atomic lifecycle transitions
// ---------------------------------------------------------------------------

// Start is the committed action and must be race-safe. One transaction:
//   1. Lock the quota-owner row (User or Organization) so two concurrent
//      starts for the same owner serialize (house precedent:
//      organization.repository.assertRecruiterSeatAvailable).
//   2. Re-count consumptions inside the lock and enforce the plan limit
//      (limit === null/undefined means unlimited).
//   3. Compare-and-swap the job DRAFT → ACTIVE. Zero rows updated means
//      someone else already started (or closed) it — kills double-click
//      double-starts without any extra table.
//   4. Create the JobQuotaConsumption row. jobId is @unique, so a job can
//      consume quota at most once ever. Closing never deletes this row —
//      closing NEVER returns quota.
//   5. Create the AiJob row (operation JOB_ANALYSIS, status PENDING) whose
//      requestPayload is an immutable snapshot of the job as it is at this
//      instant. Stage 1: this is the durable record that an AI analysis is
//      owed for the job. No queue, no worker, no AI provider.
//
// Steps 3-5 are all-or-nothing: if any of them fails (including the
// @@unique([jobId, operation]) invariant on AiJob) the transaction rolls back,
// so there is no quota consumption without job activation and no activation
// without an AI record. Returns { job, aiJob } — the AiJob is returned
// separately because its requestPayload must never reach the client through the
// job payload (see job.service.js's sanitizers).
async function startJobAtomically({
  jobId,
  ownerTable,
  ownerId,
  subscriptionId,
  limit,
  startedAt,
  analysisEndsAt,
}) {
  return prisma.$transaction(async (tx) => {
    if (ownerTable === "user") {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${ownerId} FOR UPDATE`;
    } else {
      await tx.$queryRaw`SELECT "id" FROM "Organization" WHERE "id" = ${ownerId} FOR UPDATE`;
    }

    const used = await tx.jobQuotaConsumption.count({ where: { subscriptionId } });
    if (limit !== null && limit !== undefined && used >= limit) {
      throw failure(403, "Job quota exhausted for the current subscription");
    }

    const started = await tx.job.updateMany({
      where: { id: jobId, status: JOB_STATUS.DRAFT },
      data: { status: JOB_STATUS.ACTIVE, startedAt, analysisEndsAt },
    });
    if (started.count === 0) {
      throw failure(409, "Job can only be started while it is a draft");
    }

    await tx.jobQuotaConsumption.create({ data: { jobId, subscriptionId } });

    // Re-read inside the transaction so the snapshot and the returned job both
    // describe the committed state at Start time, and so the children arrays
    // (skills/tools/questions) are the persisted rows, not client input.
    const job = await tx.job.findUnique({ where: { id: jobId }, include: JOB_DETAIL_INCLUDE });

    const aiJob = await createAiJob({
      jobId,
      operation: AI_JOB_OPERATION.JOB_ANALYSIS,
      requestPayload: buildJobAnalysisPayload(job),
      client: tx,
    });

    return { job, aiJob };
  });
}

// Only ACTIVE jobs can be closed (recruiter action or future system
// auto-close); CLOSED is terminal — it can never return to ACTIVE or DRAFT
// because no code path writes those statuses here. No quota row is touched.
async function closeJobAtomically(jobId, closedReason) {
  return prisma.$transaction(async (tx) => {
    const closed = await tx.job.updateMany({
      where: { id: jobId, status: JOB_STATUS.ACTIVE },
      data: { status: JOB_STATUS.CLOSED, closedAt: new Date(), closedReason },
    });
    if (closed.count === 0) {
      throw failure(409, "Only active jobs can be closed");
    }
    return tx.job.findUnique({ where: { id: jobId }, include: JOB_DETAIL_INCLUDE });
  });
}

// ---------------------------------------------------------------------------
// Candidate Excel Sheet association (Job ↔ StoredFile)
// ---------------------------------------------------------------------------

// Full row including the StoredFile (with storagePath) — used by the Start
// gate and by file cleanup. NEVER serialized to clients: the service layer
// projects client-safe fields only.
async function findCandidateListWithFile(jobId) {
  return prisma.jobCandidateList.findUnique({
    where: { jobId },
    include: { file: true },
  });
}

// Point the job's candidate list at a freshly uploaded StoredFile, replacing
// any previous association. The previous StoredFile row is deleted in the same
// transaction (fileId is @unique with a Restrict FK, so the swap must be
// ordered: re-point → delete-old). The previous file's DISK content is removed
// by the caller AFTER commit (best effort) — disk cleanup must never be able
// to fail the association change.
//
// Phase 7: the whitelist reference rows parsed from the SAME buffer are seeded
// inside this transaction (seed-if-absent under the Job row lock, backed by
// @@unique([jobId, candidateEmail]) + skipDuplicates). Association and
// references therefore commit together: a rejected upload seeds nothing, and
// a replacement sheet can ADD candidates but never overwrite recruiter-edited
// fields on references that already exist.
async function replaceJobCandidateList({
  jobId,
  fileId,
  candidateCount,
  referenceRows,
  createdByUserId,
}) {
  return prisma.$transaction(async (tx) => {
    const previous = await tx.jobCandidateList.findUnique({
      where: { jobId },
      include: { file: { select: { id: true, storagePath: true } } },
    });
    const candidateList = await tx.jobCandidateList.upsert({
      where: { jobId },
      create: { jobId, fileId, candidateCount },
      update: { fileId, candidateCount },
    });

    let seededReferences = 0;
    if (Array.isArray(referenceRows) && referenceRows.length > 0 && createdByUserId) {
      const seedData = buildReferenceSeedData({ jobId, createdByUserId, rows: referenceRows });
      if (seedData.length > 0) {
        // Same FOR UPDATE serialization the standalone seeder uses, so this
        // import cannot interleave with the read-path backfill.
        await tx.$queryRaw`SELECT "id" FROM "Job" WHERE "id" = ${jobId} FOR UPDATE`;
        const created = await tx.jobCandidateReference.createMany({
          data: seedData,
          skipDuplicates: true,
        });
        seededReferences = created.count;
      }
    }

    const previousFile =
      previous && previous.fileId !== fileId ? previous.file : null;
    if (previousFile) {
      await tx.storedFile.delete({ where: { id: previousFile.id } });
    }
    return {
      candidateList,
      previousFileId: previousFile?.id ?? null,
      previousStoragePath: previousFile?.storagePath ?? null,
      seededReferences,
    };
  });
}

// Remove the job's candidate-list association and its StoredFile row. Returns
// the deleted file's storage path so the caller can clean the disk content
// after commit (best effort).
async function deleteJobCandidateList(jobId) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.jobCandidateList.findUnique({
      where: { jobId },
      include: { file: { select: { id: true, storagePath: true } } },
    });
    if (!existing) {
      return null;
    }
    await tx.jobCandidateList.delete({ where: { id: existing.id } });
    await tx.storedFile.delete({ where: { id: existing.fileId } });
    return { storagePath: existing.file.storagePath };
  });
}

// ---------------------------------------------------------------------------
// AI workflow: clarification questions + assessment
// ---------------------------------------------------------------------------

// Opaque, unguessable link segment for a finalized assessment. base64url of 16
// random bytes (22 chars): URL-safe, no padding, ~128 bits of entropy. It
// identifies the link — it never grants access by itself (invitation checks
// are the next stage's concern).
const buildAssessmentPublicId = () => crypto.randomBytes(16).toString("base64url");

// The job's AiJob row for one operation, with the projected fields the service
// reasons about. Never serialized raw to clients (requestPayload/result stay
// server-side; their client-facing copies are the clarification rows and the
// materialized assessment).
async function findAiJobByOperation(jobId, operation) {
  return prisma.aiJob.findUnique({
    // Phase 7 — the AiJob unique is (jobId, operation, scopeKey); both original
    // operations always write the "" scope, so this lookup is unchanged for them.
    where: { jobId_operation_scopeKey: { jobId, operation, scopeKey: "" } },
    select: { id: true, jobId: true, operation: true, status: true, lastError: true, completedAt: true },
  });
}

// Idempotently materializes JobClarificationQuestion rows from the COMPLETED
// JOB_ANALYSIS result.
//
// Why lazy seeding on the read path: the recruiter-editable rows must exist
// exactly once, whatever happened to the worker after it wrote the result. The
// durable AiJob.result stays the source of truth; these rows are the
// recruiter's working copy (Job rows: editable, refresh-surviving). The
// job-row FOR UPDATE (house pattern from startJobAtomically) serializes two
// concurrent first reads, so rows can never be created twice.
async function seedClarificationQuestions(jobId) {
  const existing = await prisma.jobClarificationQuestion.count({ where: { jobId } });
  if (existing > 0) {
    return { seeded: false };
  }

  const analysis = await prisma.aiJob.findUnique({
    // Phase 7 — pinned to the "" scope that JOB_ANALYSIS has always used.
    where: {
      jobId_operation_scopeKey: { jobId, operation: AI_JOB_OPERATION.JOB_ANALYSIS, scopeKey: "" },
    },
    select: { id: true, status: true, result: true },
  });
  const questions = analysis?.status === AI_JOB_STATUS.COMPLETED
    ? analysis?.result?.analysis?.clarificationQuestions ?? []
    : [];
  if (questions.length === 0) {
    return { seeded: false };
  }

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Job" WHERE "id" = ${jobId} FOR UPDATE`;
    const count = await tx.jobClarificationQuestion.count({ where: { jobId } });
    if (count > 0) {
      return { seeded: false };
    }
    await tx.jobClarificationQuestion.createMany({
      data: questions.map((question, index) => ({
        jobId,
        aiJobId: analysis.id,
        section: question.section,
        sortOrder: index,
        question: question.question,
      })),
    });
    return { seeded: true, count: questions.length };
  });
}

// Applies recruiter edits to the clarification rows: new text, new order
// (sortOrder = list position) and the `edited` audit flag set only when the
// text actually changed. The caller MUST have validated that the items are a
// permutation of the job's rows (ids set-equal) and that the stage is still
// editable — no silent discard, no foreign ids, no post-approval edits.
async function updateClarificationQuestions(jobId, items) {
  if (items.length === 0) {
    return prisma.jobClarificationQuestion.findMany({ where: { jobId }, orderBy: { sortOrder: "asc" } });
  }
  return prisma.$transaction(async (tx) => {
    for (const item of items) {
      const current = await tx.jobClarificationQuestion.findFirst({
        where: { id: item.id, jobId },
        select: { question: true },
      });
      if (!current) {
        throw failure(400, "Clarification questions must include every existing question exactly once");
      }
      await tx.jobClarificationQuestion.update({
        where: { id: item.id },
        data: {
          question: item.question,
          sortOrder: item.sortOrder,
          edited: current.question !== item.question ? true : undefined,
        },
      });
    }
    return tx.jobClarificationQuestion.findMany({ where: { jobId }, orderBy: { sortOrder: "asc" } });
  });
}

// The committed Continue: locks the job row, re-checks that the clarification
// stage is not yet approved, stamps the approval and creates the PENDING
// ASSESSMENT_GENERATION AiJob whose requestPayload freezes the approved
// questions — all in ONE transaction, mirroring startJobAtomically's contract
// that a state change and its AI record can never half-apply. The
// @@unique([jobId, operation]) invariant makes a second assessment operation
// for this job structurally impossible; its P2002 surfaces as 409 and rolls
// the approval stamp back with it.
async function approveClarificationsAndCreateAssessmentJob({ jobId, approvedAt, clarifications }) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Job" WHERE "id" = ${jobId} FOR UPDATE`;

    const current = await tx.job.findUnique({
      where: { id: jobId },
      select: { clarificationsApprovedAt: true },
    });
    if (!current) {
      return { error: "JOB_NOT_FOUND" };
    }
    if (current.clarificationsApprovedAt) {
      return { error: "ALREADY_APPROVED" };
    }

    // The snapshot is built from the persisted rows (the recruiter's edited
    // state), re-read inside the same transaction that freezes it.
    const job = await tx.job.findUnique({ where: { id: jobId }, include: JOB_DETAIL_INCLUDE });

    await tx.job.update({
      where: { id: jobId },
      data: { clarificationsApprovedAt: approvedAt },
    });

    const aiJob = await createAiJob({
      jobId,
      operation: AI_JOB_OPERATION.ASSESSMENT_GENERATION,
      requestPayload: buildAssessmentGenerationPayload(job, clarifications),
      client: tx,
    });

    return { job, aiJob };
  });
}

// ---------------------------------------------------------------------------
// Job assessment (recruiter CRUD over the AI-generated draft)
// ---------------------------------------------------------------------------

async function findAssessmentWithQuestions(jobId) {
  return prisma.jobAssessment.findUnique({
    where: { jobId },
    include: { questions: { orderBy: { sortOrder: "asc" } } },
  });
}

// Recruiter edits over a DRAFT assessment: scalars + per-question content in
// one transaction. The caller validates DRAFT status and id set-equality
// (questions cannot be silently discarded or reordered out of existence).
async function updateAssessmentContent(jobId, { data, questions = [] }) {
  return prisma.$transaction(async (tx) => {
    if (Object.keys(data).length > 0) {
      await tx.jobAssessment.update({ where: { jobId }, data });
    }
    for (const question of questions) {
      const current = await tx.jobAssessmentQuestion.findFirst({
        where: { id: question.id, assessment: { jobId } },
        select: { id: true },
      });
      if (!current) {
        throw failure(400, "Assessment questions must include every existing question exactly once");
      }
      await tx.jobAssessmentQuestion.update({
        where: { id: question.id },
        data: {
          prompt: question.prompt,
          points: question.points,
          difficulty: question.difficulty ?? null,
        },
      });
    }
    return tx.jobAssessment.findUnique({
      where: { jobId },
      include: { questions: { orderBy: { sortOrder: "asc" } } },
    });
  });
}

// DRAFT → FINALIZED with the opaque public link segment. The CAS keeps a
// double Continue single (count 0 → the caller reports 409); the retry loop
// covers the astronomically unlikely publicId collision. Quota is untouched —
// finalizing is free, exactly like every other workflow action.
async function finalizeAssessment({ assessmentId, jobId }) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const finalized = await prisma.jobAssessment.updateMany({
        where: { id: assessmentId, jobId, status: "DRAFT" },
        data: {
          status: "FINALIZED",
          finalizedAt: new Date(),
          publicId: buildAssessmentPublicId(),
        },
      });
      return finalized.count === 0 ? null : true;
    } catch (error) {
      if (error?.code !== "P2002") throw error;
    }
  }
  throw failure(500, "Could not generate a unique assessment link identifier");
}

// Removes the DRAFT assessment and its questions (questions cascade with the
// assessment). The JOB, its candidate Excel list, the quota ledger and the
// AiJob history are untouched — deleting an assessment never refunds quota and
// never detaches the candidate file.
async function deleteAssessment(jobId) {
  try {
    await prisma.jobAssessment.delete({ where: { jobId } });
    return true;
  } catch (error) {
    if (error?.code === "P2025") return false;
    throw error;
  }
}

// Best-effort StoredFile row deletion used by the service's failure cleanup
// (an association change that fails must not leave the just-uploaded file
// behind). P2025 is tolerated: already deleted means already clean.
async function deleteStoredFileById(fileId) {
  try {
    await prisma.storedFile.delete({ where: { id: fileId } });
  } catch (error) {
    if (error?.code !== "P2025") throw error;
  }
}

// Candidate-facing read of a FINALIZED **and ACTIVATED** assessment by its
// opaque public link segment. Activation is the recruiter's explicit
// "open for invitations" confirmation: a finalized-but-inactive assessment
// resolves to null here (the candidate page 404s), so finalization alone can
// never make an assessment candidate-reachable.
// The projection is deliberately narrow: only what the candidate page
// renders. The recruiter/organization owners, the AiJob row (requestPayload /
// result / provider / worker bookkeeping), the job's candidate Excel list and
// the internal assessment/question ids never leave the server through this
// path. Only FINALIZED + activated assessments are eligible, so a draft's or
// a not-yet-activated assessment's content can never be read through the
// public link.
async function findFinalizedAssessmentByPublicId(publicId) {
  if (typeof publicId !== "string" || publicId.trim() === "") {
    return null;
  }
  return prisma.jobAssessment.findFirst({
    where: { publicId, status: "FINALIZED", activatedAt: { not: null } },
    select: {
      id: true,
      jobId: true,
      publicId: true,
      title: true,
      description: true,
      durationSeconds: true,
      finalizedAt: true,
      questions: {
        orderBy: { sortOrder: "asc" },
        select: {
          section: true,
          prompt: true,
          questionType: true,
          points: true,
          difficulty: true,
          options: true,
          sortOrder: true,
        },
      },
    },
  });
}

// Recruiter ACTIVATION over a FINALIZED assessment: null activatedAt → set.
// CAS on (id, jobId, status=FINALIZED, activatedAt=null) keeps a duplicate
// activation request idempotent — the loser updates 0 rows and the caller
// reports "already active" instead of double-activating. DRAFT assessments
// are structurally refused (they have no link yet), and the write is scoped
// to the exact job so no other job's assessment can ever be touched.
async function activateAssessment({ assessmentId, jobId }) {
  const changed = await prisma.jobAssessment.updateMany({
    where: { id: assessmentId, jobId, status: "FINALIZED", activatedAt: null },
    data: { activatedAt: new Date() },
  });
  return changed.count;
}

// Invitation creation for ONE assessment. Rows carry the full authorization
// triple (jobId, assessmentId, normalized email). The (assessmentId, email)
// unique index plus skipDuplicates makes a duplicate invitation for the same
// candidate + assessment impossible even under a concurrent double-submit. The
// single row-scoped invite service calls this for exactly ONE row at a time; the
// per-email idempotency rules (create / re-send / re-invite) live in that service.
async function createAssessmentInvitations(rows) {
  if (rows.length === 0) {
    return 0;
  }
  const created = await prisma.jobAssessmentInvitation.createMany({
    data: rows,
    skipDuplicates: true,
  });
  return created.count;
}

// The invitation lookup behind every candidate verification call: the exact
// assessment + the normalized invited email. Never query by invitation id or
// by job alone — the (assessment, email) pair IS the authorization handle.
async function findInvitationByAssessmentAndEmail(assessmentId, email) {
  return prisma.jobAssessmentInvitation.findUnique({
    where: { assessmentId_email: { assessmentId, email } },
  });
}

// Stores (or rotates) the email-verification challenge. Only the SHA-256
// hash is persisted; the raw token exists solely long enough to be emailed.
async function setInvitationVerificationChallenge(invitationId, { verificationTokenHash, verificationExpiresAt }) {
  await prisma.jobAssessmentInvitation.update({
    where: { id: invitationId },
    data: { verificationTokenHash, verificationExpiresAt },
  });
}

// INVITED → EMAIL_VERIFIED, CAS-guarded on the invitation still being INVITED
// and the invitation window still open. The token-hash equality check happens
// in the service (timing-safe); this write is the final transition, so a lost
// race (another request verified first) simply updates 0 rows.
async function markInvitationEmailVerified(invitationId) {
  const changed = await prisma.jobAssessmentInvitation.updateMany({
    where: { id: invitationId, status: "INVITED", expiresAt: { gt: new Date() } },
    data: {
      status: "EMAIL_VERIFIED",
      emailVerifiedAt: new Date(),
      verificationTokenHash: null,
      verificationExpiresAt: null,
    },
  });
  return changed.count;
}

// Claims the ONE invitation email for this invitation, atomically.
//
// This is the durable half of the duplicate-invitation rule. The
// (assessmentId, email) unique index already guarantees a single invitation ROW;
// this compare-and-swap guarantees a single invitation EMAIL. Only the caller
// that wins the claim (count === 1) may send. A concurrent double-click, a
// refresh, a browser retry or a duplicate HTTP request all lose the claim and
// therefore send nothing — so retries can never produce a second email.
//
// CAS on `invitationEmailSentAt: null` is what makes it race-safe: two truly
// concurrent callers serialize on the row and exactly one sees the transition.
async function claimInvitationEmailDelivery(invitationId) {
  const changed = await prisma.jobAssessmentInvitation.updateMany({
    where: { id: invitationId, invitationEmailSentAt: null },
    data: { invitationEmailSentAt: new Date() },
  });
  return changed.count;
}

// Releases the claim after a FAILED send.
//
// Without this, one transient SMTP failure would permanently burn the candidate's
// single invitation email: every later retry would lose the claim and the
// candidate could never be reached. Releasing restores the retryable state while
// keeping a SUCCESSFUL send permanently single-shot.
async function releaseInvitationEmailDelivery(invitationId) {
  const changed = await prisma.jobAssessmentInvitation.updateMany({
    where: { id: invitationId },
    data: { invitationEmailSentAt: null },
  });
  return changed.count;
}

// Re-invite after expiry: the service computes the fresh deadline from the
// SAME invitation-window mapping (never a second expiry calculation); this
// write only extends the stored window while the invitation is still INVITED.
// CAS on status keeps a concurrently verified invitation untouched — the loser
// updates 0 rows and re-reads the winner instead.
//
// The delivery claim is CLEARED as part of the same guarded write: a re-invite
// opens a NEW invitation window, and the candidate must be able to receive the
// invitation email for that new window. The (assessmentId, email) row is still
// reused, so this is a re-invite, never a second invitation.
async function refreshInvitationWindow(invitationId, expiresAt) {
  const changed = await prisma.jobAssessmentInvitation.updateMany({
    where: { id: invitationId, status: "INVITED" },
    data: { expiresAt, invitationEmailSentAt: null },
  });
  return changed.count;
}

// The automatic-expiration sweep's ONLY read: every ACTIVE job whose persisted
// availability deadline (Job.analysisEndsAt) has already passed, oldest deadline
// first.
//
// It is a plain query against persisted timestamps — no in-memory bookkeeping, no
// "last run" cursor, nothing that a process restart could lose. That is what lets
// a fresh process (or a second instance) pick up exactly the same work.
async function findExpiredActiveJobs(now = new Date()) {
  return prisma.job.findMany({
    where: {
      status: JOB_STATUS.ACTIVE,
      analysisEndsAt: { not: null, lte: now },
    },
    select: { id: true, title: true, analysisEndsAt: true },
    orderBy: { analysisEndsAt: "asc" },
  });
}

// Closes ONE expired job, guarded so that only ONE caller can ever win.
//
// The compare-and-swap on `status: ACTIVE` is the whole safety argument:
//   * two instances racing on the same job -> the loser updates 0 rows;
//   * a duplicate scheduler tick after the first closed it -> 0 rows, no-op;
//   * a process restart -> the row is already CLOSED, so it is never revisited.
// So the sweep is idempotent and safe under concurrency without any lock, and it
// NEVER deletes anything: the job, its candidates, invitations, attempts,
// answers, scores, analyses and reports all remain untouched for the recruiter.
async function closeExpiredJobAtomically(jobId, closedAt) {
  const closed = await prisma.job.updateMany({
    where: { id: jobId, status: JOB_STATUS.ACTIVE, analysisEndsAt: { lte: closedAt } },
    data: {
      status: JOB_STATUS.CLOSED,
      closedAt,
      closedReason: JOB_CLOSED_REASON.SYSTEM_EXPIRED,
    },
  });
  return closed.count;
}

// Who to notify when a job expires. A job is owned either by an individual
// recruiter (recruiterId) or by an organization (organizationId, whose owner
// receives it), so the notification goes to a real User in both cases. This is a
// minimal projection: ids only, no candidate data, no job payload.
async function findJobNotificationOwner(jobId) {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: {
      recruiterId: true,
      organization: { select: { ownerId: true } },
    },
  });
  if (!job) {
    return null;
  }
  return { userId: job.recruiterId ?? job.organization?.ownerId ?? null };
}

module.exports = {
  JOB_STATUS,
  JOB_CLOSED_REASON,
  findExpiredActiveJobs,
  closeExpiredJobAtomically,
  findJobNotificationOwner,
  refreshInvitationWindow,
  createJobWithChildren,
  updateJobWithChildren,
  findJobById,
  listJobsByRecruiter,
  listJobsByOrganization,
  countQuotaConsumptions,
  getSubscriptionWithPlan,
  startJobAtomically,
  closeJobAtomically,
  findCandidateListWithFile,
  replaceJobCandidateList,
  deleteJobCandidateList,
  deleteStoredFileById,
  findAiJobByOperation,
  seedClarificationQuestions,
  updateClarificationQuestions,
  approveClarificationsAndCreateAssessmentJob,
  findAssessmentWithQuestions,
  updateAssessmentContent,
  finalizeAssessment,
  deleteAssessment,
  findFinalizedAssessmentByPublicId,
  activateAssessment,
  createAssessmentInvitations,
  findInvitationByAssessmentAndEmail,
  setInvitationVerificationChallenge,
  claimInvitationEmailDelivery,
  releaseInvitationEmailDelivery,
  markInvitationEmailVerified,
};

