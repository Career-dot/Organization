import { useEffect, useState } from "react";
import DashboardShell from "../../components/ui/DashboardShell";
import Button from "../../components/ui/Button";
import Alert from "../../components/ui/Alert";
import {
  ChartIcon,
  BuildingIcon,
  UsersIcon,
  ShieldIcon,
  SparkIcon,
  LockIcon,
  SearchIcon,
  RefreshIcon,
  EyeIcon,
} from "../../components/ui/icons";
import { listOrganizations, listRecruiters } from "../../services/adminService";

const NAV_ITEMS = [
  { label: "Dashboard", icon: ChartIcon, to: "/admin/dashboard" },
  { label: "Organizations", icon: BuildingIcon, to: "/admin/organizations" },
  { label: "Recruiters", icon: UsersIcon, to: "/admin/recruiters" },
  { label: "Plans & Pricing", icon: SparkIcon, to: "/admin/plans" },
  { label: "Audit Logs", icon: LockIcon, to: "/admin/audit-logs" },
];

const SUB_STATUS_STYLES = {
  ACTIVE: "bg-emerald-50 text-emerald-700",
  TRIAL: "bg-blue-50 text-blue-700",
  EXPIRED: "bg-amber-50 text-amber-700",
  SUSPENDED: "bg-rose-50 text-rose-700",
  CANCELLED: "bg-slate-100 text-slate-600",
};

const AdminSubscriptions = () => {
  const [subscriptions, setSubscriptions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("ALL"); // ALL, ORGANIZATION, INDEPENDENT
  const [statusFilter, setStatusFilter] = useState("ALL");

  const loadData = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [orgsRes, recsRes] = await Promise.all([
        listOrganizations(),
        listRecruiters(),
      ]);

      const orgSubs = (orgsRes.data ?? [])
        .filter((org) => org.subscription && org.subscription.id)
        .map((org) => ({
          id: org.subscription.id,
          customerName: org.name,
          customerEmail: org.businessEmail || org.owner?.email || "",
          type: "ORGANIZATION",
          planName: org.subscription.planName || "Standard",
          price: org.subscription.price,
          status: org.subscription.status,
          usable: org.subscription.usable,
          startDate: org.subscription.startDate,
          expiryDate: org.subscription.expiryDate,
        }));

      const indSubs = (recsRes.data ?? [])
        .filter((r) => r.recruiterType === "INDEPENDENT" && r.subscription && r.subscription.id)
        .map((r) => ({
          id: r.subscription.id,
          customerName: r.fullName,
          customerEmail: r.email,
          type: "INDEPENDENT",
          planName: r.subscription.planName || "Personal",
          price: r.subscription.price,
          status: r.subscription.status,
          usable: r.subscription.usable,
          startDate: r.subscription.startDate,
          expiryDate: r.subscription.expiryDate,
        }));

      setSubscriptions([...orgSubs, ...indSubs]);
    } catch (err) {
      setLoadError(err.response?.data?.message ?? "Could not load subscription data.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const filteredSubscriptions = subscriptions.filter((sub) => {
    const matchesSearch =
      search === "" ||
      sub.customerName.toLowerCase().includes(search.toLowerCase()) ||
      sub.customerEmail.toLowerCase().includes(search.toLowerCase()) ||
      sub.planName.toLowerCase().includes(search.toLowerCase());

    const matchesType = typeFilter === "ALL" || sub.type === typeFilter;
    const matchesStatus = statusFilter === "ALL" || sub.status === statusFilter;

    return matchesSearch && matchesType && matchesStatus;
  });

  return (
    <DashboardShell
      roleLabel="Platform Admin"
      title="Platform Subscriptions"
      description="Monitor active, trial, and expiring customer subscriptions across all organizations and independent recruiters."
      navItems={NAV_ITEMS}
    >
      {/* Top Controls */}
      <div className="flex flex-col justify-between gap-4 border-b border-slate-200 pb-6 sm:flex-row sm:items-center">
        <div className="relative flex-1 max-w-md">
          <input
            type="text"
            className="w-full rounded-xl border border-slate-200 bg-white py-2 pl-9 pr-4 text-xs shadow-sm placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            placeholder="Search subscriptions by customer or plan..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <SearchIcon className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
        </div>

        <div className="flex items-center gap-3">
          {/* Type Filter */}
          <div className="flex rounded-xl bg-slate-100 p-1">
            {[
              { label: "All", value: "ALL" },
              { label: "Organizations", value: "ORGANIZATION" },
              { label: "Independent", value: "INDEPENDENT" },
            ].map((tab) => (
              <button
                key={tab.value}
                onClick={() => setTypeFilter(tab.value)}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${
                  typeFilter === tab.value
                    ? "bg-white text-indigo-600 shadow-sm"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <button
            onClick={loadData}
            title="Refresh subscriptions"
            className="flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 shadow-sm hover:bg-slate-50"
          >
            <RefreshIcon className={`h-4 w-4 ${loading ? "animate-spin text-indigo-600" : ""}`} />
          </button>
        </div>
      </div>

      {loadError && (
        <div className="mt-6">
          <Alert variant="error">{loadError}</Alert>
        </div>
      )}

      {/* Subscriptions Table */}
      <div className="mt-6 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        {loading ? (
          <div className="p-8 space-y-4">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-12 w-full animate-pulse rounded-lg bg-slate-100" />
            ))}
          </div>
        ) : filteredSubscriptions.length === 0 ? (
          <div className="p-12 text-center">
            <ShieldIcon className="mx-auto h-10 w-10 text-slate-300" />
            <p className="mt-3 text-sm font-semibold text-slate-900">No subscriptions found</p>
            <p className="mt-1 text-xs text-slate-500">
              {search || typeFilter !== "ALL" || statusFilter !== "ALL"
                ? "Try adjusting your search query or filter."
                : "Active customer subscriptions will appear here."}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 bg-slate-50/75 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-6 py-3.5">Customer</th>
                  <th className="px-6 py-3.5">Type</th>
                  <th className="px-6 py-3.5">Plan Tier</th>
                  <th className="px-6 py-3.5">Monthly Price</th>
                  <th className="px-6 py-3.5">Status</th>
                  <th className="px-6 py-3.5">Start Date</th>
                  <th className="px-6 py-3.5">Expiry Date</th>
                  <th className="px-6 py-3.5">Access State</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-medium text-slate-700">
                {filteredSubscriptions.map((sub) => (
                  <tr key={sub.id} className="transition hover:bg-slate-50/80">
                    <td className="px-6 py-4">
                      <p className="font-semibold text-slate-900">{sub.customerName}</p>
                      <p className="text-[11px] text-slate-400">{sub.customerEmail}</p>
                    </td>

                    <td className="px-6 py-4">
                      <span
                        className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold ${
                          sub.type === "ORGANIZATION"
                            ? "bg-purple-50 text-purple-700"
                            : "bg-cyan-50 text-cyan-700"
                        }`}
                      >
                        {sub.type}
                      </span>
                    </td>

                    <td className="px-6 py-4 font-semibold text-slate-900">{sub.planName}</td>

                    <td className="px-6 py-4 text-slate-700">
                      {sub.price ? `$${sub.price}/mo` : "—"}
                    </td>

                    <td className="px-6 py-4">
                      <span
                        className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold ${
                          SUB_STATUS_STYLES[sub.status] ?? "bg-slate-100 text-slate-600"
                        }`}
                      >
                        {sub.status}
                      </span>
                    </td>

                    <td className="px-6 py-4 text-slate-500">
                      {sub.startDate ? new Date(sub.startDate).toLocaleDateString() : "—"}
                    </td>

                    <td className="px-6 py-4 text-slate-500">
                      {sub.expiryDate ? new Date(sub.expiryDate).toLocaleDateString() : "—"}
                    </td>

                    <td className="px-6 py-4">
                      <span
                        className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold ${
                          sub.usable
                            ? "bg-emerald-50 text-emerald-700"
                            : "bg-rose-50 text-rose-700"
                        }`}
                      >
                        {sub.usable ? "USABLE (ACTIVE)" : "INACTIVE / LAPSED"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </DashboardShell>
  );
};

export default AdminSubscriptions;
