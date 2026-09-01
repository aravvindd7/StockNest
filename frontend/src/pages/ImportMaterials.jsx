import MasterImportPage from "../components/MasterImportPage";
import { createMasterImportService } from "../services/masterImportService";

const materialImportService = createMasterImportService("/materials");

const REQUIRED_COLUMNS = ["Material No", "Description", "Model", "STD/Discontinued", "Inv Cost", "MOQ", "FG/RM"];

export default function ImportMaterials() {
  return (
    <MasterImportPage
      title="Import Excel — Material Master"
      description="Upload a .xlsx, .xls, or .csv file to add or replace materials."
      requiredColumns={REQUIRED_COLUMNS}
      importFn={materialImportService.importFile}
      backLink="/material-master"
      historyLink="/material-master/import-history"
      appendDescription="Merge with the current Material Master. New Material Nos are added; existing ones are updated with the imported values."
      replaceDescription="Retire the entire current Material Master and make this file the new active dataset. The previous dataset is preserved in Import History."
    />
  );
}
