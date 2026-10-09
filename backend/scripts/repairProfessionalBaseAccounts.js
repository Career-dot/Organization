const prisma = require("../src/config/prisma");

const repairProfessionalBaseAccounts = async () => {
  const employeeRole = await prisma.role.findUnique({
    where: { name: "EMPLOYEE" },
  });

  if (!employeeRole) {
    throw new Error("EMPLOYEE role is not configured");
  }

  const users = await prisma.user.findMany({
    where: {
      OR: [
        { roles: { some: { role: { name: "RECRUITER" } } } },
        { roles: { some: { role: { name: "ORG_ADMIN" } } } },
      ],
    },
    select: {
      id: true,
      email: true,
      roles: { select: { role: { select: { name: true } } } },
      employeeProfile: { select: { id: true } },
    },
  });

  const repairCandidates = users.filter(
    (user) =>
      !user.roles.some(({ role }) => role.name === "EMPLOYEE") ||
      !user.employeeProfile
  );

  for (const user of repairCandidates) {
    await prisma.$transaction(async (tx) => {
      await tx.userRole.upsert({
        where: {
          userId_roleId: { userId: user.id, roleId: employeeRole.id },
        },
        update: {},
        create: { userId: user.id, roleId: employeeRole.id },
      });

      await tx.employeeProfile.upsert({
        where: { userId: user.id },
        update: {},
        create: { userId: user.id },
      });
    });

    console.log(`Repaired Employee account for ${user.email}`);
  }

  console.log(`Professional base-account repairs applied: ${repairCandidates.length}`);
};

repairProfessionalBaseAccounts()
  .catch((error) => {
    console.error("Professional base-account repair failed:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });