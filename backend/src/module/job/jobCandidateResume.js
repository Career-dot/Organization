const path = require("path");

// ---------------------------------------------------------------------------
// Phase 7 (Step 2) — candidate resume rules (PDF / TXT only) + text extraction.
//
// The BACKEND independently enforces the format: the extension AND the content
// signature are checked here, so a renamed executable/script, a DOCX or an
// image can never reach the storage layer through the resume route — the
// frontend `accept=".pdf,.txt"` filter is convenience only, never a boundary.
// Size (10 MB) and the generic MIME allow-list stay owned by storage.service;
// this module adds the resume-specific narrowing only.
//
// Extraction is deliberately modest for v1: no OCR, no scraping, no URL
// fetching, no network calls of any kind. A scanned/image-only PDF keeps its
// stored file, gets resumeText = null, and is reported as unavailable later —
// extraction never crashes the candidate-reference operation and never claims
// that a resume was analyzed.
// ---------------------------------------------------------------------------

const RESUME_MIME_BY_EXTENSION = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
};

const RESUME_MESSAGES = {
  REQUIRED: "A resume file is required",
  FILE_TYPE: "Resume must be a PDF (.pdf) or plain text (.txt) file",
  TEXT_BINARY: "This file does not look like readable text. Upload a PDF or a plain-text resume",
};

// Stored text cap for v1. Generous for a 1–3 page resume (the later analysis
// stage applies its own, stricter payload truncation).
const MAX_RESUME_TEXT_LENGTH = 20000;

// Mirrors the existing evidence-extraction quality bar: a PDF that yields less
// than this is treated as scanned/unextractable rather than as real content.
const MIN_PDF_TEXT_LENGTH = 80;

const resumeError = (message, status = 400) => Object.assign(new Error(message), { status });

// Content signatures that must never pass as a resume, whatever the extension
// claims (executables, scripts via shebang, archives/DOCX which are ZIPs, a
// PDF renamed to .txt).
const BINARY_SIGNATURES = [
  [0x4d, 0x5a], // MZ — Windows executable
  [0x7f, 0x45, 0x4c, 0x46], // \x7fELF — Linux executable
  [0xca, 0xfe, 0xba, 0xbe], // Java class
  [0x50, 0x4b, 0x03, 0x04], // PK\x03\x04 — ZIP / DOCX / XLSX
  [0x25, 0x50, 0x44, 0x46], // %PDF — a PDF that is not named .pdf
];

const assertPlainTextResume = (buffer) => {
  for (const signature of BINARY_SIGNATURES) {
    if (
      buffer.length >= signature.length &&
      signature.every((byte, index) => buffer[index] === byte)
    ) {
      throw resumeError(RESUME_MESSAGES.TEXT_BINARY, 415);
    }
  }
  if (buffer.includes(0x00)) {
    // NUL bytes never occur in a genuine text resume.
    throw resumeError(RESUME_MESSAGES.TEXT_BINARY, 415);
  }
  if (buffer.subarray(0, 2).toString("latin1") === "#!") {
    // A shebang line is a script, not a resume.
    throw resumeError(RESUME_MESSAGES.FILE_TYPE, 415);
  }
};

// Resume-specific upload boundary, run BEFORE any persistence. It normalizes
// the mimetype from the verified extension (so the generic storage validation
// sees the same value the browser cannot fake) and throws 415/400 otherwise.
const assertResumeUpload = (file) => {
  if (!file || !file.buffer) {
    throw resumeError(RESUME_MESSAGES.REQUIRED, 400);
  }
  const extension = path.extname(file.originalname || "").toLowerCase();
  const mimeType = RESUME_MIME_BY_EXTENSION[extension];
  if (!mimeType) {
    throw resumeError(RESUME_MESSAGES.FILE_TYPE, 415);
  }
  if (extension === ".pdf") {
    if (file.buffer.subarray(0, 5).toString("latin1") !== "%PDF-") {
      throw resumeError(RESUME_MESSAGES.FILE_TYPE, 415);
    }
  } else {
    assertPlainTextResume(file.buffer);
  }
  file.mimetype = mimeType;
  return file;
};

// Whitespace/control normalization shared by both formats: CRLF → LF, control
// characters removed (newlines and tabs kept), trailing whitespace and 3+ blank
// lines collapsed, BOM stripped by the caller, then the stored cap applied.
const normalizeExtractedText = (value) =>
  String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_RESUME_TEXT_LENGTH);

// Raw PDF object syntax leaking through means the text layer is not usable as
// human-readable content (same artifact test as the evidence extractor).
const PDF_ARTIFACT_PATTERN = /%PDF-|\/Type\s*\/|\bendobj\b|\/Filter\s*\/|stream\r?\n|BT\s+.*ET/i;

const extractPdfText = async (buffer) => {
  // Reuses the SAME `pdf-parse` infrastructure (and both of its call shapes)
  // that the existing evidence service already relies on.
  const pdfModule = require("pdf-parse");
  let rawText = "";

  if (typeof pdfModule === "function") {
    const pdfData = await pdfModule(buffer);
    rawText = pdfData?.text || "";
  } else if (pdfModule?.PDFParse) {
    const parser = new pdfModule.PDFParse({ data: buffer });
    const result = await parser.getText();
    rawText = typeof result === "string" ? result : result?.text || "";
    if (typeof parser.destroy === "function") {
      await parser.destroy();
    }
  }

  const text = normalizeExtractedText(rawText);
  if (text.length < MIN_PDF_TEXT_LENGTH) {
    return null;
  }
  if (PDF_ARTIFACT_PATTERN.test(text.slice(0, 500))) {
    return null;
  }
  return text;
};

// Returns { text, status } — status is EXTRACTED or UNAVAILABLE only. An
// image-only/scanned PDF, an empty file or any internal extraction failure
// yields { text: null, status: "UNAVAILABLE" }: the ORIGINAL file is preserved
// and `resumeFileId` + the file metadata remain, so later analysis can report
// the resume evidence as unavailable instead of pretending it was read.
const extractResumeText = async ({ buffer, mimeType }) => {
  try {
    if (mimeType === "application/pdf") {
      const text = await extractPdfText(buffer);
      return { text, status: text ? "EXTRACTED" : "UNAVAILABLE" };
    }
    if (mimeType === "text/plain") {
      const text = normalizeExtractedText(buffer.toString("utf8").replace(/^\uFEFF/, ""));
      return { text: text || null, status: text ? "EXTRACTED" : "UNAVAILABLE" };
    }
    return { text: null, status: "UNAVAILABLE" };
  } catch (error) {
    console.error(`[job] resume text extraction failed: ${error.message}`);
    return { text: null, status: "UNAVAILABLE" };
  }
};

module.exports = {
  RESUME_MIME_BY_EXTENSION,
  RESUME_MESSAGES,
  MAX_RESUME_TEXT_LENGTH,
  MIN_PDF_TEXT_LENGTH,
  resumeError,
  assertResumeUpload,
  extractResumeText,
};
