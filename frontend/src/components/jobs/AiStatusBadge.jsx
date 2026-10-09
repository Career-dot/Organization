// Status chip styles for the REAL AiJob states. PENDING and PROCESSING share a
// presentation deliberately: both mean "not ready yet" — PROCESSING is worker
// bookkeeping the recruiter does not need to distinguish.
const AI_STATUS_BADGES = {
  PENDING: {
    label: "Queued",
    classes: "bg-amber-50 text-amber-700 border-amber-200",
  },
  PROCESSING: {
    label: "Queued",
    classes: "bg-amber-50 text-amber-700 border-amber-200",
  },
  COMPLETED: {
    label: "Completed",
    classes: "bg-emerald-50 text-emerald-700 border-emerald-200",
  },
  FAILED: {
    label: "Failed",
    classes: "bg-rose-50 text-rose-700 border-rose-200",
  },
};

const AiStatusBadge = ({ status }) => {
  const badge = AI_STATUS_BADGES[status] ?? AI_STATUS_BADGES.PENDING;
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${badge.classes}`}
    >
      {badge.label}
    </span>
  );
};

export default AiStatusBadge;