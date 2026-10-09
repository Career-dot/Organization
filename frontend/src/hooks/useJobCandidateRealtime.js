import { useCallback, useEffect, useRef, useState } from "react";
import {
  REALTIME_CONNECTION_STATE,
  openCandidateStatusStream,
} from "../services/realtimeService";

// ---------------------------------------------------------------------------
// Phase 4 — recruiter candidate list realtime binding.
//
// Design rules (mirroring the backend contract):
//   * Postgres is the source of truth: an event NEVER writes a status into
//     React state. It only schedules an authoritative re-read of the
//     candidate list / attempt status, so duplicate events, repeated events and
//     out-of-order events all converge on the same persisted values and can
//     neither create duplicate rows nor double-count statistics.
//   * A (re)connect also triggers that authoritative re-read, which is exactly
//     how missed events are recovered after a network drop, a backend restart
//     or a Redis restart.
//   * Nothing critical lives in memory: if the stream is unavailable the list
//     still loads and can be refreshed manually.
// ---------------------------------------------------------------------------

const RECONCILE_DEBOUNCE_MS = 250;

/**
 * @param {object} params
 * @param {string} params.jobId
 * @param {() => void} params.onReconcile  authoritative assessment/list refetch
 * @param {(event: object) => void} [params.onCandidateAnalysisUpdate]
 * @param {() => void} [params.onCandidateReconnect]
 * @param {boolean} [params.enabled]
 */
export const useJobCandidateRealtime = ({
  jobId,
  onReconcile,
  onCandidateAnalysisUpdate,
  onCandidateReconnect,
  enabled = true,
}) => {
  const [streamState, setStreamState] = useState(
    REALTIME_CONNECTION_STATE.CONNECTING
  );

  // The refetch callback is held in a ref so a new function identity on every
  // render never tears the stream down and back up.
  const reconcileRef = useRef(onReconcile);
  const candidateAnalysisUpdateRef = useRef(onCandidateAnalysisUpdate);
  const candidateReconnectRef = useRef(onCandidateReconnect);
  useEffect(() => {
    reconcileRef.current = onReconcile;
    candidateAnalysisUpdateRef.current = onCandidateAnalysisUpdate;
    candidateReconnectRef.current = onCandidateReconnect;
  }, [onReconcile, onCandidateAnalysisUpdate, onCandidateReconnect]);

  const reconcileTimer = useRef(null);
  const candidateAnalysisTimers = useRef(new Map());

  const scheduleReconcile = useCallback(() => {
    if (reconcileTimer.current) return;
    reconcileTimer.current = setTimeout(() => {
      reconcileTimer.current = null;
      reconcileRef.current?.();
    }, RECONCILE_DEBOUNCE_MS);
  }, []);

  const scheduleCandidateAnalysisReconcile = useCallback((event) => {
    const referenceId = event.referenceId;
    if (candidateAnalysisTimers.current.has(referenceId)) return;
    const timer = setTimeout(() => {
      candidateAnalysisTimers.current.delete(referenceId);
      candidateAnalysisUpdateRef.current?.(event);
    }, RECONCILE_DEBOUNCE_MS);
    candidateAnalysisTimers.current.set(referenceId, timer);
  }, []);

  useEffect(() => {
    if (!enabled || !jobId) {
      return undefined;
    }

    const candidateTimers = candidateAnalysisTimers.current;
    const stream = openCandidateStatusStream({
      jobId,
      onStateChange: setStreamState,
      // Established (or re-established) stream → authoritative reconciliation,
      // so state is correct even though events may have been missed.
      onReady: () => {
        scheduleReconcile();
        candidateReconnectRef.current?.();
      },
      onEvent: (event) => {
        // Defense in depth: the gateway only forwards this job's events, and
        // the client ignores anything else. Event values are never rendered;
        // they only identify the authoritative resource to re-read.
        if (!event || event.jobId !== jobId) return;
        if (
          event.eventType === "CANDIDATE_ANALYSIS_UPDATED" &&
          typeof event.referenceId === "string" &&
          event.referenceId.length > 0
        ) {
          scheduleCandidateAnalysisReconcile(event);
          return;
        }
        scheduleReconcile();
      },
    });

    return () => {
      stream.close();
      if (reconcileTimer.current) {
        clearTimeout(reconcileTimer.current);
        reconcileTimer.current = null;
      }
      for (const timer of candidateTimers.values()) {
        clearTimeout(timer);
      }
      candidateTimers.clear();
    };
  }, [enabled, jobId, scheduleReconcile, scheduleCandidateAnalysisReconcile]);

  // Derived, not stored in an effect: when the realtime binding is disabled
  // there is no connection at all, so the reported state is OFFLINE.
  const connectionState =
    enabled && jobId ? streamState : REALTIME_CONNECTION_STATE.OFFLINE;

  return { connectionState };
};

export default useJobCandidateRealtime;
