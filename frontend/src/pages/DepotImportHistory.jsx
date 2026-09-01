import MasterImportHistoryPage from "../components/MasterImportHistoryPage";
import { createMasterImportService } from "../services/masterImportService";

const depotImportService = createMasterImportService("/depots");

export default function DepotImportHistory() {
  return (
    <MasterImportHistoryPage
      title="Import History — Depot Master"
      moduleLabel="Depot Master"
      service={depotImportService}
      backLink="/depot-master"
    />
  );
}
