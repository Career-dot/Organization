import { useEffect, useState } from "react";
import DashboardShell from "../../components/ui/DashboardShell";
import Button from "../../components/ui/Button";
import Alert from "../../components/ui/Alert";
import FormField, { inputClasses } from "../../components/ui/FormField";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import {
  ChartIcon,
  BuildingIcon,
  UsersIcon,
  SparkIcon,
  LockIcon,
  PlusIcon,
  EditIcon,
  RefreshIcon,
  XIcon,
} from "../../components/ui/icons";
import { listPlans, createPlan, updatePlan } from "../../services/adminService";

const NAV_ITEMS = [
  { label: "Dashboard", icon: ChartIcon, to: "/admin/dashboard" },
  { label: "Organizations", icon: BuildingIcon, to: "/admin/organizations" },
  { label: "Recruiters", icon: UsersIcon, to: "/admin/recruiters" },
  { label: "Plans & Pricing", icon: SparkIcon, to: "/admin/plans" },
  { label: "Audit Logs", icon: LockIcon, to: "/admin/audit-logs" },
];

const emptyForm = { name: "", type: "ORGANIZATION", price: "", maxUsers: "", jobPostingLimit: "", description: "" };

const formatLimit = (value) => value == null ? "Unlimited" : value;

const getPlanLimitSummary = (plan) => {
  const totalSeats = plan.type === "ORGANIZATION" ? plan.maxUsers : 1;
  const recruiterSeats = plan.type === "ORGANIZATION"
    ? plan.maxUsers == null ? null : Math.max(0, plan.maxUsers - 1)
    : 1;
  const maximumAnalyses = plan.type === "ORGANIZATION"
    ? recruiterSeats == null || plan.jobPostingLimit == null
      ? null
      : recruiterSeats * plan.jobPostingLimit
    : plan.jobPostingLimit;

  return { totalSeats, recruiterSeats, maximumAnalyses };
};

const AdminPlans = () => {
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  // Create Plan Modal State
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState(null);

  // Edit Plan Modal State
  const [editingPlan, setEditingPlan] = useState(null);
  const [editForm, setEditForm] = useState({ name: "", price: "", maxUsers: "", jobPostingLimit: "", description: "" });
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState(null);

  // Activate / Deactivate Confirmation Dialog
  const [pendingTogglePlan, setPendingTogglePlan] = useState(null);
  const [toggling, setToggling] = useState(false);

  const loadPlans = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await listPlans();
      setPlans(res.data ?? []);
    } catch (err) {
      setLoadError(err.response?.data?.message ?? "Could not load subscription plans.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPlans();
  }, []);

  const handleCreateSubmit = async (event) => {
    event.preventDefault();
    setFormError(null);

    const price = Number(form.price);
    if (!form.name.trim() || !Number.isFinite(price) || price <= 0) {
      setFormError("Plan name and a price greater than 0 are required.");
      return;
    }

    setSubmitting(true);
    try {
      await createPlan({
        name: form.name.trim(),
        type: form.type,
        price,
        billingCycle: "MONTHLY",
        maxUsers: form.maxUsers ? Number(form.maxUsers) : null,
        jobPostingLimit: form.jobPostingLimit ? Number(form.jobPostingLimit) : null,
        description: form.description.trim() || undefined,
      });
      setForm(emptyForm);
      setIsCreateModalOpen(false);
      loadPlans();
    } catch (err) {
      setFormError(err.response?.data?.message ?? "Could not create subscription plan.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleOpenEdit = (plan) => {
    setEditingPlan(plan);
    setEditForm({
      name: plan.name,
      price: String(plan.price),
      maxUsers: plan.maxUsers ? String(plan.maxUsers) : "",
      jobPostingLimit: plan.jobPostingLimit ? String(plan.jobPostingLimit) : "",
      description: plan.description ?? "",
    });
    setEditError(null);
  };

  const handleEditSubmit = async (event) => {
    event.preventDefault();
    setEditError(null);

    const price = Number(editForm.price);
    if (!editForm.name.trim() || !Number.isFinite(price) || price <= 0) {
      setEditError("Plan name and a price greater than 0 are required.");
      return;
    }

    setSavingEdit(true);
    try {
      await updatePlan(editingPlan.id, {
        name: editForm.name.trim(),
        price,
        maxUsers: editForm.maxUsers ? Number(editForm.maxUsers) : null,
        jobPostingLimit: editForm.jobPostingLimit ? Number(editForm.jobPostingLimit) : null,
        description: editForm.description.trim() || undefined,
      });
      setEditingPlan(null);
      loadPlans();
    } catch (err) {
      setEditError(err.response?.data?.message ?? "Could not update subscription plan.");
    } finally {
      setSavingEdit(false);
    }
  };

  const handleConfirmToggleActive = async () => {
    if (!pendingTogglePlan) return;
    setToggling(true);
    try {
      await updatePlan(pendingTogglePlan.id, { isActive: !pendingTogglePlan.isActive });
      setPendingTogglePlan(null);
      loadPlans();
    } catch (err) {
      setLoadError(err.response?.data?.message ?? "Could not update plan status.");
    } finally {
      setToggling(false);
    }
  };

  return (
    <DashboardShell
      roleLabel="Platform Admin"
      title="Plans & Pricing Catalog"
      description="Manage the global subscription plan catalog. Configure pricing tiers, seat limits, and availability."
      navItems={NAV_ITEMS}
    >
      {/* Top Controls */}
      <div className="flex flex-col justify-between gap-4 border-b border-slate-200 pb-6 sm:flex-row sm:items-center">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Subscription Catalog Tiers</h2>
          <p className="text-xs text-slate-500">Live self-service subscription offerings for Organizations & Independent Recruiters</p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={loadPlans}
            title="Refresh plans"
            className="flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 shadow-sm hover:bg-slate-50"
          >
            <RefreshIcon className={`h-4 w-4 ${loading ? "animate-spin text-indigo-600" : ""}`} />
          </button>

          <Button
            onClick={() => setIsCreateModalOpen(true)}
            className="inline-flex items-center gap-1.5 text-xs"
          >
            <PlusIcon className="h-4 w-4" />
            Add New Plan
          </Button>
        </div>
      </div>

      {loadError && (
        <div className="mt-6">
          <Alert variant="error">{loadError}</Alert>
        </div>
      )}

      {/* Plans Grid */}
      <div className="mt-8">
        {loading ? (
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-64 animate-pulse rounded-2xl border border-slate-200 bg-white p-6 shadow-sm" />
            ))}
          </div>
        ) : plans.length === 0 ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-12 text-center shadow-sm">
            <SparkIcon className="mx-auto h-10 w-10 text-slate-300" />
            <p className="mt-3 text-sm font-semibold text-slate-900">No subscription plans created</p>
            <p className="mt-1 text-xs text-slate-500">Click &quot;Add New Plan&quot; to initialize the subscription catalog.</p>
          </div>
        ) : (
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {plans.map((plan) => (
              <div
                key={plan.id}
                className={`relative flex flex-col justify-between rounded-2xl border bg-white p-6 shadow-sm transition-all hover:shadow-md ${
                  plan.isActive ? "border-slate-200" : "border-slate-200 bg-slate-50/60 opacity-80"
                }`}
              >
                {(() => {
                  const { totalSeats, recruiterSeats, maximumAnalyses } = getPlanLimitSummary(plan);

                  return (
                <div>
                  <div className="flex items-center justify-between">
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold ${
                        plan.type === "ORGANIZATION"
                          ? "bg-purple-50 text-purple-700"
                          : "bg-cyan-50 text-cyan-700"
                      }`}
                    >
                      {plan.type}
                    </span>

                    <span
                      className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold ${
                        plan.isActive
                          ? "bg-emerald-50 text-emerald-700"
                          : "bg-slate-200 text-slate-600"
                      }`}
                    >
                      {plan.isActive ? "ACTIVE CATALOG" : "DEACTIVATED"}
                    </span>
                  </div>

                  <h3 className="mt-4 font-display text-xl font-bold text-slate-900">{plan.name}</h3>
                  <p className="mt-1 text-xs text-slate-500 min-h-[32px] line-clamp-2">
                    {plan.description || "Full platform access tier."}
                  </p>

                  <div className="mt-4 flex items-baseline gap-1">
                    <span className="text-3xl font-extrabold tracking-tight text-slate-900">${plan.price}</span>
                    <span className="text-xs font-semibold text-slate-500">/ month</span>
                  </div>

                  <div className="mt-5 space-y-2 border-t border-slate-100 pt-4 text-xs text-slate-600">
                    <div className="flex justify-between">
                      <span className="text-slate-400 font-medium">Billing Cycle:</span>
                      <span className="font-semibold text-slate-800">{plan.billingCycle}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400 font-medium">Total Seats:</span>
                      <span className="font-semibold text-slate-800">{formatLimit(totalSeats)}</span>
                    </div>
                    {plan.type === "ORGANIZATION" ? (
                      <>
                        <div className="flex justify-between">
                          <span className="text-slate-400 font-medium">Org Admin Seats:</span>
                          <span className="font-semibold text-slate-800">1</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-slate-400 font-medium">Org Recruiters:</span>
                          <span className="font-semibold text-slate-800">{formatLimit(recruiterSeats)}</span>
                        </div>
                      </>
                    ) : (
                      <div className="flex justify-between">
                        <span className="text-slate-400 font-medium">Recruiter Seats:</span>
                        <span className="font-semibold text-slate-800">1</span>
                      </div>
                    )}
                    <div className="flex justify-between">
                      <span className="text-slate-400 font-medium">Job Analyses / Recruiter / Month:</span>
                      <span className="font-semibold text-slate-800">{formatLimit(plan.jobPostingLimit)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400 font-medium">Maximum Analyses / Month:</span>
                      <span className="font-semibold text-slate-800">{formatLimit(maximumAnalyses)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400 font-medium">Current Subscribers:</span>
                      <span className="font-bold text-indigo-600">
                        {plan.subscriptions?.length ?? 0} accounts
                      </span>
                    </div>
                  </div>
                </div>
                  );
                })()}

                {/* Actions Footer */}
                <div className="mt-6 flex items-center gap-2 border-t border-slate-100 pt-4">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => handleOpenEdit(plan)}
                    className="flex-1 inline-flex items-center justify-center gap-1.5"
                  >
                    <EditIcon className="h-3.5 w-3.5" />
                    Edit
                  </Button>

                  <Button
                    size="sm"
                    variant={plan.isActive ? "outline" : "secondary"}
                    onClick={() => setPendingTogglePlan(plan)}
                    className="flex-1"
                  >
                    {plan.isActive ? "Deactivate" : "Activate"}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Create Plan Modal */}
      {isCreateModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-100 pb-4">
              <div>
                <h3 className="font-display text-lg font-bold text-slate-900">Create Subscription Plan</h3>
                <p className="text-xs text-slate-500">Add a new plan tier to the platform catalog</p>
              </div>
              <button
                onClick={() => setIsCreateModalOpen(false)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              >
                <XIcon className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleCreateSubmit} className="mt-4 space-y-4 text-xs">
              {formError && <Alert variant="error">{formError}</Alert>}

              <FormField label="Plan Name" id="create-plan-name">
                <input
                  id="create-plan-name"
                  className={inputClasses}
                  value={form.name}
                  onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                  placeholder="e.g. Enterprise Team, Pro Recruiter"
                  required
                />
              </FormField>

              <div className="grid grid-cols-2 gap-4">
                <FormField label="Target Customer Type" id="create-plan-type">
                  <select
                    id="create-plan-type"
                    className={inputClasses}
                    value={form.type}
                    onChange={(e) => setForm((prev) => ({ ...prev, type: e.target.value }))}
                  >
                    <option value="ORGANIZATION">ORGANIZATION</option>
                    <option value="RECRUITER">RECRUITER</option>
                  </select>
                </FormField>

                <FormField label="Monthly Price ($ USD)" id="create-plan-price">
                  <input
                    id="create-plan-price"
                    type="number"
                    min="1"
                    step="0.01"
                    className={inputClasses}
                    value={form.price}
                    onChange={(e) => setForm((prev) => ({ ...prev, price: e.target.value }))}
                    placeholder="99"
                    required
                  />
                </FormField>
              </div>

              <FormField label="Total Seats (Optional)" id="create-plan-max-users">
                <input
                  id="create-plan-max-users"
                  type="number"
                  min="1"
                  className={inputClasses}
                  value={form.maxUsers}
                  onChange={(e) => setForm((prev) => ({ ...prev, maxUsers: e.target.value }))}
                  placeholder="Leave blank for unlimited"
                />
              </FormField>

              <FormField label="Job Analysis Limit (Optional)" id="create-plan-job-limit">
                <input
                  id="create-plan-job-limit"
                  type="number"
                  min="1"
                  className={inputClasses}
                  value={form.jobPostingLimit}
                  onChange={(e) => setForm((prev) => ({ ...prev, jobPostingLimit: e.target.value }))}
                  placeholder="Leave blank for unlimited"
                />
              </FormField>

              <FormField label="Description (Optional)" id="create-plan-desc">
                <textarea
                  id="create-plan-desc"
                  rows={2}
                  className={inputClasses}
                  value={form.description}
                  onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
                  placeholder="Brief summary of plan features..."
                />
              </FormField>

              <div className="rounded-xl bg-slate-50 p-3 text-[11px] text-slate-500">
                <span className="font-semibold text-slate-700">Notice:</span> Creating a plan adds it immediately to the active catalog for customers.
              </div>

              <div className="mt-6 flex justify-end gap-3 pt-2">
                <Button variant="secondary" onClick={() => setIsCreateModalOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" loading={submitting}>
                  Create Plan
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Plan Modal */}
      {editingPlan && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-100 pb-4">
              <div>
                <h3 className="font-display text-lg font-bold text-slate-900">Edit {editingPlan.name}</h3>
                <p className="text-xs text-slate-500">Modify live catalog parameters</p>
              </div>
              <button
                onClick={() => setEditingPlan(null)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              >
                <XIcon className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleEditSubmit} className="mt-4 space-y-4 text-xs">
              {editError && <Alert variant="error">{editError}</Alert>}

              {/* Price Impact Warning Banner */}
              <div className="rounded-xl border border-amber-200 bg-amber-50/80 p-3.5 text-amber-900 text-[11px] leading-relaxed">
                <span className="font-bold">Catalog Pricing Impact:</span> Updating price or seat limits changes the catalog for new checkouts only. Existing active subscriptions will retain their initial terms until changed.
              </div>

              <FormField label="Plan Name" id="edit-plan-name">
                <input
                  id="edit-plan-name"
                  className={inputClasses}
                  value={editForm.name}
                  onChange={(e) => setEditForm((prev) => ({ ...prev, name: e.target.value }))}
                  required
                />
              </FormField>

              <div className="grid grid-cols-2 gap-4">
                <FormField label="Monthly Price ($ USD)" id="edit-plan-price">
                  <input
                    id="edit-plan-price"
                    type="number"
                    min="1"
                    step="0.01"
                    className={inputClasses}
                    value={editForm.price}
                    onChange={(e) => setEditForm((prev) => ({ ...prev, price: e.target.value }))}
                    required
                  />
                </FormField>

                <FormField label={editingPlan.type === "ORGANIZATION" ? "Max Team Members / Total Seats" : "Total Seats"} id="edit-plan-max-users">
                  <input
                    id="edit-plan-max-users"
                    type="number"
                    min="1"
                    className={inputClasses}
                    value={editForm.maxUsers}
                    onChange={(e) => setEditForm((prev) => ({ ...prev, maxUsers: e.target.value }))}
                    placeholder="Unlimited"
                  />
                </FormField>
                <FormField label="Job Analysis Limit" id="edit-plan-job-limit">
                  <input
                    id="edit-plan-job-limit"
                    type="number"
                    min="1"
                    className={inputClasses}
                    value={editForm.jobPostingLimit}
                    onChange={(e) => setEditForm((prev) => ({ ...prev, jobPostingLimit: e.target.value }))}
                    placeholder="Unlimited"
                  />
                </FormField>
              </div>

              <FormField label="Description" id="edit-plan-desc">
                <textarea
                  id="edit-plan-desc"
                  rows={2}
                  className={inputClasses}
                  value={editForm.description}
                  onChange={(e) => setEditForm((prev) => ({ ...prev, description: e.target.value }))}
                />
              </FormField>

              <div className="mt-6 flex justify-end gap-3 pt-2">
                <Button variant="secondary" onClick={() => setEditingPlan(null)}>
                  Cancel
                </Button>
                <Button type="submit" loading={savingEdit}>
                  Save Changes
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Confirm Activate / Deactivate Dialog */}
      {pendingTogglePlan && (
        <ConfirmDialog
          open={Boolean(pendingTogglePlan)}
          title={`${pendingTogglePlan.isActive ? "Deactivate" : "Activate"} "${pendingTogglePlan.name}"?`}
          description={
            pendingTogglePlan.isActive
              ? `Deactivating this plan removes it from public self-service purchase options. Existing subscribers will continue using their current subscription uninterrupted.`
              : `Activating this plan makes it available immediately in the public catalog for new customer checkouts.`
          }
          confirmLabel={pendingTogglePlan.isActive ? "Deactivate Plan" : "Activate Plan"}
          onConfirm={handleConfirmToggleActive}
          onClose={() => setPendingTogglePlan(null)}
          loading={toggling}
        />
      )}
    </DashboardShell>
  );
};

export default AdminPlans;
