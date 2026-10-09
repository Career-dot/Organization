require("dotenv").config();

const app = require("./app");
const prisma = require("./config/prisma");
const {
  startJobExpirationScheduler,
  stopJobExpirationScheduler,
} = require("./module/job/jobExpiration.scheduler");

const PORT = process.env.PORT || 5000;


async function startServer() {
  try {

    await prisma.$connect();

    console.log("✅ Database connected successfully");


    app.listen(PORT, () => {
      console.log("=================================");
      console.log(`🚀 Server running on Port ${PORT}`);
      console.log("=================================");
    });

    // Job expiration is server-authoritative: the availability window a recruiter
    // set is enforced by this process from PERSISTED timestamps, with no browser,
    // no open dashboard and no page refresh involved. It starts only after the
    // database is connected, and it also runs once immediately so anything that
    // expired while the process was down is closed on boot.
    startJobExpirationScheduler();

    const shutdown = () => {
      stopJobExpirationScheduler();
      process.exit(0);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);


  } catch (error) {

    console.error("❌ Database connection failed");
    console.error(error);

    process.exit(1);
  }
}


startServer();