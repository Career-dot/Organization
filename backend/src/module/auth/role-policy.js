const NORMAL_USER_ROLES = ["EMPLOYEE", "RECRUITER", "ORG_ADMIN"];

// Every legal set of NORMAL (non-SUPER_ADMIN) roles. ORG_ADMIN is a valid
// FIRST account: it is NOT implicitly paired with EMPLOYEE (a Candidate
// account is added later, explicitly, via POST /api/auth/become-candidate).
// RECRUITER and ORG_ADMIN can never co-exist in any set, with or without
// EMPLOYEE.
const ALLOWED_NORMAL_ROLE_SETS = [
  ["EMPLOYEE"],
  ["RECRUITER"],
  ["ORG_ADMIN"],
  ["EMPLOYEE", "RECRUITER"],
  ["EMPLOYEE", "ORG_ADMIN"],
];

const normalizeRoleSet = (roles = []) => {
  const normalized = (roles ?? [])
    .filter(Boolean)
    .map((role) => String(role).trim().toUpperCase())
    .filter((role) => role && role !== "SUPER_ADMIN");

  return [...new Set(normalized)];
};

const isAllowedRoleCombination = (roles = []) => {
  const normalized = normalizeRoleSet(roles);

  if (normalized.length === 0) {
    return false;
  }

  const sorted = [...normalized].sort();

  return ALLOWED_NORMAL_ROLE_SETS.some((allowedSet) => {
    const expected = [...allowedSet].sort();
    return (
      expected.length === sorted.length &&
      expected.every((role) => sorted.includes(role)) &&
      sorted.every((role) => expected.includes(role))
    );
  });
};

const getAllowedActivationRoles = (currentRoles = []) => {
  const normalizedCurrent = normalizeRoleSet(currentRoles);

  return NORMAL_USER_ROLES.filter(
    (role) => !normalizedCurrent.includes(role)
      && isAllowedRoleCombination([...normalizedCurrent, role])
  );
};

module.exports = {
  NORMAL_USER_ROLES,
  ALLOWED_NORMAL_ROLE_SETS,
  normalizeRoleSet,
  isAllowedRoleCombination,
  getAllowedActivationRoles,
};
