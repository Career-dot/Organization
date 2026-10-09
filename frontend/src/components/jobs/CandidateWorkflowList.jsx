import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Alert from "../ui/Alert";
import Button from "../ui/Button";
import Spinner from "../ui/Spinner";
import { RefreshIcon } from "../ui/icons";
import CandidateAnalysisPanel from "./CandidateAnalysisPanel";
// Manual candidate addition lives in its own component so the invitation
// contract in THIS file (row identity only, never a client-entered email)
// stays free of any email input.
import ManualCandidateAdd from "./ManualCandidateAdd";
import CandidateVerificationReportModal from "./CandidateVerificationReportModal";
import {
  getJobCandidates,
  getCandidateAnalysis,
  getJobCandidateAttempts,
  getJobCandidateReferences,
  inviteJobCandidate,
} from "../../services/jobService";
import {
  REALTIME_CONNECTION_STATE,
  REALTIME_STATE_LABELS,
} from "../../services/realtimeService";
import useJobCandidateRealtime from "../../hooks/useJobCandidateRealtime";
import { extractApiErrorMessage } from "../../utils/apiError";

// ---------------------------------------------------------------------------
// Recruiter candidate list — Excel-like data table with two category sections
// ---------------------------------------------------------------------------
// ONE authoritative candidate table, rendered as TWO stacked category sections
// over ONE persisted data source:
//
//   IN SYSTEM     — the email belongs to a registered EMPLOYEE account
//   NOT IN SYSTEM — it does not
//
// Every value shown comes from a backend response; the browser never computes
// a classification, a status or a score:
//   * category     → the backend's `systemStatus`, read straight from
//                    GET /job/:jobId/candidates (classified server-side)
//   * Verification → the candidate's EXISTING platform verification (display
//                    only — not the assessment score). The full report opens
//                    in a modal only when the recruiter clicks "View Report";
//                    NOT IN SYSTEM rows show "—" and never an invented number
//   * Test Status  → the PERSISTED attempt lifecycle (STARTED / IN_PROGRESS /
//                    SUBMITTED / TIMED_UP / CHEATED), or the persisted
//                    invitation state before an attempt exists, otherwise "—"
//   * Score        → the SERVER-calculated assessment result persisted on the
//                    attempt (null until submission renders "—")
//   * Analysis     → the persisted automatic candidate-analysis state (Pending
//                    / Processing / Completed / Failed / "—"). Analysis is
//                    triggered by the platform itself after the terminal
//                    assessment lifecycle; this surface never starts it
//
// INVITATION FLOW — exactly ONE recruiter invitation action per category: the
// category-level "Invite Selected (n)" button above each table. Rows carry
// only checkboxes — there is NO per-row invite button and NO email field
// anywhere. The bulk action posts ONLY each row's own persisted identity
// (Excel rowId or job-scoped referenceId) through the existing row-scoped
// endpoint; the backend re-resolves the address from stored candidate data.
//
// REALTIME — unchanged architecture: PostgreSQL → Redis Pub/Sub → Express SSE
// → React (useJobCandidateRealtime). SSE frames are status/invalidation
// events only and NEVER carry a score; every event schedules an authoritative
// refetch of the persisted list through the authenticated API, so PostgreSQL
// stays the single source of truth. No polling exists here.

const CARD_CLASSES = "rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7";

// Persisted lifecycle state → the quiet tone its cell renders. A row shows
// several facts at once, so a status is a small dot next to its label instead
// of a filled badge. The attempt states come first; the invitation states are
// the persisted pre-attempt lifecycle (invited / email verified / expired)
// shown in Test Status until an attempt exists. These are all the values the
// backend persists — nothing else is ever rendered.
const ASSESSMENT_TONE = {
  NOT_INVITED: { dot: "bg-slate-300", text: "text-slate-600" },
  INVITED: { dot: "bg-indigo-500", text: "text-slate-700" },
  EMAIL_VERIFIED: { dot: "bg-emerald-500", text: "text-emerald-700" },
  STARTED: { dot: "bg-sky-500", text: "text-slate-700" },
  IN_PROGRESS: { dot: "bg-sky-500", text: "text-slate-700" },
  SUBMITTED: { dot: "bg-blue-500", text: "text-slate-700" },
  TIMED_UP: { dot: "bg-amber-500", text: "text-amber-700" },
  // Deterministic integrity termination (never an AI accusation).
  CHEATED: { dot: "bg-rose-500", text: "text-rose-700" },
  EXPIRED: { dot: "bg-amber-500", text: "text-amber-700" },
};

const ASSESSMENT_LABEL = {
  NOT_INVITED: "Not invited",
  INVITED: "Invited",
  EMAIL_VERIFIED: "Email verified",
  STARTED: "Started",
  IN_PROGRESS: "In progress",
  SUBMITTED: "Submitted",
  TIMED_UP: "Timed up",
  CHEATED: "Cheated",
  EXPIRED: "Invite expired",
};

// The concise deterministic reason labels the backend persists on a CHEATED
// attempt (JobAssessmentAttempt.cheatReason). These are fixed statements of
// fact about a configured rule, never an AI verdict. An unknown value is shown
// verbatim rather than invented.
const CHEAT_REASON_LABELS = {
  EXCESSIVE_VISIBILITY_CHANGES: "Excessive visibility changes",
  TIMER_INTEGRITY_VIOLATION: "Timer integrity violation",
  DUPLICATE_ATTEMPT: "Duplicate attempt",
  PROHIBITED_CLIENT_ACTION: "Prohibited client action",
  SERVER_INTEGRITY_VIOLATION: "Server integrity violation",
};

// Analysis column labels — the persisted automatic-analysis state only.
// Nothing here starts or retries anything; clicking a state simply OPENS the
// existing read-only analysis panel.
const ANALYSIS_LABEL = {
  PENDING: "Pending",
  PROCESSING: "Processing",
  COMPLETED: "Completed",
  FAILED: "Failed",
};

// Connection indicator. Informational only: the list keeps working (and stays
// manually refreshable) whether or not the live stream is up.
const REALTIME_TONE = {
  [REALTIME_CONNECTION_STATE.CONNECTED]: "bg-emerald-500",
  [REALTIME_CONNECTION_STATE.CONNECTING]: "bg-slate-400",
  [REALTIME_CONNECTION_STATE.RECONNECTING]: "bg-amber-500",
  [REALTIME_CONNECTION_STATE.OFFLINE]: "bg-slate-300",
};

// ---------------------------------------------------------------------------
// The two category sections over the SAME data source — not two systems.
//
//   FIRST  — IN SYSTEM     (registered EMPLOYEE candidates)
//   SECOND — NOT IN SYSTEM (external / non-EMPLOYEE candidates)
//
// The category is the BACKEND's classification (`systemStatus`, decided by
// classifyJobCandidates server-side). The browser never derives it, never
// computes it, and offers no control to move a candidate between sections —
// the split below is a pure read of the server-owned value. Both sections
// render the SAME table, the SAME columns and the SAME bulk invite action, so
// the invitation pipeline is identical for both.
// ---------------------------------------------------------------------------

const IN_SYSTEM_COLUMN = {
  key: "IN_SYSTEM",
  title: "IN SYSTEM",
  subtitle: "Registered EMPLOYEE candidates",
  emptyMessage: "No registered candidates in this section.",
};

const NOT_IN_SYSTEM_COLUMN = {
  key: "NOT_IN_SYSTEM",
  title: "NOT IN SYSTEM",
  subtitle: "External / non-EMPLOYEE candidates",
  emptyMessage: "No external candidates in this section.",
};

// The FIXED table columns — identical in both category sections and never
// hidden depending on the candidate type. Missing information renders "—"; a
// column never disappears.
const SHARED_COLUMNS = [
  { key: "select", label: "Select", className: "w-10 px-3" },
  { key: "candidate", label: "Candidate", className: "min-w-[9rem] px-3" },
  { key: "email", label: "Email", className: "min-w-[11rem] px-3" },
  { key: "verification", label: "Verification", className: "min-w-[10rem] px-3" },
  { key: "assessment", label: "Assessment", className: "min-w-[7rem] px-3" },
  { key: "testStatus", label: "Test Status", className: "min-w-[8rem] px-3" },
  { key: "score", label: "Score", className: "w-16 px-3 text-right" },
  { key: "analysis", label: "Analysis", className: "min-w-[7rem] px-3" },
];

// Which persisted invitation states are still ELIGIBLE for a new invitation.
//
// This is the frontend half of the duplicate-invitation rule; the backend
// enforces the same rule independently, so a stale/disabled control can never be
// the only thing preventing a duplicate.
//
//   NOT_INVITED      → eligible (first invitation)
//   INVITED          → NOT eligible: this candidate was already invited and
//                      already emailed, so their persisted INVITED status stays
//                      visible in Test Status but they cannot be re-selected.
//   EXPIRED          → eligible: the window lapsed, so a re-invite legitimately
//                      REUSES the same invitation row and opens a new window.
//   EMAIL_VERIFIED   → NOT eligible: the email is already proven, so there is
//                      nothing left to invite.
//
// A candidate's eligibility is derived purely from the backend's persisted
// `invitationStatus`; the browser never invents a status of its own.
const INVITE_ALLOWED_STATES = {
  "NOT_INVITED": true,
  "INVITED": false,
  "EXPIRED": true,
  "EMAIL_VERIFIED": false,
};

// Is this row still eligible to be invited? Unknown/absent statuses default to
// eligible so a not-yet-classified row is never silently locked out.
const isInviteEligible = (candidate) =>
  INVITE_ALLOWED_STATES[candidate.invitationStatus] ?? true;

// Stable row identity for selection — the same identity the invite call uses
// (the Excel rowId, else the job-scoped referenceId). Emails are unique in
// the uploaded list, so the email is the last-resort key.
const candidateKey = (candidate) => candidate.id ?? candidate.referenceId ?? candidate.email;

// A persisted status rendered as a small dot + label: readable inside a row
// that already shows several facts, and never a stack of filled badges.
const StatusText = ({ tone, children }) => (
  <span className={`inline-flex min-w-0 items-center gap-1.5 ${tone.text}`}>
    <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} />
    <span className="min-w-0 break-words">{children}</span>
  </span>
);

// One compact total for the list's summary line: a bold number and a muted
// word, so the summary reads as information instead of a row of badges.
const SummaryCount = ({ value, label }) => (
  <span>
    <span className="font-semibold text-slate-800">{value}</span> {label}
  </span>
);

// ---------------------------------------------------------------------------
// Score column — the SERVER-calculated assessment result, straight from the
// persisted attempt rows of GET /job/:jobId/assessment/attempts. null (or any
// status other than SUBMITTED) renders "—" — never an invented number, never
// a frontend-computed value, and deliberately separate from the Verification
// column: the two stay strictly separate results — one number is never derived
// from the other, and they are never merged into one figure.
// ---------------------------------------------------------------------------
const AssessmentScore = ({ attempt }) => {
  const score = attempt?.assessmentScore ?? null;
  const maxScore = attempt?.assessmentMaxScore ?? null;
  const percentage = attempt?.assessmentPercentage ?? null;
  if (attempt?.status !== "SUBMITTED" || score === null || percentage === null) {
    return (
      <span
        className="text-slate-400"
        title="Scored by the server when the candidate submits"
      >
        —
      </span>
    );
  }
  return (
    <span
      className="font-semibold tabular-nums text-slate-900"
      title={`${score} / ${maxScore ?? "—"}`}
    >
      {Math.round(Number(percentage))}%
    </span>
  );
};

// ---------------------------------------------------------------------------
// Verification column — the candidate's EXISTING platform verification, kept
// completely separate from the assessment result in the Score column. Only an
// IN_SYSTEM row can have one; a NOT_IN_SYSTEM row (or an in-system candidate
// without a completed verification) renders "—" — never an invented number.
// "View Report" opens the report in a modal, so the row never expands and the
// report never occupies permanent space in the table.
// ---------------------------------------------------------------------------
const VerificationCell = ({ candidate, onViewReport }) => {
  if (candidate.systemStatus !== "IN_SYSTEM") {
    return (
      <span
        className="text-slate-400"
        title="No platform account — no platform verification"
      >
        —
      </span>
    );
  }
  const score = candidate.existingVerifiedSkillScore;
  if (score === null || score === undefined) {
    return (
      <span
        className="text-slate-400"
        title="No completed skill verification on the platform yet"
      >
        —
      </span>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5">
      <span className="font-semibold tabular-nums text-slate-900">{score}%</span>
      {candidate.referenceId ? (
        <button
          type="button"
          className="text-indigo-600 hover:text-indigo-700 hover:underline"
          onClick={() => onViewReport(candidate)}
        >
          View Report
        </button>
      ) : null}
    </span>
  );
};

// Test Status column — the PERSISTED lifecycle: the attempt status once an
// attempt exists, otherwise the persisted invitation state (invited but not
// started yet), and "—" when nothing has been persisted at all. A CHEATED
// attempt also shows its concise deterministic reason. Nothing is inferred.
const TestStatusCell = ({ candidate, attempt }) => {
  const status =
    attempt?.status ??
    (candidate.invitationStatus === "NOT_INVITED" ? null : candidate.invitationStatus);
  if (!status) {
    return <span className="text-slate-400">—</span>;
  }
  return (
    <span className="inline-flex flex-col gap-0.5">
      <StatusText tone={ASSESSMENT_TONE[status] ?? ASSESSMENT_TONE.NOT_INVITED}>
        {ASSESSMENT_LABEL[status] ?? status}
      </StatusText>
      {status === "CHEATED" && attempt?.cheatReason && (
        <span className="text-[10px] text-slate-500">
          {CHEAT_REASON_LABELS[attempt.cheatReason] ?? attempt.cheatReason}
        </span>
      )}
    </span>
  );
};

// Analysis column — the persisted AUTOMATIC candidate-analysis state, shown
// compactly. The platform queues this candidate's analysis itself the moment
// the assessment reaches its terminal lifecycle, so this cell never starts
// anything: it reports the state (Pending / Processing / Completed / Failed,
// or "—" when nothing has been persisted) and clicking it only OPENS the
// existing read-only panel.
const AnalysisCell = ({ candidate, enabled, onOpenAnalysis }) => {
  const status = enabled ? candidate.analysis?.status : null;
  const label = status ? ANALYSIS_LABEL[status] ?? null : null;
  if (!candidate.referenceId || !label) {
    return <span className="text-slate-400">—</span>;
  }
  return (
    <button
      type="button"
      className="text-indigo-600 hover:text-indigo-700 hover:underline"
      title="Open the read-only candidate analysis"
      onClick={() => onOpenAnalysis(candidate)}
    >
      {label}
    </button>
  );
};

// ---------------------------------------------------------------------------
// THE single invitation action per category — "Invite Selected (n)" above the
// table. The SAME component is rendered by BOTH category sections (one render
// site, shared by both), so both go through one endpoint and one service:
// there is no second invitation workflow and no invite button inside any row.
//
// COMPLETE INDEPENDENCE (the reported bug): `inviting` is passed PER CATEGORY,
// so when IN_SYSTEM is mid-request the NOT_IN_SYSTEM button is unaffected —
// it keeps its own label, its own spinner slot, its own enabled/disabled state
// and its own layout box. Nothing about the other category moves or resizes.
//
// Disabled until the job's assessment is ACTIVATED (the backend enforces this
// regardless), while THIS category's own request is in flight (a double-click
// can never fire two invitations) and while nothing is selected in it.
//
// The label box is given a stable min-width so switching to the "Sending…"
// state cannot change the button's size and nudge the rest of the row.
// ---------------------------------------------------------------------------
const InviteAction = ({ selectedCount, assessmentActive, inviting, onInvite }) => {
  const disabled = inviting || !assessmentActive || selectedCount === 0;
  const title = !assessmentActive
    ? "Activate the assessment before inviting candidates"
    : inviting
      ? "Invitations for this category are being sent"
      : selectedCount === 0
        ? "Select candidates to invite"
        : `Invite the ${selectedCount} selected candidate${selectedCount === 1 ? "" : "s"}`;
  return (
    <Button
      type="button"
      size="sm"
      variant="primary"
      disabled={disabled}
      title={title}
      onClick={onInvite}
      data-inviting={inviting ? "true" : "false"}
    >
      {/* Reserved slot: the spinner occupies the same box whether or not it is
          visible, so only this button's contents change — never its size. */}
      <span
        aria-hidden="true"
        className="inline-flex h-4 w-4 shrink-0 items-center justify-center"
      >
        {inviting ? <Spinner className="h-4 w-4" /> : null}
      </span>
      <span className="tabular-nums">
        {inviting ? "Sending…" : `Invite Selected (${selectedCount})`}
      </span>
    </Button>
  );
};

// ---------------------------------------------------------------------------
// ONE category section: header (title + candidate count + Select All + the
// single Invite Selected action) and the shared Excel-like table underneath.
// The SAME component renders BOTH categories, so the two sections cannot
// drift into two systems: fixed columns, identical cells, one bulk invite
// action, one handler. Rows are compact with thin separators; the wrapper
// scrolls horizontally on narrow screens so the table structure always stays
// a table — rows never turn into cards.
// ---------------------------------------------------------------------------
const CandidateCategoryColumn = ({
  column,
  candidates,
  selectedKeys,
  assessmentActive,
  inviting,
  onInvite,
  onToggle,
  onToggleAll,
  attemptFor,
  analysisEnabled,
  onOpenAnalysis,
  onViewReport,
  assessmentTitle,
}) => {
  // Category-scoped selection view: only THIS section's rows count toward the
  // select-all state and the invite count — the other section's selection is
  // never included.
  //
  // Selection is further restricted to ELIGIBLE rows: an already-invited or
  // already email-verified candidate is excluded from the count, so
  // "Invite Selected (n)" always states exactly how many candidates that click
  // will actually invite, and the button disables itself once no eligible
  // candidate remains.
  const eligibleCandidates = candidates.filter(isInviteEligible);
  const selectedCandidates = eligibleCandidates.filter((candidate) =>
    selectedKeys.has(candidateKey(candidate))
  );
  const allSelected =
    eligibleCandidates.length > 0 && selectedCandidates.length === eligibleCandidates.length;
  const someSelected = selectedCandidates.length > 0 && !allSelected;
  const handleSelectAllRef = (element) => {
    if (element) element.indeterminate = someSelected;
  };

  return (
    <section
      aria-label={column.title}
      data-testid={`candidate-column-${column.key}`}
      data-category={column.key}
      className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"
    >
      {/* Section header: category + count and Select All on the left, the ONE
          category-level invite action on the right. */}
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50/70 px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex items-baseline gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-600">
              {column.title}
            </h3>
            <span className="text-xs text-slate-500">
              {candidates.length} {candidates.length === 1 ? "candidate" : "candidates"}
            </span>
          </div>
          <label
            className={`inline-flex items-center gap-1.5 text-xs font-medium ${
              eligibleCandidates.length > 0 ? "cursor-pointer text-slate-600" : "text-slate-400"
            }`}
          >
            <input
              ref={handleSelectAllRef}
              type="checkbox"
              disabled={eligibleCandidates.length === 0}
              title={
                eligibleCandidates.length > 0
                  ? "Select every candidate in this section who has not been invited yet"
                  : "Every candidate in this section has already been invited"
              }
              className="h-3.5 w-3.5 rounded border-slate-300"
              checked={allSelected}
              onChange={onToggleAll}
            />
            Select All
          </label>
        </div>
        <InviteAction
          selectedCount={selectedCandidates.length}
          assessmentActive={assessmentActive}
          // Scoped to THIS section only: `inviting` was already resolved per
          // category by the parent, and `onInvite` receives this section's key so
          // the request is attributed to — and guarded by — this category alone.
          inviting={inviting}
          onInvite={() => onInvite(selectedCandidates, column.key)}
        />
      </header>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[54rem] border-collapse text-left text-xs">
          <thead>
            <tr className="border-b border-slate-200 text-[11px] uppercase tracking-wide text-slate-500">
              {SHARED_COLUMNS.map((col) => (
                <th key={col.key} scope="col" className={`py-2 font-semibold ${col.className}`}>
                  {col.key === "select" ? (
                    <input
                      ref={handleSelectAllRef}
                      type="checkbox"
                      aria-label={`Select all in ${column.title}`}
                      disabled={eligibleCandidates.length === 0}
                      className="h-3.5 w-3.5 rounded border-slate-300"
                      checked={allSelected}
                      onChange={onToggleAll}
                    />
                  ) : (
                    col.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {candidates.map((candidate) => {
              const key = candidateKey(candidate);
              const attempt = attemptFor(candidate);
              const name = candidate.name ?? null;
              // An already-invited (or already email-verified) candidate stays
              // fully visible — including their persisted INVITED status — but
              // their checkbox is disabled, so they can never be selected for a
              // second invitation. The backend enforces the same rule.
              const eligible = isInviteEligible(candidate);
              return (
                <tr
                  key={key}
                  data-testid="candidate-row"
                  data-candidate-email={candidate.email ?? null}
                  data-system-status={candidate.systemStatus}
                  data-invitation-status={candidate.invitationStatus ?? "NOT_INVITED"}
                  data-invite-eligible={eligible ? "true" : "false"}
                  className="border-b border-slate-100 align-middle last:border-b-0 hover:bg-slate-50/70"
                >
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      disabled={!eligible}
                      aria-label={`Select ${name ?? candidate.email ?? "candidate"}`}
                      title={
                        eligible
                          ? "Select for invitation"
                          : "This candidate was already invited and emailed"
                      }
                      className="h-3.5 w-3.5 rounded border-slate-300"
                      checked={eligible && selectedKeys.has(key)}
                      onChange={() => onToggle(key)}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className="block max-w-[14rem] truncate font-medium text-slate-800"
                      title={name ?? undefined}
                    >
                      {name ?? "—"}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <span className="block break-all text-slate-600">
                      {candidate.email ?? "—"}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <VerificationCell candidate={candidate} onViewReport={onViewReport} />
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-slate-700">
                    {assessmentTitle ?? "—"}
                  </td>
                  <td className="px-3 py-2">
                    <TestStatusCell candidate={candidate} attempt={attempt} />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <AssessmentScore attempt={attempt} />
                  </td>
                  <td className="px-3 py-2">
                    <AnalysisCell
                      candidate={candidate}
                      enabled={analysisEnabled}
                      onOpenAnalysis={onOpenAnalysis}
                    />
                  </td>
                </tr>
              );
            })}
            {candidates.length === 0 && (
              <tr>
                <td
                  colSpan={SHARED_COLUMNS.length}
                  className="px-4 py-8 text-center text-xs text-slate-500"
                >
                  {column.emptyMessage}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
};

const CandidateWorkflowList = ({
  jobId,
  candidateListFileId = null,
  title = "Candidates",
  analysisEnabled = false,
  // Manual candidate addition is a recruiter-only write (the route enforces
  // authorize("RECRUITER")). Both current call sites are RECRUITER-gated, so
  // this defaults to available; it is an explicit prop so a future read-only
  // surface can hide the form instead of showing a control that would 403.
  canAddCandidate = true,
}) => {
  const [listing, setListing] = useState(null);
  const [attempts, setAttempts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // -------------------------------------------------------------------------
  // PER-CATEGORY invitation state — the fix for the reported UI bug.
  //
  // Previously ONE `invitingKey` (and, further up, one `inviting` boolean derived
  // from it) drove BOTH category buttons, so pressing "Invite Selected" in one
  // category put the OTHER category's button into its loading/disabled state as
  // well and made both sections appear to move together.
  //
  // The state is now keyed BY CATEGORY, which makes the two sections completely
  // independent in every respect the UI can express:
  //   invitingCategory   "IN_SYSTEM" | "NOT_IN_SYSTEM" | null  — which section
  //                      currently has a request in flight (null = neither)
  //   invitingKey        the row identity of the row being sent right now
  //                      (a double-click guard WITHIN that category only)
  //
  // `invitingCategory` is set for the WHOLE batch, not per row, so a category's
  // button stays in its "Sending…" state for every row of that batch instead of
  // flickering once per candidate.
  // -------------------------------------------------------------------------
  const [invitingCategory, setInvitingCategory] = useState(null);
  const [invitingKey, setInvitingKey] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [analysisCandidate, setAnalysisCandidate] = useState(null);
  // The verification report modal — opened ONLY by "View Report", so the
  // report never lives inside (or below) a table row.
  const [reportCandidate, setReportCandidate] = useState(null);
  // Category-specific selection: row keys live in ONE set, but every count,
  // select-all and invite action is computed per category section, so the two
  // "Invite Selected" buttons never share a selection.
  const [selectedKeys, setSelectedKeys] = useState(() => new Set());
  const analysisPanelRef = useRef(null);

  const load = useCallback(
    async ({ background = false } = {}) => {
      if (!background) setLoading(true);
      try {
        if (analysisEnabled) {
          // Explicit Step 2 endpoint owns legacy seed-if-absent backfill. The
          // candidate-list read itself remains read-only and returns the opaque
          // referenceId only after the server has resolved it.
          await getJobCandidateReferences(jobId);
        }
        const response = await getJobCandidates(jobId);
        // The authoritative listing replaces the previous one wholesale: no
        // merge, so a duplicate realtime event can never duplicate a row and no
        // counter can drift. Every field — classification, invitation status,
        // verification score, analysis state — comes from this one read.
        setListing(response?.data ?? null);
        setError(null);
      } catch (caught) {
        if (!background) {
          setError(extractApiErrorMessage(caught, "The candidate list could not be loaded."));
        }
      } finally {
        if (!background) setLoading(false);
      }
    },
    [analysisEnabled, jobId]
  );

  // Persisted attempt status per candidate email. A failure here degrades the
  // Test Status column to the invitation status instead of blanking the
  // candidate list — the primary data stays visible. The Score column reads
  // from the SAME persisted rows: a score only ever comes from PostgreSQL
  // through this authenticated call, never from a realtime frame.
  const loadAttempts = useCallback(async () => {
    try {
      const response = await getJobCandidateAttempts(jobId);
      setAttempts(response?.data?.attempts ?? []);
    } catch {
      setAttempts([]);
    }
  }, [jobId]);

  // Re-reads the persisted state whenever the job changes or the uploaded file
  // is replaced (candidateListFileId). No optimistic/local classification.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await Promise.all([load(), loadAttempts()]);
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [load, loadAttempts, candidateListFileId]);

  // Authoritative reconciliation. Triggered by realtime events and by every
  // (re)connect, so a missed event, a duplicate event or an out-of-order event
  // all converge on the persisted state. SSE frames are invalidation-only —
  // they never carry a score, and nothing event-shaped is ever rendered.
  const reconcile = useCallback(() => {
    void Promise.all([load({ background: true }), loadAttempts()]);
  }, [load, loadAttempts]);

  // Candidate-analysis SSE is a notification only. Reconcile exactly one
  // job/reference pair through the authenticated API; never apply the event's
  // status to the row. An open panel performs the same one API call and returns
  // the authoritative latest state so its row summary is updated from that read.
  const reconcileCandidateAnalysis = useCallback(async (event) => {
    if (
      event?.jobId !== jobId ||
      typeof event.referenceId !== "string" ||
      event.referenceId.length === 0
    ) return;
    try {
      const payload = analysisCandidate?.referenceId === event.referenceId
        ? await analysisPanelRef.current?.reconcileLatest()
        : (await getCandidateAnalysis(jobId, event.referenceId))?.data ?? null;
      const latest = payload?.latest;
      if (!latest) return;
      setListing((current) => current
        ? {
            ...current,
            candidates: current.candidates.map((candidate) =>
              candidate.referenceId === event.referenceId
                ? {
                    ...candidate,
                    analysis: {
                      analysisId: latest.analysisId,
                      aiJobId: latest.aiJobId,
                      analysisVersion: latest.analysisVersion,
                      status: latest.status,
                      createdAt: latest.createdAt,
                      updatedAt: latest.updatedAt,
                      completedAt: latest.completedAt,
                    },
                  }
                : candidate
            ),
          }
        : current);
    } catch (caught) {
      setActionError(extractApiErrorMessage(caught, "Candidate analysis status could not be refreshed."));
    }
  }, [analysisCandidate, jobId]);

  const reconcileOpenAnalysisPanel = useCallback(() => {
    if (analysisPanelRef.current) void analysisPanelRef.current.reconcileLatest();
  }, []);

  // ONE authenticated SSE connection serves assessment and candidate-analysis
  // events (no second realtime system, no polling). Reconnect recovers missed
  // events through a full authoritative list refetch plus a targeted
  // open-panel refetch.
  const { connectionState } = useJobCandidateRealtime({
    jobId,
    onReconcile: reconcile,
    onCandidateAnalysisUpdate: reconcileCandidateAnalysis,
    onCandidateReconnect: reconcileOpenAnalysisPanel,
    enabled: Boolean(jobId),
  });

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([load(), loadAttempts()]);
    } finally {
      setRefreshing(false);
    }
  }, [load, loadAttempts]);

  const summary = listing?.summary;
  // Memoized so the category split below has a stable dependency: `?? []`
  // would otherwise produce a NEW empty array on every render.
  const candidates = useMemo(() => listing?.candidates ?? [], [listing]);
  const totalFromFile = listing?.candidateList?.candidateCount ?? 0;
  const returned = summary?.rowsReturned ?? candidates.length;
  // The job's assessment name for the Assessment column — a persisted value
  // like every other cell; "—" when the job has no assessment yet.
  const assessmentTitle = listing?.assessment?.title ?? null;

  // Attempt status keyed by the SAME normalized email the candidate row shows.
  // Emails are unique in the uploaded list (the upload rejects duplicates) and
  // an attempt is unique per (assessment, email), so the merge is by persisted
  // identity — never by array position.
  const attemptByEmail = new Map(
    attempts
      .filter((attempt) => typeof attempt?.email === "string")
      .map((attempt) => [attempt.email.trim().toLowerCase(), attempt])
  );
  const attemptFor = (candidate) => {
    const email = typeof candidate.email === "string" ? candidate.email.trim().toLowerCase() : null;
    return email ? attemptByEmail.get(email) ?? null : null;
  };

  // Backend-authoritative activation state: FINALIZED + activatedAt = active.
  const assessment = listing?.assessment ?? null;
  const assessmentActive = Boolean(
    assessment && assessment.status === "FINALIZED" && assessment.activatedAt
  );

  // The TWO category sections. This is a PURE READ of the backend's
  // `systemStatus` — the value classifyJobCandidates decided server-side from
  // the candidate's email and the registered EMPLOYEE accounts. The browser
  // never re-derives it, never allows editing it, and never reorders across the
  // boundary; the only thing that happens here is partitioning one authoritative
  // list into the two sections the recruiter asked for.
  const { inSystemCandidates, notInSystemCandidates } = useMemo(() => {
    const inSystem = [];
    const notInSystem = [];
    for (const candidate of candidates) {
      // Anything the backend did not explicitly mark IN_SYSTEM is grouped as
      // NOT_IN_SYSTEM, so a row can never be silently dropped from the view.
      if (candidate.systemStatus === "IN_SYSTEM") inSystem.push(candidate);
      else notInSystem.push(candidate);
    }
    return { inSystemCandidates: inSystem, notInSystemCandidates: notInSystem };
  }, [candidates]);

  // Selection — a row checkbox toggles its own key; a section's select-all
  // toggles exactly that section's keys and never touches the other one, so
  // the two categories stay independently selectable.
  const handleToggleCandidate = useCallback((key) => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // Select-all toggles exactly the ELIGIBLE keys of one section and never
  // touches the other category. Ineligible rows are skipped entirely, so
  // "Select All" can never select an already-invited candidate.
  const handleToggleCategory = useCallback((categoryCandidates) => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      const keys = categoryCandidates.filter(isInviteEligible).map(candidateKey);
      const allSelected = keys.length > 0 && keys.every((key) => next.has(key));
      for (const key of keys) {
        if (allSelected) next.delete(key);
        else next.add(key);
      }
      return next;
    });
  }, []);

  // ONE row's invitation through the EXISTING row-scoped endpoint. The request
  // carries ONLY the row's own identity and NEVER an address:
  //   * `candidate.id`         — the stable Excel sheet rowId for an imported row
  //   * `candidate.referenceId` — the job-scoped candidate-reference id for one
  //                               added manually (a manual candidate has no
  //                               spreadsheet row, so its reference id addresses it)
  // Both are resolved server-side from persisted candidate data inside the
  // authorized job, so the browser can never submit an arbitrary email as the
  // authoritative identity, and both converge on the same
  // JobAssessmentInvitation system and the same FINALIZED + ACTIVATED gate.
  // The returned invitation status is authoritative and updates the row in
  // place; a refresh simply re-reads the same persisted state.
  const inviteOne = async (candidate) => {
    const rowId = candidate.id ?? candidate.referenceId;
    if (rowId === null || rowId === undefined) {
      return { ok: false, message: "This candidate has no stored identity to invite." };
    }
    setInvitingKey(rowId);
    try {
      const response = await inviteJobCandidate(jobId, rowId);
      const result = response?.data ?? null;
      const status = result?.invitation?.status ?? "INVITED";
      setListing((current) =>
        current
          ? {
              ...current,
              candidates: current.candidates.map((entry) =>
                entry === candidate || entry.id === candidate.id
                  ? {
                      ...entry,
                      invitationStatus: status === "EMAIL_VERIFIED" ? "EMAIL_VERIFIED" : "INVITED",
                      invitedAt: result?.invitation?.invitedAt ?? entry.invitedAt,
                      invitationExpiresAt:
                        result?.invitation?.expiresAt ?? entry.invitationExpiresAt,
                    }
                  : entry
              ),
            }
          : current
      );
      return { ok: true };
    } catch (caught) {
      return {
        ok: false,
        message: extractApiErrorMessage(
          caught,
          "The invitation could not be sent. You can safely retry — no duplicate invitation will be created."
        ),
      };
    } finally {
      // Only the per-row key is cleared here. The CATEGORY-level "Sending…"
      // state is owned by handleInvite and spans the whole batch, so it is not
      // released between rows.
      setInvitingKey(null);
    }
  };

  // THE invitation action — the ONLY way a recruiter sends invitations: the
  // category-level "Invite Selected" button hands its selected rows here, one
  // after another, each through the same row-scoped endpoint. Candidates who were
  // already invited or already verified their email are filtered out by the same
  // shared eligibility rule the checkboxes use, so the count in the button and
  // the number of requests issued always agree. After the loop the authoritative
  // list + attempts are re-read, so the table always reflects persisted state.
  //
  // CATEGORY SCOPING: `categoryKey` is the section that was pressed. The re-entry
  // guard is checked against THAT category only, so an in-flight IN_SYSTEM batch
  // cannot block a NOT_IN_SYSTEM click (and vice versa) — the two buttons are
  // fully independent request paths.
  const handleInvite = async (selected, categoryKey) => {
    if (invitingCategory === categoryKey) return;
    if (!Array.isArray(selected) || selected.length === 0) return;
    setActionError(null);
    setNotice(null);

    // Defence in depth: even if a stale selection slipped through, an ineligible
    // candidate is never invited from here. The backend enforces the same rule.
    const toInvite = selected.filter(isInviteEligible);
    const skipped = selected.length - toInvite.length;
    if (toInvite.length === 0) {
      setNotice(
        "Every selected candidate has already been invited or verified their email — nothing to send."
      );
      return;
    }
    // Held for the WHOLE batch, so this category's button shows "Sending…" from
    // the first row to the last instead of flickering once per candidate. The
    // other category's button reads a DIFFERENT key and is unaffected.
    setInvitingCategory(categoryKey);
    let sent = 0;
    const failures = [];
    try {
      for (const candidate of toInvite) {
        // eslint-disable-next-line no-await-in-loop
        const outcome = await inviteOne(candidate);
        if (outcome.ok) sent += 1;
        else failures.push(outcome.message);
      }
    } finally {
      // Always released, so a throw can never leave this category stuck loading.
      setInvitingCategory(null);
      setInvitingKey(null);
    }

    // Authoritative re-read: persisted invitation state replaces the optimistic
    // row updates above, exactly like a realtime reconcile would.
    await Promise.all([load({ background: true }), loadAttempts()]);

    if (failures.length > 0) {
      setActionError(
        `${failures.length} of ${toInvite.length} selected candidate${toInvite.length === 1 ? "" : "s"} could not be invited. ${failures[0]}`
      );
    }
    const parts = [];
    if (sent > 0) parts.push(`${sent} invitation${sent === 1 ? "" : "s"} sent`);
    if (skipped > 0) parts.push(`${skipped} already invited or verified — nothing to send`);
    if (parts.length > 0) setNotice(`${parts.join(" · ")}.`);
  };

  return (
    <section className={CARD_CLASSES}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-bold text-slate-900">{title}</h2>
          <p className="mt-1 text-sm text-slate-600">
            {listing?.candidateList?.file?.originalName ? (
              <>
                <span className="font-medium text-slate-800">
                  {listing.candidateList.file.originalName}
                </span>
                {" · "}
                {totalFromFile === 1 ? "1 candidate" : `${totalFromFile} candidates`}
              </>
            ) : (
              "Candidates uploaded for this job"
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {/* Live connection state. Purely informational — the table below is
              always rendered from persisted backend data and can be refreshed
              manually, so a dropped stream never blocks the recruiter. */}
          <p className="inline-flex items-center gap-2 text-xs text-slate-500">
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 rounded-full ${REALTIME_TONE[connectionState] ?? "bg-slate-300"}`}
            />
            {REALTIME_STATE_LABELS[connectionState] ?? connectionState}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleRefresh}
            disabled={refreshing}
          >
            {refreshing ? <Spinner className="h-4 w-4" /> : <RefreshIcon className="h-4 w-4" />}
            Refresh
          </Button>
        </div>
      </div>

      {/* Manual candidate addition. The backend classifies the submitted address
          with the SAME authoritative rule the Excel rows use and the response is
          re-read through the same authoritative list below — the section the new
          row appears in is therefore server-derived, never computed in the
          browser. */}
      {canAddCandidate && <ManualCandidateAdd jobId={jobId} onAdded={handleRefresh} />}

      {loading && !listing && (
        <div className="mt-6 flex items-center gap-3 text-sm text-slate-600">
          <Spinner className="h-5 w-5" /> Loading candidates…
        </div>
      )}

      {error && (
        <div className="mt-5">
          <Alert variant="error">{error}</Alert>
        </div>
      )}

      {listing && (
        <>
          {/* Invitation totals only, as plain information: the candidate count is
              in the description above and the two category counts are in each
              section header, so this line never repeats them. */}
          <p className="mt-5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
            <SummaryCount value={summary?.invitedCount ?? 0} label="invited" />
            <span aria-hidden="true" className="text-slate-300">·</span>
            <SummaryCount value={summary?.emailVerifiedCount ?? 0} label="email verified" />
            <span aria-hidden="true" className="text-slate-300">·</span>
            <SummaryCount value={summary?.expiredInvitationCount ?? 0} label="invitation expired" />
          </p>

          {(summary?.duplicateEmails?.length ?? 0) > 0 && (
            <div className="mt-4">
              <Alert variant="error">
                This uploaded file contains duplicate email addresses. Re-upload a clean list
                before inviting candidates.
              </Alert>
            </div>
          )}

          {notice && (
            <div className="mt-4">
              <Alert variant="success">{notice}</Alert>
            </div>
          )}

          {actionError && (
            <div className="mt-4">
              <Alert variant="error">{actionError}</Alert>
            </div>
          )}

          {!assessmentActive && (
            <div className="mt-4">
              <Alert variant="info">
                The assessment must be activated before candidates can be invited — activation
                controls invitation availability on the backend as well, and a candidate&apos;s
                analysis becomes available once the job is active.
              </Alert>
            </div>
          )}

          {/* The candidate list as TWO stacked category sections over one data
              source: IN SYSTEM first, NOT IN SYSTEM underneath. Both sections
              render the SAME table component and the SAME category-level
              Invite Selected action, so they are one list shown in two
              categories — never two management systems and never two
              invitation workflows. Selection and invitation stay
              category-scoped: each section counts, selects and invites only its
              own rows. The category itself is the backend's classification,
              read straight from the response: the browser neither computes it
              nor offers a control to move a candidate between sections. */}
          {candidates.length > 0 ? (
            <div className="mt-5 flex flex-col gap-6">
              <CandidateCategoryColumn
                column={IN_SYSTEM_COLUMN}
                candidates={inSystemCandidates}
                selectedKeys={selectedKeys}
                assessmentActive={assessmentActive}
                // PER-CATEGORY: true only while THIS section has a batch in
                // flight. The NOT_IN_SYSTEM section below reads a different key
                // and therefore never enters a loading/disabled state because of
                // an IN_SYSTEM request (and vice versa).
                inviting={invitingCategory === IN_SYSTEM_COLUMN.key}
                onInvite={handleInvite}
                onToggle={handleToggleCandidate}
                onToggleAll={() => handleToggleCategory(inSystemCandidates)}
                attemptFor={attemptFor}
                analysisEnabled={analysisEnabled}
                onOpenAnalysis={setAnalysisCandidate}
                onViewReport={setReportCandidate}
                assessmentTitle={assessmentTitle}
              />
              <CandidateCategoryColumn
                column={NOT_IN_SYSTEM_COLUMN}
                candidates={notInSystemCandidates}
                selectedKeys={selectedKeys}
                assessmentActive={assessmentActive}
                // PER-CATEGORY, mirroring the IN_SYSTEM section above.
                inviting={invitingCategory === NOT_IN_SYSTEM_COLUMN.key}
                onInvite={handleInvite}
                onToggle={handleToggleCandidate}
                onToggleAll={() => handleToggleCategory(notInSystemCandidates)}
                attemptFor={attemptFor}
                analysisEnabled={analysisEnabled}
                onOpenAnalysis={setAnalysisCandidate}
                onViewReport={setReportCandidate}
                assessmentTitle={assessmentTitle}
              />
            </div>
          ) : (
            <p className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
              No candidates in this list yet — upload the candidate Excel above.
            </p>
          )}

          {analysisEnabled && analysisCandidate && (
            <CandidateAnalysisPanel
              ref={analysisPanelRef}
              key={analysisCandidate.referenceId}
              jobId={jobId}
              candidate={analysisCandidate}
              onClose={() => setAnalysisCandidate(null)}
            />
          )}

          {/* Verification report modal — secondary UI, opened ONLY by
              "View Report", so the table itself stays compact and the report
              never permanently expands a row. */}
          {reportCandidate && (
            <CandidateVerificationReportModal
              jobId={jobId}
              candidate={reportCandidate}
              onClose={() => setReportCandidate(null)}
            />
          )}

          {returned < totalFromFile && (
            <p className="mt-3 text-xs text-slate-500">
              Showing {returned} of {totalFromFile} candidates from the uploaded file.
            </p>
          )}

          {/* The long-form explanations stay available but collapsed: they are
              documentation, not something the recruiter has to re-read every
              time the list is opened. */}
          <details className="mt-5 rounded-xl border border-slate-200 bg-slate-50/60 px-4 py-3">
            <summary className="cursor-pointer text-xs font-semibold text-slate-700">
              About these columns
            </summary>
            <div className="mt-2 space-y-2 text-xs text-slate-500">
              <p>
                <span className="font-semibold text-slate-700">Two sections</span> — the same
                candidate list split by the platform&apos;s own server-side classification:{" "}
                <span className="font-semibold text-slate-700">IN SYSTEM</span> means the email
                belongs to a registered candidate (EMPLOYEE) account,{" "}
                <span className="font-semibold text-slate-700">NOT IN SYSTEM</span> means it
                does not. The platform decides this server-side; a candidate is never moved
                between sections by hand, and a Not In System candidate never needs an account.
              </p>
              <p>
                <span className="font-semibold text-slate-700">Inviting</span> — select rows
                with the checkboxes and use the section&apos;s single{" "}
                <span className="font-semibold text-slate-700">Invite Selected</span> button.
                There is no invitation button inside a row and no email field anywhere: the
                backend resolves every address from the persisted candidate list, and a
                candidate who already verified their email is skipped.
              </p>
              <p>
                <span className="font-semibold text-slate-700">Verification</span> is the
                candidate&apos;s existing platform skill verification, shown for information
                only — it is not the assessment score, it is never recalculated here, and the
                full report opens in a modal only when you click View Report. Not In System
                candidates show &quot;—&quot; because no platform verification exists for them.
              </p>
              <p>
                <span className="font-semibold text-slate-700">Test Status</span> is the
                persisted attempt lifecycle (started → in progress → submitted / timed up /
                cheated) or the invitation state before an attempt exists. Status and
                candidate-analysis updates arrive through the authorized recruiter realtime
                stream; Refresh always re-reads the same server state.
              </p>
              <p>
                <span className="font-semibold text-slate-700">Score</span> is calculated by
                the server exactly once at submission, from the persisted questions and
                answers — it shows &quot;—&quot; until then, and timed-up or terminated
                attempts are never scored. It stays separate from the verification result and
                is never merged with it.
              </p>
              <p>
                <span className="font-semibold text-slate-700">Analysis</span> starts
                automatically when the assessment reaches a terminal state; the column only
                reports the current state (Pending / Processing / Completed / Failed) and opens
                the read-only panel — nothing on this page triggers an analysis.
              </p>
            </div>
          </details>
        </>
      )}
    </section>
  );
};

export default CandidateWorkflowList;
