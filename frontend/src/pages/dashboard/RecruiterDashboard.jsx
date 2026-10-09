import { useEffect, useState } from "react";
import DashboardShell from "../../components/ui/DashboardShell";
import Alert from "../../components/ui/Alert";
import Button from "../../components/ui/Button";
import Spinner from "../../components/ui/Spinner";
import { ChartIcon, PlusIcon } from "../../components/ui/icons";
import { RECRUITER_NAV_ITEMS } from "../../constants/recruiterNav";
import { useJobContext } from "../../hooks/useJobContext";
import { fetchEmployeeFileUrl, getRecruiterProfile } from "../../services/authService";
import { getOrganizationBranding } from "../../services/organizationService";
import { getOrganizationLimits, getRecruiterLimits } from "../../services/jobService";
import { extractApiErrorMessage } from "../../utils/apiError.js";

const cardClasses = "rounded-2xl border border-slate-200 bg-white p-6 shadow-sm";
const labelClasses = "text-xs font-semibold uppercase tracking-wide text-slate-500";
const PLACEHOLDER = "—";

// Quota is consumed on Start (never on draft save). limit === null means
// unlimited — the recruiter-facing word for that is exactly "Unlimited".
// (Same rule as the QuotaBanner on /recruiter/jobs.)
const formatQuota = (limits) => {
  if (limits.limit === null) return "Unlimited";
  return `${limits.used} / ${limits.limit}`;
};

const QuotaStatCard = ({ limits, limitError }) => {
  if (limitError) {
    return (
      <div className={cardClasses}>
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-cyan-400 text-white">
          <ChartIcon className="h-5 w-5" />
        </div>
        <p className="mt-4 text-2xl font-bold text-slate-900">{PLACEHOLDER}</p>
        <p className="mt-1 text-sm text-slate-600">Total Jobs Left</p>
        <p className="mt-1 text-xs text-rose-600">{limitError}</p>
      </div>
    );
  }

  return (
    <div className={cardClasses}>
      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-cyan-400 text-white">
        <ChartIcon className="h-5 w-5" />
      </div>
      <p className="mt-4 text-2xl font-bold text-slate-900">
        {limits === null ? (
          <Spinner className="h-6 w-6" />
        ) : (
          <>{formatQuota(limits)}</>
        )}
      </p>
      <p className="mt-1 text-sm text-slate-600">Total Jobs Left</p>
    </div>
  );
};

// Values come from the existing recruiter profile API
// (GET /auth/recruiter/profile) -- the same endpoint and row the setup flow
// and /recruiter/profile already use. `specialties` is the stored
// "Hiring Fields / Domains" value and `bio` is the stored Recruiter
// Description. "Roles They Hire For" has no persisted field yet, so it always
// renders the placeholder. Summary only -- the full recruiter profile, and all
// editing, stays at /recruiter/profile.
const PROFILE_FIELDS = [
  { key: "yearsExperience", label: "Years of Experience" },
  { key: "specialties", label: "Hiring Fields / Domains" },
  { key: "rolesHiredFor", label: "Roles They Hire For" },
];

const displayValue = (value) =>
  value === null || value === undefined || value === ""
    ? PLACEHOLDER
    : String(value);

const RecruiterDashboard = () => {
  const jobContext = useJobContext();
  const [organizationBranding, setOrganizationBranding] = useState(null);
  const [recruiterProfile, setRecruiterProfile] = useState(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const [profileError, setProfileError] = useState(false);

  // Quota for the "Total Jobs Left" stat card. Reuses the SAME context
  // resolution (useJobContext) and the SAME limit endpoint + formatting
  // convention as /recruiter/jobs, so the two pages always agree.
  //   independent      -> getRecruiterLimits()
  //   organization     -> getOrganizationLimits(orgId)   // orgId from the session
  //   unresolved/error -> skip the fetch
  const [limits, setLimits] = useState(null);
  const [limitsLoading, setLimitsLoading] = useState(false);
  const [limitsError, setLimitsError] = useState(null);

  useEffect(() => {
    let mounted = true;
    let logoUrl = "";
    getOrganizationBranding()
      .then(async (response) => {
        const branding = response.data;
        if (branding?.organizationLogo) {
          logoUrl = await fetchEmployeeFileUrl(
            branding.organizationLogo.match(/\/files\/([^/]+)\/view$/)?.[1],
            "view"
          );
        }
        if (mounted) setOrganizationBranding({ ...branding, organizationLogo: logoUrl });
        else if (logoUrl) URL.revokeObjectURL(logoUrl);
      })
      .catch(() => {});

    return () => {
      mounted = false;
      if (logoUrl) URL.revokeObjectURL(logoUrl);
    };
  }, []);

  useEffect(() => {
    let mounted = true;

    getRecruiterProfile()
      .then((response) => {
        if (mounted) setRecruiterProfile(response.data?.profile ?? null);
      })
      .catch(() => {
        if (mounted) setProfileError(true);
      })
      .finally(() => {
        if (mounted) setProfileLoading(false);
      });

        return () => {
      mounted = false;
    };
  }, []);

  // Quota fetch — mirrors /recruiter/jobs exactly:
  // independent -> getRecruiterLimits ; organization -> getOrganizationLimits(orgId)
  // where orgId comes ONLY from the authenticated session (jobContext).
  // If the context can't be resolved we leave limits null and show a placeholder —
  // the rest of the dashboard still renders.
    useEffect(() => {
    // Quota fetch — mirrors /recruiter/jobs exactly:
    // independent -> getRecruiterLimits ; organization -> getOrganizationLimits(orgId)
    // where orgId comes ONLY from the authenticated session (jobContext).
    // If the context can't be resolved we leave limits null and show a
    // placeholder — the rest of the dashboard still renders.
    //
    // The two branches below are each entered at most once (jobContext is
    // stable per session), and the setState calls inside the promise
    // callbacks (after await) are the async updates React wants to see.
    if (jobContext.kind !== "independent" && jobContext.kind !== "organization") {
      return undefined;
    }

    const fetchLimits =
      jobContext.kind === "independent" ? getRecruiterLimits : () => getOrganizationLimits(jobContext.organizationId);

    let cancelled = false;

    (async () => {
      setLimitsLoading(true);
      try {
        const response = await fetchLimits();
        if (!cancelled) setLimits(response.data);
      } catch (error) {
        if (!cancelled) {
          setLimitsError(extractApiErrorMessage(error, "Could not load job limits."));
        }
      } finally {
        if (!cancelled) setLimitsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [jobContext]);

  return (
    <DashboardShell
      roleLabel="Recruiter"
      description="Your recruiting overview, professional profile summary, and job postings."
      navItems={RECRUITER_NAV_ITEMS}
      organizationBranding={organizationBranding}
    >
      <div className="space-y-6">
        <section>
                    <h2 className="font-display text-lg font-bold text-slate-900">Statistics</h2>
          <div className="mt-4 grid gap-5 sm:grid-cols-1">
            <QuotaStatCard
              limits={limits}
              limitError={limitsError || (limitsLoading ? null : undefined)}
            />
          </div>
        </section>

        <section className={cardClasses}>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <h2 className="font-display text-lg font-bold text-slate-900">Recruiter Profile</h2>
            <Button as="link" to="/recruiter/profile" variant="ghost" size="sm">
              View Recruiter Profile
            </Button>
          </div>

          {profileLoading ? (
            <p className="mt-4 text-sm text-slate-500">
              Loading your recruiter profile...
            </p>
          ) : (
            <>
              {profileError && (
                <Alert variant="error" className="mt-4">
                  We couldn&apos;t load your recruiter profile details.
                </Alert>
              )}

              <dl className="mt-4 grid gap-5 sm:grid-cols-2">
                {PROFILE_FIELDS.map(({ key, label }) => (
                  <div key={key} className="rounded-xl bg-slate-50 px-4 py-3">
                    <dt className={labelClasses}>{label}</dt>
                    <dd className="mt-1 text-sm font-medium text-slate-900">
                      {displayValue(recruiterProfile?.[key])}
                    </dd>
                  </div>
                ))}
              </dl>

              <div className="mt-5 rounded-xl bg-slate-50 px-4 py-3">
                <p className={labelClasses}>Recruiter Description</p>
                <p className="mt-1 text-sm leading-relaxed text-slate-600">
                  {displayValue(recruiterProfile?.bio)}
                </p>
              </div>
            </>
          )}
        </section>

        <section className={cardClasses}>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <h2 className="font-display text-lg font-bold text-slate-900">Jobs</h2>
            <Button as="link" to="/recruiter/jobs/create" size="sm">
              <PlusIcon className="h-4 w-4" />
              Create Job
            </Button>
          </div>

          <div className="mt-6 rounded-xl border border-dashed border-slate-300 p-8 text-center">
            <p className="text-sm font-medium text-slate-700">No jobs yet</p>
            <p className="mt-1 text-sm text-slate-500">
              Your job postings, analysis and candidate progress will appear here.
            </p>
          </div>
        </section>
      </div>
    </DashboardShell>
  );
};

export default RecruiterDashboard;
