import { formatMonthLabel } from "./orgAdminNav";

// ---------------------------------------------------------------------------
// Org Admin dashboard charts.
//
// Hand-rolled SVG, matching the existing AdminCharts.jsx approach — the project
// has no charting library and none was added here.
//
// BOTH CHARTS ARE DATA-HONEST:
//   * ActivityChart renders the persisted monthly series the backend already
//     aggregated (date_trunc in PostgreSQL).
//   * HiringChart renders ONLY when hiring.available is true, i.e. only when an
//     explicit persisted recruiter hiring decision exists. Otherwise it shows an
//     empty state. It never derives "hired" from a score, an analysis or a
//     preference, and never shows a made-up bar.
// ---------------------------------------------------------------------------

const SERIES_COLORS = {
  jobsPosted: "#6366f1", // indigo-500 (matches AdminCharts candidates)
  candidatesAdded: "#06b6d4", // cyan-500 (matches AdminCharts recruiters)
  candidatesAnalyzed: "#10b981", // emerald-500 (matches AdminCharts organizations)
};

const SERIES_LABELS = {
  jobsPosted: "Jobs posted",
  candidatesAdded: "Candidates added",
  candidatesAnalyzed: "Candidates analyzed",
};

export const ActivityChart = ({ series = [], height = 200 }) => {
  const points = Array.isArray(series) ? series : [];

  // An all-zero series is genuinely empty data, not a broken chart.
  const hasActivity = points.some(
    (p) => (p.jobsPosted || 0) + (p.candidatesAdded || 0) + (p.candidatesAnalyzed || 0) > 0
  );

  if (points.length === 0 || !hasActivity) {
    return (
      <div className="flex h-48 flex-col items-center justify-center rounded-xl border border-dashed border-slate-200 bg-slate-50/50 p-6 text-center">
        <p className="text-sm font-medium text-slate-700">No activity in this period</p>
        <p className="mt-1 text-xs text-slate-400">
          Job and candidate activity will appear here as it is recorded.
        </p>
      </div>
    );
  }

  const width = 600;
  const padding = { top: 16, right: 16, bottom: 28, left: 34 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const keys = Object.keys(SERIES_COLORS);
  const maxVal = Math.max(
    1,
    ...points.flatMap((p) => keys.map((k) => p[k] || 0))
  );

  const getX = (index) =>
    points.length <= 1
      ? padding.left + chartWidth / 2
      : padding.left + (index / (points.length - 1)) * chartWidth;
  const getY = (val) => padding.top + chartHeight - (val / maxVal) * chartHeight;

  // Label every bucket when few, otherwise thin them out so they never collide.
  const labelStep = points.length <= 6 ? 1 : Math.ceil(points.length / 6);

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-4">
        {keys.map((key) => (
          <span key={key} className="flex items-center gap-1.5 text-xs text-slate-600">
            <span
              className="h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: SERIES_COLORS[key] }}
            />
            {SERIES_LABELS[key]}
          </span>
        ))}
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        role="img"
        aria-label="Monthly organization activity"
      >
        {[0, 0.5, 1].map((fraction) => {
          const y = padding.top + chartHeight - fraction * chartHeight;
          return (
            <g key={fraction}>
              <line
                x1={padding.left}
                x2={width - padding.right}
                y1={y}
                y2={y}
                stroke="#e2e8f0"
                strokeWidth="1"
              />
              <text x={padding.left - 6} y={y + 4} textAnchor="end" fontSize="10" fill="#94a3b8">
                {Math.round(maxVal * fraction)}
              </text>
            </g>
          );
        })}

        {keys.map((key) => (
          <polyline
            key={key}
            fill="none"
            stroke={SERIES_COLORS[key]}
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
            points={points.map((p, i) => `${getX(i)},${getY(p[key] || 0)}`).join(" ")}
          />
        ))}

        {points.map((point, index) =>
          index % labelStep === 0 ? (
            <text
              key={point.bucket}
              x={getX(index)}
              y={height - 8}
              textAnchor="middle"
              fontSize="10"
              fill="#94a3b8"
            >
              {formatMonthLabel(point.bucket)}
            </text>
          ) : null
        )}
      </svg>
    </div>
  );
};

// PHASE 4 — ASSESSMENT ACTIVITY TREND.
//
// Reads only the persisted monthly attempt buckets the backend aggregated in
// PostgreSQL. Like ActivityChart it renders an explicit empty state when there is
// genuinely no activity, and it never invents a bar.
const ASSESSMENT_SERIES_COLORS = {
  assessmentsStarted: "#8b5cf6", // violet-500
  assessmentsSubmitted: "#10b981", // emerald-500
  assessmentsTimedUp: "#f59e0b", // amber-500
  assessmentsCheated: "#ef4444", // red-500
};

const ASSESSMENT_SERIES_LABELS = {
  assessmentsStarted: "Started",
  assessmentsSubmitted: "Submitted",
  assessmentsTimedUp: "Timed up",
  assessmentsCheated: "Cheated",
};

export const AssessmentActivityChart = ({ series = [], height = 200 }) => {
  const points = Array.isArray(series) ? series : [];
  const keys = Object.keys(ASSESSMENT_SERIES_COLORS);

  const hasActivity = points.some((p) => keys.some((k) => (p[k] || 0) > 0));

  if (points.length === 0 || !hasActivity) {
    return (
      <div className="flex h-40 flex-col items-center justify-center rounded-xl border border-dashed border-slate-200 bg-slate-50/50 p-6 text-center">
        <p className="text-sm font-medium text-slate-700">No assessment activity in this period</p>
        <p className="mt-1 text-xs text-slate-400">
          Started, submitted, timed-up and cheated attempts will appear here as they are recorded.
        </p>
      </div>
    );
  }

  const width = 600;
  const padding = { top: 16, right: 16, bottom: 28, left: 34 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const maxVal = Math.max(1, ...points.flatMap((p) => keys.map((k) => p[k] || 0)));
  const getX = (index) =>
    points.length <= 1
      ? padding.left + chartWidth / 2
      : padding.left + (index / (points.length - 1)) * chartWidth;
  const getY = (val) => padding.top + chartHeight - (val / maxVal) * chartHeight;
  const labelStep = points.length <= 6 ? 1 : Math.ceil(points.length / 6);

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-4">
        {keys.map((key) => (
          <span key={key} className="flex items-center gap-1.5 text-xs text-slate-600">
            <span
              className="h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: ASSESSMENT_SERIES_COLORS[key] }}
            />
            {ASSESSMENT_SERIES_LABELS[key]}
          </span>
        ))}
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        role="img"
        aria-label="Monthly organization assessment activity"
      >
        {[0, 0.5, 1].map((fraction) => {
          const y = padding.top + chartHeight - fraction * chartHeight;
          return (
            <g key={fraction}>
              <line
                x1={padding.left}
                x2={width - padding.right}
                y1={y}
                y2={y}
                stroke="#e2e8f0"
                strokeWidth="1"
              />
              <text x={4} y={y + 3} fontSize="10" fill="#94a3b8">
                {Math.round(maxVal * fraction)}
              </text>
            </g>
          );
        })}

        {keys.map((key) => (
          <polyline
            key={key}
            fill="none"
            stroke={ASSESSMENT_SERIES_COLORS[key]}
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
            points={points.map((p, i) => `${getX(i)},${getY(p[key] || 0)}`).join(" ")}
          />
        ))}

        {points.map((point, index) =>
          index % labelStep === 0 ? (
            <text
              key={point.bucket}
              x={getX(index)}
              y={height - 8}
              textAnchor="middle"
              fontSize="10"
              fill="#94a3b8"
            >
              {formatMonthLabel(point.bucket)}
            </text>
          ) : null
        )}
      </svg>
    </div>
  );
};

// HIRING CHART — renders a real Hired / Not hired split ONLY when the backend
// reports hiring.available === true (i.e. an explicit persisted recruiter hiring
// decision exists). Otherwise it shows the honest empty state. It never infers
// hiring from an assessment score, an AI analysis or a preference.
export const HiringChart = ({ hiring }) => {
  const available = hiring?.available === true;
  const total = available ? hiring.totalCandidates : hiring?.totalCandidates ?? 0;
  const hired = available ? hiring.hired : null;
  const notHired = available ? hiring.notHired : null;

  if (!available) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-200 bg-slate-50/50 p-6 text-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-400">
          <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
        </div>
        <p className="mt-3 text-sm font-medium text-slate-700">No hiring data yet</p>
        <p className="mt-1 max-w-md text-xs text-slate-500">
          Hiring is an explicit recruiter decision. Until candidates can be marked as
          hired, this section stays empty rather than estimating a number from
          assessment scores or AI analysis.
        </p>
      </div>
    );
  }

  const rate = Number.isFinite(hiring.hiringRate) ? hiring.hiringRate : null;
  const hiredPct = total > 0 ? (hired / total) * 100 : 0;

  return (
    <div>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-slate-100">
        <div className="bg-emerald-500" style={{ width: `${hiredPct}%` }} role="presentation" />
        <div className="flex-1 bg-slate-200" role="presentation" />
      </div>
      <div className="mt-3 flex flex-wrap gap-4 text-xs text-slate-600">
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" /> Hired: {hired}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-slate-200" /> Not hired: {notHired}
        </span>
        <span className="text-slate-500">
          Hiring rate: {rate === null ? "—" : `${rate}%`}
        </span>
      </div>
    </div>
  );
};
