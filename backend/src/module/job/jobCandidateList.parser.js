const fs = require("fs/promises");
const path = require("path");
const XLSX = require("xlsx");
const { absolutePathFor } = require("../storage/storage.service");
// Phase 7 (Step 2) — shared field limits, so an Excel-seeded reference and a
// recruiter-edited one are always shaped identically (job.validation is the
// single source of truth for these bounds; it depends only on zod).
const {
  CANDIDATE_REFERENCE_FIELD_LIMITS,
  // The ONE candidate-email shape rule. Manual candidate addition validates its
  // recruiter-entered address against this very constant, so a manually added
  // candidate can never be accepted under a laxer rule than the same address in
  // the uploaded sheet. The pattern itself is unchanged.
  CANDIDATE_EMAIL_PATTERN,
  MAX_CANDIDATE_REFERENCE_SKILLS,
} = require("./job.validation");

// ---------------------------------------------------------------------------
// Candidate Excel Sheet parsing & validation (recruiter Job module).
//
// The recruiter uploads one Excel workbook per job. Parsing is deliberately
// strict: the first worksheet must carry a header row with an "Email" column
// (matched case-insensitively), and every non-empty row below it is one
// candidate. Column structure: an "Email" column is REQUIRED; any additional
// columns are preserved for future candidate flows and ignored here.
//
// The SAME rules are enforced twice by this module:
//   * at upload time (against the in-memory multer buffer), and
//   * at Start time (against the stored file re-read from disk — the
//     upload-time count on JobCandidateList is display metadata, never the
//     authoritative gate).
//
// Rules:
//   * 1..1000 candidates — more than 1000 rows REJECTS the file (no silent
//     truncation, no partial import)
//   * every candidate row must carry a syntactically valid email address
//   * email addresses are unique CASE-INSENSITIVELY (A@EMAIL.COM ===
//     a@email.com) — duplicates REJECT the file, never silently removed
// ---------------------------------------------------------------------------

const MAX_CANDIDATES = 1000;

const CANDIDATE_LIST_MESSAGES = {
  REQUIRED: "Candidate list is required before starting this job.",
  LIMIT: "Candidate list cannot contain more than 1,000 candidates.",
  DUPLICATE:
    "Candidate list contains duplicate email addresses. Each email can belong to only one candidate.",
  UNREADABLE: "Candidate list could not be read. Please upload a valid Excel file.",
  EMPTY: "Candidate list must contain at least one candidate.",
  EMAIL_COLUMN: "Candidate list must include an 'Email' column.",
  EMAIL_INVALID:
    "Candidate list contains rows with a missing or invalid email address. Every candidate must have an email.",
  FILE_TYPE: "Candidate list must be an Excel file (.xlsx or .xls).",
};

const EXCEL_MIME_BY_EXTENSION = {
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
};

const EMAIL_HEADERS = new Set(["email", "emailaddress"]);
// The candidate's display name is the ONLY other recruiter-provided candidate
// field the current Excel contract carries: the compact preview already treats
// the first column as the name, and the recruiters' sheets label it "Name".
// The header is matched case/format-insensitively (same normalization as the
// Email header) and is OPTIONAL — a sheet without it keeps the existing
// first-column behaviour. No other candidate column is read: unsupported
// columns are ignored exactly as before.
const NAME_HEADERS = new Set(["name", "candidatename", "fullname"]);
// Re-exported name for readability at the single use site below; the value is the
// shared job.validation constant (identical pattern, one definition).
const EMAIL_PATTERN = CANDIDATE_EMAIL_PATTERN;

const candidateListError = (message, status = 400) =>
  Object.assign(new Error(message), { status });

const normalizeHeaderCell = (value) =>
  String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

// Upload boundary: the multer file must be present and Excel-shaped. Browsers
// frequently send spreadsheets as application/octet-stream, so the mimetype is
// normalized from the extension before the storage service validates it (same
// normalization idea as storage.service's own PDF fix-up).
const assertCandidateListUpload = (file) => {
  if (!file || !file.buffer) {
    throw candidateListError("A candidate list file is required");
  }
  const extension = path.extname(file.originalname || "").toLowerCase();
  const mimeType = EXCEL_MIME_BY_EXTENSION[extension];
  if (!mimeType) {
    throw candidateListError(CANDIDATE_LIST_MESSAGES.FILE_TYPE, 415);
  }
  file.mimetype = mimeType;
  return file;
};

// ---------------------------------------------------------------------------
// Phase 7 (Step 2) — candidate-reference seeding columns (STRICT WHITELIST).
//
// Only the five columns below may ever populate a JobCandidateReference. Every
// other spreadsheet column stays ignored exactly as before: no arbitrary column
// is treated as candidate data, and no new Excel field is invented here.
// A missing header (or a blank cell) yields null — the seeder writes NOTHING
// for it, so a replacement sheet that omits a column can never erase a
// recruiter-edited value.
// ---------------------------------------------------------------------------
const LINKEDIN_HEADERS = new Set(["linkedin", "linkedinurl", "linkedinprofile", "linkedinlink"]);
const GITHUB_HEADERS = new Set(["github", "githuburl", "githubprofile", "githublink"]);
const PREFERRED_ROLE_HEADERS = new Set(["preferredrole", "preferredposition", "desiredrole"]);
const SKILLS_HEADERS = new Set(["skills", "skill", "skillset"]);
const SKILL_NOTES_HEADERS = new Set(["skillnotes", "skillnote", "notes"]);

// First column whose normalized header matches wins; -1 when absent (reading
// row[-1] is undefined, which normalizes to null).
const findColumn = (headerRow, headers) => headerRow.findIndex((header) => headers.has(header));

const cleanCell = (value) => {
  const text = String(value ?? "").trim();
  return text === "" ? null : text;
};

const truncateTo = (value, max) => (value === null ? null : value.slice(0, max));

// A "LinkedIn"/"GitHub" cell is routed to the URL field when it looks like a
// link (http(s) scheme or the platform host) and to the free-text field
// otherwise — deterministic, so the same sheet always seeds the same shape.
const looksLikeUrl = (value, host) => {
  if (!value) {
    return false;
  }
  if (/^https?:\/\//i.test(value)) {
    return true;
  }
  return new RegExp(`(^|[./])${host}\\.`, "i").test(value);
};

// "Skills" is one cell: split on the usual separators, trim, drop blanks,
// de-duplicate case-insensitively, and bound by the same limits the recruiter
// edit schema enforces (100 chars per skill, 50 skills).
const parseSkillCell = (value) => {
  if (!value) {
    return null;
  }
  const seen = new Set();
  const skills = [];
  for (const part of value.split(/[,;|\n]/)) {
    const skill = part.trim().slice(0, CANDIDATE_REFERENCE_FIELD_LIMITS.skill);
    if (!skill) {
      continue;
    }
    const key = skill.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    skills.push(skill);
    if (skills.length >= MAX_CANDIDATE_REFERENCE_SKILLS) {
      break;
    }
  }
  return skills.length > 0 ? skills : null;
};

const resolveReferenceColumns = (headerRow) => ({
  linkedin: findColumn(headerRow, LINKEDIN_HEADERS),
  github: findColumn(headerRow, GITHUB_HEADERS),
  preferredRole: findColumn(headerRow, PREFERRED_ROLE_HEADERS),
  skills: findColumn(headerRow, SKILLS_HEADERS),
  skillNotes: findColumn(headerRow, SKILL_NOTES_HEADERS),
});

const buildReferenceFields = (row, columns) => {
  const linkedin = cleanCell(row[columns.linkedin]);
  const github = cleanCell(row[columns.github]);
  const linkedinIsUrl = looksLikeUrl(linkedin, "linkedin");
  const githubIsUrl = looksLikeUrl(github, "github");
  return {
    linkedinUrl: linkedinIsUrl
      ? truncateTo(linkedin, CANDIDATE_REFERENCE_FIELD_LIMITS.linkedinUrl)
      : null,
    linkedinText:
      linkedin && !linkedinIsUrl
        ? truncateTo(linkedin, CANDIDATE_REFERENCE_FIELD_LIMITS.linkedinText)
        : null,
    githubUrl: githubIsUrl ? truncateTo(github, CANDIDATE_REFERENCE_FIELD_LIMITS.githubUrl) : null,
    githubText:
      github && !githubIsUrl
        ? truncateTo(github, CANDIDATE_REFERENCE_FIELD_LIMITS.githubText)
        : null,
    preferredRole: truncateTo(
      cleanCell(row[columns.preferredRole]),
      CANDIDATE_REFERENCE_FIELD_LIMITS.preferredRole
    ),
    skills: parseSkillCell(cleanCell(row[columns.skills])),
    skillNotes: truncateTo(
      cleanCell(row[columns.skillNotes]),
      CANDIDATE_REFERENCE_FIELD_LIMITS.skillNotes
    ),
  };
};

const parseCandidateListCore = (buffer, rowLimit, options = {}) => {
  // Strict container sniffing BEFORE parsing: a real .xlsx is a ZIP (PK\x03\x04)
  // and a real .xls is an OLE2 compound file. SheetJS would otherwise happily
  // parse arbitrary text as a CSV-ish sheet and produce a confusing "no Email
  // column" error for a file that was never an Excel workbook at all.
  const isXlsx =
    buffer.length > 4 &&
    buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
  const isXls =
    buffer.length > 8 &&
    buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0 &&
    buffer[4] === 0xa1 && buffer[5] === 0xb1 && buffer[6] === 0x1a && buffer[7] === 0xe1;
  if (!isXlsx && !isXls) {
    throw candidateListError(CANDIDATE_LIST_MESSAGES.UNREADABLE);
  }

  let sheet;
  try {
    const workbook = XLSX.read(buffer, { type: "buffer" });
    sheet = workbook.Sheets[workbook.SheetNames[0]];
  } catch {
    throw candidateListError(CANDIDATE_LIST_MESSAGES.UNREADABLE);
  }
  if (!sheet || !sheet["!ref"]) {
    throw candidateListError(CANDIDATE_LIST_MESSAGES.UNREADABLE);
  }

  // Cheap dimension pre-check: reject obviously over-limit sheets before
  // materializing rows (a small file can still declare a huge used range).
  const range = XLSX.utils.decode_range(sheet["!ref"]);
  if (range.e.r - range.s.r > MAX_CANDIDATES + 1000) {
    throw candidateListError(CANDIDATE_LIST_MESSAGES.LIMIT);
  }

  const rows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: false,
    defval: null,
    blankrows: false,
  });
  if (rows.length === 0) {
    throw candidateListError(CANDIDATE_LIST_MESSAGES.UNREADABLE);
  }

  const headerRow = (rows[0] ?? []).map(normalizeHeaderCell);
  const emailColumn = headerRow.findIndex((header) => EMAIL_HEADERS.has(header));
  if (emailColumn === -1) {
    throw candidateListError(CANDIDATE_LIST_MESSAGES.EMAIL_COLUMN);
  }

  // Fully-empty rows are padding, not candidates; every other row is one.
  const candidateRows = rows
    .slice(1)
    .filter((row) => (row ?? []).some((cell) => String(cell ?? "").trim() !== ""));
  if (candidateRows.length > MAX_CANDIDATES) {
    throw candidateListError(CANDIDATE_LIST_MESSAGES.LIMIT);
  }
  if (candidateRows.length === 0) {
    throw candidateListError(CANDIDATE_LIST_MESSAGES.EMPTY);
  }

  const seen = new Set();
  let invalidEmail = false;
  let duplicateEmail = null;
  for (const row of candidateRows) {
    const email = String(row[emailColumn] ?? "").trim();
    if (!EMAIL_PATTERN.test(email)) {
      invalidEmail = true;
      continue;
    }
    const key = email.toLowerCase();
    if (seen.has(key)) {
      duplicateEmail = duplicateEmail ?? email;
    }
    seen.add(key);
  }

  if (invalidEmail) {
    throw candidateListError(CANDIDATE_LIST_MESSAGES.EMAIL_INVALID);
  }
  if (duplicateEmail) {
    throw candidateListError(
      `${CANDIDATE_LIST_MESSAGES.DUPLICATE} (for example: ${duplicateEmail})`
    );
  }

  // Count is always authoritative; the caller asked for rows only for preview.
  const result = { candidateCount: candidateRows.length };
  if (rowLimit && rowLimit > 0) {
    const take = Math.min(candidateRows.length, rowLimit);
    // nameColumn: the default (undefined) keeps the shipped preview contract —
    // the first column is the name. The candidate-workflow read passes
    // "header" and resolves the Name column BY HEADER instead, falling back to
    // the first column when the sheet has no Name header.
    const headerAware = options.nameColumn === "header";
    // Phase 7 (Step 2) — the whitelisted reference columns are resolved BY
    // HEADER once per sheet and only when the caller explicitly asks for
    // reference rows, so the existing preview/workflow shapes stay unchanged.
    const referenceColumnsAware = headerAware && options.referenceColumns === true;
    const referenceColumns = referenceColumnsAware ? resolveReferenceColumns(headerRow) : null;
    const nameColumnIndex = headerAware
      ? Math.max(
          0,
          headerRow.findIndex((header) => NAME_HEADERS.has(header))
        )
      : 0;
    result.rows = candidateRows
      .slice(0, take)
      .map((row, index) => ({
        // Position within the stored candidate list: the stable per-row
        // identity the recruiter workflow addresses (rows are never reordered).
        // Part of the workflow shape only — the preview shape is unchanged.
        ...(headerAware ? { rowIndex: index } : {}),
        name: String(row[nameColumnIndex] ?? "").trim() || undefined,
        email: String(row[emailColumn] ?? "").trim(),
        ...(referenceColumnsAware ? buildReferenceFields(row, referenceColumns) : {}),
      }))
      .filter((row) => row.email);
  }
  return result;
};

// Full-file validation used at upload time (in-memory multer buffer). Public
// contract unchanged: returns { candidateCount } and throws on any rule
// violation. Preserved verbatim as a thin wrapper over the shared core so
// existing callers (upload path + Start gate) need no changes.
const parseCandidateListBuffer = (buffer) => {
  return parseCandidateListCore(buffer, null);
};

// Compact preview of an in-memory buffer: candidateCount + first N candidate
// rows (name + email only). Used for the small on-card preview so a
// 1,000-row sheet is never fully rendered into a response.
const parseCandidateListPreview = (buffer, limit = 5) => {
  return parseCandidateListCore(buffer, Math.max(1, Math.floor(limit)));
};

// Header-aware candidate rows for the recruiter candidate workflow: the Name
// column is resolved BY HEADER (falling back to the first column when the
// sheet has no Name header, exactly like the preview contract). Only the two
// recruiter-provided candidate fields the current Excel contract carries —
// name and email — are ever read; every other column stays ignored, so no new
// Excel column is introduced. rowIndex is the row's position in the stored
// list and is the stable per-candidate identity for this job.
const parseCandidateListRows = (buffer, limit = MAX_CANDIDATES) => {
  return parseCandidateListCore(buffer, Math.max(1, Math.floor(limit)), {
    nameColumn: "header",
  });
};

// Read-only header-aware read of the STORED candidate list, mirroring
// previewStoredCandidateList: the file was already validated at upload time,
// and an unreadable/missing file surfaces as the same recruiter-facing error.
const readStoredCandidateListRows = async (storedFile, limit = MAX_CANDIDATES) => {
  let buffer;
  try {
    buffer = await fs.readFile(absolutePathFor(storedFile.storagePath));
  } catch {
    throw candidateListError(CANDIDATE_LIST_MESSAGES.UNREADABLE);
  }
  return parseCandidateListRows(buffer, limit);
};

// Phase 7 (Step 2) — whitelist-only reference rows from an in-memory buffer.
//
// Returns { candidateCount, rows } where every row is
// { email, name, linkedinUrl, linkedinText, githubUrl, githubText,
//   preferredRole, skills, skillNotes }. The Excel rowIndex is deliberately NOT
// part of this shape: a candidate reference is identified by its own
// JobCandidateReference.id, never by a spreadsheet position (rows can move when
// the sheet is replaced).
const parseCandidateListReferenceRows = (buffer, limit = MAX_CANDIDATES) => {
  const parsed = parseCandidateListCore(buffer, Math.max(1, Math.floor(limit)), {
    nameColumn: "header",
    referenceColumns: true,
  });
  return {
    candidateCount: parsed.candidateCount,
    rows: (parsed.rows ?? []).map((row) => ({
      email: row.email,
      name: row.name ?? null,
      linkedinUrl: row.linkedinUrl ?? null,
      linkedinText: row.linkedinText ?? null,
      githubUrl: row.githubUrl ?? null,
      githubText: row.githubText ?? null,
      preferredRole: row.preferredRole ?? null,
      skills: row.skills ?? null,
      skillNotes: row.skillNotes ?? null,
    })),
  };
};

// Read-only reference rows from the STORED candidate list: the seeding source
// at import/replace time and the upgrade-safe backfill on the reference read
// path. Same disk-read safety and same recruiter-facing error as the other
// stored-list readers.
const readStoredCandidateReferenceRows = async (storedFile, limit = MAX_CANDIDATES) => {
  let buffer;
  try {
    buffer = await fs.readFile(absolutePathFor(storedFile.storagePath));
  } catch {
    throw candidateListError(CANDIDATE_LIST_MESSAGES.UNREADABLE);
  }
  return parseCandidateListReferenceRows(buffer, limit);
};

// Read-only compact preview of the STORED candidate list. Mirrors
// validateStoredCandidateList's disk read (same path-traversal safety via
// absolutePathFor) but returns the preview shape instead of re-asserting
// validity — the file was already validated when it was uploaded.
const previewStoredCandidateList = async (storedFile, limit = 5) => {
  let buffer;
  try {
    buffer = await fs.readFile(absolutePathFor(storedFile.storagePath));
  } catch {
    throw candidateListError(CANDIDATE_LIST_MESSAGES.UNREADABLE);
  }
  return parseCandidateListPreview(buffer, limit);
};


// Start-time validation: re-read the STORED file from disk and re-apply every
// rule above. A missing/unreadable stored file is a validation failure, not a
// crash — the recruiter gets the same recruiter-facing error and can re-upload.
const validateStoredCandidateList = async (storedFile) => {
  let buffer;
  try {
    buffer = await fs.readFile(absolutePathFor(storedFile.storagePath));
  } catch {
    throw candidateListError(CANDIDATE_LIST_MESSAGES.UNREADABLE);
  }
  return parseCandidateListBuffer(buffer);
};

module.exports = {
  MAX_CANDIDATES,
  CANDIDATE_LIST_MESSAGES,
  assertCandidateListUpload,
  candidateListError,
  parseCandidateListBuffer,
  parseCandidateListPreview,
  parseCandidateListRows,
  validateStoredCandidateList,
  previewStoredCandidateList,
  readStoredCandidateListRows,
  // Phase 7 (Step 2) — candidate-reference seeding rows (strict whitelist).
  parseCandidateListReferenceRows,
  readStoredCandidateReferenceRows,
};
