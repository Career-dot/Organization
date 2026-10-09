import DashboardShell from "../../components/ui/DashboardShell";
import SettingsPanel from "../../components/ui/SettingsPanel";
import { UsersIcon, CheckIcon, LockIcon } from "../../components/ui/icons";

const NAV_ITEMS = [
  { label: "Candidates", icon: UsersIcon },
  { label: "Shortlists", icon: CheckIcon },
  { label: "Settings", icon: LockIcon, to: "/recruiter/dashboard/settings" },
];

const RecruiterSettings = () => (
  <DashboardShell
    roleLabel="Recruiter"
    title="Settings"
    description="Manage your password, session, and account."
    navItems={NAV_ITEMS}
  >
    <SettingsPanel />
  </DashboardShell>
);

export default RecruiterSettings;
