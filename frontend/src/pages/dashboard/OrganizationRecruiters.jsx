import { useEffect, useState } from "react";
import DashboardShell from "../../components/ui/DashboardShell";
import Button from "../../components/ui/Button";
import Alert from "../../components/ui/Alert";
import FormField, { inputClasses } from "../../components/ui/FormField";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import { BuildingIcon, MailIcon, TrashIcon } from "../../components/ui/icons";
import { ORG_ADMIN_NAV_ITEMS } from "../../components/organization/orgAdminNav";
import {
  listRecruiters,
  createRecruiter,
  setRecruiterStatus,
  resetCredentials,
  deleteRecruiter,
} from "../../services/organizationService";

// The recruiter-management section nav now comes from the SHARED
// ORG_ADMIN_NAV_ITEMS so all four sections stay in one place instead of four
// hand-maintained lists drifting apart.
const NAV_ITEMS = ORG_ADMIN_NAV_ITEMS;

const STATUS_STYLES = {
  ACTIVE: "bg-emerald-50 text-emerald-700 border-emerald-200",
  // INVITED is no longer produced by recruiter creation, but the status
  // still exists in the schema (see MembershipStatus) — kept here purely so
  // any legacy row still renders sensibly rather than falling back to the
  // unstyled default.
  INVITED: "bg-amber-50 text-amber-700 border-amber-200",
  REMOVED: "bg-slate-100 text-slate-500 border-slate-200",
};

// No `permissions` field: every organization recruiter receives the same
// global RECRUITER capabilities. Per-recruiter permission selection was
// removed because it was never enforced by any authorization check.
const emptyForm = { fullName: "", email: "" };

const OrganizationRecruiters = () => {
  const [recruiters, setRecruiters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const [form, setForm] = useState(emptyForm);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState(null);
  const [formSuccess, setFormSuccess] = useState(null);

  const [pendingRemoval, setPendingRemoval] = useState(null);
  const [pendingReset, setPendingReset] = useState(null);
  // PHASE 1 — permanent deletion state. Kept separate from `pendingRemoval`
  // (the reversible Remove action) so the two irreversible/reversible flows can
  // never be confused, and neither dialog can be left open under the other.
  const [pendingDeletion, setPendingDeletion] = useState(null);
  const [deletingUserId, setDeletingUserId] = useState(null);
  const [deletionFeedback, setDeletionFeedback] = useState(null);
  const [statusUpdating, setStatusUpdating] = useState(null);
  const [resettingUserId, setResettingUserId] = useState(null);
  const [credentialsFeedback, setCredentialsFeedback] = useState(null);

  // Reusable for the post-mutation refreshes triggered from event handlers
  // below (create success, status change) — those aren't effects, so calling
  // an async function that sets state synchronously up front is fine there.
  const loadRecruiters = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await listRecruiters();
      setRecruiters(res.data ?? []);
    } catch (err) {
      setLoadError(
        err.response?.data?.message ?? "Could not load recruiters."
      );
    } finally {
      setLoading(false);
    }
  };

  // Deliberately not calling loadRecruiters() here — invoking a function that
  // sets state synchronously before its first await, from inside an effect
  // body, triggers cascading renders. Chaining .then/.catch/.finally instead
  // defers every state update to the microtask queue.
  useEffect(() => {
    listRecruiters()
      .then((res) => setRecruiters(res.data ?? []))
      .catch((err) =>
        setLoadError(err.response?.data?.message ?? "Could not load recruiters.")
      )
      .finally(() => setLoading(false));
  }, []);

  const handleCreate = async (event) => {
    event.preventDefault();
    setFormError(null);
    setFormSuccess(null);

    if (!form.fullName.trim() || !form.email.trim()) {
      setFormError("Full name and email are required.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await createRecruiter(form);
      // The recruiter account is created either way — only report "sent"
      // when the email operation actually succeeded (data.emailSent), never
      // as a blanket success message. When the send failed the account DOES
      // exist, so the copy points at the existing "Reset & Resend Credentials"
      // action rather than inviting a duplicate invite.
      if (res.data?.emailSent) {
        setFormSuccess(
          res.message ??
            `Invited ${form.email}. They received temporary credentials and must set their own password at first sign-in.`
        );
      } else {
        setFormError(
          res.message ??
            "The recruiter account was created, but the credentials email could not be sent. Use “Reset & Resend Credentials” on their row below to send new credentials."
        );
      }
      setForm(emptyForm);
      loadRecruiters();
    } catch (err) {
      setFormError(
        err.response?.data?.message ?? "Could not invite the recruiter."
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleResetCredentials = async (recruiter) => {
    setResettingUserId(recruiter.userId);
    setCredentialsFeedback(null);
    try {
      const res = await resetCredentials(recruiter.userId);
      setCredentialsFeedback({
        userId: recruiter.userId,
        variant: res.data?.emailSent ? "success" : "error",
        message:
          res.message ??
          (res.data?.emailSent
            ? "New temporary credentials sent."
            : "Could not send the credentials email."),
      });
    } catch (err) {
      setCredentialsFeedback({
        userId: recruiter.userId,
        variant: "error",
        message:
          err.response?.data?.message ?? "Could not reset credentials.",
      });
    } finally {
      setResettingUserId(null);
    }
  };

  const handleStatusChange = async (membershipId, nextStatus) => {
    setStatusUpdating(membershipId);
    try {
      await setRecruiterStatus(membershipId, nextStatus);
      loadRecruiters();
    } catch (err) {
      setLoadError(
        err.response?.data?.message ?? "Could not update recruiter status."
      );
    } finally {
      setStatusUpdating(null);
      setPendingRemoval(null);
    }
  };

  // PHASE 1 — PERMANENT delete.
//
// This is NOT `handleStatusChange(..., "REMOVED")`: that only flips the
// membership status and is reversible via Reactivate. This destroys the account
// server-side and cannot be undone, so it is a separate handler, a separately
// confirmed dialog, and a separately labelled button.
const handlePermanentDelete = async (recruiter) => {
  setDeletingUserId(recruiter.userId);
  setDeletionFeedback(null);
  try {
    const res = await deleteRecruiter(recruiter.userId);
    // Refresh from the server so the list AND the seat count reflect reality —
    // never decrement a local counter optimistically.
    await loadRecruiters();
    const seats = res.data?.recruiterSeats;
    setDeletionFeedback({
      userId: recruiter.userId,
      variant: "success",
      message:
        res.message ??
        `${recruiter.fullName} was permanently deleted.` +
          (seats ? ` Active recruiters now: ${seats.active}.` : ""),
    });
  } catch (err) {
    setDeletionFeedback({
      userId: recruiter.userId,
      variant: "error",
      message:
        err.response?.data?.message ??
        "Could not permanently delete this recruiter.",
    });
  } finally {
    setDeletingUserId(null);
    setPendingDeletion(null);
  }
};

return (
    <DashboardShell
      roleLabel="Organization"
      title="Recruiters"
      description="Invite recruiters to your organization and manage their access."
      navItems={NAV_ITEMS}
    >
      <div className="grid gap-8 lg:grid-cols-[360px_1fr]">
        <form
          onSubmit={handleCreate}
          className="h-fit space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
        >
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-cyan-400 text-white">
              <MailIcon className="h-4 w-4" />
            </div>
            <h2 className="font-display text-base font-semibold text-slate-900">
              Invite a recruiter
            </h2>
          </div>

          {formError && <Alert variant="error">{formError}</Alert>}
          {formSuccess && <Alert variant="success">{formSuccess}</Alert>}

          <FormField label="Full name" id="fullName">
            <input
              id="fullName"
              className={inputClasses}
              value={form.fullName}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, fullName: e.target.value }))
              }
              placeholder="Jane Doe"
            />
          </FormField>

          <FormField label="Email" id="email">
            <input
              id="email"
              type="email"
              className={inputClasses}
              value={form.email}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, email: e.target.value }))
              }
              placeholder="jane@company.com"
            />
          </FormField>

          <p className="text-xs text-slate-500">
            A temporary password is generated automatically and emailed to
            the recruiter — you never set or see it here. They sign in with it
            once and are required to set their own password before they can
            use any recruiter feature.
          </p>

          <Button type="submit" className="w-full" disabled={submitting}>
            {submitting ? "Inviting recruiter..." : "Invite recruiter"}
          </Button>
        </form>

        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center gap-2 border-b border-slate-200 p-6">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-cyan-400 text-white">
              <BuildingIcon className="h-4 w-4" />
            </div>
            <h2 className="font-display text-base font-semibold text-slate-900">
              Team members
            </h2>
          </div>

          {loadError && (
            <div className="p-6">
              <Alert variant="error">{loadError}</Alert>
            </div>
          )}

          {loading ? (
            <p className="p-6 text-sm text-slate-500">Loading recruiters…</p>
          ) : recruiters.length === 0 ? (
            <p className="p-6 text-sm text-slate-500">
              No recruiters yet. Add your first recruiter using the form.
            </p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {recruiters.map((recruiter) => (
                <li
                  key={recruiter.membershipId}
                  className="flex flex-col gap-3 p-6 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <p className="text-sm font-semibold text-slate-900">
                      {recruiter.fullName}
                    </p>
                    <p className="text-sm text-slate-500">{recruiter.email}</p>
                    {credentialsFeedback?.userId === recruiter.userId && (
                      <p
                        className={`mt-1 text-xs ${
                          credentialsFeedback.variant === "success"
                            ? "text-emerald-600"
                            : "text-red-600"
                        }`}
                      >
                        {credentialsFeedback.message}
                      </p>
                    )}
                  </div>

                  <div className="flex items-center gap-3">
                    <span
                      className={`rounded-full border px-3 py-1 text-xs font-semibold ${
                        STATUS_STYLES[recruiter.status] ??
                        "border-slate-200 text-slate-500"
                      }`}
                    >
                      {recruiter.status}
                    </span>

                    {recruiter.status === "ACTIVE" && (
                      <>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={resettingUserId === recruiter.userId}
                          onClick={() => setPendingReset(recruiter)}
                        >
                          {resettingUserId === recruiter.userId
                            ? "Resetting..."
                            : "Reset & Resend Credentials"}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={statusUpdating === recruiter.membershipId}
                          onClick={() => setPendingRemoval(recruiter)}
                        >
                          Remove
                        </Button>
                        {/* PHASE 1 — permanent delete.
                            Deliberately labelled "Delete Recruiter" and NOT
                            "Remove": the server really destroys the account, so
                            "Remove" would understate it while sitting right next
                            to a different, reversible "Remove" action.

                            Uses the existing `secondary` Button variant plus
                            explicit destructive colours, rather than adding a
                            new `danger` variant to the shared Button component —
                            this feature must not alter a component every other
                            page depends on. */}
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          className="bg-red-600 text-white hover:bg-red-700 hover:shadow-red-500/25 focus-visible:outline-red-600"
                          disabled={deletingUserId === recruiter.userId}
                          onClick={() => {
                            setDeletionFeedback(null);
                            setPendingDeletion(recruiter);
                          }}
                        >
                          {deletingUserId === recruiter.userId
                            ? "Deleting..."
                            : "Delete Recruiter"}
                        </Button>
                      </>
                    )}

                    {recruiter.status === "REMOVED" && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={statusUpdating === recruiter.membershipId}
                        onClick={() =>
                          handleStatusChange(recruiter.membershipId, "ACTIVE")
                        }
                      >
                        Reactivate
                      </Button>
                    )}
                  </div>

                  {/* PHASE 1 — deletion outcome for this row. Placed AFTER the
                      action row and OUTSIDE the ACTIVE-only block, so a success
                      message remains visible even though a successful delete has
                      already removed this row from the list. */}
                  {deletionFeedback?.userId === recruiter.userId && (
                    <p
                      className={`mt-1 text-xs ${
                        deletionFeedback.variant === "success"
                          ? "text-emerald-600"
                          : "text-red-600"
                      }`}
                    >
                      {deletionFeedback.message}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={Boolean(pendingReset)}
        title="Reset recruiter credentials"
        description={
          pendingReset
            ? `This will invalidate ${pendingReset.fullName}'s current password and sign out existing sessions. A new temporary password will be sent to ${pendingReset.email}.`
            : ""
        }
        confirmLabel={
          resettingUserId === pendingReset?.userId
            ? "Resetting..."
            : "Reset & Send"
        }
        onClose={() => {
          if (!resettingUserId) setPendingReset(null);
        }}
        onConfirm={async () => {
          if (!pendingReset) return;
          await handleResetCredentials(pendingReset);
          setPendingReset(null);
        }}
      />

      <ConfirmDialog
        open={Boolean(pendingRemoval)}
        title="Remove recruiter"
        description={
          pendingRemoval
            ? `${pendingRemoval.fullName} will lose access to the organization dashboard immediately.`
            : ""
        }
        confirmLabel="Remove"
        onClose={() => setPendingRemoval(null)}
        onConfirm={() =>
          pendingRemoval &&
          handleStatusChange(pendingRemoval.membershipId, "REMOVED")
        }
      />

      {/* PHASE 1 — permanent delete confirmation.

          Separate dialog from the reversible "Remove" above, so the two very
          different consequences can never be triggered by the same click.

          The wording is explicit about BOTH halves of the behaviour, because
          only stating the first would be misleading: the account is destroyed
          permanently, AND their historical jobs/candidates/assessments are
          deliberately retained (shown as "Deleted Recruiter" in Job Analysis).
          An admin must not be led to believe deleting the recruiter erases the
          organization's audit history. */}
      <ConfirmDialog
        open={Boolean(pendingDeletion)}
        title="Permanently delete recruiter"
        description={
          pendingDeletion
            ? `This permanently deletes the recruiter account and cannot be undone. ${pendingDeletion.fullName} (${pendingDeletion.email}) will immediately lose access and can never sign in again. Their historical jobs and candidate records are retained and will be shown as "Deleted Recruiter".`
            : ""
        }
        confirmLabel={
          deletingUserId === pendingDeletion?.userId
            ? "Deleting..."
            : "Delete Permanently"
        }
        cancelLabel="Cancel"
        onClose={() => {
          // Blocked while the request is in flight so the dialog cannot be
          // dismissed and re-opened mid-delete, which would invite a double
          // submit against the irreversible endpoint.
          if (!deletingUserId) setPendingDeletion(null);
        }}
        onConfirm={() => {
          if (!pendingDeletion || deletingUserId) return;
          return handlePermanentDelete(pendingDeletion);
        }}
      />
    </DashboardShell>
  );
};

export default OrganizationRecruiters;
