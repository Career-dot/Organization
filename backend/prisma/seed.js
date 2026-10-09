const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

async function main() {

  console.log("Starting database seed...");


  const roles = [
    {
      name: "EMPLOYEE",
      description: "Candidate or employee profile user"
    },
    {
      name: "RECRUITER",
      description: "Recruiter who evaluates and manages candidates"
    },
    {
      name: "ORG_ADMIN",
      description: "Organization administrator who manages recruiters"
    },
    {
      name: "SUPER_ADMIN",
      description: "Platform administrator"
    }
  ];


  for (const role of roles) {

    await prisma.role.upsert({

      where: {
        name: role.name
      },

      update: {
        description: role.description
      },

      create: {
        name: role.name,
        description: role.description
      }

    });

  }


  console.log("Roles created successfully");


  const subscriptionPlans = [
    {
      name: "Recruiter Pro",
      type: "RECRUITER",
      price: 25,
      billingCycle: "MONTHLY",
      maxUsers: null,
      description: "Recruiter Pro plan"
    },
    {
      name: "Organization 10",
      type: "ORGANIZATION",
      price: 270,
      billingCycle: "MONTHLY",
      maxUsers: 10,
      description: "Organization plan for up to 10 users"
    },
    {
      name: "Organization 25",
      type: "ORGANIZATION",
      price: 625,
      billingCycle: "MONTHLY",
      maxUsers: 25,
      description: "Organization plan for up to 25 users"
    },
    {
      name: "Organization 50",
      type: "ORGANIZATION",
      price: 1250,
      billingCycle: "MONTHLY",
      maxUsers: 50,
      description: "Organization plan for up to 50 users"
    }
  ];

  for (const plan of subscriptionPlans) {

    const existing = await prisma.subscriptionPlan.findFirst({
      where: { name: plan.name }
    });

    if (existing) {

      await prisma.subscriptionPlan.update({
        where: { id: existing.id },
        data: plan
      });

    } else {

      await prisma.subscriptionPlan.create({
        data: plan
      });

    }

  }


  console.log("Subscription plans created successfully");


}


main()
  .catch((error) => {

    console.error("Seed failed:");
    console.error(error);

    process.exit(1);

  })

  .finally(async () => {

    await prisma.$disconnect();

  });