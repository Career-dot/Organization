/* eslint-disable no-console */
// Classify an address against the REAL database, exactly as the recruiter
// candidate workflow does. Diagnostic only — it performs no writes.
//
//   npm run candidate:check-email -- areebadastageer924@gmail.com
//
// Prints, for each address: the stored User row (if any), its roles, whether the
// production repository query returns it, and the resulting IN_SYSTEM /
// NOT_IN_SYSTEM verdict. Use this to confirm an address really is a registered
// CANDIDATE (EMPLOYEE) account before trusting what the UI shows.
require("dotenv").config();

const prisma = require("../src/config/prisma");
const jobCandidateRepository = require("../src/module/job/jobCandidate.repository");
const { classifyCandidateRows } = require("../src/module/job/jobCandidate.classification");

const normalizeEmail = (email) => String(email ?? "").trim().toLowerCase();

const addresses = process.argv.slice(2);

const main = async () => {
  if (addresses.length === 0) {
    console.error("usage: npm run candidate:check-email -- <email> [<email> ...]");
    process.exitCode = 2;
    return;
  }

  for (const input of addresses) {
    const email = normalizeEmail(input);
    const normalizedChanged = input !== email;

    const exact = await prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, status: true, isDeleted: true },
    });
    const anyCase = await prisma.user.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
      select: {
        id: true,
        email: true,
        status: true,
        isDeleted: true,
        roles: { select: { role: { select: { name: true } } } },
      },
    });

    const found = await jobCandidateRepository.findCandidateAccountsByEmails([email]);
    const { candidates } = classifyCandidateRows({
      rows: [{ rowIndex: null, name: null, email }],
      accountsByEmail: Object.fromEntries(
        found.map((a) => [normalizeEmail(a.email), { userId: a.id, status: a.status }])
      ),
      verificationByUserId: {},
      invitationsByEmail: {},
    });

    console.log(`\n=== input: ${JSON.stringify(input)} ===`);
    console.log(`  normalized              : ${email}${normalizedChanged ? "  (input was changed by normalization)" : ""}`);
    console.log(`  exact User.email match  : ${exact ? exact.id : "NONE"}`);
    console.log(`  case-insensitive match  : ${anyCase ? `${anyCase.id} (stored as ${JSON.stringify(anyCase.email)})` : "NONE"}`);
    if (anyCase) {
      console.log(`  roles                   : ${anyCase.roles.map((r) => r.role.name).join(", ") || "(none)"}`);
      console.log(`  status / isDeleted      : ${anyCase.status} / ${anyCase.isDeleted}`);
    }
    console.log(`  production query result : ${found.length ? JSON.stringify(found) : "NO MATCH"}`);
    console.log(`  VERDICT                 : ${candidates[0].systemStatus}`);
    if (anyCase && !found.length) {
      console.log(
        "  NOTE: an account exists but is NOT a candidate account — the EMPLOYEE role is what counts."
      );
    }
    if (!anyCase) {
      console.log("  NOTE: no User row has this address at all, so it can never be IN_SYSTEM.");
    }
  }
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
