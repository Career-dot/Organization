import { Outlet } from "react-router-dom";
import PublicNavbar from "./PublicNavbar";
import PublicFooter from "./PublicFooter";

const PublicLayout = () => (
  <div className="flex min-h-screen flex-col">
    <PublicNavbar />
    <main className="flex-1">
      <Outlet />
    </main>
    <PublicFooter />
  </div>
);

export default PublicLayout;
