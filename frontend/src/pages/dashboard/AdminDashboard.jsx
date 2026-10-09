import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import DashboardShell from "../../components/ui/DashboardShell";
import Alert from "../../components/ui/Alert";
import Button from "../../components/ui/Button";
import {
  ChartIcon,
  BuildingIcon,
  UsersIcon,
  ShieldIcon,
  SparkIcon,
  LockIcon,
  CalendarIcon,
  EyeIcon,
  RefreshIcon,
} from "../../components/ui/icons";
import { getDashboardStatistics } from "../../services/adminService";
import {
  PlatformGrowthChart,
  SubscriptionDonutChart,
  PlanDistributionBars,
} from "../../components/admin/AdminCharts";

const NAV_ITEMS = [
  { label: "Dashboard", icon: ChartIcon, to: "/admin/dashboard" },
  { label: "Organizations", icon: BuildingIcon, to: "/admin/organizations" },
  { label: "Recruiters", icon: UsersIcon, to: "/admin/recruiters" },
  { label: "Plans & Pricing", icon: SparkIcon, to: "/admin/plans" },
  { label: "Audit Logs", icon: LockIcon, to: "/admin/audit-logs" },
];

const TIME_RANGES = [
  { label: "Today", value: "today" },
  { label: "7 Days", value: "7d" },
  { label: "30 Days", value: "30d" },
  { label: "90 Days", value: "90d" },
  { label: "All Time", value: "all" },
];

const formatTimeAgo = (dateStr) => {
  if (!dateStr) return "";
  const date = new Date(dateStr);
  const now = new Date();
  const diffInSec = Math.floor((now - date) / 1000);

  if (diffInSec < 60) return "Just now";
  if (diffInSec < 3600) return `${Math.floor(diffInSec / 60)}m ago`;
  if (diffInSec < 86400) return `${Math.floor(diffInSec / 3600)}h ago`;
  return `${Math.floor(diffInSec / 86400)}d ago`;
};

const AdminDashboard = () => {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [timeRange, setTimeRange] = useState("30d");
  const [selectedPaymentModal, setSelectedPaymentModal] = useState(false);

  const fetchStats = (range = timeRange) => {
    setLoading(true);
    setError(null);
    getDashboardStatistics(range)
      .then((res) => setStats(res.data))
      .catch((err) => setError(err.response?.data?.message ?? "Could not load platform statistics."))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchStats(timeRange);
  }, [timeRange]);

  const kpiCards = stats
    ? [
        {
          label: "Total Organizations",
          value: stats.kpis.totalOrganizations,
          subtext: `${stats.kpis.activeOrganizations} active · ${stats.kpis.suspendedOrganizations} suspended`,
          icon: BuildingIcon,
          color: "from-emerald-500 to-teal-400",
        },
        {
          label: "Active Organizations",
          value: stats.kpis.activeOrganizations,
          subtext: `${stats.kpis.pendingOrganizations} pending verification`,
          icon: ShieldIcon,
          color: "from-emerald-600 to-emerald-400",
        },
        {
          label: "Total Recruiters",
          value: stats.kpis.totalRecruiters,
          subtext: `Ind: ${stats.kpis.independentRecruiters} · Org: ${stats.kpis.organizationRecruiters}`,
          icon: UsersIcon,
          color: "from-cyan-500 to-blue-400",
        },
        {
          label: "Total Candidates",
          value: stats.kpis.totalCandidates,
          subtext: "Registered employees / passport profiles",
          icon: SparkIcon,
          color: "from-indigo-500 to-purple-400",
        },
        {
          label: "Active Subscriptions",
          value: stats.kpis.activeSubscriptions,
          subtext: "Currently usable & verified",
          icon: ShieldIcon,
          color: "from-indigo-600 to-cyan-400",
        },
        {
          label: "Expiring Soon",
          value: stats.kpis.expiringSoonSubscriptions,
          subtext: "Expiring within next 14 days",
          icon: CalendarIcon,
          color: "from-amber-500 to-orange-400",
        },
        {
          label: "Suspended / Expired",
          value: stats.kpis.suspendedOrExpiredSubscriptions,
          subtext: "Lapsed or administrative suspensions",
          icon: LockIcon,
          color: "from-rose-500 to-red-400",
        },
        {
          label: "Active Plans",
          value: stats.kpis.activePlansCount,
          subtext: "Live global catalog options",
          icon: ChartIcon,
          color: "from-violet-500 to-indigo-400",
        },
      ]
    : [];

  return (
    <DashboardShell
      roleLabel="Platform Admin"
      title="Platform Overview"
      description="Monitor organizations, recruiters, candidates, subscriptions and overall platform activity in real-time."
      navItems={NAV_ITEMS}
    >
      {/* Top Header Controls */}
      <div className="flex flex-col justify-between gap-4 border-b border-slate-200 pb-6 sm:flex-row sm:items-center">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Executive Summary</h2>
          <p className="text-xs text-slate-500">Live platform aggregates calculated from database records</p>
        </div>

        <div className="flex items-center gap-3">
          {/* Time Range Selector */}
          <div className="flex rounded-xl bg-slate-100 p-1">
            {TIME_RANGES.map((range) => (
              <button
                key={range.value}
                onClick={() => setTimeRange(range.value)}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${
                  timeRange === range.value
                    ? "bg-white text-indigo-600 shadow-sm"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                {range.label}
              </button>
            ))}
          </div>

          <button
            onClick={() => fetchStats(timeRange)}
            title="Refresh statistics"
            className="flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 shadow-sm hover:bg-slate-50"
          >
            <RefreshIcon className={`h-4 w-4 ${loading ? "animate-spin text-indigo-600" : ""}`} />
          </button>
        </div>
      </div>

      {/* Quick Navigation Action Cards */}
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Link
          to="/admin/organizations"
          className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm transition-all hover:border-indigo-300 hover:bg-indigo-50/30"
        >
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600">
            <BuildingIcon className="h-4 w-4" />
          </div>
          <div>
            <p className="text-xs font-semibold text-slate-900">Organizations</p>
            <p className="text-[10px] text-slate-500">Monitor & members</p>
          </div>
        </Link>

        <Link
          to="/admin/recruiters"
          className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm transition-all hover:border-indigo-300 hover:bg-indigo-50/30"
        >
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-cyan-50 text-cyan-600">
            <UsersIcon className="h-4 w-4" />
          </div>
          <div>
            <p className="text-xs font-semibold text-slate-900">Recruiters</p>
            <p className="text-[10px] text-slate-500">Org vs independent</p>
          </div>
        </Link>

        <Link
          to="/admin/plans"
          className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm transition-all hover:border-indigo-300 hover:bg-indigo-50/30"
        >
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
            <SparkIcon className="h-4 w-4" />
          </div>
          <div>
            <p className="text-xs font-semibold text-slate-900">Plan Catalog</p>
            <p className="text-[10px] text-slate-500">Manage pricing</p>
          </div>
        </Link>

        <Link
          to="/admin/audit-logs"
          className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm transition-all hover:border-indigo-300 hover:bg-indigo-50/30"
        >
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-100 text-slate-700">
            <LockIcon className="h-4 w-4" />
          </div>
          <div>
            <p className="text-xs font-semibold text-slate-900">Audit Logs</p>
            <p className="text-[10px] text-slate-500">Security history</p>
          </div>
        </Link>
      </div>

      {error && (
        <div className="mt-6">
          <Alert variant="error">{error}</Alert>
        </div>
      )}

      {loading && !stats ? (
        <div className="mt-8 space-y-6">
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="h-32 animate-pulse rounded-2xl border border-slate-200 bg-white p-6 shadow-sm" />
            ))}
          </div>
          <div className="h-80 animate-pulse rounded-2xl border border-slate-200 bg-white" />
        </div>
      ) : stats ? (
        <div className="mt-8 space-y-8">
          {/* 8 KPI Cards Grid */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {kpiCards.map((card) => (
              <div
                key={card.label}
                className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition-all hover:shadow-md"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">{card.label}</span>
                  <div
                    className={`flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br ${card.color} text-white shadow-sm`}
                  >
                    <card.icon className="h-4 w-4" />
                  </div>
                </div>
                <p className="mt-3 text-3xl font-extrabold tracking-tight text-slate-900">{card.value}</p>
                <p className="mt-1 text-xs text-slate-500">{card.subtext}</p>
              </div>
            ))}
          </div>

          {/* Platform Growth Chart */}
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
              <div>
                <h3 className="font-display text-base font-bold text-slate-900">Platform Growth Trends</h3>
                <p className="text-xs text-slate-500">
                  New organizations, recruiters, and candidates registered over time
                </p>
              </div>
              <span className="rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-semibold text-indigo-700">
                Range: {TIME_RANGES.find((r) => r.value === timeRange)?.label}
              </span>
            </div>
            <div className="mt-6">
              <PlatformGrowthChart data={stats.growthTimeline} height={260} />
            </div>
          </div>

          {/* Two Columns: Subscription Overview & Plan Distribution */}
          <div className="grid gap-8 lg:grid-cols-2">
            {/* Subscription Health & Donut */}
            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-display text-base font-bold text-slate-900">Subscription Overview</h3>
                  <p className="text-xs text-slate-500">Distribution across subscription lifecycle statuses</p>
                </div>
              </div>
              <div className="mt-6">
                <SubscriptionDonutChart subscriptions={stats.subscriptions} />
              </div>

              {/* Health Summary Box */}
              <div className="mt-6 border-t border-slate-100 pt-4">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-500">Subscription Health</h4>
                <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4 text-center">
                  <div className="rounded-xl bg-emerald-50/80 p-2.5">
                    <p className="text-xs font-semibold text-emerald-800">Active / Usable</p>
                    <p className="mt-1 text-lg font-bold text-emerald-900">{stats.subscriptions.usable}</p>
                  </div>
                  <div className="rounded-xl bg-blue-50/80 p-2.5">
                    <p className="text-xs font-semibold text-blue-800">Trial</p>
                    <p className="mt-1 text-lg font-bold text-blue-900">{stats.subscriptions.trial}</p>
                  </div>
                  <div className="rounded-xl bg-amber-50/80 p-2.5">
                    <p className="text-xs font-semibold text-amber-800">Expiring Soon</p>
                    <p className="mt-1 text-lg font-bold text-amber-900">{stats.subscriptions.expiringSoon}</p>
                  </div>
                  <div className="rounded-xl bg-rose-50/80 p-2.5">
                    <p className="text-xs font-semibold text-rose-800">Expired / Lapsed</p>
                    <p className="mt-1 text-lg font-bold text-rose-900">{stats.subscriptions.expired}</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Plan Distribution */}
            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-display text-base font-bold text-slate-900">Subscription Plan Distribution</h3>
                  <p className="text-xs text-slate-500">Active subscribers mapped to global catalog tiers</p>
                </div>
                <Link to="/admin/plans" className="text-xs font-semibold text-indigo-600 hover:text-indigo-800">
                  Manage catalog →
                </Link>
              </div>
              <div className="mt-6">
                <PlanDistributionBars plans={stats.planDistribution} />
              </div>
            </div>
          </div>

          {/* Subscriptions Requiring Attention & Activity Feed Grid */}
          <div className="grid gap-8 lg:grid-cols-[1.4fr_1fr]">
            {/* Subscriptions Requiring Attention */}
            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-display text-base font-bold text-slate-900">Subscriptions Requiring Attention</h3>
                  <p className="text-xs text-slate-500">Accounts nearing expiration within the next 30 days</p>
                </div>
                <span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-bold text-amber-700">
                  {stats.expiringSubscriptions.length} Subscriptions
                </span>
              </div>

              <div className="mt-4 overflow-x-auto">
                {stats.expiringSubscriptions.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-slate-200 p-8 text-center text-xs text-slate-400">
                    No subscriptions expiring within the next 30 days.
                  </div>
                ) : (
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 font-semibold text-slate-500">
                        <th className="pb-3 pr-4">Customer</th>
                        <th className="pb-3 pr-4">Type</th>
                        <th className="pb-3 pr-4">Plan</th>
                        <th className="pb-3 pr-4">Days Left</th>
                        <th className="pb-3 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {stats.expiringSubscriptions.map((sub) => (
                        <tr key={sub.id} className="hover:bg-slate-50/80">
                          <td className="py-3 pr-4">
                            <p className="font-semibold text-slate-900">{sub.customer}</p>
                            <p className="text-[11px] text-slate-500">{sub.email}</p>
                          </td>
                          <td className="py-3 pr-4">
                            <span
                              className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                                sub.type === "ORGANIZATION"
                                  ? "bg-purple-50 text-purple-700"
                                  : "bg-cyan-50 text-cyan-700"
                              }`}
                            >
                              {sub.type}
                            </span>
                          </td>
                          <td className="py-3 pr-4 font-medium text-slate-700">{sub.planName}</td>
                          <td className="py-3 pr-4">
                            <span className="font-semibold text-amber-600">
                              {sub.daysRemaining !== null ? `${sub.daysRemaining} days` : "—"}
                            </span>
                          </td>
                          <td className="py-3 text-right">
                            <Link
                              to={sub.type === "ORGANIZATION" ? "/admin/organizations" : "/admin/recruiters"}
                              className="inline-flex items-center gap-1 font-semibold text-indigo-600 hover:text-indigo-800"
                            >
                              <EyeIcon className="h-3.5 w-3.5" />
                              View
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            {/* Recent Activity Stream */}
            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-display text-base font-bold text-slate-900">Recent Platform Activity</h3>
                  <p className="text-xs text-slate-500">Live security & privileged audit logs</p>
                </div>
                <Link to="/admin/audit-logs" className="text-xs font-semibold text-indigo-600 hover:text-indigo-800">
                  Full log →
                </Link>
              </div>

              <div className="mt-4 space-y-3">
                {stats.recentActivity.length === 0 ? (
                  <p className="text-center text-xs text-slate-400 py-8">No recent activity logged yet.</p>
                ) : (
                  stats.recentActivity.map((evt) => (
                    <div key={evt.id} className="flex items-start gap-3 rounded-xl bg-slate-50/70 p-3">
                      <div className="flex h-7 w-7 flex-none items-center justify-center rounded-lg bg-indigo-100 text-indigo-600">
                        <LockIcon className="h-3.5 w-3.5" />
                      </div>
                      <div className="flex-1 overflow-hidden">
                        <p className="text-xs font-semibold text-slate-900 truncate">
                          {evt.action.replace(/_/g, " ")}
                        </p>
                        <p className="text-[11px] text-slate-500">
                          by <span className="font-medium text-slate-700">{evt.actorName}</span> · {formatTimeAgo(evt.createdAt)}
                        </p>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Payment Gateway Monitoring Section */}
          <div className="rounded-2xl border border-slate-200 bg-slate-900 p-6 text-white shadow-sm">
            <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
              <div>
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-amber-400 animate-pulse" />
                  <h3 className="font-display text-base font-bold text-white">Payment & Billing Gateway Status</h3>
                </div>
                <p className="mt-1 text-xs text-slate-400">
                  Mode: <span className="font-semibold text-slate-200 uppercase">{stats.paymentGatewayStatus.provider}</span> · {stats.paymentGatewayStatus.message}
                </p>
              </div>

              <button
                onClick={() => setSelectedPaymentModal(true)}
                className="rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-xs font-semibold text-slate-200 shadow-sm transition hover:bg-slate-700 hover:text-white"
              >
                View Gateway Details
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Payment Gateway Info Modal */}
      {selectedPaymentModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
            <h3 className="font-display text-lg font-bold text-slate-900">Payment Gateway Diagnostics</h3>
            <p className="mt-1 text-xs text-slate-500">Live platform gateway connectivity parameters</p>

            <div className="mt-5 space-y-3 text-xs">
              <div className="flex justify-between rounded-lg bg-slate-50 p-3">
                <span className="text-slate-500 font-medium">Gateway Provider:</span>
                <span className="font-bold text-slate-800 uppercase">{stats?.paymentGatewayStatus?.provider ?? "Simulated"}</span>
              </div>
              <div className="flex justify-between rounded-lg bg-slate-50 p-3">
                <span className="text-slate-500 font-medium">Environment:</span>
                <span className="font-bold text-amber-600">Development (Simulated Gateway)</span>
              </div>
              <div className="flex justify-between rounded-lg bg-slate-50 p-3">
                <span className="text-slate-500 font-medium">Production Webhooks:</span>
                <span className="font-bold text-slate-500">Not Connected</span>
              </div>
              <div className="flex justify-between rounded-lg bg-slate-50 p-3">
                <span className="text-slate-500 font-medium">Payment Reference:</span>
                <span className="font-bold text-slate-500">Awaiting production gateway</span>
              </div>
            </div>

            <div className="mt-6 flex justify-end">
              <Button variant="secondary" onClick={() => setSelectedPaymentModal(false)}>
                Close
              </Button>
            </div>
          </div>
        </div>
      )}
    </DashboardShell>
  );
};

export default AdminDashboard;

