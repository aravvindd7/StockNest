import MasterImportPage from "../components/MasterImportPage";
import { createMasterImportService } from "../services/masterImportService";
import { SALES_COLUMNS, SALES_FORM_KEYS } from "../constants/salesColumns";

const salesImportService = createMasterImportService("/sales");
// Quarter and Period are excluded — neither is ever read from the file, both derived (Quarter from Month, Period from Financial Year + Month).
const REQUIRED_COLUMNS = SALES_COLUMNS.filter((c) => SALES_FORM_KEYS.includes(c.key)).map((c) => c.label);

export default function ImportSales() {
  return (
    <MasterImportPage
      title="Import Excel — Sales Master"
      description="Upload a .xlsx, .xls, or .csv file with monthly sales data (Quarter is calculated automatically from Month)."
      requiredColumns={REQUIRED_COLUMNS}
      importFn={salesImportService.importFile}
      backLink="/sales-master"
      historyLink="/sales-master/import-history"
      appendDescription="Merge with the current Sales Master. Records matching by Material + Financial Year + Month + Plant are updated; everything else is added as new."
      replaceDescription="Retire the entire current Sales Master and make this file the new active dataset. The previous dataset is preserved in Import History."
    />
  );
}
