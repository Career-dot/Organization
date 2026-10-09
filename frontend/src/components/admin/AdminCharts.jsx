import { useState } from "react";

// Color palette matching the project's Tailwind design system
const COLORS = {
  candidates: {
    stroke: "#6366f1", // indigo-500
    fill: "rgba(99, 102, 241, 0.12)",
    label: "Candidates",
  },
  recruiters: {
    stroke: "#06b6d4", // cyan-500
    fill: "rgba(6, 182, 212, 0.12)",
    label: "Recruiters",
  },
  organizations: {
    stroke: "#10b981", // emerald-500
    fill: "rgba(16, 185, 129, 0.12)",
    label: "Organizations",
  },
};

const SUB_COLORS = {
  ACTIVE: "#10b981",    // emerald-500
  TRIAL: "#3b82f6",     // blue-500
  EXPIRED: "#f59e0b",   // amber-500
  SUSPENDED: "#ef4444", // red-500
  CANCELLED: "#64748b", // slate-500
};

/**
 * Platform Growth Area / Line Chart
 * Computes SVG paths from actual daily counts.
 */
export const PlatformGrowthChart = ({ data = [], height = 240 }) => {
  const [hoveredIdx, setHoveredIdx] = useState(null);

  if (!data || data.length === 0) {
    return (
      <div className="flex h-56 flex-col items-center justify-center rounded-xl border border-dashed border-slate-200 bg-slate-50/50 p-6 text-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-400">
          <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
          </svg>
        </div>
        <p className="mt-3 text-sm font-medium text-slate-700">No timeline data available for this range</p>
        <p className="mt-1 text-xs text-slate-400">Historical growth data will appear as platform activity accumulates.</p>
      </div>
    );
  }

  // Calculate scaling
  const width = 600;
  const padding = { top: 20, right: 30, bottom: 35, left: 40 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const maxVal = Math.max(
    1,
    ...data.map((d) => Math.max(d.candidates || 0, d.recruiters || 0, d.organizations || 0))
  );

  const getX = (index) => {
    if (data.length <= 1) return padding.left + chartWidth / 2;
    return padding.left + (index / (data.length - 1)) * chartWidth;
  };

  const getY = (val) => {
    return padding.top + chartHeight - (val / maxVal) * chartHeight;
  };

  // Generate SVG path strings
  const buildLinePath = (key) => {
    if (data.length === 0) return "";
    return data
      .map((d, i) => `${i === 0 ? "M" : "L"} ${getX(i)} ${getY(d[key] || 0)}`)
      .join(" ");
  };

  const buildAreaPath = (key) => {
    if (data.length === 0) return "";
    const line = buildLinePath(key);
    const firstX = getX(0);
    const lastX = getX(data.length - 1);
    const bottomY = padding.top + chartHeight;
    return `${line} L ${lastX} ${bottomY} L ${firstX} ${bottomY} Z`;
  };

  return (
    <div className="relative">
      {/* Chart Legend */}
      <div className="mb-4 flex flex-wrap items-center gap-5 text-xs font-medium text-slate-600">
        <div className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-full" style={{ backgroundColor: COLORS.organizations.stroke }} />
          <span>Organizations</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-full" style={{ backgroundColor: COLORS.recruiters.stroke }} />
          <span>Recruiters</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-full" style={{ backgroundColor: COLORS.candidates.stroke }} />
          <span>Candidates</span>
        </div>
      </div>

      <div className="relative w-full overflow-hidden">
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full overflow-visible" preserveAspectRatio="none">
          {/* Horizontal Grid lines */}
          {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
            const y = padding.top + chartHeight * (1 - ratio);
            const val = Math.round(maxVal * ratio);
            return (
              <g key={ratio}>
                <line
                  x1={padding.left}
                  y1={y}
                  x2={width - padding.right}
                  y2={y}
                  stroke="#e2e8f0"
                  strokeDasharray={ratio === 0 ? "" : "3 3"}
                  strokeWidth={1}
                />
                <text x={padding.left - 8} y={y + 3} fontSize={10} textAnchor="end" fill="#94a3b8">
                  {val}
                </text>
              </g>
            );
          })}

          {/* Area Fills */}
          <path d={buildAreaPath("candidates")} fill={COLORS.candidates.fill} />
          <path d={buildAreaPath("recruiters")} fill={COLORS.recruiters.fill} />
          <path d={buildAreaPath("organizations")} fill={COLORS.organizations.fill} />

          {/* Lines */}
          <path d={buildLinePath("candidates")} fill="none" stroke={COLORS.candidates.stroke} strokeWidth={2.5} strokeLinecap="round" />
          <path d={buildLinePath("recruiters")} fill="none" stroke={COLORS.recruiters.stroke} strokeWidth={2.5} strokeLinecap="round" />
          <path d={buildLinePath("organizations")} fill="none" stroke={COLORS.organizations.stroke} strokeWidth={2.5} strokeLinecap="round" />

          {/* Data Points */}
          {data.map((d, i) => (
            <g key={i}>
              <circle
                cx={getX(i)}
                cy={getY(d.organizations || 0)}
                r={hoveredIdx === i ? 4.5 : 3}
                fill="#ffffff"
                stroke={COLORS.organizations.stroke}
                strokeWidth={2}
              />
              <circle
                cx={getX(i)}
                cy={getY(d.recruiters || 0)}
                r={hoveredIdx === i ? 4.5 : 3}
                fill="#ffffff"
                stroke={COLORS.recruiters.stroke}
                strokeWidth={2}
              />
              <circle
                cx={getX(i)}
                cy={getY(d.candidates || 0)}
                r={hoveredIdx === i ? 4.5 : 3}
                fill="#ffffff"
                stroke={COLORS.candidates.stroke}
                strokeWidth={2}
              />
            </g>
          ))}

          {/* X Axis Dates */}
          {data.map((d, i) => {
            // Show every Nth label to prevent cluttering
            const step = Math.max(1, Math.floor(data.length / 6));
            if (i % step !== 0 && i !== data.length - 1) return null;
            const dateStr = d.date ? d.date.slice(5) : "";
            return (
              <text key={i} x={getX(i)} y={height - 8} fontSize={10} textAnchor="middle" fill="#94a3b8">
                {dateStr}
              </text>
            );
          })}
        </svg>
      </div>
    </div>
  );
};

/**
 * Subscription Status Donut Chart
 */
export const SubscriptionDonutChart = ({ subscriptions = {} }) => {
  const [hoveredSlice, setHoveredSlice] = useState(null);

  const items = [
    { label: "Active", count: subscriptions.active || 0, key: "ACTIVE", color: SUB_COLORS.ACTIVE },
    { label: "Trial", count: subscriptions.trial || 0, key: "TRIAL", color: SUB_COLORS.TRIAL },
    { label: "Expired", count: subscriptions.expired || 0, key: "EXPIRED", color: SUB_COLORS.EXPIRED },
    { label: "Suspended", count: subscriptions.suspended || 0, key: "SUSPENDED", color: SUB_COLORS.SUSPENDED },
    { label: "Cancelled", count: subscriptions.cancelled || 0, key: "CANCELLED", color: SUB_COLORS.CANCELLED },
  ];

  const total = items.reduce((acc, curr) => acc + curr.count, 0);

  if (total === 0) {
    return (
      <div className="flex h-56 flex-col items-center justify-center text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-400">
          <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <circle cx="12" cy="12" r="9" />
          </svg>
        </div>
        <p className="mt-2 text-sm font-medium text-slate-700">No subscriptions created yet</p>
        <p className="text-xs text-slate-400">Customer subscription statuses will appear here.</p>
      </div>
    );
  }

  // Calculate SVG arc paths
  const size = 180;
  const strokeWidth = 24;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;

  let accumulatedPercent = 0;

  return (
    <div className="flex flex-col items-center justify-between gap-6 sm:flex-row">
      <div className="relative flex flex-none items-center justify-center">
        <svg width={size} height={size} className="-rotate-90 transform">
          {items.map((item) => {
            if (item.count === 0) return null;
            const percent = (item.count / total) * 100;
            const strokeDasharray = `${(percent / 100) * circumference} ${circumference}`;
            const strokeDashoffset = -((accumulatedPercent / 100) * circumference);
            accumulatedPercent += percent;

            const isHovered = hoveredSlice === item.key;

            return (
              <circle
                key={item.key}
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                stroke={item.color}
                strokeWidth={isHovered ? strokeWidth + 4 : strokeWidth}
                strokeDasharray={strokeDasharray}
                strokeDashoffset={strokeDashoffset}
                className="cursor-pointer transition-all duration-200"
                onMouseEnter={() => setHoveredSlice(item.key)}
                onMouseLeave={() => setHoveredSlice(null)}
              />
            );
          })}
        </svg>
        <div className="pointer-events-none absolute flex flex-col items-center justify-center text-center">
          <span className="text-2xl font-bold text-slate-900">{total}</span>
          <span className="text-xs font-medium text-slate-500">Total</span>
        </div>
      </div>

      <div className="flex-1 space-y-2 text-xs">
        {items.map((item) => {
          const pct = total > 0 ? ((item.count / total) * 100).toFixed(1) : 0;
          return (
            <div
              key={item.key}
              className={`flex items-center justify-between rounded-lg p-2 transition-colors ${
                hoveredSlice === item.key ? "bg-slate-100 font-semibold text-slate-900" : "text-slate-600"
              }`}
              onMouseEnter={() => setHoveredSlice(item.key)}
              onMouseLeave={() => setHoveredSlice(null)}
            >
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: item.color }} />
                <span>{item.label}</span>
              </div>
              <div className="flex items-center gap-2 font-medium">
                <span className="text-slate-900">{item.count}</span>
                <span className="w-10 text-right text-slate-400">{pct}%</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

/**
 * Plan Distribution Bar Breakdown
 */
export const PlanDistributionBars = ({ plans = [] }) => {
  const totalSubscribers = plans.reduce((acc, p) => acc + (p.subscriberCount || 0), 0);

  if (!plans || plans.length === 0) {
    return <p className="text-xs text-slate-400">No active plans in catalog.</p>;
  }

  return (
    <div className="space-y-4">
      {plans.map((plan) => {
        const count = plan.subscriberCount || 0;
        const percent = totalSubscribers > 0 ? Math.round((count / totalSubscribers) * 100) : 0;
        return (
          <div key={plan.id} className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-2 font-medium text-slate-800">
                <span>{plan.name}</span>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-500 font-semibold">
                  ${plan.price}/mo
                </span>
                <span className="rounded-full bg-indigo-50 px-1.5 py-0.5 text-[9px] font-semibold text-indigo-700">
                  {plan.type}
                </span>
              </div>
              <div className="flex items-center gap-2 font-medium text-slate-600">
                <span className="font-semibold text-slate-900">{count}</span>
                <span className="text-slate-400">({percent}%)</span>
              </div>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
              <div
                className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-cyan-400 transition-all duration-500"
                style={{ width: `${percent}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
};

