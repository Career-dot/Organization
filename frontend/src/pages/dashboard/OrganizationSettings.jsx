import DashboardShell from "../../components/ui/DashboardShell";
import SettingsPanel from "../../components/ui/SettingsPanel";
import { UsersIcon, ChartIcon, LockIcon } from "../../components/ui/icons";

const NAV_ITEMS = [
  { label: "Talent Pool", icon: UsersIcon },
  { label: "Team Coverage", icon: ChartIcon },
  { label: "Settings", icon: LockIcon, to: "/organization/dashboard/settings" },
];

const OrganizationSettings = () => (
  <DashboardShell
    roleLabel="Organization"
    title="Settings"
    description="Manage your password, session, and account."
    navItems={NAV_ITEMS}
  >
    <SettingsPanel />
  </DashboardShell>
);

export default OrganizationSettings;
