// One-time, manually-invoked SUPER_ADMIN bootstrap.
//
// Run with:  npm run bootstrap:super-admin
//
// Reads SUPER_ADMIN_BOOTSTRAP_EMAIL / SUPER_ADMIN_BOOTSTRAP_PASSWORD from the
// local environment (never from source, never from seed.js, never
// hardcoded). Idempotent: if a SUPER_ADMIN already exists anywhere in the
// system, this exits 0 having made no change. The plaintext password is
// held only in memory for the duration of hashing and is never logged,
// printed, returned, or persisted anywhere.
//
// After a successful run, remove or rotate SUPER_ADMIN_BOOTSTRAP_PASSWORD in
// your local .env — this script does not and cannot do that for you.
require("dotenv").config();

const { z } = require("zod");
const prisma = require("../src/config/prisma");
const hashPassword = require("../src/utils/hashPassword");
const { findRoleByName } = require("../src/module/auth/auth.repository");
const { validatePasswordStrength } = require("../src/module/auth/auth.service");

const emailSchema = z.string().trim().email();

async function main() {
  const email = process.env.SUPER_ADMIN_BOOTSTRAP_EMAIL;
  const password = process.env.SUPER_ADMIN_BOOTSTRAP_PASSWORD;

  if (!email || !password) {
    console.error(
      "Bootstrap aborted: SUPER_ADMIN_BOOTSTRAP_EMAIL and SUPER_ADMIN_BOOTSTRAP_PASSWORD must both be set in the environment."
    );
    process.exitCode = 1;
    return;
  }

  const emailResult = emailSchema.safeParse(email);

  if (!emailResult.success) {
    console.error("Bootstrap aborted: SUPER_ADMIN_BOOTSTRAP_EMAIL is not a valid email address.");
    process.exitCode = 1;
    return;
  }

  const normalizedEmail = emailResult.data.toLowerCase();

  try {
    validatePasswordStrength(password);
  } catch (error) {
    console.error(`Bootstrap aborted: SUPER_ADMIN_BOOTSTRAP_PASSWORD does not meet the password policy — ${error.message}`);
    process.exitCode = 1;
    return;
  }

  // Idempotency guard: a SUPER_ADMIN existing ANYWHERE (not just at this
  // email) stops the run — this is a one-time platform bootstrap, not a
  // way to create additional admins.
  const existingSuperAdmin = await prisma.user.findFirst({
    where: { roles: { some: { role: { name: "SUPER_ADMIN" } } } },
    select: { id: true, email: true },
  });

  if (existingSuperAdmin) {
    console.log(
      `Bootstrap skipped: a SUPER_ADMIN account already exists (${existingSuperAdmin.email}). No change made.`
    );
    return;
  }

  const existingUserWithEmail = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: { id: true },
  });

  if (existingUserWithEmail) {
    console.error(
      "Bootstrap aborted: an account with SUPER_ADMIN_BOOTSTRAP_EMAIL already exists (as a non-SUPER_ADMIN user) — choose a different bootstrap email."
    );
    process.exitCode = 1;
    return;
  }

  const superAdminRole = await findRoleByName("SUPER_ADMIN");

  if (!superAdminRole) {
    console.error("Bootstrap aborted: the SUPER_ADMIN role is not seeded. Run the Prisma seed first.");
    process.exitCode = 1;
    return;
  }

  const passwordHash = await hashPassword(password);

  await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        fullName: "Platform Administrator",
        email: normalizedEmail,
        passwordHash,
        provider: "LOCAL",
        // Manually bootstrapped by the operator — vouched for the same way
        // organization-created recruiters are (see createActiveRecruiter in
        // organization.repository.js): no email-verification loop needed.
        emailVerified: true,
        status: "ACTIVE",
        roles: { create: { roleId: superAdminRole.id } },
      },
    });

    await tx.passwordHistory.create({
      data: { userId: user.id, passwordHash },
    });
  });

  console.log(`SUPER_ADMIN account created successfully for ${normalizedEmail}.`);
  console.log(
    "Remove or rotate SUPER_ADMIN_BOOTSTRAP_PASSWORD in your local environment now that bootstrap is complete."
  );
}

main()
  .catch((error) => {
    console.error("Bootstrap failed:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
