import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../hooks/useAuth";
import { becomeCandidate } from "../../services/authService";
import { resolveOnboardingPath } from "../../utils/onboarding";
import Button from "./Button";
import ConfirmDialog from "./ConfirmDialog";

export const CandidateActivationDialog = ({ open, onClose }) => {
  const navigate = useNavigate();
  const { switchRole } = useAuth();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const handleConfirm = async () => {
    setSubmitting(true);
    setError(null);

    try {
      await becomeCandidate();
      const nextUser = await switchRole("EMPLOYEE");
      onClose();
      navigate(resolveOnboardingPath(nextUser), { replace: true });
      return nextUser;
    } catch (requestError) {
      setError(
        requestError.response?.data?.message ??
          "Could not create the Candidate account."
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ConfirmDialog
      open={open}
      title="Become a Candidate?"
      description={error ?? "Create and access a Candidate profile on this same account. Your current professional account will remain unchanged."}
      confirmLabel={submitting ? "Creating..." : "Confirm"}
      onClose={() => {
        if (!submitting) {
          setError(null);
          onClose();
        }
      }}
      onConfirm={handleConfirm}
    />
  );
};

const BecomeCandidateAction = () => {
  const [open, setOpen] = useState(false);
  const { user } = useAuth();

  const candidateActivated = user?.roles?.includes("EMPLOYEE");
  console.debug("[auth-trace] BecomeCandidateAction render", {
    userId: user?.id,
    email: user?.email,
    role: user?.role,
    activeRole: user?.activeRole,
    roles: user?.roles,
    candidateActivated,
  });

  if (!user || candidateActivated || user?.role === "ORG_ADMIN") {
    return null;
  }

  return (
    <>
      <div className="mt-8 flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-slate-900">
            Want to become a Candidate?
          </p>
          <p className="mt-1 text-sm text-slate-600">
            Create a Candidate profile using this same account and password.
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
          Become a Candidate
        </Button>
      </div>

      <CandidateActivationDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
};

export default BecomeCandidateAction;