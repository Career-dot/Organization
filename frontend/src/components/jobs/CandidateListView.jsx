import { AnimatePresence, motion } from "framer-motion";
import { MailIcon } from "../ui/icons";
import Spinner from "../ui/Spinner";

// Read-only view of the job's uploaded candidate list. Shows the file name,
// total candidate count and a full Name/Email table (the file was already
// validated at upload, so no re-parsing rules are applied here — the backend's
// preview endpoint already caps the returned rows for the compact card; this
// modal is the full view the recruiter opens from that card).
const CandidateListView = ({
  open,
  loading,
  fileName,
  candidateCount,
  rows,
  error,
  onClose,
}) => {
  if (!open) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4"
        onClick={onClose}
      >
        <motion.div
          initial={{ opacity: 0, y: 12, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 12, scale: 0.98 }}
          transition={{ duration: 0.2 }}
          role="dialog"
          aria-modal="true"
          className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl border border-slate-200 bg-white p-6 shadow-xl"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="font-display text-lg font-semibold text-slate-900">
                Candidate list
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                {fileName ? (
                  <>
                    <span className="font-medium text-slate-800">{fileName}</span>
                    {" · "}
                    {candidateCount === 1 ? "1 candidate" : `${candidateCount} candidates`}
                  </>
                ) : (
                  "No candidate list uploaded"
                )}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-700"
              aria-label="Close"
            >
              <svg
                className="h-5 w-5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="mt-5 min-h-[12rem] flex-1 overflow-hidden">
            {loading && (
              <div className="flex items-center justify-center py-10">
                <Spinner className="h-5 w-5 text-slate-400" />
              </div>
            )}

            {error && (
              <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
                {error}
              </div>
            )}

            {!loading && !error && rows && rows.length > 0 && (
              <div className="max-h-[60vh] overflow-auto rounded-xl border border-slate-200">
                <table className="min-w-full divide-y divide-slate-200">
                  <thead className="bg-slate-50">
                    <tr>
                      <th
                        scope="col"
                        className="sticky top-0 border-b border-slate-200 bg-slate-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-600"
                      >
                        Name
                      </th>
                      <th
                        scope="col"
                        className="sticky top-0 border-b border-slate-200 bg-slate-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-600"
                      >
                        Email
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white">
                    {rows.map(
                      (row, index) => (
                        <tr key={index}>
                          <td className="px-4 py-3 text-sm text-slate-800">
                            {row.name ?? "—"}
                          </td>
                          <td className="px-4 py-3 text-sm text-slate-700">
                            <span className="inline-flex items-center gap-1.5">
                              {row.email ? (
                                <>
                                  <MailIcon className="h-4 w-4 text-slate-400" />
                                  {row.email}
                                </>
                              ) : (
                                <span className="text-slate-400">—</span>
                              )}
                            </span>
                          </td>
                        </tr>
                      )
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {!loading && !error && (!rows || rows.length === 0) && (
              <p className="py-10 text-center text-sm text-slate-500">
                No candidates to show.
              </p>
            )}
          </div>

          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
            >
              Close
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
};

export default CandidateListView;
