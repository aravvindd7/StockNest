import { Link } from "react-router-dom";

export default function Unauthorized() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-[#F5F7FA] px-4 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-out/10 text-out">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-8 w-8">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 10-8 0v2" />
        </svg>
      </div>
      <h1 className="font-display text-xl font-bold text-[#1B2338]">Unauthorized Access</h1>
      <p className="max-w-sm text-sm text-gray-500">You do not have permission to access this page.</p>
      <Link to="/dashboard" className="sn-btn-primary mt-2">
        Back to Dashboard
      </Link>
    </div>
  );
}
