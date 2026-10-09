import { AnimatePresence, motion } from "framer-motion";
import Button from "./Button";

const ConfirmDialog = ({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  variant = "primary",
  onConfirm,
  onClose,
}) => (
  <AnimatePresence>
    {open && (
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
          className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-xl"
          onClick={(event) => event.stopPropagation()}
        >
          <h2 className="font-display text-lg font-semibold text-slate-900">
            {title}
          </h2>
          <p className="mt-2 text-sm text-slate-600">{description}</p>

          <div className="mt-6 flex justify-end gap-3">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              {cancelLabel}
            </Button>
            {onConfirm && (
              <Button
                type="button"
                variant={variant}
                size="sm"
                onClick={onConfirm}
              >
                {confirmLabel}
              </Button>
            )}
          </div>
        </motion.div>
      </motion.div>
    )}
  </AnimatePresence>
);

export default ConfirmDialog;
