import MasterImportHistoryPage from "../components/MasterImportHistoryPage";
import { createMasterImportService } from "../services/masterImportService";

const salesImportService = createMasterImportService("/sales");

export default function SalesImportHistory() {
  return (
    <MasterImportHistoryPage
      title="Import History — Sales Master"
      moduleLabel="Sales Master"
      service={salesImportService}
      backLink="/sales-master"
    />
  );
}
