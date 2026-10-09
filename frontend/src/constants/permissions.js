// Must stay in sync with ALLOWED_RECRUITER_PERMISSIONS in the backend's
// organization.service.js — the backend is the source of truth and rejects
// anything not in that list.
export const RECRUITER_PERMISSIONS = [
  { value: "CANDIDATE_VIEW", label: "View candidates" },
  { value: "CANDIDATE_EVALUATE", label: "Evaluate candidates" },
  { value: "CANDIDATE_REPORT", label: "Generate reports" },
  { value: "CANDIDATE_HIRE", label: "Record hiring decisions" },
  { value: "CANDIDATE_EXPORT", label: "Export candidate data" },
];
