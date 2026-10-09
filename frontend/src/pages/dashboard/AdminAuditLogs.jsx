import { useEffect, useState } from "react";
import DashboardShell from "../../components/ui/DashboardShell";
import Button from "../../components/ui/Button";
import Alert from "../../components/ui/Alert";
import { inputClasses } from "../../components/ui/FormField";
import {
  ChartIcon,
  BuildingIcon,
  UsersIcon,
  SparkIcon,
  LockIcon,
  SearchIcon,
  RefreshIcon,
  EyeIcon,
  XIcon,
} from "../../components/ui/icons";
import { listAuditLogs } from "../../services/adminService";

const NAV_ITEMS = [
  { label: "Dashboard", icon: ChartIcon, to: "/admin/dashboard" },
  { label: "Organizations", icon: BuildingIcon, to: "/admin/organizations" },
  { label: "Recruiters", icon: UsersIcon, to: "/admin/recruiters" },
  { label: "Plans & Pricing", icon: SparkIcon, to: "/admin/plans" },
  { label: "Audit Logs", icon: LockIcon, to: "/admin/audit-logs" },
];

const ACTION_OPTIONS = [
  { label: "All Actions", value: "" },
  { label: "Plan Created", value: "SUBSCRIPTION_PLAN_CREATED" },
  { label: "Plan Updated", value: "SUBSCRIPTION_PLAN_UPDATED" },
  { label: "Plan Activated", value: "SUBSCRIPTION_PLAN_ACTIVATED" },
  { label: "Plan Deactivated", value: "SUBSCRIPTION_PLAN_DEACTIVATED" },
  { label: "User Registered", value: "USER_REGISTERED" },
  { label: "Org Registered", value: "ORGANIZATION_REGISTERED" },
  { label: "Status Changed", value: "ORGANIZATION_STATUS_CHANGED" },
];

const TARGET_TYPE_OPTIONS = [
  { label: "All Target Types", value: "" },
  { label: "Subscription Plan", value: "SubscriptionPlan" },
  { label: "Organization", value: "Organization" },
  { label: "User", value: "User" },
  { label: "Subscription", value: "Subscription" },
];

const ACTION_COLORS = {
  SUBSCRIPTION_PLAN_CREATED: "bg-emerald-50 text-emerald-700",
  SUBSCRIPTION_PLAN_ACTIVATED: "bg-emerald-50 text-emerald-700",
  SUBSCRIPTION_PLAN_UPDATED: "bg-blue-50 text-blue-700",
  SUBSCRIPTION_PLAN_DEACTIVATED: "bg-amber-50 text-amber-700",
  ORGANIZATION_CREATED: "bg-purple-50 text-purple-700",
  ORGANIZATION_STATUS_CHANGED: "bg-rose-50 text-rose-700",
  RECRUITER_STATUS_CHANGED: "bg-rose-50 text-rose-700",
};

const PAGE_SIZE = 25;

const AdminAuditLogs = () => {
  const [logs, setLogs] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [actionFilter, setActionFilter] = useState("");
  const [targetTypeFilter, setTargetTypeFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Metadata JSON Modal
  const [selectedMetadata, setSelectedMetadata] = useState(null);
  const [copied, setCopied] = useState(false);

  const fetchLogs = (currentOffset = offset, currentAction = actionFilter, currentTarget = targetTypeFilter) => {
    setLoading(true);
    setError(null);
    listAuditLogs({
      limit: PAGE_SIZE,
      offset: currentOffset,
      action: currentAction || undefined,
      targetType: currentTarget || undefined,
    })
      .then((res) => {
        // Backend returns { logs, total, take, skip } inside res.data
        const data = res.data || {};
        setLogs(data.logs ?? []);
        setTotal(data.total ?? 0);
      })
      .catch((err) => setError(err.response?.data?.message ?? "Could not load audit logs."))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchLogs(offset, actionFilter, targetTypeFilter);
  }, [offset, actionFilter, targetTypeFilter]);

  const handleActionChange = (e) => {
    setActionFilter(e.target.value);
    setOffset(0);
  };

  const handleTargetTypeChange = (e) => {
    setTargetTypeFilter(e.target.value);
    setOffset(0);
  };

  const handleCopyJson = () => {
    if (!selectedMetadata) return;
    navigator.clipboard.writeText(JSON.stringify(selectedMetadata.metadata, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <DashboardShell
      roleLabel="Platform Admin"
      title="Platform Audit Logs"
      description="Immutable, tamper-evident audit record of administrative actions, catalog modifications, and security events."
      navItems={NAV_ITEMS}
    >
      {/* Top Filter Bar */}
      <div className="flex flex-col justify-between gap-4 border-b border-slate-200 pb-6 sm:flex-row sm:items-center">
        <div className="flex flex-wrap items-center gap-3">
          {/* Action Filter */}
          <select
            value={actionFilter}
            onChange={handleActionChange}
            className={`${inputClasses} w-auto text-xs py-2`}
          >
            {ACTION_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>

          {/* Target Type Filter */}
          <select
            value={targetTypeFilter}
            onChange={handleTargetTypeChange}
            className={`${inputClasses} w-auto text-xs py-2`}
          >
            {TARGET_TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-xs font-semibold text-slate-500">{total} total events</span>

          <button
            onClick={() => fetchLogs(offset, actionFilter, targetTypeFilter)}
            title="Refresh logs"
            className="flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 shadow-sm hover:bg-slate-50"
          >
            <RefreshIcon className={`h-4 w-4 ${loading ? "animate-spin text-indigo-600" : ""}`} />
          </button>
        </div>
      </div>

      {error && (
        <div className="mt-6">
          <Alert variant="error">{error}</Alert>
        </div>
      )}

      {/* Audit Logs Table */}
      <div className="mt-6 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        {loading ? (
          <div className="p-8 space-y-4">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="h-12 w-full animate-pulse rounded-lg bg-slate-100" />
            ))}
          </div>
        ) : logs.length === 0 ? (
          <div className="p-12 text-center">
            <LockIcon className="mx-auto h-10 w-10 text-slate-300" />
            <p className="mt-3 text-sm font-semibold text-slate-900">No audit logs found</p>
            <p className="mt-1 text-xs text-slate-500">Privileged events and catalog changes will appear here.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 bg-slate-50/75 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-6 py-3.5">Timestamp</th>
                  <th className="px-6 py-3.5">Action</th>
                  <th className="px-6 py-3.5">Actor</th>
                  <th className="px-6 py-3.5">Target</th>
                  <th className="px-6 py-3.5">IP Address</th>
                  <th className="px-6 py-3.5 text-right">Metadata</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-medium text-slate-700">
                {logs.map((log) => {
                  const hasMeta = log.metadata && Object.keys(log.metadata).length > 0;

                  return (
                    <tr key={log.id} className="transition hover:bg-slate-50/80">
                      <td className="px-6 py-4 text-slate-500 whitespace-nowrap">
                        <p className="font-semibold text-slate-800">
                          {new Date(log.createdAt).toLocaleDateString()}
                        </p>
                        <p className="text-[10px] text-slate-400">
                          {new Date(log.createdAt).toLocaleTimeString()}
                        </p>
                      </td>

                      <td className="px-6 py-4">
                        <span
                          className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold ${
                            ACTION_COLORS[log.action] ?? "bg-slate-100 text-slate-700"
                          }`}
                        >
                          {log.action}
                        </span>
                      </td>

                      <td className="px-6 py-4">
                        <p className="font-semibold text-slate-900">{log.actor?.fullName ?? "System"}</p>
                        <p className="text-[10px] text-slate-400">{log.actor?.email ?? "system@platform.local"}</p>
                      </td>

                      <td className="px-6 py-4">
                        <span className="font-semibold text-slate-900">{log.targetType}</span>
                        {log.targetId && (
                          <p className="font-mono text-[10px] text-slate-400 truncate max-w-[120px]">
                            {log.targetId}
                          </p>
                        )}
                      </td>

                      <td className="px-6 py-4 font-mono text-[11px] text-slate-500">
                        {log.ipAddress || "—"}
                      </td>

                      <td className="px-6 py-4 text-right">
                        {hasMeta ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => setSelectedMetadata(log)}
                            className="inline-flex items-center gap-1 text-[11px]"
                          >
                            <EyeIcon className="h-3 w-3" />
                            View JSON
                          </Button>
                        ) : (
                          <span className="text-slate-400 text-[11px]">None</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination Footer */}
        {total > PAGE_SIZE && (
          <div className="flex items-center justify-between border-t border-slate-200 px-6 py-4">
            <p className="text-xs text-slate-500">
              Showing <span className="font-semibold text-slate-800">{offset + 1}</span> to{" "}
              <span className="font-semibold text-slate-800">{Math.min(offset + PAGE_SIZE, total)}</span> of{" "}
              <span className="font-semibold text-slate-800">{total}</span> entries
            </p>

            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={offset === 0}
                onClick={() => setOffset((prev) => Math.max(0, prev - PAGE_SIZE))}
              >
                Previous
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={offset + PAGE_SIZE >= total}
                onClick={() => setOffset((prev) => prev + PAGE_SIZE)}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Metadata JSON Modal */}
      {selectedMetadata && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm">
          <div className="w-full max-w-xl rounded-2xl bg-white p-6 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-100 pb-4">
              <div>
                <h3 className="font-display text-base font-bold text-slate-900">Audit Event Metadata</h3>
                <p className="text-xs text-slate-500">
                  {selectedMetadata.action} · {selectedMetadata.targetType}
                </p>
              </div>
              <button
                onClick={() => setSelectedMetadata(null)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              >
                <XIcon className="h-5 w-5" />
              </button>
            </div>

            <div className="mt-4">
              <div className="relative">
                <pre className="max-h-96 overflow-y-auto rounded-xl bg-slate-900 p-4 font-mono text-xs text-emerald-400">
                  {JSON.stringify(selectedMetadata.metadata, null, 2)}
                </pre>
                <button
                  onClick={handleCopyJson}
                  className="absolute right-3 top-3 rounded-lg bg-slate-800 px-2.5 py-1 text-[10px] font-semibold text-slate-300 transition hover:bg-slate-700 hover:text-white"
                >
                  {copied ? "Copied!" : "Copy JSON"}
                </button>
              </div>
            </div>

            <div className="mt-6 flex justify-end">
              <Button variant="secondary" onClick={() => setSelectedMetadata(null)}>
                Close
              </Button>
            </div>
          </div>
        </div>
      )}
    </DashboardShell>
  );
};

export default AdminAuditLogs;
