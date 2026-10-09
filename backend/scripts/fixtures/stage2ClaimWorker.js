// Test-only processor for the Stage-2 claim boundary. Never imported by production.
const { startAiJobWorker, processAiJob } = require("../../src/ai-worker");
const repo = require("../../src/module/ai-job/aiJob.repository");
const processor = async (delivery, workerId) => {
  const row = await repo.findAiJobById(delivery.data.aiJobId);
  if (!row || row.status !== "PENDING" || !row.requestPayload) return processAiJob(delivery, workerId);
  const claimed = await repo.claimAiJobForProcessing({ aiJobId: row.id, workerId });
  if (!claimed) return { skipped: "CLAIM_LOST" };
  console.log(`[aiWorker] ${workerId} claimed AiJob ${row.id}`);
  console.log("TEST ONLY: AI execution not implemented in Stage 2 claim-boundary probe");
  return { status: "PROCESSING" };
};
startAiJobWorker({ processor }).catch(() => { process.exitCode = 1; });
