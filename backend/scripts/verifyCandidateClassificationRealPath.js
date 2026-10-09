/* eslint-disable no-console */
// REAL-PATH regression for the reported bug:
//   "a registered EMPLOYEE added MANUALLY still shows NOT_IN_SYSTEM".
//
// This harness exists BECAUSE verifyCandidateClassification.js calls
// jobService.addManualJobCandidate() DIRECTLY: it never exercises the Express
// route, the authorize/validate middlewares, or the final GET /candidates list
// DTO that the recruiter UI actually renders. It also creates its own EMPLOYEE
// fixture, which cannot prove anything about the real accounts already present
// in this database.
//
// So this harness:
//   1. boots the REAL Express app on an ephemeral port;
//   2. picks a REAL, already-registered EMPLOYEE row that exists in PostgreSQL
//      BEFORE this run (never one it creates) and prints that row;
//   3. POSTs /api/job/:jobId/candidates over HTTP with that address;
//   4. GETs /api/job/:jobId/candidates over HTTP and asserts the FINAL list
//      DTO reports IN_SYSTEM (and NOT_IN_SYSTEM for an external address).
//
// Run with: npm run verify:candidate-classification-realpath
require("dotenv").config();

const http = require("node:http");
const XLSX = require("xlsx");

const prisma = require("../src/config/prisma");
const app = require("../src/app");
const jobService = require("../src/module/job/job.service");
const generateAccessToken = require("../src/utils/generateAccessToken");
const { cleanupJobCandidateLists } = require("./jobCandidateListFixture");

const SUFFIX = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const results = [];
const created = { jobIds: [], planIds: [], subscriptionIds: [] };

const section = (t) => console.log(`\n${t}`);
const check = (label, ok, detail) => {
  results.push({ label, ok: Boolean(ok) });
  console.log(
    !ok && detail ? `  FAIL  ${label}\n        -> ${detail}` : `  ${ok ? "PASS" : "FAIL"}  ${label}`
  );
};
const summarize = (v) => JSON.stringify(v ?? null);
const normalizeEmail = (email) => String(email ?? "").trim().toLowerCase();

const startServer = () =>
  new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, origin: `http://127.0.0.1:${server.address().port}` })
    );
  });

const call = async (origin, pathname, { method = "GET", token, body } = {}) => {
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status: response.status, json };
};

const buildSheet = (rows) => {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  return XLSX.write(
    { SheetNames: ["Candidates"], Sheets: { Candidates: sheet } },
    { type: "buffer", bookType: "xlsx" }
  );
};

const JOB_PAYLOAD = {
  description: "Harness job verifying the real manual-candidate HTTP path.",
  analysisDays: 3,
  skills: [{ name: "Node.js", weight: 100 }],
  questions: [{ question: "Describe a system you have operated in production." }],
};

const makeRecruiter = async () => {
  const user = await prisma.user.create({
    data: {
      email: `realpath-recruiter-${SUFFIX}@example.test`,
      fullName: "Real Path Harness Recruiter",
      provider: "LOCAL",
      emailVerified: true,
      status: "ACTIVE",
    },
  });
  const role = await prisma.role.findUnique({ where: { name: "RECRUITER" } });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  const plan = await prisma.subscriptionPlan.create({
    data: {
      name: `Real Path Plan ${SUFFIX}`,
      type: "RECRUITER",
      price: 0,
      billingCycle: "MONTHLY",
      jobPostingLimit: 5,
    },
  });
  const subscription = await prisma.subscription.create({
    data: {
      planId: plan.id,
      userId: user.id,
      status: "ACTIVE",
      startDate: new Date(),
      expiryDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });
  created.planIds.push(plan.id);
  created.subscriptionIds.push(subscription.id);
  // The job service reads the AUTHENTICATED PRINCIPAL (user.id + user.role), not the raw
  // Prisma row (which has a roles relation and no role column, so the row itself
  // resolves to scope "none" and 403s). The row IS real, so ownership and FK
  // cleanup behave exactly like production.
  return { id: user.id, role: "RECRUITER" };
};

// A job whose sheet deliberately contains NEITHER address under test, so the
// manual candidate is genuinely absent from the Excel list.
const newJobWithSheet = async (recruiter, label) => {
  const draft = await jobService.createDraft(recruiter, {
    ...JOB_PAYLOAD,
    title: `Real path ${label} ${SUFFIX}`,
  });
  created.jobIds.push(draft.id);
  const buffer = buildSheet([
    ["Name", "Email"],
    ["Sheet", `realpath-sheet-${SUFFIX}@example.test`],
  ]);
  await jobService.uploadCandidateList(recruiter, draft.id, {
    originalname: `realpath-${label}-${SUFFIX}.xlsx`,
    mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size: buffer.byteLength,
    buffer,
  });
  return draft;
};

const run = async () => {
  console.log(`Real-path candidate classification harness (${SUFFIX})`);

  section("1. Real registered EMPLOYEE already in PostgreSQL (not created here)");
  // EVERY real EMPLOYEE account in the database, not just the first one: that
  // covers an EMPLOYEE who ALSO carries ORG_ADMIN, which the contract still
  // counts as an eligible candidate (only EMPLOYEE marks a candidate account).
  const realEmployees = await prisma.user.findMany({
    where: { isDeleted: false, roles: { some: { role: { name: "EMPLOYEE" } } } },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      email: true,
      status: true,
      isDeleted: true,
      roles: { select: { role: { select: { name: true } } } },
    },
  });
  console.log(`  real EMPLOYEE accounts found: ${realEmployees.length}`);
  for (const employee of realEmployees) {
    console.log(`    - ${employee.email}  roles=[${employee.roles.map((r) => r.role.name).join(", ")}] status=${employee.status}`);
  }
  const realEmployee = realEmployees[0];
  if (!realEmployee) {
    throw new Error("No EMPLOYEE account exists in this database to test against");
  }
  const registeredEmail = normalizeEmail(realEmployee.email);
  console.log(
    `  real User row: ${summarize({
      id: realEmployee.id,
      storedEmail: realEmployee.email,
      normalized: registeredEmail,
      status: realEmployee.status,
      isDeleted: realEmployee.isDeleted,
      roles: realEmployee.roles.map((r) => r.role.name),
    })}`
  );
  const externalEmail = `realpath-external-${SUFFIX}@example.test`;

  const { server, origin } = await startServer();
  try {
    const recruiter = await makeRecruiter();
    const token = generateAccessToken({ userId: recruiter.id, role: "RECRUITER" });
    const draft = await newJobWithSheet(recruiter, "primary");
    const listPath = `/api/job/${draft.id}/candidates`;

    section("2. POST /api/job/:jobId/candidates — real registered EMPLOYEE");
    const postRegistered = await call(origin, listPath, {
      method: "POST",
      token,
      body: { email: registeredEmail },
    });
    check("POST accepts a real registered EMPLOYEE address", postRegistered.status === 201, summarize(postRegistered));
    check(
      "POST response already reports IN_SYSTEM",
      postRegistered.json?.data?.candidate?.systemStatus === "IN_SYSTEM",
      summarize(postRegistered.json?.data?.candidate)
    );
    console.log(`  POST registered -> ${summarize(postRegistered.json?.data?.candidate)}`);

    section("3. GET /api/job/:jobId/candidates — the FINAL rendered list DTO");
    const listAfter = await call(origin, listPath, { token });
    check("GET candidate list succeeds", listAfter.status === 200, summarize(listAfter.json));
    const rows = listAfter.json?.data?.candidates ?? [];
    const registeredRow = rows.find((r) => r.email === registeredEmail);
    check(
      "the manually added real EMPLOYEE appears in the list",
      Boolean(registeredRow),
      summarize(rows.map((r) => ({ email: r.email, systemStatus: r.systemStatus })))
    );
    check(
      "the manually added real EMPLOYEE is IN_SYSTEM in the FINAL list DTO",
      registeredRow?.systemStatus === "IN_SYSTEM",
      summarize(registeredRow)
    );
    console.log(
      `  list row -> ${summarize({
        email: registeredRow?.email,
        systemStatus: registeredRow?.systemStatus,
        candidateUserId: registeredRow?.candidateUserId,
        referenceId: registeredRow?.referenceId,
      })}`
    );


    // ---- 3b. EVERY real EMPLOYEE account, over HTTP ----------------------
    // Includes an EMPLOYEE who ALSO holds ORG_ADMIN: the contract says only the
    // EMPLOYEE role marks a candidate account, so that row must be IN_SYSTEM too.
    section("3b. Every real EMPLOYEE account in the database, over HTTP");
    for (const employee of realEmployees.slice(1)) {
      const otherEmail = normalizeEmail(employee.email);
      const post = await call(origin, listPath, {
        method: "POST",
        token,
        body: { email: otherEmail },
      });
      const get = await call(origin, listPath, { token });
      const row = (get.json?.data?.candidates ?? []).find((r) => r.email === otherEmail);
      const roleNames = employee.roles.map((r) => r.role.name).join("+");
      check(
        `real EMPLOYEE ${otherEmail} [${roleNames}] is IN_SYSTEM in the final list DTO`,
        post.status === 201 &&
          post.json?.data?.candidate?.systemStatus === "IN_SYSTEM" &&
          row?.systemStatus === "IN_SYSTEM",
        summarize({ post: post.json?.data?.candidate?.systemStatus, list: row?.systemStatus })
      );
    }

    section("4. POST + GET — external (unregistered) address");
    const postExternal = await call(origin, listPath, { method: "POST", token, body: { email: externalEmail } });
    check("POST accepts an external address", postExternal.status === 201, summarize(postExternal));
    check(
      "POST reports NOT_IN_SYSTEM for an unregistered address",
      postExternal.json?.data?.candidate?.systemStatus === "NOT_IN_SYSTEM",
      summarize(postExternal.json?.data?.candidate)
    );
    const listAfterExternal = await call(origin, listPath, { token });
    const externalRow = (listAfterExternal.json?.data?.candidates ?? []).find((r) => r.email === externalEmail);
    check(
      "the external address is NOT_IN_SYSTEM in the FINAL list DTO",
      externalRow?.systemStatus === "NOT_IN_SYSTEM",
      summarize(externalRow)
    );

    section("5. Case/whitespace normalization on the real address");
    const messy = `  ${registeredEmail.toUpperCase()}  `;
    const messyJob = await newJobWithSheet(recruiter, "messy");
    const messyPost = await call(origin, `/api/job/${messyJob.id}/candidates`, {
      method: "POST",
      token,
      body: { email: messy },
    });
    check(
      "POST with uppercase+whitespace normalizes to the registered address and is IN_SYSTEM",
      messyPost.json?.data?.candidate?.email === registeredEmail &&
        messyPost.json?.data?.candidate?.systemStatus === "IN_SYSTEM",
      summarize(messyPost.json?.data?.candidate)
    );

    section("6. Duplicate protection over HTTP (one reference, no invitation)");
    const beforeDup = await prisma.jobCandidateReference.count({
      where: { jobId: draft.id, candidateEmail: registeredEmail },
    });
    const dup = await call(origin, listPath, {
      method: "POST",
      token,
      body: { email: registeredEmail.toUpperCase() },
    });
    const afterDup = await prisma.jobCandidateReference.count({
      where: { jobId: draft.id, candidateEmail: registeredEmail },
    });
    check(
      "re-adding the same address creates NO second reference",
      beforeDup === 1 && afterDup === 1,
      summarize({ beforeDup, afterDup })
    );
    check(
      "the duplicate POST still classifies IN_SYSTEM (same candidate, same answer)",
      dup.json?.data?.candidate?.systemStatus === "IN_SYSTEM",
      summarize(dup.json?.data?.candidate)
    );
    check(
      "no invitation was ever created by manual addition",
      (await prisma.jobAssessmentInvitation.count({ where: { jobId: draft.id } })) === 0,
      "manual addition must never create an invitation"
    );

    section("7. Cross-job isolation");
    const jobBList = await call(origin, `/api/job/${messyJob.id}/candidates`, { token });
    const jobBRow = (jobBList.json?.data?.candidates ?? []).find((r) => r.email === registeredEmail);
    check(
      "the same address in another job is its own job-scoped reference",
      Boolean(jobBRow) && jobBRow.referenceId !== registeredRow.referenceId,
      summarize({ jobA: registeredRow?.referenceId, jobB: jobBRow?.referenceId })
    );
    check(
      "both jobs classify the same real address identically",
      jobBRow?.systemStatus === "IN_SYSTEM",
      summarize(jobBRow?.systemStatus)
    );

    section("8. Rejections over HTTP");
    const withStatus = await call(origin, listPath, {
      method: "POST",
      token,
      body: { email: externalEmail, status: "IN_SYSTEM" },
    });
    check("a client-supplied status is rejected (400), never trusted", withStatus.status === 400, summarize(withStatus));
    const noAuth = await call(origin, listPath, { method: "POST", body: { email: externalEmail } });
    check("an unauthenticated manual add is rejected (401)", noAuth.status === 401, summarize(noAuth));
    const badEmail = await call(origin, listPath, { method: "POST", token, body: { email: "not-an-email" } });
    check("an invalid email is rejected (400)", badEmail.status === 400, summarize(badEmail));

    section("9. No user creation, no user modification");
    check(
      "the external address still has NO User row",
      (await prisma.user.count({ where: { email: externalEmail } })) === 0,
      "manual addition must never create an account"
    );
    const stillEmployee = await prisma.user.findUnique({
      where: { id: realEmployee.id },
      select: { email: true, status: true, isDeleted: true },
    });
    check(
      "the real EMPLOYEE row is untouched",
      stillEmployee.email === realEmployee.email && stillEmployee.status === realEmployee.status,
      summarize({
        before: { email: realEmployee.email, status: realEmployee.status },
        after: stillEmployee,
      })
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

const cleanup = async () => {
  for (const jobId of created.jobIds) {
    await prisma.jobCandidateReference.deleteMany({ where: { jobId } });
  }
  if (created.jobIds.length) {
    await cleanupJobCandidateLists(prisma, created.jobIds);
    await prisma.job.deleteMany({ where: { id: { in: created.jobIds } } });
  }
  if (created.subscriptionIds.length) {
    await prisma.subscription.deleteMany({ where: { id: { in: created.subscriptionIds } } });
  }
  if (created.planIds.length) {
    await prisma.subscriptionPlan.deleteMany({ where: { id: { in: created.planIds } } });
  }
  await prisma.userRole.deleteMany({
    where: { user: { email: { startsWith: `realpath-recruiter-${SUFFIX}` } } },
  });
  await prisma.user.deleteMany({
    where: { email: { startsWith: `realpath-recruiter-${SUFFIX}` } },
  });
};

run()
  .catch((error) => {
    console.error("\nUNEXPECTED ERROR:", error);
    check("the real-path harness ran without an unexpected error", false, error.message);
  })
  .finally(async () => {
    section("Cleanup");
    try {
      await cleanup();
      console.log("  harness rows removed");
    } catch (error) {
      check("cleanup succeeded", false, error.message);
    }
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length) {
      console.log("FAILED CHECKS:");
      failed.forEach((f) => console.log(`  - ${f.label}`));
      process.exitCode = 1;
    } else {
      console.log(
        "Real-path candidate classification verified: a real registered EMPLOYEE added " +
          "manually over HTTP is IN_SYSTEM in the final list DTO; an unregistered address is NOT_IN_SYSTEM."
      );
    }
    await prisma.$disconnect();
  });
