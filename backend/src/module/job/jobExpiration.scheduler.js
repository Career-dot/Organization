// ---------------------------------------------------------------------------
// The job-expiration scheduler.
//
// This is the ONLY periodic timer this feature owns. It is deliberately a plain
// interval that calls the ONE existing sweep (jobService.runExpirationSweep) —
// there is no second scheduler and no competing expiry path, and it reuses the
// platform's existing service rather than duplicating its rules.
//
// WHY A PLAIN INTERVAL IS ENOUGH (each property is a requirement):
//
//   * SURVIVES RESTART        — the work list is a query over persisted
//     timestamps, never an in-memory queue. Whatever a killed process had not
//     yet done is simply found again by the next tick after the restart.
//   * SAFE WITH N INSTANCES  — every close is a compare-and-swap on
//     `status = ACTIVE`, so N concurrent ticks close each job exactly once and
//     the N-1 losers are silent no-ops. Nothing needs electing a leader.
//   * IDEMPOTENT              — running the sweep twice in the same second
//     closes nothing the second time.
//   * DUPLICATE-SAFE          — an overlapping tick (a slow sweep, a duplicated
//     timer) is harmless for the same reason.
//
// It runs `unref`'d so it can never hold the process open on shutdown, it never
// overlaps itself (a tick is skipped while one is still running), and a failing
// tick is logged and swallowed so one bad row can never kill the timer.
// ---------------------------------------------------------------------------

const jobService = require("./job.service");

const DEFAULT_INTERVAL_MS = 60 * 1000;

const readIntervalMs = () => {
  const parsed = Number.parseInt(process.env.JOB_EXPIRATION_SWEEP_INTERVAL_MS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS;
};

let timer = null;
let running = false;
let lastError = null;

const tick = async () => {
  // Never overlap: a slow sweep must not be able to stack up behind itself.
  if (running) return;
  running = true;
  try {
    const result = await jobService.runExpirationSweep();
    lastError = null;
    if (result.closed.length > 0) {
      console.log(
        `[job-expiration] scheduler closed ${result.closed.length} job(s): ${result.closed.join(", ")}`
      );
    }
  } catch (error) {
    // A transient database/Redis problem must never stop the timer: the next
    // tick retries the same persisted work. Only the message is logged — never
    // any credential.
    lastError = error.message;
    console.error(`[job-expiration] sweep failed, will retry: ${error.message}`);
  } finally {
    running = false;
  }
};

const startJobExpirationScheduler = () => {
  if (timer) {
    return timer;
  }
  const intervalMs = readIntervalMs();
  timer = setInterval(tick, intervalMs);
  // Never hold the event loop open on its account.
  timer.unref?.();
  console.log(`[job-expiration] scheduler started (every ${intervalMs}ms)`);

  // Run once at boot so a job that expired while the process was DOWN is closed
  // immediately on restart, rather than one interval later.
  void tick();
  return timer;
};

const stopJobExpirationScheduler = () => {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
};

const isJobExpirationSchedulerRunning = () => Boolean(timer);
const getJobExpirationSchedulerState = () => ({
  running: isJobExpirationSchedulerRunning(),
  inFlight: running,
  intervalMs: readIntervalMs(),
  lastError,
});

module.exports = {
  DEFAULT_INTERVAL_MS,
  startJobExpirationScheduler,
  stopJobExpirationScheduler,
  isJobExpirationSchedulerRunning,
  getJobExpirationSchedulerState,
  tick,
};
