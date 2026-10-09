import Button from "../components/ui/Button";

const NotFound = () => (
  <div className="flex min-h-screen flex-col items-center justify-center px-4 text-center">
    <p className="text-sm font-semibold text-indigo-600">404</p>
    <h1 className="mt-2 text-3xl font-bold text-slate-900">Page not found</h1>
    <p className="mt-2 text-slate-600">
      The page you&apos;re looking for doesn&apos;t exist.
    </p>
    <Button as="link" to="/" className="mt-6">
      Back to Home
    </Button>
  </div>
);

export default NotFound;
