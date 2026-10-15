import { useCallback, useRef, useState } from "react";
import { newIdempotencyKey } from "../../services/distributionService";

/**
 * Shared building blocks for Distribution Master — formatting, badges, the
 * slide-in drawer shell (same overlay + panel pattern as Planning's drawers),
 * API error presentation and a submission hook. Kept in one place so every
 * Distribution view behaves identically.
 */

// ─── Formatting ──────────────────────────────────────────────────────────────

export const num = (n) => (n === null || n === undefined || n === "" ? "—" : Number(n).toLocaleString("en-IN"));

export const dateTime = (d) =>
  d ? new Date(d).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

const FY_MONTHS = ["April", "May", "June", "July", "August", "September", "October", "November", "December", "January", "February", "March"];
const SHORT = (m) => m.slice(0, 3);

/** { financialYear: "2026-27", startMonth: "October", horizonMonths: 3 } → "Oct – Dec 2026 · FY 2026-27" */
export function forecastPeriodLabel(fp) {
  if (!fp?.financialYear || !fp.startMonth) return "—";
  const fyStart = parseInt(fp.financialYear.slice(0, 4), 10);
  const startIdx = FY_MONTHS.indexOf(fp.startMonth);
  if (startIdx < 0 || Number.isNaN(fyStart)) return `${fp.startMonth} ${fp.financialYear}`;
  const calYear = (idx) => fyStart + Math.floor(idx / 12) + (idx % 12 >= 9 ? 1 : 0);
  const endIdx = startIdx + Math.max(1, fp.horizonMonths || 1) - 1;
  const start = `${SHORT(FY_MONTHS[startIdx % 12])} ${calYear(startIdx)}`;
  const end = `${SHORT(FY_MONTHS[endIdx % 12])} ${calYear(endIdx)}`;
  return `${start === end ? start : `${start} – ${end}`} · FY ${fp.financialYear}`;
}

// ─── Badges ──────────────────────────────────────────────────────────────────

const PRIORITY_STYLE = {
  CRITICAL: "bg-out/10 text-out",
  HIGH: "bg-low/15 text-[#B45309]",
  MEDIUM: "bg-primary/10 text-primary",
  LOW: "bg-gray-100 text-gray-500",
};

export function PriorityBadge({ priority }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-wide ${PRIORITY_STYLE[priority] || "bg-gray-100 text-gray-500"}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {priority}
    </span>
  );
}

const STATUS_STYLE = {
  // recommendation
  PENDING: "border-primary/30 text-primary bg-primary/5",
  SUPERSEDED: "border-gray-200 text-gray-400 bg-gray-50",
  REJECTED: "border-gray-300 text-gray-500 bg-gray-50",
  // shared / transfer
  APPROVED: "border-healthy/30 text-healthy bg-healthy/5",
  REQUESTED: "border-gray-300 text-[#3B4666] bg-white",
  DISPATCHED: "border-low/40 text-[#B45309] bg-low/10",
  IN_TRANSIT: "border-accent/40 text-[#0369A1] bg-accent/10",
  RECEIVED: "border-healthy/40 text-white bg-healthy",
  CANCELLED: "border-gray-200 text-gray-400 bg-gray-50 line-through",
};

export const statusLabel = (s) => (s === "IN_TRANSIT" ? "IN TRANSIT" : s);

export function StatusBadge({ status }) {
  return (
    <span className={`inline-flex items-center rounded border px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-wide ${STATUS_STYLE[status] || "border-gray-200 text-gray-500"}`}>
      {statusLabel(status)}
    </span>
  );
}

// ─── Session-scoped UI preferences ───────────────────────────────────────────

/** sessionStorage keys — only the Recommendations / Transfers primary filter selection, never data. */
export const PRIMARY_FILTER_KEYS = {
  recommendations: "distribution.recommendations.primaryFilter",
  transfers: "distribution.transfers.primaryFilter",
};

/** Stored value if it is one of `validValues`; otherwise (missing, obsolete, storage unavailable) `fallback`. */
export function readSessionPreference(key, validValues, fallback) {
  try {
    const value = window.sessionStorage.getItem(key);
    return value !== null && validValues.includes(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

/** Saves one preference value; silently ignored if sessionStorage is unavailable. */
export function writeSessionPreference(key, value) {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    /* storage unavailable (e.g. private mode quota) — the preference just isn't remembered */
  }
}

// ─── Layout pieces ───────────────────────────────────────────────────────────

export function TabButton({ active, onClick, children, count }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 rounded-md px-4 py-1.5 text-sm font-semibold transition ${
        active ? "bg-white text-primary shadow-sm" : "text-gray-500 hover:text-gray-700"
      }`}
    >
      {children}
      {count !== undefined && count !== null && (
        <span className={`rounded-full px-1.5 text-[11px] ${active ? "bg-primary/10" : "bg-gray-200 text-gray-600"}`}>{num(count)}</span>
      )}
    </button>
  );
}

/** Slide-in drawer — same overlay/panel pattern as PlanDetailsDrawer, wider for operational detail. */
export function Drawer({ open, onClose, title, subtitle, badge, children, footer, width = "max-w-2xl" }) {
  return (
    <>
      <div className={`fixed inset-0 z-40 bg-black/30 transition-opacity ${open ? "opacity-100" : "pointer-events-none opacity-0"}`} onClick={onClose} />
      <div
        className={`fixed right-0 top-0 z-50 flex h-full w-full ${width} transform flex-col bg-white shadow-2xl transition-transform duration-300 ${open ? "translate-x-0" : "translate-x-full"}`}
        role="dialog"
        aria-modal="true"
      >
        {open && (
          <>
            <div className="flex items-center justify-between gap-3 border-b border-gray-200 px-6 py-4">
              <div className="min-w-0">
                <h3 className="truncate font-display text-base font-bold">{title}</h3>
                {subtitle && <p className="truncate text-xs text-gray-500">{subtitle}</p>}
              </div>
              <div className="flex shrink-0 items-center gap-3">
                {badge}
                <button onClick={onClose} className="text-gray-400 hover:text-gray-600" aria-label="Close">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
            {footer && <div className="border-t border-gray-200 bg-gray-50 px-6 py-3">{footer}</div>}
          </>
        )}
      </div>
    </>
  );
}

/**
 * Identity display: the human name is the primary value (semibold, high
 * contrast); the internal ID is a smaller, muted, monospace secondary line —
 * kept visible for operational/audit reference. Falls back to the ID alone
 * when no name is known. Presentation only — IDs and data are untouched.
 */
function Identity({ name, id, align = "left", size = "md", maxWidth }) {
  if (!name) return <span className="font-mono font-semibold text-[#1B2338]">{id}</span>;
  const nameSize = size === "lg" ? "text-[15px] font-bold" : "text-[13px] font-semibold";
  return (
    <span className={`inline-flex min-w-0 flex-col leading-tight ${align === "right" ? "items-end text-right" : ""}`}>
      <span className={`${nameSize} text-[#1B2338] ${maxWidth ? "block truncate" : ""}`} style={maxWidth ? { maxWidth } : undefined} title={name}>
        {name}
      </span>
      <span className="font-mono text-[11px] font-normal text-gray-500">{id}</span>
    </span>
  );
}

/** Depot: centre name primary, depot ID secondary. */
export function DepotIdentity({ depotId, depotName, align, size }) {
  return <Identity name={depotName} id={depotId} align={align} size={size} />;
}

/** Material: material name primary, material number secondary. */
export function MaterialIdentity({ materialNo, materialName, align, size, maxWidth }) {
  return <Identity name={materialName} id={materialNo} align={align} size={size} maxWidth={maxWidth} />;
}

/** Compact direction marker between a source and a destination. */
export function ToSeparator() {
  return <span className="inline-block rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-gray-500">to</span>;
}

/** Table column that sits between Source and Destination, so the row reads "Chennai TO Coimbatore". */
export const TO_COLUMN = { key: "_to", label: "", sortable: false, className: "text-center", render: () => <ToSeparator /> };

/** Drawer layout: SOURCE · TO · DESTINATION side by side (stacked on narrow screens). */
export function RouteSections({ source, destination }) {
  return (
    <div className="grid items-start gap-4 md:grid-cols-[1fr_auto_1fr]">
      <div>
        <SectionTitle>Source</SectionTitle>
        {source}
      </div>
      <div className="flex items-center justify-center md:self-center md:pt-6">
        <ToSeparator />
      </div>
      <div>
        <SectionTitle>Destination</SectionTitle>
        {destination}
      </div>
    </div>
  );
}

/** "Chennai" (name) or the ID when no name is known — for plain-text places such as drawer subtitles. */
export const nameOr = (map, id) => (map?.[id] ? map[id] : id);

export function SectionTitle({ children, aside }) {
  return (
    <div className="mb-2 mt-5 flex items-center justify-between first:mt-0">
      <h4 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{children}</h4>
      {aside}
    </div>
  );
}

/** Label/value rows inside a bordered box (same as Planning's IntelRow). */
export function KV({ rows }) {
  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 text-sm">
      {rows.filter(Boolean).map(([label, value, cls]) => (
        <div key={label} className="flex items-center justify-between gap-4 border-b border-gray-100 px-4 py-2 last:border-b-0">
          <span className="text-gray-500">{label}</span>
          <span className={`text-right font-semibold ${cls || "text-[#1B2338]"}`}>{value}</span>
        </div>
      ))}
    </div>
  );
}

export function StatTile({ label, value, hint, tone, onClick }) {
  const toneClass = { warn: "text-out", good: "text-healthy", info: "text-primary", amber: "text-[#B45309]" }[tone] || "text-[#1B2338]";
  const Tag = onClick ? "button" : "div";
  return (
    <Tag onClick={onClick} className={`sn-card px-4 py-3 text-left ${onClick ? "transition hover:border-primary" : ""}`}>
      <div className="text-[10.5px] font-semibold uppercase tracking-wide text-gray-500">{label}</div>
      <div className={`mt-0.5 font-display text-2xl font-bold ${toneClass}`}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-gray-400">{hint}</div>}
    </Tag>
  );
}

export function Field({ label, required, hint, children }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
        {label} {required && <span className="text-out">*</span>}
      </span>
      {children}
      {hint && <span className="text-xs text-gray-400">{hint}</span>}
    </label>
  );
}

// ─── Errors ──────────────────────────────────────────────────────────────────

/** Turns an Axios error from a Distribution endpoint into { title, message, details[], status, code }. */
export function describeError(err, fallback = "The request could not be completed.") {
  const res = err?.response;
  if (!res) {
    return { title: "Cannot reach the server", message: "StockNest did not respond. Check that the backend is running, then retry — retrying the same action is safe.", details: [], status: 0 };
  }
  const body = res.data || {};
  const details = [...(Array.isArray(body.errors) ? body.errors : [])];
  const cur = body.details?.current;
  if (cur) {
    details.push(`Live figures now: stock in hand ${num(cur.stockInHand)} · open commitments ${num(cur.openCommitments)} · available ${num(cur.available)}.`);
  }
  if (body.details?.stockInHand !== undefined && body.details?.requested !== undefined) {
    details.push(`Stock in hand ${num(body.details.stockInHand)} · requested ${num(body.details.requested)}.`);
  }
  if (Array.isArray(body.details?.problems)) details.push(...body.details.problems);
  const titles = {
    400: "Invalid request",
    401: "Session expired",
    403: "Not permitted",
    404: "Not found",
    409: "Conflict — the data has changed",
    422: "Cannot be applied",
    503: "Temporarily unavailable",
  };
  const messages = {
    401: "Your session has ended. Please sign in again.",
    403: "Distribution Master is restricted to administrators.",
  };
  return {
    status: res.status,
    code: body.code,
    title: titles[res.status] || "Server error",
    message: messages[res.status] || body.message || fallback,
    details,
  };
}

export function ErrorBanner({ error, onRetry, onDismiss }) {
  if (!error) return null;
  const conflict = error.status === 409;
  return (
    <div className={`rounded-lg border px-4 py-3 text-sm ${conflict ? "border-low/40 bg-low/10 text-[#92400E]" : "border-out/30 bg-out/5 text-out"}`} role="alert">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-semibold">{error.title}</div>
          <div className="mt-0.5">{error.message}</div>
          {error.details?.length > 0 && (
            <ul className="mt-1.5 list-inside list-disc text-[13px] opacity-90">
              {error.details.map((d, i) => <li key={i}>{d}</li>)}
            </ul>
          )}
        </div>
        <div className="flex shrink-0 gap-3 text-xs font-semibold">
          {onRetry && <button onClick={onRetry} className="hover:underline">Retry</button>}
          {onDismiss && <button onClick={onDismiss} className="hover:underline">Dismiss</button>}
        </div>
      </div>
    </div>
  );
}

// ─── Submissions ─────────────────────────────────────────────────────────────

/**
 * One in-flight submission at a time, with a stable Idempotency-Key per
 * submission: the same key is reused if that submission is retried after an
 * error (the server replays a result it already committed instead of acting
 * twice), and a fresh key is issued after success or when the form resets.
 */
export function useSubmission() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const keyRef = useRef(newIdempotencyKey());
  const inFlight = useRef(false);

  const reset = useCallback(() => {
    keyRef.current = newIdempotencyKey();
    setError(null);
  }, []);

  const submit = useCallback(async (fn) => {
    if (inFlight.current) return undefined; // double-click guard
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await fn(keyRef.current);
      keyRef.current = newIdempotencyKey();
      return result;
    } catch (err) {
      setError(describeError(err));
      return undefined;
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }, []);

  return { pending, error, setError, submit, reset };
}
