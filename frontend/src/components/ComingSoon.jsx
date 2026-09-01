export default function ComingSoon({ title, step }) {
  return (
    <div className="sn-card flex flex-col items-center gap-3 p-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-6 w-6">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      </div>
      <h2 className="font-display text-lg font-bold">{title}</h2>
      <p className="max-w-sm text-sm text-gray-500">
        This module is built in {step} of the development plan. The auth shell and routing you're
        looking at right now already enforce access to this page correctly.
      </p>
    </div>
  );
}
