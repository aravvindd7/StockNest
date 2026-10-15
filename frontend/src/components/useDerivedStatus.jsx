import { useCallback, useEffect, useRef, useState } from "react";
import { fetchDerivedStatus } from "../services/derivedStatusService";

const IDLE_INTERVAL_MS = 30_000; // conservative check while everything is current
const BUSY_INTERVAL_MS = 8_000; // a little faster while an automatic update is in progress

/**
 * Watches the server's automatic-update status (forecast / recommendations).
 *
 * - Checks only while the browser tab is visible; a hidden tab never polls.
 * - Returning to the tab (or focusing the window) checks once, immediately.
 * - Never overlaps requests; a failed check keeps the last known status.
 * - Calls onChange(next) when `signature(status)` changes — not on the first
 *   load — so pages refresh their data only when something really changed.
 * - `tick` advances after every successful check, so a page can retry a quiet
 *   refresh that failed (e.g. a brief outage) without waiting for the next change.
 */
export default function useDerivedStatus({ signature, onChange }) {
  const [status, setStatus] = useState(null);
  const [tick, setTick] = useState(0);
  const inFlight = useRef(false);
  const lastSig = useRef(null);
  const timer = useRef(null);
  const handlers = useRef({ signature, onChange });
  handlers.current = { signature, onChange };
  const statusRef = useRef(null);
  statusRef.current = status;

  const check = useCallback(async () => {
    if (inFlight.current || document.visibilityState !== "visible") return;
    inFlight.current = true;
    try {
      const next = await fetchDerivedStatus();
      statusRef.current = next;
      setStatus(next);
      const sig = handlers.current.signature(next);
      if (lastSig.current !== null && sig !== lastSig.current) handlers.current.onChange?.(next);
      lastSig.current = sig;
      setTick((t) => t + 1);
    } catch {
      // keep the last known status; the next check retries
    } finally {
      inFlight.current = false;
    }
  }, []);

  const loopId = useRef(0);
  useEffect(() => {
    let cancelled = false;
    // Exactly one polling loop: starting a new one (tab became visible again)
    // retires any loop still waiting on a request, so timers never double up.
    const loop = async () => {
      const id = ++loopId.current;
      clearTimeout(timer.current);
      await check();
      if (cancelled || id !== loopId.current) return;
      const st = statusRef.current;
      const busy = st?.forecast?.status === "updating" || st?.distribution?.status === "updating";
      timer.current = setTimeout(loop, busy ? BUSY_INTERVAL_MS : IDLE_INTERVAL_MS);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") loop();
    };
    loop();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      cancelled = true;
      clearTimeout(timer.current);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [check]);

  return { status, check, tick };
}

/** "just now", "2 min ago", "3 h ago", or a date. */
export function relativeTime(d) {
  if (!d) return "";
  const s = Math.max(0, (Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}

/**
 * Subtle one-line freshness note, e.g. "Forecast updated automatically · 2 min ago".
 * noun: "forecast" | "recommendations".
 */
export function FreshnessNote({ stage, noun }) {
  if (!stage) return null;
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
  let text;
  let tone = "text-gray-400";
  if (stage.status === "updating") {
    text = `Updating ${noun}…`;
    tone = "text-primary";
  } else if (stage.status === "failed") {
    text = `Update failed — showing the last available ${noun}`;
    tone = "text-[#B45309]";
  } else if (stage.updatedAt) {
    text = `${Noun} updated automatically · ${relativeTime(stage.updatedAt)}`;
  } else {
    return null;
  }
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs ${tone}`} role="status">
      {stage.status === "updating" && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
      {text}
    </span>
  );
}
