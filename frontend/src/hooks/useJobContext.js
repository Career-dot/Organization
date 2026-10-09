import { useAuth } from "./useAuth";

// Derives the recruiter job context from the authenticated session only.
//
// The organization id ALWAYS comes from the active account the backend sent
// at login/refresh (activeAccount.scope === "organization" with its
// organizationId) — it is never collected from user input, and job pages
// render a hard error state when an organization account somehow lacks one
// rather than guessing or falling back.
//
// Returns one of:
//   { kind: "independent" }
//   { kind: "organization", organizationId }
//   { kind: "error", message }          — org scope without an organizationId
//   { kind: "unresolved", message }     — not a usable recruiter session
export const useJobContext = () => {
  const { user } = useAuth();

  const activeAccount = user?.accounts?.find((account) => account.role === user.role) ?? null;

  if (user?.role !== "RECRUITER") {
    return {
      kind: "unresolved",
      message: "Sign in with a recruiter account to manage jobs.",
    };
  }

  const scope = activeAccount?.scope ?? "user";

  if (scope === "organization") {
    if (!activeAccount?.organizationId) {
      return {
        kind: "error",
        message:
          "Your organization membership is not linked to an organization yet. Contact your organization administrator.",
      };
    }
    return { kind: "organization", organizationId: activeAccount.organizationId };
  }

  return { kind: "independent" };
};

export default useJobContext;
