import DashboardShell from "../../components/ui/DashboardShell";
import SettingsPanel from "../../components/ui/SettingsPanel";
import { SparkIcon, CheckIcon, LockIcon } from "../../components/ui/icons";

const NAV_ITEMS = [
  { label: "My Passport", icon: SparkIcon },
  { label: "Assessments", icon: CheckIcon },
  { label: "Settings", icon: LockIcon, to: "/employee/dashboard/settings" },
];

const EmployeeSettings = () => (
  <DashboardShell
    roleLabel="Employee"
    title="Settings"
    description="Manage your password, session, and account."
    navItems={NAV_ITEMS}
  >
    <SettingsPanel />
  </DashboardShell>
);

export default EmployeeSettings;
