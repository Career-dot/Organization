// Tests the server-side must-change-password allow-list resolution added to
// authenticate.js (Phase 2). No database required: these assert the exact
// method+path matching that decides whether a blocked user may still reach the
// password-change lifecycle.
//
// Run with:  node src/middleware/authenticate.test.js
const assert = require("assert");
const test = require("node:test");

// Loaded lazily inside the helper below so `prisma` (required transitively by
// authenticate.js) is never needed to evaluate these pure-function assertions.
function loadGate() {
  return require("./authenticate").__test;
}

let PASSWORD_CHANGE_ALLOWED_ROUTES;
let resolveRequestPath;

test.before?.(() => {
  ({ PASSWORD_CHANGE_ALLOWED_ROUTES, resolveRequestPath } = loadGate());
});

const isAllowed = (method, url) =>
  PASSWORD_CHANGE_ALLOWED_ROUTES.has(resolveRequestPath({ method, originalUrl: url }));

test("the four password-change lifecycle endpoints are allowed", () => {
  assert.strictEqual(isAllowed("POST", "/api/auth/change-password"), true);
  assert.strictEqual(isAllowed("GET", "/api/auth/me"), true);
  assert.strictEqual(isAllowed("POST", "/api/auth/logout"), true);
  assert.strictEqual(isAllowed("POST", "/api/auth/refresh"), true);
});

test("recruiter APIs are blocked", () => {
  const blocked = [
    ["GET", "/api/job/recruiter/jobs"],
    ["GET", "/api/job/recruiter/limits"],
    ["POST", "/api/job/"],
    ["GET", "/api/job/overview/jobs"],
    ["GET", "/api/auth/recruiter/profile"],
    ["PUT", "/api/auth/recruiter/profile"],
    ["GET", "/api/organization/recruiters"],
    ["POST", "/api/organization/recruiters"],
    ["GET", "/api/organization/me"],
    ["GET", "/api/files/abc/view"],
    ["GET", "/api/realtime/candidates/job1/events"],
  ];
  for (const [method, url] of blocked) {
    assert.strictEqual(isAllowed(method, url), false, `${method} ${url} must be blocked`);
  }
});

test("method matters: a wrong verb on an allowed path is still blocked", () => {
  // The lifecycle endpoints are not blanket-allowlisted by path.
  assert.strictEqual(isAllowed("GET", "/api/auth/change-password"), false);
  assert.strictEqual(isAllowed("DELETE", "/api/auth/change-password"), false);
  assert.strictEqual(isAllowed("POST", "/api/auth/me"), false);
  assert.strictEqual(isAllowed("GET", "/api/auth/logout"), false);
  assert.strictEqual(isAllowed("GET", "/api/auth/refresh"), false);
});

test("path matching is exact, not substring (no prefix/suffix bypass)", () => {
  // A substring/`includes` implementation would wrongly allow all of these.
  assert.strictEqual(isAllowed("POST", "/api/auth/change-password/../../job/recruiters/jobs"), false);
  assert.strictEqual(isAllowed("POST", "/api/job/recruiters/jobs?x=/api/auth/change-password"), false);
  assert.strictEqual(isAllowed("GET", "/api/auth/me/extra"), false);
  assert.strictEqual(isAllowed("POST", "/api/other/auth/change-password"), false);
  assert.strictEqual(isAllowed("POST", "/api/auth/employee/change-password"), false);
  assert.strictEqual(isAllowed("POST", "/evil/api/auth/change-password"), false);
});

test("query strings and trailing slashes normalize to the same endpoint", () => {
  assert.strictEqual(isAllowed("GET", "/api/auth/me?refresh=1"), true);
  assert.strictEqual(isAllowed("GET", "/api/auth/me/"), true);
  assert.strictEqual(isAllowed("POST", "/api/auth/refresh?a=1&b=2"), true);
  assert.strictEqual(isAllowed("GET", "/api/auth//me"), true);
  // Normalization must not turn a different resource into an allowed one.
  assert.strictEqual(isAllowed("GET", "/api/auth/me/../job/recruiters/jobs"), false);
});

test("the allow-list contains exactly the four intended entries", () => {
  assert.deepStrictEqual(
    [...PASSWORD_CHANGE_ALLOWED_ROUTES].sort(),
    [
      "GET /api/auth/me",
      "POST /api/auth/change-password",
      "POST /api/auth/logout",
      "POST /api/auth/refresh",
    ]
  );
});