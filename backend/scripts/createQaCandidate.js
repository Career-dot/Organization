const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcrypt");
const prisma = new PrismaClient();
(async () => {
  const email = "qa.candidate.test@example.com";
  const passwordHash = await bcrypt.hash("TestPass123!", 12);
  const user = await prisma.user.upsert({
    where: { email },
    update: {
      fullName: "QA Candidate",
      passwordHash,
      emailVerified: true,
      status: "ACTIVE",
      provider: "LOCAL",
      mustChangePassword: false,
    },
    create: {
      email,
      fullName: "QA Candidate",
      passwordHash,
      emailVerified: true,
      status: "ACTIVE",
      provider: "LOCAL",
      mustChangePassword: false,
    },
  });
  const role = await prisma.role.findUnique({ where: { name: "EMPLOYEE" } });
  if (!role) throw new Error("EMPLOYEE role missing");
  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: user.id, roleId: role.id } },
    update: {},
    create: { userId: user.id, roleId: role.id },
  });
  console.log(JSON.stringify({ email, id: user.id }, null, 2));
})().catch((err) => {
  console.error(err);
  process.exit(1);
}).finally(() => prisma.$disconnect());
