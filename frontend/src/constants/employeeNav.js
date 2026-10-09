/**
 * Single canonical navigation definition for all Candidate (employee) pages.
 *
 * Every page that renders DashboardShell for the Candidate role must import
 * and use this constant -- never define a local NAV_ITEMS array.
 *
 * Canonical order:
 *   Dashboard -> Profile & Career -> Skills -> Projects -> Career Links
 */
import { SparkIcon, ChartIcon, BuildingIcon } from "../components/ui/icons";

export const EMPLOYEE_NAV_ITEMS = [
  { label: "Dashboard",        icon: SparkIcon,    to: "/employee/dashboard"    },
  { label: "Profile & Career", icon: SparkIcon,    to: "/employee/profile"      },
  { label: "Skills",           icon: ChartIcon,    to: "/employee/skills"       },
  { label: "Projects",         icon: BuildingIcon, to: "/employee/projects"     },
  { label: "Career Links",     icon: BuildingIcon, to: "/employee/career-links" },
];
