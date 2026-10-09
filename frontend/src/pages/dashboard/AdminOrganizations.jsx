import { useEffect, useState } from "react";
import DashboardShell from "../../components/ui/DashboardShell";
import Button from "../../components/ui/Button";
import Alert from "../../components/ui/Alert";
import {
  ChartIcon,
  BuildingIcon,
  UsersIcon,
  SparkIcon,
  LockIcon,
  SearchIcon,
  EyeIcon,
  RefreshIcon,
  XIcon,
} from "../../components/ui/icons";
import {
  listOrganizations,
  getOrganizationDetail,
} from "../../services/adminService";

const NAV_ITEMS = [
  { label: "Dashboard", icon: ChartIcon, to: "/admin/dashboard" },
  { label: "Organizations", icon: BuildingIcon, to: "/admin/organizations" },
  { label: "Recruiters", icon: UsersIcon, to: "/admin/recruiters" },
  { label: "Plans & Pricing", icon: SparkIcon, to: "/admin/plans" },
  { label: "Audit Logs", icon: LockIcon, to: "/admin/audit-logs" },
];

const STATUS_STYLES = {
  ACTIVE: "bg-emerald-50 text-emerald-700 border-emerald-200",
  PENDING_VERIFICATION: "bg-amber-50 text-amber-700 border-amber-200",
  SUSPENDED: "bg-rose-50 text-rose-700 border-rose-200",
};

const SUB_STATUS_STYLES = {
  ACTIVE: "bg-emerald-50 text-emerald-700",
  TRIAL: "bg-blue-50 text-blue-700",
  EXPIRED: "bg-amber-50 text-amber-700",
  SUSPENDED: "bg-rose-50 text-rose-700",
  CANCELLED: "bg-slate-100 text-slate-600",
};

const AdminOrganizations = () => {
  const [organizations, setOrganizations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");

  // Detail Drawer State
  const [selectedOrgId, setSelectedOrgId] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [orgDetail, setOrgDetail] = useState(null);
  const [detailError, setDetailError] = useState(null);

  const fetchOrganizations = async (params = { search, status: statusFilter }) => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await listOrganizations(params);
      setOrganizations(res.data ?? []);
    } catch (err) {
      setLoadError(err.response?.data?.message ?? "Could not load organizations.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOrganizations({ search, status: statusFilter });
  }, [statusFilter]);

  const handleSearchSubmit = (e) => {
    e.preventDefault();
    fetchOrganizations({ search, status: statusFilter });
  };

  const handleOpenDetail = async (orgId) => {
    setSelectedOrgId(orgId);
    setDetailLoading(true);
    setDetailError(null);
    try {
      const res = await getOrganizationDetail(orgId);
      setOrgDetail(res.data);
    } catch (err) {
      setDetailError(err.response?.data?.message ?? "Could not load organization details.");
    } finally {
      setDetailLoading(false);
    }
  };

  const handleCloseDetail = () => {
    setSelectedOrgId(null);
    setOrgDetail(null);
    setDetailError(null);
  };

  return (
    <DashboardShell
      roleLabel="Platform Admin"
      title="Organizations"
      description="Monitor organizations, team members, and subscription activity platform-wide."
      navItems={NAV_ITEMS}
    >
      {/* Top Filter & Search Bar */}
      <div className="flex flex-col justify-between gap-4 border-b border-slate-200 pb-6 sm:flex-row sm:items-center">
        <form onSubmit={handleSearchSubmit} className="relative flex-1 max-w-md">
          <input
            type="text"
            className="w-full rounded-xl border border-slate-200 bg-white py-2 pl-9 pr-4 text-xs shadow-sm placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            placeholder="Search organizations by name..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <SearchIcon className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
        </form>

        <div className="flex items-center gap-3">
          {/* Status Filter Tabs */}
          <div className="flex rounded-xl bg-slate-100 p-1">
            {[
              { label: "All", value: "ALL" },
              { label: "Active", value: "ACTIVE" },
              { label: "Pending", value: "PENDING_VERIFICATION" },
              { label: "Suspended", value: "SUSPENDED" },
            ].map((tab) => (
              <button
                key={tab.value}
                onClick={() => setStatusFilter(tab.value)}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${
                  statusFilter === tab.value
                    ? "bg-white text-indigo-600 shadow-sm"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <button
            onClick={() => fetchOrganizations({ search, status: statusFilter })}
            title="Refresh list"
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

      {/* Organizations Table */}
      <div className="mt-6 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        {loading ? (
          <div className="p-8 space-y-4">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-12 w-full animate-pulse rounded-lg bg-slate-100" />
            ))}
          </div>
        ) : organizations.length === 0 ? (
          <div className="p-12 text-center">
            <BuildingIcon className="mx-auto h-10 w-10 text-slate-300" />
            <p className="mt-3 text-sm font-semibold text-slate-900">No organizations found</p>
            <p className="mt-1 text-xs text-slate-500">
              {search || statusFilter !== "ALL"
                ? "Try adjusting your search query or filter."
                : "Registered organizations will appear here."}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 bg-slate-50/75 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-6 py-3.5">Organization</th>
                  <th className="px-6 py-3.5">ORG_ADMIN</th>
                  <th className="px-6 py-3.5">Members</th>
                  <th className="px-6 py-3.5">Recruiters</th>
                  <th className="px-6 py-3.5">Plan</th>
                  <th className="px-6 py-3.5">Subscription</th>
                  <th className="px-6 py-3.5">Expiry</th>
                  <th className="px-6 py-3.5">Status</th>
                  <th className="px-6 py-3.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-medium text-slate-700">
                {organizations.map((org) => {
                  const sub = org.subscription;
                  const totalMembers = org.memberCounts?.totalActiveMembers ?? 0;
                  const activeRecruiters = org.memberCounts?.activeRecruiters ?? 0;

                  return (
                    <tr key={org.id} className="transition hover:bg-slate-50/80">
                      <td className="px-6 py-4">
                        <p className="font-semibold text-slate-900">{org.name}</p>
                        {org.businessEmail && <p className="text-[11px] text-slate-400">{org.businessEmail}</p>}
                      </td>

                      <td className="px-6 py-4">
                        {org.owner ? (
                          <>
                            <p className="font-semibold text-slate-900">{org.owner.fullName}</p>
                            <p className="text-[11px] text-slate-400">{org.owner.email}</p>
                          </>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>

                      <td className="px-6 py-4">
                        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">
                          {totalMembers} {totalMembers === 1 ? "member" : "members"}
                        </span>
                      </td>

                      <td className="px-6 py-4">
                        <span className="font-semibold text-slate-900">{activeRecruiters}</span>
                        {sub?.maxUsers && <span className="text-slate-400"> / {sub.maxUsers} max</span>}
                      </td>

                      <td className="px-6 py-4">
                        {sub?.planName ? (
                          <span className="font-semibold text-slate-900">{sub.planName}</span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>

                      <td className="px-6 py-4">
                        {sub?.status ? (
                          <span
                            className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold ${
                              SUB_STATUS_STYLES[sub.status] ?? "bg-slate-100 text-slate-600"
                            }`}
                          >
                            {sub.status}
                          </span>
                        ) : (
                          <span className="text-slate-400">NONE</span>
                        )}
                      </td>

                      <td className="px-6 py-4 text-slate-500">
                        {sub?.expiryDate ? new Date(sub.expiryDate).toLocaleDateString() : "—"}
                      </td>

                      <td className="px-6 py-4">
                        <span
                          className={`rounded-full border px-2.5 py-0.5 text-[10px] font-bold ${
                            STATUS_STYLES[org.status] ?? "bg-slate-100 text-slate-600"
                          }`}
                        >
                          {org.status.replace(/_/g, " ")}
                        </span>
                      </td>

                      <td className="px-6 py-4 text-right">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => handleOpenDetail(org.id)}
                          className="inline-flex items-center gap-1.5"
                        >
                          <EyeIcon className="h-3.5 w-3.5" />
                          View Details
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Organization Detail Slide-over Modal / Drawer */}
      {selectedOrgId && (
        <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/50 backdrop-blur-sm">
          <div className="relative flex h-full w-full max-w-2xl flex-col bg-white shadow-2xl">
            {/* Drawer Header */}
            <div className="flex items-center justify-between border-b border-slate-200 px-6 py-5">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500 to-teal-400 text-white">
                  <BuildingIcon className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="font-display text-lg font-bold text-slate-900">
                    {orgDetail?.name ?? "Organization Details"}
                  </h3>
                  <p className="text-xs text-slate-500">Platform administrator inspection</p>
                </div>
              </div>

              <button
                onClick={handleCloseDetail}
                className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              >
                <XIcon className="h-5 w-5" />
              </button>
            </div>

            {/* Drawer Content */}
            <div className="flex-1 overflow-y-auto p-6 space-y-6 text-xs">
              {detailLoading ? (
                <div className="space-y-4 py-8">
                  {[...Array(6)].map((_, i) => (
                    <div key={i} className="h-10 w-full animate-pulse rounded-lg bg-slate-100" />
                  ))}
                </div>
              ) : detailError ? (
                <Alert variant="error">{detailError}</Alert>
              ) : orgDetail ? (
                <>
                  {/* Organization Overview Box */}
                  <div className="rounded-2xl border border-slate-200 bg-slate-50/50 p-5 space-y-3">
                    <div className="flex items-center justify-between">
                      <h4 className="font-semibold text-slate-900 uppercase tracking-wider text-[11px]">
                        Organization Profile
                      </h4>
                      <span
                        className={`rounded-full border px-2.5 py-0.5 text-[10px] font-bold ${
                          STATUS_STYLES[orgDetail.status] ?? "bg-slate-100 text-slate-600"
                        }`}
                      >
                        {orgDetail.status.replace(/_/g, " ")}
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-3 text-slate-600">
                      <div>
                        <span className="font-medium text-slate-400">Created:</span>{" "}
                        <span className="font-semibold text-slate-800">
                          {new Date(orgDetail.createdAt).toLocaleDateString()}
                        </span>
                      </div>
                      <div>
                        <span className="font-medium text-slate-400">Website:</span>{" "}
                        <span className="font-semibold text-slate-800">{orgDetail.website ?? "—"}</span>
                      </div>
                      <div>
                        <span className="font-medium text-slate-400">Business Email:</span>{" "}
                        <span className="font-semibold text-slate-800">{orgDetail.businessEmail ?? "—"}</span>
                      </div>
                      <div>
                        <span className="font-medium text-slate-400">Owner Status:</span>{" "}
                        <span className="font-semibold text-slate-800">{orgDetail.owner?.status ?? "—"}</span>
                      </div>
                    </div>
                  </div>

                  {/* ORG_ADMIN Details */}
                  <div className="rounded-2xl border border-slate-200 p-5 space-y-3">
                    <h4 className="font-semibold text-slate-900 uppercase tracking-wider text-[11px]">
                      Administrator (ORG_ADMIN)
                    </h4>
                    {orgDetail.owner ? (
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="font-bold text-slate-900 text-sm">{orgDetail.owner.fullName}</p>
                          <p className="text-slate-500">{orgDetail.owner.email}</p>
                        </div>
                        <span className="rounded-full bg-purple-50 px-2.5 py-1 font-bold text-purple-700 text-[10px]">
                          PRIMARY OWNER
                        </span>
                      </div>
                    ) : (
                      <p className="text-slate-400">No owner account linked.</p>
                    )}
                  </div>

                  {/* Subscription & Payment Monitoring */}
                  <div className="rounded-2xl border border-slate-200 p-5 space-y-3">
                    <div className="flex items-center justify-between">
                      <h4 className="font-semibold text-slate-900 uppercase tracking-wider text-[11px]">
                        Subscription & Payment Monitoring
                      </h4>
                      <span className="text-[10px] font-semibold text-amber-600 bg-amber-50 rounded-full px-2 py-0.5">
                        Read-only
                      </span>
                    </div>

                    {orgDetail.subscription?.planName ? (
                      <div className="space-y-2">
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <span className="text-slate-400 font-medium">Plan:</span>{" "}
                            <span className="font-bold text-slate-900">{orgDetail.subscription.planName}</span>
                          </div>
                          <div>
                            <span className="text-slate-400 font-medium">Price:</span>{" "}
                            <span className="font-bold text-slate-900">
                              {orgDetail.subscription.price ? `$${orgDetail.subscription.price}/mo` : "—"}
                            </span>
                          </div>
                          <div>
                            <span className="text-slate-400 font-medium">Subscription Status:</span>{" "}
                            <span
                              className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                                SUB_STATUS_STYLES[orgDetail.subscription.status] ?? "bg-slate-100"
                              }`}
                            >
                              {orgDetail.subscription.status}
                            </span>
                          </div>
                          <div>
                            <span className="text-slate-400 font-medium">Seat Limit:</span>{" "}
                            <span className="font-bold text-slate-900">
                              {orgDetail.subscription.maxUsers ? `${orgDetail.subscription.maxUsers} users` : "Unlimited"}
                            </span>
                          </div>
                          <div>
                            <span className="text-slate-400 font-medium">Start Date:</span>{" "}
                            <span className="font-semibold text-slate-800">
                              {orgDetail.subscription.startDate
                                ? new Date(orgDetail.subscription.startDate).toLocaleDateString()
                                : "—"}
                            </span>
                          </div>
                          <div>
                            <span className="text-slate-400 font-medium">Expiry Date:</span>{" "}
                            <span className="font-semibold text-slate-800">
                              {orgDetail.subscription.expiryDate
                                ? new Date(orgDetail.subscription.expiryDate).toLocaleDateString()
                                : "—"}
                            </span>
                          </div>
                        </div>

                        <div className="mt-3 rounded-xl bg-slate-50 p-3 text-slate-600 text-[11px]">
                          <p>
                            <span className="font-medium text-slate-400">Payment Gateway:</span>{" "}
                            <span className="font-semibold text-slate-800">Simulated (Development Mode)</span>
                          </p>
                          <p className="mt-1">
                            <span className="font-medium text-slate-400">Payment Reference:</span>{" "}
                            <span className="font-semibold text-slate-800">Not Available (Awaiting live integration)</span>
                          </p>
                        </div>
                      </div>
                    ) : (
                      <p className="text-slate-400 py-2">No active subscription found for this organization.</p>
                    )}
                  </div>

                  {/* Team Members List (Authoritative OrganizationMembership) */}
                  <div className="rounded-2xl border border-slate-200 p-5 space-y-3">
                    <div className="flex items-center justify-between">
                      <h4 className="font-semibold text-slate-900 uppercase tracking-wider text-[11px]">
                        Organization Members ({orgDetail.members?.length ?? 0})
                      </h4>
                      <span className="text-[10px] text-slate-400 font-medium">
                        ORG_ADMIN + Recruiters
                      </span>
                    </div>

                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs">
                        <thead>
                          <tr className="border-b border-slate-100 text-slate-400 font-semibold">
                            <th className="pb-2">User</th>
                            <th className="pb-2">Role</th>
                            <th className="pb-2">Status</th>
                            <th className="pb-2">Permissions</th>
                            <th className="pb-2">Joined</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {orgDetail.members?.map((m) => (
                            <tr key={m.membershipId}>
                              <td className="py-2.5 pr-2">
                                <p className="font-semibold text-slate-900">{m.fullName}</p>
                                <p className="text-[10px] text-slate-400">{m.email}</p>
                              </td>
                              <td className="py-2.5 pr-2 font-medium">{m.role}</td>
                              <td className="py-2.5 pr-2">
                                <span
                                  className={`rounded-full px-2 py-0.5 text-[9px] font-bold ${
                                    m.membershipStatus === "ACTIVE"
                                      ? "bg-emerald-50 text-emerald-700"
                                      : "bg-slate-100 text-slate-500"
                                  }`}
                                >
                                  {m.membershipStatus}
                                </span>
                              </td>
                              <td className="py-2.5 pr-2">
                                {m.permissions && m.permissions.length > 0 ? (
                                  <div className="flex flex-wrap gap-1">
                                    {m.permissions.map((p) => (
                                      <span
                                        key={p}
                                        className="rounded bg-indigo-50 px-1 py-0.5 text-[9px] font-semibold text-indigo-700"
                                      >
                                        {p.replace("CANDIDATE_", "")}
                                      </span>
                                    ))}
                                  </div>
                                ) : (
                                  <span className="text-slate-400 text-[10px]">None</span>
                                )}
                              </td>
                              <td className="py-2.5 text-slate-400 text-[10px]">
                                {new Date(m.joinedAt).toLocaleDateString()}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              ) : null}
            </div>

            {/* Drawer Footer */}
            <div className="border-t border-slate-200 px-6 py-4 flex justify-end">
              <Button variant="secondary" onClick={handleCloseDetail}>
                Close Inspector
              </Button>
            </div>
          </div>
        </div>
      )}
    </DashboardShell>
  );
};

export default AdminOrganizations;
