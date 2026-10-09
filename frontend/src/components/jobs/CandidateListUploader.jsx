import Button from "../ui/Button";
import Spinner from "../ui/Spinner";
import { PlusIcon, TrashIcon, EyeIcon } from "../ui/icons";
import { JOB_FORM_LIMITS } from "../../constants/jobForm";

const { MAX_CANDIDATES } = JOB_FORM_LIMITS;

// Compact recruiter-facing card for the job's Candidate Excel Sheet. Shows the
// file name, total candidate count and a small first-few-rows preview (loaded
// via the parent's GET /job/:jobId/candidate-list endpoint). The full list is
// viewed in a separate modal; this card never renders the entire sheet.
//
// Upload/replace/delete are free draft actions (the backend enforces this;
// Start readiness simply mirrors the rule). Ownership is checked server-side
// through the job ownership checks in the route — never through file ownership.
const CandidateListUploader = ({
  candidateList,
  preview,
  previewLoading,
  uploading,
  onUpload,
  onView,
  onDelete,
  onPreviewRefresh,
}) => {
  const file = candidateList?.file ?? null;

  const pickFile = (event) => {
    const [selected] = event.target.files ?? [];
    if (selected) onUpload(selected);
    event.target.value = "";
  };

  const previewRows = preview?.rows ?? [];
  const showPreview = file && previewRows.length > 0 && !previewLoading;

  return (
    <div className="space-y-4">
      <div className="space-y-1 text-sm text-slate-600">
        <p>Upload Excel file containing candidates.</p>
        <p>
          <span className="font-semibold text-slate-800">
            Maximum {MAX_CANDIDATES.toLocaleString()} candidates per job.
          </span>{" "}
          Each email address must belong to only one candidate.
        </p>
      </div>

      {file ? (
        <div className="space-y-3">
          {/* Header: file name + count + action row */}
          <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-emerald-900">
                {file.originalName}
              </p>
              <p className="mt-0.5 text-xs text-emerald-700">
                {candidateList.candidateCount === 1
                  ? "1 candidate"
                  : `${candidateList.candidateCount} candidates`}
              </p>
            </div>
            <div className="flex flex-none items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onView}
                disabled={previewLoading || uploading}
                aria-label="View candidate list"
              >
                <EyeIcon className="h-3.5 w-3.5" />
                View
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onDelete}
                disabled={uploading}
                aria-label="Remove candidate list"
              >
                <TrashIcon className="h-3.5 w-3.5" />
                Delete
              </Button>
              <label className="cursor-pointer">
                <input
                  type="file"
                  accept=".xlsx,.xls"
                  className="sr-only"
                  disabled={uploading}
                  onChange={pickFile}
                />
                <span className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50">
                  {uploading ? (
                    <Spinner className="h-3.5 w-3.5" />
                  ) : (
                    <PlusIcon className="h-3.5 w-3.5" />
                  )}
                  Replace
                </span>
              </label>
            </div>
          </div>
          {/* Compact preview: file name + first few rows */}
          {showPreview && (
            <div className="rounded-xl border border-slate-200 bg-white">
              <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Preview
                </p>
                <p className="text-xs text-slate-500">
                  {previewRows.length === candidateList?.candidateCount
                    ? `${candidateList.candidateCount} candidates shown`
                    : `Showing first ${previewRows.length} of ${candidateList?.candidateCount} candidates`}
                </p>
              </div>
              <div className="overflow-auto">
                <table className="min-w-full divide-y divide-slate-200">
                  <thead className="bg-slate-50">
                    <tr>
                      <th
                        scope="col"
                        className="sticky top-0 border-b border-slate-200 bg-slate-50 px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-600"
                      >
                        Name
                      </th>
                      <th
                        scope="col"
                        className="sticky top-0 border-b border-slate-200 bg-slate-50 px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-600"
                      >
                        Email
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white">
                    {previewRows.map((row, index) => (
                      <tr key={index} className="hover:bg-slate-50">
                        <td className="px-4 py-2 text-sm text-slate-800">
                          {row.name ?? "—"}
                        </td>
                        <td className="px-4 py-2 text-sm text-slate-700">
                          {row.email}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {candidateList?.candidateCount != null &&
                previewRows.length < candidateList.candidateCount && (
                  <p className="px-4 py-2 text-xs text-slate-500">
                    Showing first {previewRows.length} candidates — open View for
                    the full list.
                  </p>
                )}
            </div>
          )}

          {/* Loading state for the preview */}
          {!showPreview && previewLoading && (
            <div className="flex items-center justify-center rounded-xl border border-slate-200 bg-white py-6">
              <Spinner className="h-5 w-5 text-slate-400" />
              <span className="ml-2 text-sm text-slate-500">Loading preview…</span>
            </div>
          )}
        </div>
      ) : (
        <label className="flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 p-6 text-center transition-colors hover:border-indigo-300 hover:bg-indigo-50/40">
          <input
            type="file"
            accept=".xlsx,.xls"
            className="sr-only"
            disabled={uploading}
            onChange={pickFile}
          />
          {uploading ? (
            <span className="flex items-center gap-2 text-sm text-slate-600">
              <Spinner className="h-4 w-4" /> Uploading…
            </span>
          ) : (
            <>
              <span className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white">
                <PlusIcon className="h-4 w-4" />
                Choose Excel file
              </span>
              <span className="mt-2 text-xs text-slate-500">.xlsx or .xls</span>
            </>
          )}
        </label>
      )}
    </div>
  );
};

export default CandidateListUploader;
