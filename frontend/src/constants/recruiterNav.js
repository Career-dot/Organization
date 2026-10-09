/**
 * Single canonical navigation definition for all Recruiter dashboard pages.
 *
 * Every page that renders DashboardShell for the Recruiter role must import
 * and use this constant -- never define a local NAV_ITEMS array.
 *
 * Canonical order:
 *   Dashboard -> Recruiter Profile -> Jobs
 *
 * Account Settings is intentionally NOT part of this navigation. It is not a
 * recruiter dashboard page -- it is shared by the Candidate, Recruiter and
 * Organization Admin accounts and stays reachable through the existing
 * DashboardLayout account menu at /account/settings, unchanged.
 *
 * Every `to` below must stay an exact match for a real route path:
 * DashboardShell resolves the active item with a strict equality check
 * against location.pathname.
 *
 * /recruiter/profile-setup is NOT here either -- that is the onboarding
 * profile step, an entirely different thing from /recruiter/profile.
 */
import { SparkIcon, UsersIcon, BuildingIcon } from "../components/ui/icons";

export const RECRUITER_NAV_ITEMS = [
  { label: "Dashboard",         icon: SparkIcon,    to: "/recruiter/dashboard" },
  { label: "Recruiter Profile", icon: UsersIcon,    to: "/recruiter/profile"   },
  { label: "Jobs",              icon: BuildingIcon, to: "/recruiter/jobs"      },
];
