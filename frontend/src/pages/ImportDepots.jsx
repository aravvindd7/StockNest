import MasterImportPage from "../components/MasterImportPage";
import { createMasterImportService } from "../services/masterImportService";

const depotImportService = createMasterImportService("/depots");

const REQUIRED_COLUMNS = ["Depot ID", "Depot Name"];

export default function ImportDepots() {
  return (
    <MasterImportPage
      title="Import Excel — Depot Master"
      description="Upload a .xlsx, .xls, or .csv file to add or replace depots."
      requiredColumns={REQUIRED_COLUMNS}
      importFn={depotImportService.importFile}
      backLink="/depot-master"
      historyLink="/depot-master/import-history"
      appendDescription="Merge with the current Depot Master. New Depot IDs are added; a Depot ID that already exists is updated with the imported name rather than duplicated."
      replaceDescription="Retire the entire current Depot Master and make this file the new active dataset. The previous dataset is preserved in Import History."
    />
  );
}
