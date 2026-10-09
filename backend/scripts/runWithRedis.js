/* eslint-disable */
/* Temporary helper: starts an in-memory Redis instance and runs a verifier script. */
const { RedisMemoryServer } = require("redis-memory-server");

(async () => {
  const r = new RedisMemoryServer({
    binary: {
      redisPort: 6379,
      redisHost: "127.0.0.1",
    },
  });

  await r.start();
  const port = await r.getPort();
  console.error(`[runWithRedis] Redis started on port ${port}`);

  if (port !== 6379) {
    process.env.REDIS_URL = `redis://127.0.0.1:${port}`;
  } else {
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
  }

  // The verifier script reads env at call time (redis.js reads REDIS_URL lazily).
  const verifierArg = process.argv[2];
  if (!verifierArg) {
    console.error("[runWithRedis] Usage: node runWithRedis.js <verifier-script>");
    process.exit(2);
  }

  // Spawn the verifier as a child process that inherits stdout/stderr.
  const { spawn } = require("node:child_process");
  const child = spawn(process.execPath, [verifierArg], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: "inherit",
  });

  child.on("close", async (code) => {
    console.error(`[runWithRedis] Verifier exited with code ${code}`);
    try {
      await r.stop();
    } catch {
      /* best effort */
    }
    process.exit(code);
  });

  child.on("error", async (err) => {
    console.error("[runWithRedis] Failed to start verifier:", err.message);
    try {
      await r.stop();
    } catch {
      /* best effort */
    }
    process.exit(1);
  });
})();
