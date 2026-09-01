import { useState } from "react";
import { Link } from "react-router-dom";

function downloadErrorsCsv(errors) {
  const lines = ["Row,Reference,Error"];
  errors.forEach((e) => {
    lines.push([e.row, e.materialNo ?? e.depotId ?? "", e.error].map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(","));
  });
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "import_errors.csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Generic Append/Replace Excel import UI, shared by Material, Depot, and
 * Stock Master (Section 16: "consistent user experience... where
 * appropriate"). Each module just supplies its title, required-column
 * list, and importFn — everything else (mode selection, upload, result
 * display, error CSV export) is identical.
 *
 * title, description: page heading text
 * requiredColumns: string[] shown as reference chips
 * importFn: (file, mode) => Promise<result>
 * backLink, historyLink: route paths
 * appendDescription, replaceDescription: mode-specific copy
 */
export default function MasterImportPage({
  title,
  description,
  requiredColumns,
  importFn,
  backLink,
  historyLink,
  appendDescription,
  replaceDescription,
}) {
  const [mode, setMode] = useState("APPEND");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [missingColumns, setMissingColumns] = useState(null);
  const [result, setResult] = useState(null);
  const [fileName, setFileName] = useState("");

  async function handleFileSelected(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setBusy(true);
    setError(null);
    setMissingColumns(null);
    setResult(null);
    try {
      const data = await importFn(file, mode);
      setResult(data);
    } catch (err) {
      if (err.response?.status === 422 && err.response.data.missingRequiredColumns) {
        setMissingColumns(err.response.data.missingRequiredColumns);
      } else {
        setError(err.response?.data?.message || "Could not import this file. Please check the format and try again.");
      }
    } finally {
      setBusy(false);
      e.target.value = "";
    }
  }

  function reset() {
    setResult(null);
    setError(null);
    setMissingColumns(null);
    setFileName("");
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-display text-xl font-bold">{title}</h2>
          <p className="text-sm text-gray-500">{description}</p>
        </div>
        <Link to={backLink} className="sn-btn-ghost">
          Back
        </Link>
      </div>

      <div className="sn-card p-5">
        <h3 className="font-display text-sm font-bold">Required columns</h3>
        <p className="mt-1 text-sm text-gray-500">The file's first row must contain these headers (in any order):</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {requiredColumns.map((c) => (
            <span key={c} className="rounded-md bg-gray-100 px-2.5 py-1 font-mono text-xs text-gray-600">
              {c}
            </span>
          ))}
        </div>
      </div>

      {!result && (
        <div className="sn-card p-5">
          <h3 className="font-display text-sm font-bold">Import Mode</h3>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <ModeOption value="APPEND" selected={mode === "APPEND"} onSelect={setMode} title="Append" description={appendDescription} />
            <ModeOption value="REPLACE" selected={mode === "REPLACE"} onSelect={setMode} title="Replace" description={replaceDescription} />
          </div>
        </div>
      )}

      {error && <div className="rounded-lg border border-out/30 bg-out/5 px-4 py-3 text-sm text-out">{error}</div>}

      {missingColumns && (
        <div className="rounded-lg border border-out/30 bg-out/5 px-4 py-3 text-sm text-out">
          <p className="font-semibold">Import failed: missing required columns.</p>
          <p className="mt-1">{missingColumns.join(", ")}</p>
        </div>
      )}

      {!result && (
        <div className="sn-card flex flex-col items-center gap-4 p-12 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-7 w-7">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 9l5-5 5 5M12 4v12" />
            </svg>
          </div>
          <div>
            <h3 className="font-display text-base font-bold">Upload your file</h3>
            <p className="mt-1 text-sm text-gray-500">
              Mode: <span className="font-semibold">{mode === "APPEND" ? "Append" : "Replace"}</span> · Supported formats: .xlsx, .xls, .csv (max 10MB)
            </p>
          </div>
          <label className="sn-btn-primary cursor-pointer">
            {busy ? `Processing ${fileName}…` : "Choose File & Import"}
            <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleFileSelected} disabled={busy} />
          </label>
        </div>
      )}

      {result && <ResultSummary result={result} historyLink={historyLink} backLink={backLink} onImportAnother={reset} />}
    </div>
  );
}

function ModeOption({ value, selected, onSelect, title, description }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(value)}
      className={`flex flex-col items-start gap-1.5 rounded-xl border-2 p-4 text-left transition ${
        selected ? "border-primary bg-primary/5" : "border-gray-200 bg-white hover:border-gray-300"
      }`}
    >
      <div className="flex items-center gap-2">
        <span className={`flex h-4 w-4 items-center justify-center rounded-full border-2 ${selected ? "border-primary" : "border-gray-300"}`}>
          {selected && <span className="h-2 w-2 rounded-full bg-primary" />}
        </span>
        <span className="font-display text-sm font-bold">{title}</span>
      </div>
      <p className="text-xs text-gray-500">{description}</p>
    </button>
  );
}

function ResultSummary({ result, historyLink, backLink, onImportAnother }) {
  return (
    <div className="flex flex-col gap-5">
      <div className="sn-card flex flex-col items-center gap-3 p-8 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-healthy/10 text-healthy">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-7 w-7">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h3 className="font-display text-lg font-bold">{result.importType === "APPEND" ? "Append" : "Replace"} import complete</h3>
        <p className="text-sm text-gray-500">{result.fileName}</p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Total Rows" value={result.totalRecords} color="#1B5FBF" />
        <StatCard label="Added" value={result.addedCount} color="#16A34A" />
        <StatCard label="Updated" value={result.updatedCount} color="#0EA5E9" />
        <StatCard label="Failed" value={result.failedRecords} color="#DC2626" />
      </div>

      {result.errors?.length > 0 && (
        <div className="sn-card p-5">
          <div className="flex items-center justify-between">
            <h3 className="font-display text-sm font-bold">Row Errors ({result.errors.length})</h3>
            <button onClick={() => downloadErrorsCsv(result.errors)} className="sn-btn-ghost sm">
              Download Error Report
            </button>
          </div>
          <div className="mt-3 max-h-72 overflow-y-auto rounded-lg border border-gray-200">
            <table className="w-full text-left text-xs">
              <thead className="bg-gray-50 uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-3 py-2">Row</th>
                  <th className="px-3 py-2">Reference</th>
                  <th className="px-3 py-2">Error</th>
                </tr>
              </thead>
              <tbody>
                {result.errors.map((e, i) => (
                  <tr key={i} className="border-t border-gray-100">
                    <td className="px-3 py-2 font-mono">{e.row}</td>
                    <td className="px-3 py-2 font-mono">{e.materialNo || e.depotId || "—"}</td>
                    <td className="px-3 py-2 text-out">{e.error}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="flex justify-end gap-2">
        <button onClick={onImportAnother} className="sn-btn-ghost">
          Import Another File
        </button>
        <Link to={historyLink} className="sn-btn-ghost">
          View Import History
        </Link>
        <Link to={backLink} className="sn-btn-primary">
          Done
        </Link>
      </div>
    </div>
  );
}

function StatCard({ label, value, color }) {
  return (
    <div className="sn-card relative overflow-hidden p-4">
      <div className="absolute inset-y-0 left-0 w-1" style={{ backgroundColor: color }} />
      <div className="font-display text-2xl font-bold">{value}</div>
      <div className="mt-1 text-xs text-gray-500">{label}</div>
    </div>
  );
}
