import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "./context/AuthContext";
import { ROLES } from "./constants/roles";

import PublicLayout from "./components/layout/PublicLayout";
import AuthLayout from "./components/layout/AuthLayout";
import DashboardLayout from "./components/layout/DashboardLayout";
import ProtectedRoutes from "./components/ProtectedRoutes";

import Home from "./pages/public/Home";
import About from "./pages/public/About";
import HowItWorks from "./pages/public/HowItWorks";
import ForEmployees from "./pages/public/ForEmployees";
import ForRecruiters from "./pages/public/ForRecruiters";
import ForOrganizations from "./pages/public/ForOrganizations";
import JobAssessment from "./pages/public/JobAssessment";

import Login from "./pages/auth/Login";
import Register from "./pages/auth/Register";
import VerifyEmail from "./pages/auth/VerifyEmail";
import CheckEmail from "./pages/auth/CheckEmail";
import ForgotPassword from "./pages/auth/ForgotPassword";
import ResetPassword from "./pages/auth/ResetPassword";
import ChangePassword from "./pages/auth/ChangePassword";

import EmployeeDashboard from "./pages/dashboard/EmployeeDashboard";
import EmployeeSkills from "./pages/dashboard/EmployeeSkills";
import EmployeeProjects from "./pages/dashboard/EmployeeProjects";
import EmployeeProfile from "./pages/dashboard/EmployeeProfile";
import EmployeeCareerLinks from "./pages/dashboard/EmployeeCareerLinks";
import EmployeeProfileSetup from "./pages/dashboard/EmployeeProfileSetup";
import AssessmentIntro from "./pages/dashboard/verification/AssessmentIntro";
import AssessmentProcessing from "./pages/dashboard/verification/AssessmentProcessing";
import VerificationReport from "./pages/dashboard/verification/VerificationReport";
import AssessmentTake from "./pages/dashboard/verification/AssessmentTake";
import TestEnded from "./pages/dashboard/verification/TestEnded";
import RecruiterDashboard from "./pages/dashboard/RecruiterDashboard";
import OrganizationDashboard from "./pages/dashboard/OrganizationDashboard";
import OrganizationRecruiters from "./pages/dashboard/OrganizationRecruiters";
import OrganizationJobAnalysis from "./pages/dashboard/OrganizationJobAnalysis";
import OrganizationRecruiterAnalysis from "./pages/dashboard/OrganizationRecruiterAnalysis";
import OrganizationProfileSetup from "./pages/dashboard/OrganizationProfileSetup";
import AccountSettings from "./pages/dashboard/AccountSettings";
import RecruiterSubscription from "./pages/dashboard/RecruiterSubscription";
import RecruiterProfileSetup from "./pages/dashboard/RecruiterProfileSetup";
import RecruiterProfile from "./pages/dashboard/RecruiterProfile";
import RecruiterJobs from "./pages/dashboard/RecruiterJobs";
import RecruiterJobCreate from "./pages/dashboard/RecruiterJobCreate";
import RecruiterJobDetail from "./pages/dashboard/RecruiterJobDetail";
import OrganizationSubscription from "./pages/dashboard/OrganizationSubscription";
import AdminDashboard from "./pages/dashboard/AdminDashboard";
import AdminOrganizations from "./pages/dashboard/AdminOrganizations";
import AdminSubscriptions from "./pages/dashboard/AdminSubscriptions";
import AdminRecruiters from "./pages/dashboard/AdminRecruiters";
import AdminPlans from "./pages/dashboard/AdminPlans";
import AdminAuditLogs from "./pages/dashboard/AdminAuditLogs";

import NotFound from "./pages/NotFound";

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route element={<PublicLayout />}>
            <Route path="/" element={<Home />} />
            <Route path="/about" element={<About />} />
            <Route path="/how-it-works" element={<HowItWorks />} />
            <Route path="/for-employees" element={<ForEmployees />} />
            <Route path="/for-recruiters" element={<ForRecruiters />} />
            <Route path="/for-organizations" element={<ForOrganizations />} />
          </Route>

          <Route element={<AuthLayout />}>
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            <Route path="/check-email" element={<CheckEmail />} />
            <Route path="/verify-email" element={<VerifyEmail />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/reset-password" element={<ResetPassword />} />
          </Route>

          <Route element={<DashboardLayout />}>
            {/* No allowedRoles — reachable by any authenticated role while
                onboarding.nextStep === "PASSWORD_CHANGE_REQUIRED" (a
                server-issued temporary password not yet changed). */}
            <Route element={<ProtectedRoutes />}>
              <Route path="/change-password" element={<ChangePassword />} />
            </Route>

            <Route element={<ProtectedRoutes allowedRoles={[ROLES.EMPLOYEE, ROLES.RECRUITER, ROLES.ORG_ADMIN]} />}>
              <Route path="/account/settings" element={<AccountSettings />} />
            </Route>

            <Route element={<ProtectedRoutes allowedRoles={[ROLES.EMPLOYEE]} />}>
              <Route path="/employee/profile/setup" element={<EmployeeProfileSetup />} />
              <Route path="/employee/profile-setup" element={<EmployeeProfileSetup />} />
              <Route path="/employee/dashboard" element={<EmployeeDashboard />} />
              <Route path="/employee/profile" element={<EmployeeProfile />} />
              <Route path="/employee/skills" element={<EmployeeSkills />} />
              <Route path="/employee/projects" element={<EmployeeProjects />} />
              <Route path="/employee/career-links" element={<EmployeeCareerLinks />} />
              <Route path="/employee/skills/:skillId/verify/intro" element={<AssessmentIntro />} />
              <Route path="/employee/skills/:skillId/verify/processing/:attemptId" element={<AssessmentProcessing />} />
              <Route path="/employee/skills/:skillId/verify/report/:reportId" element={<VerificationReport />} />
            </Route>

            <Route
              element={
                <ProtectedRoutes
                  allowedRoles={[ROLES.RECRUITER]}
                  requiresUsableAccount
                  requiresRecruiterProfileComplete
                />
              }
            >
              <Route path="/recruiter/dashboard" element={<RecruiterDashboard />} />
              <Route path="/recruiter/profile" element={<RecruiterProfile />} />
              <Route path="/recruiter/jobs" element={<RecruiterJobs />} />
              <Route path="/recruiter/jobs/create" element={<RecruiterJobCreate />} />
              <Route path="/recruiter/jobs/:jobId" element={<RecruiterJobDetail />} />
            </Route>
            <Route element={<ProtectedRoutes allowedRoles={[ROLES.EMPLOYEE, ROLES.RECRUITER]} requiresUsableAccount />}>
              <Route
                path="/recruiter/subscription"
                element={<RecruiterSubscription />}
              />
              <Route
                path="/recruiter/profile-setup"
                element={<RecruiterProfileSetup />}
              />
            </Route>

            <Route element={<ProtectedRoutes allowedRoles={[ROLES.ORG_ADMIN]} />}>
              <Route
                path="/organization/profile/setup"
                element={<OrganizationProfileSetup />}
              />
            </Route>

            <Route
              element={
                <ProtectedRoutes
                  allowedRoles={[ROLES.ORG_ADMIN]}
                  requiresUsableAccount
                  requiresOrgAdminProfileComplete
                />
              }
            >
              <Route
                path="/organization/dashboard"
                element={<OrganizationDashboard />}
              />
              <Route
                path="/organization/dashboard/recruiters"
                element={<OrganizationRecruiters />}
              />
              {/* Job Analysis + Recruiter Analysis are separate read-only
                  sections. All three sit under the SAME existing guard as the
                  dashboard (ORG_ADMIN + usable account + organization profile
                  complete); no new guard or authorization path was introduced. */}
              <Route
                path="/organization/dashboard/jobs"
                element={<OrganizationJobAnalysis />}
              />
              <Route
                path="/organization/dashboard/recruiter-analysis"
                element={<OrganizationRecruiterAnalysis />}
              />
            </Route>
            <Route element={<ProtectedRoutes allowedRoles={[ROLES.EMPLOYEE, ROLES.ORG_ADMIN]} />}>
              <Route
                path="/organization/subscription"
                element={<OrganizationSubscription />}
              />
            </Route>

            {/* Platform administration — never reuses the organization
                dashboard/routes above. SUPER_ADMIN manages the platform
                (organizations, subscriptions, plans, independent
                recruiters, audit logs), never an individual organization's
                own recruiters (that stays exclusively ORG_ADMIN's). */}
            <Route element={<ProtectedRoutes allowedRoles={[ROLES.SUPER_ADMIN]} />}>
              <Route path="/admin/dashboard" element={<AdminDashboard />} />
              <Route path="/admin/organizations" element={<AdminOrganizations />} />
              <Route path="/admin/subscriptions" element={<AdminSubscriptions />} />
              <Route path="/admin/recruiters" element={<AdminRecruiters />} />
              <Route path="/admin/plans" element={<AdminPlans />} />
              <Route path="/admin/audit-logs" element={<AdminAuditLogs />} />
            </Route>
          </Route>

          {/* Standalone Assessment Page Outside DashboardLayout */}
          <Route element={<ProtectedRoutes allowedRoles={[ROLES.EMPLOYEE]} />}>
            <Route path="/employee/skills/:skillId/verify/test/:attemptId" element={<AssessmentTake />} />
            <Route path="/employee/skills/:skillId/verify/ended/:attemptId" element={<TestEnded />} />
          </Route>

          {/* Candidate JOB assessment — the public link issued at finalize
              (/assessment/:publicId). Public capability route: no layout and no
              auth, because the candidate has no account in this stage; the
              opaque publicId segment IS the access grant. Deliberately separate
              from the EMPLOYEE skill-verification AssessmentTake flow above
              (different workflow, different backend). */}
          <Route path="/assessment/:publicId" element={<JobAssessment />} />

          <Route path="*" element={<NotFound />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
