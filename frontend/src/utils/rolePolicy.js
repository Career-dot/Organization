export const NORMAL_USER_ROLES = ["EMPLOYEE", "RECRUITER", "ORG_ADMIN"];

const ALLOWED_NORMAL_ROLE_SETS = [
  ["EMPLOYEE"],
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

export const isAllowedRoleCombination = (roles = []) => {
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

export const getAllowedActivationRoles = (currentRoles = []) => {
  const normalizedCurrent = normalizeRoleSet(currentRoles);

  return NORMAL_USER_ROLES.filter(
    (role) => !normalizedCurrent.includes(role)
      && isAllowedRoleCombination([...normalizedCurrent, role])
  );
};
