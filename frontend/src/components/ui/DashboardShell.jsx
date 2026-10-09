import { Link, useLocation } from "react-router-dom";
import Container from "./Container";

const DashboardShell = ({
  roleLabel,
  title,
  description,
  navItems,
  statCards,
  children,
  additionalContent,
  organizationBranding,
}) => {
  const location = useLocation();
  const activeLinkedItem = navItems.find(
    (item) => item.to && location.pathname === item.to
  );

  const isItemActive = (item, index) =>
    item.to ? location.pathname === item.to : !activeLinkedItem && index === 0;

  return (
    <div className="lg:flex">
      <aside className="hidden w-64 flex-none border-r border-slate-200 bg-white p-6 lg:block">
        <div className="flex items-center gap-3 rounded-xl bg-slate-50 p-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-cyan-400 text-sm font-bold text-white">
            {roleLabel[0]}
          </div>
          <div>
            <p className="text-sm font-semibold text-slate-900">{roleLabel}</p>
            <p className="text-xs text-slate-500">Preview profile</p>
          </div>
        </div>

        <nav className="mt-6 space-y-1">
          {navItems.map((item, index) => {
            const active = isItemActive(item, index);
            const className = `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium ${
              active ? "bg-indigo-50 text-indigo-700" : "text-slate-600"
            }`;

            if (item.to) {
              return (
                <Link key={item.label} to={item.to} className={className}>
                  <item.icon className="h-4 w-4" />
                  {item.label}
                </Link>
              );
            }

            return (
              <div key={item.label} className={className}>
                <item.icon className="h-4 w-4" />
                {item.label}
              </div>
            );
          })}
        </nav>
      </aside>

      <div className="flex-1">
        <div className="flex gap-2 overflow-x-auto border-b border-slate-200 bg-white px-4 py-3 lg:hidden">
          {navItems.map((item, index) => {
            const active = isItemActive(item, index);
            const className = `flex-none rounded-full px-3 py-1.5 text-xs font-medium ${
              active
                ? "bg-indigo-50 text-indigo-700"
                : "bg-slate-100 text-slate-600"
            }`;

            if (item.to) {
              return (
                <Link key={item.label} to={item.to} className={className}>
                  {item.label}
                </Link>
              );
            }

            return (
              <span key={item.label} className={className}>
                {item.label}
              </span>
            );
          })}
        </div>

        <Container className="py-10">
          {organizationBranding?.organizationLogo && (
            <Link
              to={organizationBranding.settingsPath ?? "#"}
              className="mb-5 flex w-fit items-center gap-3 rounded-lg p-1 transition hover:bg-slate-50"
              aria-label={organizationBranding.settingsPath ? "Organization Settings" : undefined}
              onClick={(event) => {
                if (!organizationBranding.settingsPath) event.preventDefault();
              }}
            >
              <img
                src={organizationBranding.organizationLogo}
                alt={`${organizationBranding.name} logo`}
                className="h-10 w-10 rounded-lg border border-slate-200 object-cover"
              />
              <span className="text-sm font-semibold text-slate-700">
                {organizationBranding.name}
              </span>
              {organizationBranding.settingsPath && <span className="text-xs text-slate-500">Organization Settings</span>}
            </Link>
          )}
          <h1 className="font-display text-2xl font-bold text-slate-900">
            {title ?? `${roleLabel} Dashboard`}
          </h1>
          <p className="mt-1 text-slate-600">{description}</p>

          {children ? (
            <div className="mt-8">{children}</div>
          ) : (
            <>
              <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                {statCards.map((card) => (
                  <div
                    key={card.label}
                    className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
                  >
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-cyan-400 text-white">
                      <card.icon className="h-5 w-5" />
                    </div>
                    <p className="mt-4 text-2xl font-bold text-slate-900">
                      {card.value}
                    </p>
                    <p className="mt-1 text-sm text-slate-600">{card.label}</p>
                  </div>
                ))}
              </div>

              <div className="mt-8 rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
                Full {roleLabel.toLowerCase()} functionality is coming soon.
              </div>
            </>
          )}

          {additionalContent}
        </Container>
      </div>
    </div>
  );
};

export default DashboardShell;
