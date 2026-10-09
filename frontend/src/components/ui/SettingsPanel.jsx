import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../hooks/useAuth";
import Button from "./Button";
import ConfirmDialog from "./ConfirmDialog";
import { LockIcon, LogoutIcon, TrashIcon } from "./icons";

const SettingsPanel = () => {
  const navigate = useNavigate();
  const { logout } = useAuth();
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const handleLogout = async () => {
    await logout();
    navigate("/", { replace: true });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-4">
          <div className="flex h-10 w-10 flex-none items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-cyan-400 text-white">
            <LockIcon className="h-5 w-5" />
          </div>
          <div>
            <p className="text-sm font-semibold text-slate-900">
              Change password
            </p>
            <p className="mt-1 text-sm text-slate-600">
              We&apos;ll email you a link to set a new password.
            </p>
          </div>
        </div>
        <Button
          as="link"
          to="/forgot-password"
          variant="outline"
          size="sm"
          className="sm:flex-none"
        >
          Change password
        </Button>
      </div>

      <div className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-4">
          <div className="flex h-10 w-10 flex-none items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-cyan-400 text-white">
            <LogoutIcon className="h-5 w-5" />
          </div>
          <div>
            <p className="text-sm font-semibold text-slate-900">Logout</p>
            <p className="mt-1 text-sm text-slate-600">
              Sign out of your account on this device.
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="sm:flex-none"
          onClick={handleLogout}
        >
          Logout
        </Button>
      </div>

      <div className="flex flex-col gap-4 rounded-2xl border border-red-200 bg-red-50/40 p-6 shadow-sm sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-4">
          <div className="flex h-10 w-10 flex-none items-center justify-center rounded-xl bg-red-100 text-red-600">
            <TrashIcon className="h-5 w-5" />
          </div>
          <div>
            <p className="text-sm font-semibold text-slate-900">
              Delete account
            </p>
            <p className="mt-1 text-sm text-slate-600">
              Permanently delete your account and all associated data.
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="border-red-300 text-red-600 hover:border-red-400 hover:bg-red-50 sm:flex-none"
          onClick={() => setShowDeleteDialog(true)}
        >
          Delete account
        </Button>
      </div>

      <ConfirmDialog
        open={showDeleteDialog}
        title="Coming soon"
        description="Account deletion isn't available yet. This feature is still being built — your account is safe for now."
        cancelLabel="Close"
        onClose={() => setShowDeleteDialog(false)}
      />
    </div>
  );
};

export default SettingsPanel;
