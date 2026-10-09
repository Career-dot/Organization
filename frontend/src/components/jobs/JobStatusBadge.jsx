import { JOB_CLOSED_REASON_LABELS, JOB_STATUS_BADGES } from "../../constants/jobForm";

const JobStatusBadge = ({ status, closedReason }) => {
  const badge = JOB_STATUS_BADGES[status] ?? {
    label: status,
    classes: "bg-slate-100 text-slate-700 border-slate-200",
  };

  const closedReasonLabel =
    status === "CLOSED" && closedReason ? JOB_CLOSED_REASON_LABELS[closedReason] : null;

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${badge.classes}`}
      title={closedReasonLabel ?? undefined}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {badge.label}
      {closedReasonLabel && <span className="font-normal opacity-75">· {closedReasonLabel}</span>}
    </span>
  );
};

export default JobStatusBadge;
