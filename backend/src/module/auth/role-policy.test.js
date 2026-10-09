const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isAllowedRoleCombination,
  getAllowedActivationRoles,
} = require('./auth.service');
const { getRequiredRegistrationRoleNames } = require('./auth.repository');

test('EMPLOYEE is valid', () => {
  assert.equal(isAllowedRoleCombination(['EMPLOYEE']), true);
});

test('EMPLOYEE + RECRUITER is valid', () => {
  assert.equal(isAllowedRoleCombination(['EMPLOYEE', 'RECRUITER']), true);
});

test('EMPLOYEE + ORG_ADMIN is valid', () => {
  assert.equal(isAllowedRoleCombination(['EMPLOYEE', 'ORG_ADMIN']), true);
});

test('RECRUITER only is valid', () => {
  assert.equal(isAllowedRoleCombination(['RECRUITER']), true);
});

test('ORG_ADMIN only is valid', () => {
  assert.equal(isAllowedRoleCombination(['ORG_ADMIN']), true);
});

test('RECRUITER + ORG_ADMIN is invalid', () => {
  assert.equal(isAllowedRoleCombination(['RECRUITER', 'ORG_ADMIN']), false);
});

test('EMPLOYEE + RECRUITER + ORG_ADMIN is invalid', () => {
  assert.equal(isAllowedRoleCombination(['EMPLOYEE', 'RECRUITER', 'ORG_ADMIN']), false);
});

test('EMPLOYEE + RECRUITER cannot activate ORG_ADMIN', () => {
  assert.deepEqual(getAllowedActivationRoles(['EMPLOYEE', 'RECRUITER']), []);
});

test('EMPLOYEE + ORG_ADMIN cannot activate RECRUITER', () => {
  assert.deepEqual(getAllowedActivationRoles(['EMPLOYEE', 'ORG_ADMIN']), []);
});

test('ORG_ADMIN registration is ORG_ADMIN only (no implicit EMPLOYEE)', () => {
  assert.deepEqual(getRequiredRegistrationRoleNames('ORG_ADMIN'), ['ORG_ADMIN']);
});

test('RECRUITER registration stays single-role', () => {
  assert.deepEqual(getRequiredRegistrationRoleNames('RECRUITER'), ['RECRUITER']);
});

test('EMPLOYEE registration stays single-role', () => {
  assert.deepEqual(getRequiredRegistrationRoleNames('EMPLOYEE'), ['EMPLOYEE']);
});

test('ORG_ADMIN remains the default active role when a user also has EMPLOYEE', () => {
  const user = {
    roles: [{ role: { name: 'ORG_ADMIN' } }, { role: { name: 'EMPLOYEE' } }],
    organizationMemberships: [{ role: 'ORG_ADMIN', status: 'INVITED' }],
  };

  assert.equal(require('./auth.service').getRoleState(user, null, false).role, 'ORG_ADMIN');
});

test('Explicit candidate switch still works for a mixed org-admin user', () => {
  const user = {
    roles: [{ role: { name: 'ORG_ADMIN' } }, { role: { name: 'EMPLOYEE' } }],
    organizationMemberships: [{ role: 'ORG_ADMIN', status: 'INVITED' }],
  };

  assert.equal(require('./auth.service').getRoleState(user, 'EMPLOYEE', false).role, 'EMPLOYEE');
});

test('Membership-only organization recruiter resolves as organization RECRUITER', () => {
  const user = {
    roles: [],
    organizationMemberships: [{
      role: 'RECRUITER',
      status: 'ACTIVE',
      organizationId: 'organization-1',
    }],
  };

  const state = require('./auth.service').getRoleState(user, null, false);
  assert.equal(state.role, 'RECRUITER');
  assert.deepEqual(state.accounts, [{
    role: 'RECRUITER',
    scope: 'organization',
    organizationId: 'organization-1',
  }]);
});

test('Membership-only organization recruiter can resolve explicit recruiter activation', () => {
  const user = {
    roles: [],
    organizationMemberships: [{ role: 'RECRUITER', status: 'ACTIVE' }],
  };

  assert.equal(require('./auth.service').getRoleState(user, 'RECRUITER', false).role, 'RECRUITER');
});

// ---------------------------------------------------------------------------
// ORG_ADMIN as a FIRST account: activation matrix
// ---------------------------------------------------------------------------

test('ORG_ADMIN-only account resolves ORG_ADMIN as its default role', () => {
  const user = {
    roles: [{ role: { name: 'ORG_ADMIN' } }],
    organizationMemberships: [{ role: 'ORG_ADMIN', status: 'INVITED' }],
  };

  assert.equal(require('./auth.service').getRoleState(user, null, false).role, 'ORG_ADMIN');
});

test('ORG_ADMIN can activate EMPLOYEE (Candidate added explicitly later)', () => {
  assert.deepEqual(getAllowedActivationRoles(['ORG_ADMIN']), ['EMPLOYEE']);
});

test('RECRUITER can activate EMPLOYEE but never ORG_ADMIN', () => {
  assert.deepEqual(getAllowedActivationRoles(['RECRUITER']), ['EMPLOYEE']);
});

test('EMPLOYEE can activate either RECRUITER or ORG_ADMIN, never both', () => {
  assert.deepEqual(getAllowedActivationRoles(['EMPLOYEE']), ['RECRUITER', 'ORG_ADMIN']);
});

// ---------------------------------------------------------------------------
// Subscription transition decision table
//
// These mirror the guard in subscription.service.js's resolveOwnerContext
// (the explicit targetRole purchase path), which projects the shared
// role-policy rules onto purchases. Asserting the policy directly keeps the
// two from drifting.
// ---------------------------------------------------------------------------

test('TRANSITION: ORG_ADMIN -> ORG_ADMIN is allowed (renewal / re-activation)', () => {
  assert.equal(isAllowedRoleCombination(['ORG_ADMIN', 'ORG_ADMIN']), true);
});

test('TRANSITION: ORG_ADMIN -> EMPLOYEE is allowed', () => {
  assert.equal(isAllowedRoleCombination(['ORG_ADMIN', 'EMPLOYEE']), true);
});

test('TRANSITION: ORG_ADMIN -> RECRUITER is rejected', () => {
  assert.equal(isAllowedRoleCombination(['ORG_ADMIN', 'RECRUITER']), false);
});

test('TRANSITION: RECRUITER -> ORG_ADMIN is rejected', () => {
  assert.equal(isAllowedRoleCombination(['RECRUITER', 'ORG_ADMIN']), false);
});

test('TRANSITION: EMPLOYEE + RECRUITER -> ORG_ADMIN is rejected', () => {
  assert.equal(isAllowedRoleCombination(['EMPLOYEE', 'RECRUITER', 'ORG_ADMIN']), false);
});

test('TRANSITION: a role-less account is not a legal combination', () => {
  // resolveOwnerContext's guard requires the CURRENT set to be legal too, so
  // role-less accounts (e.g. a membership-only organization recruiter) stay
  // exactly as ineligible for a targetRole purchase as they are today.
  assert.equal(isAllowedRoleCombination([]), false);
});

test('SUPER_ADMIN is normalized out of combination checks', () => {
  // Documents WHY resolveOwnerContext rejects SUPER_ADMIN explicitly instead
  // of relying on the combination check alone: normalizeRoleSet drops
  // SUPER_ADMIN (it is not a NORMAL_USER_ROLE), so a bare
  // isAllowedRoleCombination([...roles, targetRole]) would be blindly
  // permissive for a platform admin.
  assert.equal(isAllowedRoleCombination(['SUPER_ADMIN', 'ORG_ADMIN']), true);
  assert.equal(isAllowedRoleCombination(['SUPER_ADMIN']), false);
});
