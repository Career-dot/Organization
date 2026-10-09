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
  listRecruiters,
  getRecruiterDetail,
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

const AdminRecruiters = () => {
  const [recruiters, setRecruiters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("ALL"); // ALL, INDEPENDENT, ORGANIZATION

  // Detail Drawer State
  const [selectedRecruiterId, setSelectedRecruiterId] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [recruiterDetail, setRecruiterDetail] = useState(null);
  const [detailError, setDetailError] = useState(null);

  const fetchRecruiters = async (params = { search, type: typeFilter }) => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await listRecruiters(params);
      setRecruiters(res.data ?? []);
    } catch (err) {
      setLoadError(err.response?.data?.message ?? "Could not load recruiters.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRecruiters({ search, type: typeFilter });
  }, [typeFilter]);

  const handleSearchSubmit = (e) => {
    e.preventDefault();
    fetchRecruiters({ search, type: typeFilter });
  };

  const handleOpenDetail = async (id) => {
    setSelectedRecruiterId(id);
    setDetailLoading(true);
    setDetailError(null);
    try {
      const res = await getRecruiterDetail(id);
      setRecruiterDetail(res.data);
    } catch (err) {
      setDetailError(err.response?.data?.message ?? "Could not load recruiter profile.");
    } finally {
      setDetailLoading(false);
    }
  };

  const handleCloseDetail = () => {
    setSelectedRecruiterId(null);
    setRecruiterDetail(null);
    setDetailError(null);
  };

  return (
    <DashboardShell
      roleLabel="Platform Admin"
      title="Recruiters"
      description="Monitor independent recruiters and organization-affiliated team recruiters platform-wide."
      navItems={NAV_ITEMS}
    >
      {/* Top Filter & Search Bar */}
      <div className="flex flex-col justify-between gap-4 border-b border-slate-200 pb-6 sm:flex-row sm:items-center">
        <form onSubmit={handleSearchSubmit} className="relative flex-1 max-w-md">
          <input
            type="text"
            className="w-full rounded-xl border border-slate-200 bg-white py-2 pl-9 pr-4 text-xs shadow-sm placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            placeholder="Search recruiters by name or email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <SearchIcon className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
        </form>

        <div className="flex items-center gap-3">
          {/* Type Filter Tabs */}
          <div className="flex rounded-xl bg-slate-100 p-1">
            {[
              { label: "All Recruiters", value: "ALL" },
              { label: "Independent", value: "INDEPENDENT" },
              { label: "Organization", value: "ORGANIZATION" },
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
            onClick={() => fetchRecruiters({ search, type: typeFilter })}
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

      {/* Recruiters Table */}
      <div className="mt-6 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        {loading ? (
          <div className="p-8 space-y-4">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-12 w-full animate-pulse rounded-lg bg-slate-100" />
            ))}
          </div>
        ) : recruiters.length === 0 ? (
          <div className="p-12 text-center">
            <UsersIcon className="mx-auto h-10 w-10 text-slate-300" />
            <p className="mt-3 text-sm font-semibold text-slate-900">No recruiters found</p>
            <p className="mt-1 text-xs text-slate-500">
              {search || typeFilter !== "ALL"
                ? "Try adjusting your search query or filter."
                : "Registered recruiters will appear here."}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 bg-slate-50/75 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-6 py-3.5">Recruiter</th>
                  <th className="px-6 py-3.5">Type</th>
                  <th className="px-6 py-3.5">Organization / Affiliation</th>
                  <th className="px-6 py-3.5">Subscription</th>
                  <th className="px-6 py-3.5">Status</th>
                  <th className="px-6 py-3.5">Registered</th>
                  <th className="px-6 py-3.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-medium text-slate-700">
                {recruiters.map((recruiter) => {
                  const isOrg = recruiter.recruiterType === "ORGANIZATION";
                  const sub = recruiter.subscription;

                  return (
                    <tr key={recruiter.id} className="transition hover:bg-slate-50/80">
                      <td className="px-6 py-4">
                        <p className="font-semibold text-slate-900">{recruiter.fullName}</p>
                        <p className="text-[11px] text-slate-400">{recruiter.email}</p>
                      </td>

                      <td className="px-6 py-4">
                        <span
                          className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold ${
                            isOrg ? "bg-purple-50 text-purple-700" : "bg-cyan-50 text-cyan-700"
                          }`}
                        >
                          {recruiter.recruiterType}
                        </span>
                      </td>

                      <td className="px-6 py-4">
                        {isOrg ? (
                          <div>
                            <p className="font-semibold text-slate-900">{recruiter.organization?.name}</p>
                            <p className="text-[10px] text-slate-400">Role: {recruiter.organization?.role}</p>
                          </div>
                        ) : (
                          <span className="text-slate-500 italic">Independent (Self-employed)</span>
                        )}
                      </td>

                      <td className="px-6 py-4">
                        {isOrg ? (
                          <div>
                            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600">
                              Covered by Organization
                            </span>
                            {sub?.planName && (
                              <p className="text-[10px] text-slate-400 mt-0.5">Plan: {sub.planName}</p>
                            )}
                          </div>
                        ) : sub?.planName ? (
                          <div className="flex items-center gap-1.5">
                            <span className="font-semibold text-slate-900">{sub.planName}</span>
                            <span
                              className={`rounded-full px-1.5 py-0.5 text-[9px] font-bold ${
                                SUB_STATUS_STYLES[sub.status] ?? "bg-slate-100"
                              }`}
                            >
                              {sub.status}
                            </span>
                          </div>
                        ) : (
                          <span className="text-slate-400">No active plan</span>
                        )}
                      </td>

                      <td className="px-6 py-4">
                        <span
                          className={`rounded-full border px-2.5 py-0.5 text-[10px] font-bold ${
                            STATUS_STYLES[recruiter.status] ?? "bg-slate-100 text-slate-600"
                          }`}
                        >
                          {recruiter.status}
                        </span>
                      </td>

                      <td className="px-6 py-4 text-slate-500">
                        {new Date(recruiter.createdAt).toLocaleDateString()}
                      </td>

                      <td className="px-6 py-4 text-right">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => handleOpenDetail(recruiter.id)}
                          className="inline-flex items-center gap-1.5"
                        >
                          <EyeIcon className="h-3.5 w-3.5" />
                          View Profile
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

      {/* Recruiter Detail Slide-over Modal / Drawer */}
      {selectedRecruiterId && (
        <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/50 backdrop-blur-sm">
          <div className="relative flex h-full w-full max-w-xl flex-col bg-white shadow-2xl">
            {/* Drawer Header */}
            <div className="flex items-center justify-between border-b border-slate-200 px-6 py-5">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-500 to-blue-400 text-white">
                  <UsersIcon className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="font-display text-lg font-bold text-slate-900">
                    {recruiterDetail?.fullName ?? "Recruiter Profile"}
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
              ) : recruiterDetail ? (
                <>
                  {/* Overview Profile Box */}
                  <div className="rounded-2xl border border-slate-200 bg-slate-50/50 p-5 space-y-3">
                    <div className="flex items-center justify-between">
                      <h4 className="font-semibold text-slate-900 uppercase tracking-wider text-[11px]">
                        Account Profile
                      </h4>
                      <span
                        className={`rounded-full border px-2.5 py-0.5 text-[10px] font-bold ${
                          STATUS_STYLES[recruiterDetail.status] ?? "bg-slate-100 text-slate-600"
                        }`}
                      >
                        {recruiterDetail.status}
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-3 text-slate-600">
                      <div>
                        <span className="font-medium text-slate-400">Email:</span>{" "}
                        <span className="font-semibold text-slate-800">{recruiterDetail.email}</span>
                      </div>
                      <div>
                        <span className="font-medium text-slate-400">Email Verified:</span>{" "}
                        <span className="font-semibold text-slate-800">
                          {recruiterDetail.emailVerified ? "Verified (Yes)" : "Unverified (No)"}
                        </span>
                      </div>
                      <div>
                        <span className="font-medium text-slate-400">Joined Platform:</span>{" "}
                        <span className="font-semibold text-slate-800">
                          {new Date(recruiterDetail.createdAt).toLocaleDateString()}
                        </span>
                      </div>
                      <div>
                        <span className="font-medium text-slate-400">Last Login:</span>{" "}
                        <span className="font-semibold text-slate-800">
                          {recruiterDetail.lastLogin
                            ? new Date(recruiterDetail.lastLogin).toLocaleDateString()
                            : "—"}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Recruiter Classification & Affiliation */}
                  <div className="rounded-2xl border border-slate-200 p-5 space-y-3">
                    <div className="flex items-center justify-between">
                      <h4 className="font-semibold text-slate-900 uppercase tracking-wider text-[11px]">
                        Affiliation & Role
                      </h4>
                      <span
                        className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold ${
                          recruiterDetail.recruiterType === "ORGANIZATION"
                            ? "bg-purple-50 text-purple-700"
                            : "bg-cyan-50 text-cyan-700"
                        }`}
                      >
                        {recruiterDetail.recruiterType}
                      </span>
                    </div>

                    {recruiterDetail.organization ? (
                      <div className="space-y-2 rounded-xl bg-purple-50/50 p-3 text-purple-950">
                        <div className="flex justify-between">
                          <span className="font-medium text-purple-600">Organization:</span>
                          <span className="font-bold">{recruiterDetail.organization.name}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="font-medium text-purple-600">Organization Role:</span>
                          <span className="font-bold">{recruiterDetail.organization.role}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="font-medium text-purple-600">Membership Status:</span>
                          <span className="font-bold">{recruiterDetail.organization.membershipStatus}</span>
                        </div>
                        {recruiterDetail.organization.permissions && (
                          <div className="mt-2 pt-2 border-t border-purple-200/60">
                            <span className="text-[10px] font-semibold text-purple-600">Permissions:</span>
                            <div className="mt-1 flex flex-wrap gap-1">
                              {recruiterDetail.organization.permissions.map((p) => (
                                <span
                                  key={p}
                                  className="rounded bg-white px-1.5 py-0.5 text-[9px] font-bold text-purple-700 shadow-sm"
                                >
                                  {p}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    ) : (
                      <p className="text-slate-500">
                        This recruiter operates independently with a personal subscription. They are not a member of any organization team.
                      </p>
                    )}
                  </div>

                  {/* Subscription Monitoring */}
                  <div className="rounded-2xl border border-slate-200 p-5 space-y-3">
                    <div className="flex items-center justify-between">
                      <h4 className="font-semibold text-slate-900 uppercase tracking-wider text-[11px]">
                        Subscription Status
                      </h4>
                      <span className="text-[10px] font-semibold text-amber-600 bg-amber-50 rounded-full px-2 py-0.5">
                        Read-only
                      </span>
                    </div>

                    {recruiterDetail.subscription?.planName ? (
                      <div className="grid grid-cols-2 gap-3 text-slate-600">
                        <div>
                          <span className="text-slate-400 font-medium">Plan:</span>{" "}
                          <span className="font-bold text-slate-900">{recruiterDetail.subscription.planName}</span>
                        </div>
                        <div>
                          <span className="text-slate-400 font-medium">Status:</span>{" "}
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                              SUB_STATUS_STYLES[recruiterDetail.subscription.status] ?? "bg-slate-100"
                            }`}
                          >
                            {recruiterDetail.subscription.status}
                          </span>
                        </div>
                        <div>
                          <span className="text-slate-400 font-medium">Expiry:</span>{" "}
                          <span className="font-semibold text-slate-800">
                            {recruiterDetail.subscription.expiryDate
                              ? new Date(recruiterDetail.subscription.expiryDate).toLocaleDateString()
                              : "—"}
                          </span>
                        </div>
                        <div>
                          <span className="text-slate-400 font-medium">Usable:</span>{" "}
                          <span className="font-semibold text-slate-800">
                            {recruiterDetail.subscription.usable ? "Yes (Active)" : "No (Expired / Lapsed)"}
                          </span>
                        </div>
                      </div>
                    ) : (
                      <p className="text-slate-400">
                        {recruiterDetail.recruiterType === "ORGANIZATION"
                          ? "Covered under organization-level subscription."
                          : "No active personal subscription found."}
                      </p>
                    )}
                  </div>
                </>
              ) : null}
            </div>

            {/* Drawer Footer */}
            <div className="border-t border-slate-200 px-6 py-4 flex justify-end">
              <Button variant="secondary" onClick={handleCloseDetail}>
                Close Profile
              </Button>
            </div>
          </div>
        </div>
      )}
    </DashboardShell>
  );
};

export default AdminRecruiters;
