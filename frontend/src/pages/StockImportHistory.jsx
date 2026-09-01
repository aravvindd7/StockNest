import MasterImportHistoryPage from "../components/MasterImportHistoryPage";
import { createMasterImportService } from "../services/masterImportService";

const stockImportService = createMasterImportService("/stock");

export default function StockImportHistory() {
  return (
    <MasterImportHistoryPage
      title="Import History — Stock Master"
      moduleLabel="Stock Master"
      service={stockImportService}
      backLink="/stock-master"
    />
  );
}
