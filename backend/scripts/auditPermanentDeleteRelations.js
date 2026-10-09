/* eslint-disable no-console */
// PHASE 1 AUDIT — enumerate every FK that cascades from a deleted recruiter's
// User row, so we can prove that NO historical job/candidate/assessment/analysis
// row is destroyed by the delete. Read-only; writes nothing.
require("dotenv").config();
const prisma = require("../src/config/prisma");

// Tables whose rows must SURVIVE a recruiter deletion: they are the
// organization's historical record.
const HISTORICAL_TABLES = [
  "Job",
  "JobCandidateReference",
  "JobAssessment",
  "JobAssessmentAttempt",
  "JobAssessmentAttemptAnswer",
  "JobAssessmentAttemptIntegrityEvent",
  "JobCandidateAnalysis",
  "AiJob",
  "JobAssessmentInvitation",
];

const main = async () => {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT con.conname AS name,
           rel.relname AS child_table,
           pg_get_constraintdef(con.oid) AS def
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_class parent ON parent.oid = con.confrelid
    WHERE con.contype = 'f'
      AND parent.relname = 'User'
      AND con.confdeltype = 'c'
    ORDER BY rel.relname
  `);

  const cascaded = rows.map((r) => r.child_table);
  console.log("=== FKs that CASCADE when a User is deleted ===");
  rows.forEach((r) => console.log(`  ${r.child_table}  (${r.name})`));

  console.log(`\n=== CASCADE check against historical tables (must all be 'SAFE') ===`);
  let unsafe = 0;
  for (const table of HISTORICAL_TABLES) {
    const hit = cascaded.includes(table);
    if (hit) unsafe += 1;
    console.log(`  ${hit ? "UNSAFE - CASCADES" : "SAFE   - not cascaded"}  ${table}`);
  }

  console.log(`\nHistorical tables destroyed by the delete: ${unsafe} (must be 0)`);

  // Confirm the Job ownership links detach rather than block or cascade.
  const jobFks = await prisma.$queryRawUnsafe(`
    SELECT con.conname AS name, con.confdeltype AS rule,
           pg_get_constraintdef(con.oid) AS def
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_class parent ON parent.oid = con.confrelid
    WHERE con.contype = 'f' AND rel.relname = 'Job' AND parent.relname = 'User'
    ORDER BY con.conname
  `);
  const ruleName = { a: "NO ACTION", r: "RESTRICT", c: "CASCADE", n: "SET NULL", d: "SET DEFAULT" };
  console.log("\n=== Job -> User ownership links ===");
  jobFks.forEach((f) => console.log(`  ${f.name}: ${ruleName[f.rule]} (${f.rule})`));
  const allSetNull = jobFks.length === 2 && jobFks.every((f) => f.rule === "n");
  console.log(`Both Job ownership links are SET NULL: ${allSetNull}`);

  process.exitCode = unsafe === 0 && allSetNull ? 0 : 1;
};

main()
  .catch((e) => {
    console.error("ERR", e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());