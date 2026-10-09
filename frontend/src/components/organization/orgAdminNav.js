// ---------------------------------------------------------------------------
// Shared ORG ADMIN section navigation.
//
// All four Org Admin sections are separate ROUTES, so the shell sidebar is the
// single place that defines the structure. Keeping it here guarantees the
// dashboard, recruiter management, job analysis and recruiter analysis can never
// drift apart, and avoids duplicating the nav list in four pages.
//
// The icons below MUST be imported: without this import every identifier below
// was an undefined global, so every Org Admin page threw a ReferenceError at
// render time. `vite build` did not catch it because bundling does not evaluate
// those references — only `no-undef` at lint time and the browser did.
// ---------------------------------------------------------------------------
import { BuildingIcon, ChartIcon, SparkIcon, UsersIcon } from "../ui/icons";

// The shared analytics range vocabulary. All-time / this-month / 30d / 3m / 6m
// are resolved SERVER-SIDE into a real UTC window (organization.service.js
// resolveAuditWindow); CUSTOM is used when from/to are supplied instead.
export const ORG_RANGE_OPTIONS = [
  { value: "ALL", label: "All time" },
  { value: "MONTH", label: "This month" },
  { value: "LAST_30_DAYS", label: "Last 30 days" },
  { value: "LAST_3_MONTHS", label: "Last 3 months" },
  { value: "LAST_6_MONTHS", label: "Last 6 months" },
  { value: "CUSTOM", label: "Custom range" },
];

// Order follows the separation of responsibilities, so the sidebar reads as the
// org admin's actual workflow:
//
//   1. Dashboard          — organization-level executive overview + trends.
//                           Deliberately holds NO recruiter-management controls,
//                           NO full recruiter list and NO candidate tables.
//   2. Manage Recruiters  — the ONLY write surface: add, remove/deactivate,
//                           reset credentials, permanent delete.
//   3. Recruiter Analysis — recruiter-wise jobs, candidates, assessments and
//                           analysis. Read-only; hiring only when real state exists.
//   4. Job Analysis       — job list, job details and historical candidate
//                           reports. Read-only.
//
// Every entry points at an EXISTING route; no page or route is created here.
export const ORG_ADMIN_NAV_ITEMS = [
  { label: "Dashboard", icon: ChartIcon, to: "/organization/dashboard" },
  { label: "Manage Recruiters", icon: UsersIcon, to: "/organization/dashboard/recruiters" },
  { label: "Recruiter Analysis", icon: SparkIcon, to: "/organization/dashboard/recruiter-analysis" },
  { label: "Job Analysis", icon: BuildingIcon, to: "/organization/dashboard/jobs" },
];

export const ORG_JOB_STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "ACTIVE", label: "Active" },
  { value: "DRAFT", label: "Draft" },
  { value: "CLOSED", label: "Closed / completed" },
];

export const formatOrgDate = (value) =>
  value ? new Date(value).toLocaleDateString(undefined, { dateStyle: "medium" }) : "—";

// "2026-09" -> "Sep 2026", used for the chart axis labels.
export const formatMonthLabel = (bucket) => {
  if (!bucket) return "";
  const [year, month] = bucket.split("-");
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, 1));
  return date.toLocaleDateString(undefined, { month: "short", year: "2-digit", timeZone: "UTC" });
};
