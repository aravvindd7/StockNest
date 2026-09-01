import MasterImportPage from "../components/MasterImportPage";
import { createMasterImportService } from "../services/masterImportService";
import { STOCK_COLUMNS } from "../constants/stockColumns";

const stockImportService = createMasterImportService("/stock");
const REQUIRED_COLUMNS = STOCK_COLUMNS.map((c) => c.label);

export default function ImportStock() {
  return (
    <MasterImportPage
      title="Import Excel — Stock Master"
      description="Upload a .xlsx, .xls, or .csv file with all 43 Stock Master columns."
      requiredColumns={REQUIRED_COLUMNS}
      importFn={stockImportService.importFile}
      backLink="/stock-master"
      historyLink="/stock-master/import-history"
      appendDescription="Merge with the current Stock Master. Records matching by Plant Name + Mat No + Stock Date + Storage Location are updated; everything else is added as new."
      replaceDescription="Retire the entire current Stock Master and make this file the new active dataset. The previous dataset is preserved in Import History."
    />
  );
}
