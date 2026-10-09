// Extracts a user-facing message from a failed apiClient call. Backend
// error responses always look like { success: false, message }, but a
// network failure (server unreachable, CORS, timeout) never gets a
// response at all, and must be handled separately.
export const extractApiErrorMessage = (
  error,
  fallback = "Something went wrong. Please try again."
) => {
  if (error.response?.data?.message) {
    return error.response.data.message;
  }

  if (error.request) {
    return "Unable to reach the server. Please check your connection and try again.";
  }

  return fallback;
};
