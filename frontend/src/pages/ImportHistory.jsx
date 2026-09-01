import MasterImportHistoryPage from "../components/MasterImportHistoryPage";
import { createMasterImportService } from "../services/masterImportService";

const materialImportService = createMasterImportService("/materials");

export default function ImportHistory() {
  return (
    <MasterImportHistoryPage
      title="Import History — Material Master"
      moduleLabel="Material Master"
      service={materialImportService}
      backLink="/material-master"
    />
  );
}
