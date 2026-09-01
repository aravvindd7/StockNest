import api from "./api";

/**
 * Creates a set of import/export/history calls bound to one module's API
 * base path (e.g. "/materials", "/depots", "/stock"). All three modules
 * share the exact same backend shape (see datasetHistoryHelper.js on the
 * backend), so this factory avoids re-writing the same axios calls three
 * times with only the URL prefix differing.
 */
export function createMasterImportService(basePath) {
  return {
    async importFile(file, mode) {
      const form = new FormData();
      form.append("file", file);
      form.append("mode", mode);
      const { data } = await api.post(`${basePath}/import`, form, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      return data; // { fileName, importType, totalRecords, addedCount, updatedCount, failedRecords, errors }
    },

    async fetchHistory() {
      const { data } = await api.get(`${basePath}/import-history`);
      return data.data; // array of DatasetHistory entries (snapshotData omitted)
    },

    async viewHistory(id) {
      const { data } = await api.post(`${basePath}/import-history/${id}/view`);
      return data; // { message, restoredCount }
    },

    async removeHistory(id) {
      const { data } = await api.delete(`${basePath}/import-history/${id}`);
      return data; // { message, batchId }
    },

    async exportData() {
      const response = await api.get(`${basePath}/export`, { responseType: "blob" });
      return response.data; // blob (.xlsx)
    },
  };
}

/** Triggers a browser download for a blob returned by exportData(). */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
