# StockNest — Inventory Management System (Steps 1–21 + standalone Depot Master)

This covers:

- **Steps 1–11:** JWT + bcrypt authentication, role-based authorization enforced
  on the backend, a single login screen, and a shared React dashboard whose
  sidebar/KPIs adapt to the logged-in user's role (`ADMIN` vs `USER`).
- **Step 12:** A real, filterable, paginated **Inventory** module — MongoDB
  schema, aggregation-based API, and a React page with the full filter panel —
  readable by both `ADMIN` and `USER`.
- **Steps 13–21: Material Master** (admin-only), **simplified to exactly
  seven business fields** — `materialNo`, `description`, `model`, `status`
  (STD/Discontinued), `invCost`, `moq`, `type` (FG/RM). No category, brand,
  supplier, unit of measure, or other fields. Search/filter/sort/paginate,
  Add/Edit/soft-Delete, CSV export, and a single-step Excel bulk import:
  upload → validate headers + every row → import directly → summary with
  per-row errors. No column-mapping/preview step.
- **Depot Master** (admin-only, standalone) — a minimal two-field module
  (`depotId`, `depotName`) with full CRUD, unique Depot ID enforced at the
  MongoDB level, and its own sidebar entry. Deliberately has **no**
  relationship to Material or Inventory yet — see the note near the bottom
  of this file.

Products/Branches/Warehouses/Reports pages still render a "Coming in Step N"
placeholder — those were never in scope for Steps 1–21.

## Stack

- **Backend:** Node.js, Express, MongoDB + Mongoose, JWT, bcryptjs
- **Frontend:** React 18 (Vite), React Router v6, Axios, Tailwind CSS

## Prerequisites

- Node.js 18+
- A MongoDB instance (local `mongod`, or a free Atlas cluster) and its connection string

> **Note on port 5000:** on macOS, port 5000 is often already taken by the
> AirPlay Receiver service, which silently breaks the backend. This project
> defaults to **5001** instead. It also loads `.env` with
> `dotenv.config({ override: true })` in `server.js` and both seed scripts,
> so values in your `.env` file always win over any stale environment
> variable left in your shell — if you still see a port conflict, check
> `echo $PORT` in your terminal and unset it if it's set.

## 1. Backend setup

```bash
cd backend
cp .env.example .env
# edit .env: set MONGO_URI to your MongoDB connection string,
# and set a real JWT_SECRET (any long random string)

npm install
npm run seed:all           # runs seed -> masterdata -> inventory -> depots in order
npm run dev                # starts the API on http://localhost:5001
```

Or run each step individually if you want to re-seed just one layer:

```bash
npm run seed             # Admin/User accounts
npm run seed:masterdata  # Material + Stock + Sales Master — single source of truth (see below)
npm run seed:inventory   # 5 branches, 5 warehouses, branch-wise inventory rows
npm run seed:depots      # 5 sample depots
```

Seed accounts (change the passwords in `.env` before seeding for anything
beyond local testing):

| Role  | Email                  | Password         |
|-------|-------------------------|-------------------|
| ADMIN | admin@company.com       | Admin@12345       |
| USER  | employee@company.com    | Employee@12345    |

### `seed:masterdata` — the single source of truth

`seed/seedMasterData.js` replaces what used to be three separate scripts
(`seedMaterials.js`, `seedStock.js`, `seedSales.js`). Those generated their
Material Numbers independently — Stock/Sales used fictional placeholders
that didn't match Material Master's real numbers, which made Planning
Master show mostly zeros (nothing to join on).

Now there's exactly **one** material list, defined once at the top of
`seedMasterData.js` — clean, sequential `MAT0001`, `MAT0002`, ... numbering,
no `NWA...`-style codes anywhere. Material Master, Stock Master, and Sales
Master are all derived from that same list, so every Stock/Sales row is
structurally guaranteed to reference a Material Number that exists in
Material Master. `seed:inventory` then reads those same materials for
Step 12's Inventory rows. `seed/seedSuppliers.js` still exists standalone
but isn't part of `seed:all` — Material Master doesn't reference suppliers.

**Backend imports also enforce this now**: Stock and Sales Excel
Append/Replace imports reject any row whose `MatNo` doesn't already exist
in Material Master (`"MatNo does not exist in Material Master."`), rather
than silently creating orphaned records. Material Master remains the only
module that can introduce a new Material Number.

If you already had data seeded with the old `MAT001`-style or `NWA...`-style
numbers, re-run `seed:masterdata` (or `seed:all`) against a fresh database
to pick up the realigned numbering — old dummy Excel import files keyed to
those numbers will no longer match after reseeding.

### Inventory API (Step 12)

```
GET /api/inventory            List inventory (filters, sort, pagination) — ADMIN or USER
GET /api/inventory/filters    Distinct branches/warehouses/statuses for dropdowns
GET /api/inventory/:id        Single record, fully populated
```

Supported query params on `GET /api/inventory`: `materialNo`, `description`,
`model`, `branch`, `warehouse`, `stockStatus`, `minQty`, `maxQty`, `search`
(free text), `page`, `limit`, `sortBy`, `sortDir`.

### Material Master API (Steps 13–21, ADMIN only, 7-field schema)

```
GET    /api/materials              List/search/filter/sort/paginate
POST   /api/materials              Create
GET    /api/materials/:id          Single material
PUT    /api/materials/:id          Update (materialNo immutable)
DELETE /api/materials/:id          Soft delete (isActive: false)
GET    /api/materials/filters      { statuses, types, models } for dropdowns
GET    /api/materials/filter-values?field=&search=   Live column-filter options (Global Filtering System)
GET    /api/materials/export       CSV export of the filtered list

POST   /api/materials/import       Upload .xlsx/.xls/.csv -> validated + imported
                                    directly in one request -> summary + row errors

GET    /api/materials/import-history                    List past imports
GET    /api/materials/import-history/:id/errors          Per-row errors for one import
GET    /api/materials/import-history/:id/errors/export   CSV of those errors
```

Every route above requires `requireAuth` **and** `requireRole("ADMIN")` — a
USER token gets `403 Forbidden` on all of them, matching Section 5's
security model.

**Material schema — exactly seven business fields, nothing else:**

| Field        | Type              | Notes                                   |
|--------------|-------------------|------------------------------------------|
| `materialNo` | String, unique    | Required, immutable after creation       |
| `description`| String            | Required                                 |
| `model`      | String            | Optional                                 |
| `status`     | `"STD"` \| `"Discontinued"` | Required                        |
| `invCost`    | Number, ≥ 0       | Required                                 |
| `moq`        | Number, > 0       | Required                                 |
| `type`       | `"FG"` \| `"RM"`  | Required                                 |

`_id`, `createdAt`, `updatedAt`, and `isActive` (the existing soft-delete
flag) remain on the document but are never shown as form fields. The Add
and Edit Material forms, the Material Master table, and the Excel import
all use exactly these seven fields — no category, brand, supplier, part
number, unit of measure, or location fields.

> **One-time index migration note:** `materialNo`'s unique index changed
> from a plain unique index to a *partial* unique index (unique only among
> `isActive:true` documents — see below). If you already have a running
> MongoDB with the old index, either drop the `materialNo_1` index manually
> once (`db.materials.dropIndex("materialNo_1")`, Mongoose will recreate the
> correct one on next connect with `autoIndex`), or just re-run
> `npm run seed:masterdata` against a fresh database, which is the simpler
> path for a dev setup like this one.

### Excel import: Append and Replace, with a reversible batch system

The first row of the uploaded file must contain exactly these seven
headers (in any order — extra columns are ignored, missing ones fail the
import before any row is read):

```
Material No | Description | Model | STD/Discontinued | Inv Cost | MOQ | FG/RM
```

Every import is a single request — no preview/column-mapping step — but
the admin now chooses a **mode** first:

- **APPEND** — merges the file into the current Material Master by
  `materialNo`. New Material Nos are added; existing ones are updated with
  the imported values. Every add/update is recorded with a full
  before/after snapshot (`models/MaterialImportChange.js`), which is what
  makes the batch reversible via **Remove Import**.
- **REPLACE** — retires the entire current active Material Master and
  makes the file the new active dataset. Implemented by soft-deactivating
  every current `isActive:true` material (not deleting them — they remain
  in the database, fully preserved) and inserting the file's rows as a
  fresh active set. This only works because `materialNo`'s unique index is
  now a **partial index** scoped to `isActive:true`, so a Replace can
  freely reuse Material Nos that existed in the old (now-inactive) set.
  Replace does **not** create per-material change records and has **no
  Remove Import action** in this version — matches the spec's Import
  History example, which only shows "View" for the active Replace batch.

Every import creates an **Import Batch** (`models/MaterialImport.js`) with
a human-friendly sequential id (`IMP-0001`, `IMP-0002`, ...), row counts
(total/added/updated/failed), and a status of `ACTIVE` — batches are never
hard-deleted, only ever marked `REMOVED`, preserving a full audit trail.

**Remove Import (Append only) — how rollback safety works:** for each
material the batch touched, the backend re-checks that material's *current
live values* against the snapshot the batch left behind (`newData`). If
they still match exactly, it's safe to reverse — delete it (if it was
`ADDED`) or restore `previousData` (if it was `UPDATED`). If they don't
match, a later import or manual edit has changed that material since —
that one material is **skipped** and reported as a conflict rather than
overwritten, while the rest of the batch still reverses normally. The
batch is marked `REMOVED` either way. This is the mechanism behind Section
8's requirement that an older rollback must never blindly destroy a newer
change.

```
POST /api/materials/import                        Body: multipart file + mode (APPEND|REPLACE)
GET  /api/materials/import-history                 List batches
GET  /api/materials/import-history/:id              Batch details + change list (Append only)
POST /api/materials/import-history/:id/remove       Reverse an ACTIVE Append batch
GET  /api/materials/import-history/:id/errors       Per-row validation failures for a batch
GET  /api/materials/import-history/:id/errors/export  CSV of those errors
```

**Design decision worth knowing:** the Material Master form does **not**
collect Warehouse, Branch, Manufacturing Date, Expiry Date, category,
brand, supplier, or unit of measure — those either don't exist in this
schema at all, or (for Warehouse/Branch/dates) stay on Inventory documents
(Step 12) per Section 21's "Material answers what, Inventory answers
where/how much" split. Once a material exists here, stock is assigned to a
branch via the Inventory module. If your instructor wants those fields flattened onto Material
directly instead, that's a small, contained schema change — say the word.


### Depot Master API (ADMIN only, standalone — no Material/Inventory relationship)

```
GET    /api/depots        List depots, optional ?search= on depotId/depotName
POST   /api/depots        Create (depotId, depotName)
GET    /api/depots/:id    Single depot
PUT    /api/depots/:id    Update (depotId is editable — see note below)
DELETE /api/depots/:id    Hard delete
```

Same `requireAuth` + `requireRole("ADMIN")` enforcement as every other
admin route — a USER token gets `403 Forbidden`.

**Schema — exactly two business fields:**

| Field       | Type            | Notes                                    |
|-------------|-----------------|--------------------------------------------|
| `depotId`   | String, unique  | Required, trimmed, uppercased; unique index enforced at the MongoDB level, not just app code |
| `depotName` | String          | Required, trimmed                          |

`_id`, `createdAt`, `updatedAt` remain on the document but are never shown
as form fields. No address, city, state, manager, phone, capacity, status,
region, or description fields — intentionally.

**depotId is editable** (not locked like Material's `materialNo`), with
uniqueness re-checked server-side on every update. This was a deliberate
choice for this initial version: nothing yet references `depotId` as a
foreign key, so there's no risk of orphaning a relationship by renaming it.
If/when Inventory starts referencing `depotId`, that's the point to decide
whether it should become immutable — flagged in the code with a comment.

**No relationship to Material or Inventory yet.** Depot Master is fully
standalone by design (see Section 15 of the spec) — Material Master was
not modified, and no `depotId` field was added anywhere on Material or
Inventory. Deletion is a hard delete for now since nothing references a
depot; once Inventory does, `depotController.deleteDepot` is the place to
add a "depot is in use" guard (flagged with a comment there too).

## 2. Frontend setup

```bash
cd frontend
cp .env.example .env
# edit .env if your backend isn't on http://localhost:5001

npm install
npm run dev      # starts the app on http://localhost:5173
```

Open http://localhost:5173, log in with either seed account, and you'll land
on the shared dashboard. Log in as the ADMIN account to see the extra
"Material Master" sidebar link and Material Master KPI row — log in as USER
and confirm both are absent, and that navigating directly to
`/material-master` redirects to the Unauthorized page.

## 3. Verifying the security model

The frontend route guard is a UX convenience only. The real enforcement is
on the backend. To confirm it, with the USER account's token:

```bash
curl -H "Authorization: Bearer <user_token>" http://localhost:5001/api/materials
# -> 403 Forbidden

curl -H "Authorization: Bearer <admin_token>" http://localhost:5001/api/materials
# -> 200 OK
```

## Sales Master — full operational ERP module + forecasting-prep layer

Sales Master's schema is a full **19-field** operational ERP record shape,
organized into Identification / Location / Time / Product / Sales Values —
restoring fields an earlier pass dropped too aggressively — plus the
monthly-forecasting-prep additions (Financial Year, Month, and two
auto-derived fields, Quarter and Period).

**Sales Master vs. Planning Master — different purposes, never merged:**
Sales Master answers *"what happened"* (detailed historical records);
Planning Master answers *"what should we do"* (forecast/decision
support). Sales Master is not a slimmed-down analytics view of itself —
it's the full record store, with an additional read-oriented summary on
top.

**Quarter and Period are never user-entered.** Add Sales and Excel import
both derive them via `utils/financialYear.js`'s `deriveQuarter()` and
`derivePeriod()` — the one shared place this logic exists, used by Sales
validation and Planning Service alike. `QtrWk` (week-within-quarter) has
no underlying week-level data source, so it's preserved as an optional
free-text field, same as before — not auto-derived, just carried through
if a source system supplies it.

**Why "monthly totals match quarterly totals" doesn't need a separate
check**: quarterly totals are never independently stored — both the
Quarterly Summary view (`GET /api/sales/summary`) and Planning Service
compute them as a live MongoDB aggregation (`$group` + `$sum`) over the
monthly rows, grouped by the always-correct Quarter field. Since there's
only one source of truth and no redundant derived-and-stored value,
monthly-to-quarterly drift is structurally impossible, not something a
reconciliation job needs to catch.

### Two views, one collection

Sales Master's page has two tabs over the **same** underlying monthly
record collection — never two different datasets:

- **Detailed Records** (default) — the full operational table: all 19
  fields, every column filterable (via its own filter icon), sortable,
  paginated. This is Sales Master's primary view, matching every other
  master module's pattern.
- **Quarterly Summary** — `Material | Financial Year | Q1 | Q2 | Q3 | Q4`,
  click a quarter to open `components/MonthlyBreakdownDrawer.jsx` with
  that quarter's month-by-month numbers. The forecasting-prep /
  at-a-glance view.

Add Sales, Import, Export, and Import History all operate on the same
underlying collection regardless of which tab is showing.

### Filters: Apply/Cancel on Detailed Records, instant everywhere else

Sales Master's Detailed Records tab is the one place in the app where
filtering requires clicking **Apply** (with **Cancel** to discard) rather
than applying instantly as you type — a deliberate, explicit requirement
for this view specifically. This is implemented as an opt-in `instant`
prop (default `true`, so every other module's filtering is completely
unaffected) on the shared `ColumnFilter.jsx`/`AdvancedFilter.jsx`/
`FilterManager.jsx`/`DataTable.jsx` components — edits buffer in local
draft state until Apply, rather than a second filtering implementation.
The Quarterly Summary tab's Advanced Filter stays instant, matching
Planning Master's pivoted-view pattern.

### New API surface (`routes/salesRoutes.js`, all ADMIN-only)
```
GET /api/sales           Full operational record list — Detailed Records' data source
GET /api/sales/summary    Material + Financial Year rows with Q1-Q4 sums — Quarterly Summary's data source
GET /api/sales/monthly    ?materialNo=&financialYear=&quarter= — the expandable
                           monthly breakdown, fetched only when a quarter cell is clicked
GET /api/sales/export     The full 19-column dataset as .xlsx
```

**Import validation**: Material Number must exist in Material Master,
Financial Year must match `"YYYY-YY"`, Month must be a real month name,
and duplicate Material + Plant + Financial Year + Month within the same
file is rejected. **Import History (View/Remove/snapshot) was not
touched** — same `DatasetHistory` architecture, same behavior.

**Planning Service integration** (`services/planningService.js`): the
Sales read path aggregates via MongoDB (`$group` by MatNo/FinancialYear/
Quarter, `$sum` SalesQty) instead of reading pre-quarterized rows.
**The forecasting functions themselves — `buildForecast`,
`computeTrendGrowthRate`, `weightedSeasonalAverage`, `computeConfidence`,
and everything else in the actual algorithm — were not modified**,
confirmed by checking every function definition is still present after
each change made in this area.

**Seed data**: `seed/seedMasterData.js`'s Sales generation produces 756
monthly rows across all 19 fields for the default 21-material set. Run
`npm run seed:masterdata` to pick this up — old Sales dummy Excel files
keyed to an earlier schema version will no longer match.

## Global ERP Filtering System

Every master module list (Material, Depot, Stock, Sales) and Planning
Master's analytical view now share **one filtering architecture**, not
five separate ones — this was the explicit point of the upgrade.

**Frontend** (`frontend/src/components/table/`):
- `useTableFilters.js` — the actual "Filter State Manager." Tracks column
  filters, Advanced-Filter-drawer filters, search, and sort in one place,
  and turns it into query params (`queryParams`). A column filter and a
  drawer filter for the same field are literally the same piece of state —
  set one, the other reflects it, and both appear as one chip.
- `ColumnFilter.jsx` — the Excel-style popup a column header's filter icon
  opens: live-searchable multiselect checkboxes (backed by a real
  `GET /module/filter-values?field=&search=` call, not whatever happens to
  be on the current page) or a Min/Max range, plus Sort Ascending/
  Descending/Clear Sorting and Clear Filter. No Apply/Submit button
  anywhere — every click updates the table immediately.
- `FilterChip.jsx` / `FilterManager.jsx` — the active-filter chip row with
  per-chip removal and "Clear All," plus the "Advanced Filter" trigger.
  `FilterManager` is the one component every module page drops in.
- `AdvancedFilter.jsx` — the right-side drawer for filters that don't map
  to a single visible column (e.g. Planning Master's Trend/Growth %/
  Confidence/Stock Risk), or that a module wants surfaced more
  prominently. Same instant-update behavior, same shared state.
- `filterValuesFetcher.js` — one-line factory for the `filter-values` API
  call, reused by every module instead of four near-identical fetchers.

`DataTable.jsx` gained **optional, backward-compatible** filter-icon
support: a column only gets a filter icon if it declares a `filterType`
*and* the page passes a `filterState`. Pages that don't (Inventory.jsx,
for instance — out of scope for this upgrade) render exactly as they did
before.

**Backend** (`utils/queryFilterBuilder.js`): `buildMongoFilter` (multiselect
via `?field=a,b,c` → `$in`, range via `?fieldMin=`/`?fieldMax=` →
`$gte`/`$lte`), `buildSort`, and `getDistinctValues` (the `filter-values`
endpoint's implementation, capped at 50 results — the search box narrows
further from there). Every module's list controller and export handler
calls these instead of hand-rolling its own query-building logic, and each
module still layers its own field config on top (what's filterable, and
whether it's multiselect or range) — the mechanism is shared, the field
list per module isn't.

**Planning Master's filters run strictly after the forecast is computed**
(`applyPlanningFilters` in `services/planningService.js`) — Trend/Growth %/
Confidence/Stock Risk filter the already-computed rows; nothing in
`buildForecast`, `computeTrendGrowthRate`, `weightedSeasonalAverage`, or
any other forecasting function was touched, per the explicit constraint
not to modify the forecasting logic. `stockRisk` (Low/Healthy/Overstock)
is a new, simple comparison of numbers the engine already produces
(Current Stock vs. Safety Stock vs. Recommended Stock) — not part of the
forecast itself.

**Gaps worth knowing about — filters mentioned in the upgrade spec that
aren't implemented, because the underlying field doesn't exist:**
- **Depot Master**: Location, Region, Status — Depot Master was
  deliberately locked to exactly `depotId` + `depotName` in an earlier
  update; adding fields just to filter on them would be a regression.
- **Stock Master**: Safety Stock (that's a Planning-only computed
  heuristic, never stored on Stock) and Stock Status (Low/Over/Available)
  — the spec itself marks Stock Status as "future compatibility."
- **Sales Master**: a separate "Depot" field (Sales only has `Plant`) and
  "Month" (Sales only has `Qtr`/`Period`/`Year`, no month-level data).

None of these block anything — they're simply not filterable yet because
there's nothing to filter on. Each is a schema addition away, not a
filtering-architecture limitation.

## Project structure

```
backend/
├── config/db.js               Mongoose connection
├── models/
│   ├── User.js                 Auth: username/email/passwordHash/role
│   ├── Branch.js / Warehouse.js
│   ├── Supplier.js             No longer referenced by Material; kept unused for future reuse
│   ├── Material.js             Exactly 7 business fields (see table above)
│   ├── Inventory.js            One doc = one material at one branch/warehouse
│   ├── Depot.js                Standalone: depotId, depotName only
│   ├── DatasetHistory.js       Shared snapshot history for Material/Depot/Stock/Sales Append/Replace/Restore
│   ├── Stock.js                43 fields, matched to Material via MatNo
│   └── Sales.js                20 fields, matched to Material via MatNo
├── middleware/
│   ├── authMiddleware.js       JWT verification (requireAuth)
│   ├── roleMiddleware.js       Role check (requireRole)
│   └── uploadMiddleware.js     Multer config for .xlsx/.xls/.csv uploads
├── utils/
│   ├── excelParser.js          Workbook parsing, header validation, row normalization (shared)
│   ├── xlsxExport.js           Builds real .xlsx buffers (shared)
│   ├── datasetHistoryHelper.js Snapshot/archive helpers (shared)
│   ├── stockMatcher.js         Isolated Stock Append matching key
│   ├── salesMatcher.js         Isolated Sales Append matching key (6-field)
│   ├── queryFilterBuilder.js   Shared MongoDB filter/sort building (Global Filtering System)
│   └── safetyStock.js          Safety Stock heuristic (see Planning Master below)
├── services/
│   └── planningService.js      Planning Engine — aggregation + forecasting, isolated from the controller
├── controllers/
│   ├── authController.js       login / me / logout
│   ├── dashboardController.js  Real KPI aggregations (Material + Inventory)
│   ├── inventoryController.js  Filtered/sorted/paginated list + filter options
│   ├── materialController.js / materialImportController.js
│   ├── depotController.js / depotImportController.js
│   ├── stockController.js / stockImportController.js
│   ├── salesController.js / salesImportController.js
│   └── planningController.js   Thin HTTP layer over services/planningService.js
├── routes/
│   ├── authRoutes.js / dashboardRoutes.js / inventoryRoutes.js
│   ├── materialRoutes.js / depotRoutes.js / stockRoutes.js / salesRoutes.js  (CRUD + import/export/history)
│   └── planningRoutes.js       GET-only, no mutations
├── seed/
│   ├── seedUsers.js
│   ├── seedSuppliers.js        Standalone; not part of seed:all (unused by Material now)
│   ├── seedMasterData.js       Single source of truth: Material + Stock + Sales, shared MAT0001... numbering
│   ├── seedInventory.js        Branches, warehouses, inventory (reads existing materials)
│   ├── seedDepots.js           5 sample depots
│   └── seedAll.js              Runs seedUsers -> seedMasterData -> seedInventory -> seedDepots
└── server.js

frontend/src/
├── components/
│   ├── Navbar.jsx / Sidebar.jsx / DashboardLayout.jsx
│   ├── DataTable.jsx            Generic sortable/paginated table, frozen columns, optional column-filter icons
│   ├── table/                   Global ERP Filtering System — reused by every module (see section above)
│   │   ├── useTableFilters.js   The Filter State Manager hook
│   │   ├── ColumnFilter.jsx     Instant multiselect/range popup, no Apply button
│   │   ├── FilterChip.jsx / FilterManager.jsx   Chip bar + "Advanced Filter" trigger + drawer, composed
│   │   ├── AdvancedFilter.jsx   Right-side drawer, module-configurable fields
│   │   └── filterValuesFetcher.js  Shared "GET /module/filter-values" call factory
│   ├── MaterialForm.jsx         Add/Edit Material modal — exactly 7 fields
│   ├── DepotForm.jsx            Add/Edit Depot modal — exactly 2 fields
│   ├── StockForm.jsx            Add Stock modal — 43 fields
│   ├── SalesForm.jsx            Add Sales modal — 20 fields
│   ├── MasterImportPage.jsx / MasterImportHistoryPage.jsx   Generic, reused by Material/Depot/Stock/Sales
│   ├── PlanningTable.jsx        ERP-style planning table — sticky columns/header, forecast year block
│   ├── ForecastDrawer.jsx       Right-side drawer for a clicked forecast quarter cell
│   ├── ConfirmDialog.jsx        Generic yes/no confirmation (used for delete)
│   ├── ProtectedRoute.jsx       Redirects to /login if not authenticated
│   ├── RoleBasedRoute.jsx       Redirects to /unauthorized if role mismatched
│   └── ComingSoon.jsx           Placeholder for Products/Branches/Warehouses/Reports/Distribution Master
├── pages/
│   ├── Login.jsx                Single login form for all roles
│   ├── Dashboard.jsx            Shared, role-aware KPI dashboard
│   ├── Inventory.jsx            Real filter panel + DataTable, built on /api/inventory
│   ├── MaterialMaster.jsx / ImportMaterials.jsx / ImportHistory.jsx
│   ├── DepotMaster.jsx / ImportDepots.jsx / DepotImportHistory.jsx
│   ├── StockMaster.jsx / ImportStock.jsx / StockImportHistory.jsx
│   ├── SalesMaster.jsx / ImportSales.jsx / SalesImportHistory.jsx
│   ├── PlanningMaster.jsx       Read-only: search + FY dropdown + PlanningTable + ForecastDrawer
│   ├── DistributionMaster.jsx   Placeholder only (Sidebar entry + route, no implementation)
│   ├── Products.jsx / Branches.jsx / Warehouses.jsx / Reports.jsx  (placeholders)
│   └── Unauthorized.jsx
├── context/AuthContext.jsx      Holds user/token, login()/logout()
├── constants/
│   ├── stockColumns.js          Frontend mirror of the 43 Stock Master columns
│   └── salesColumns.js          Frontend mirror of the 20 Sales Master columns
├── services/
│   ├── api.js / authService.js / dashboardService.js / inventoryService.js
│   ├── materialService.js       CRUD + filters + xlsx export
│   ├── depotService.js          Depot CRUD + xlsx export
│   ├── stockService.js          Stock list/add + xlsx export
│   ├── salesService.js          Sales list/add + xlsx export
│   ├── planningService.js       fetchPlanningData / fetchPlanningYears (read-only)
│   └── masterImportService.js   Generic factory: importFile/fetchHistory/viewHistory/removeHistory,
│                                 bound per-module to /materials, /depots, /stock, /sales
├── constants/
│   ├── stockColumns.js          Frontend mirror of the 43 Stock Master columns
│   └── salesColumns.js          Frontend mirror of the 20 Sales Master columns
├── routes/AppRoutes.jsx
└── App.jsx / main.jsx
```

Also worth knowing: `components/MasterImportPage.jsx` and `components/MasterImportHistoryPage.jsx`
are generic, reused as-is by Material/Depot/Stock/Sales' import and import-history
pages — each module's page (e.g. `pages/ImportSales.jsx`) is just a thin wrapper
supplying its title, required columns, and a `masterImportService` instance.

### Planning Master — read-only analytical/forecasting module, owns no data

Unlike every other Admin module, Planning Master is **not a CRUD master**: it
has no model of its own, no Add/Edit/Delete, no Import/Export/History, no
Refresh button, no forecast-model selector. It's a read-only analytical view
assembled fresh on every request from Material, Stock, and Sales Master —
nothing it displays is stored anywhere as "planning" data, and the forecast
is regenerated on every request rather than cached.

```
GET /api/planning         Full view: historical + forecast. Query: search, startYear
GET /api/planning/years   Distinct years in Sales Master, for the FY dropdown
```

Both require `requireAuth` + `requireRole("ADMIN")`, same as every other
Admin route — no exception for being read-only.

**Architecture:** `controllers/planningController.js` is a thin HTTP layer;
all aggregation and forecasting logic lives in `services/planningService.js`
(Forecast Hierarchy: Historical Sales → Monthly Forecast → Quarter Forecast
→ Year Forecast). The React table only renders what the service returns —
no business logic in the frontend, and the forecasting algorithm can be
upgraded later without touching the UI.

**The Financial Year dropdown selects the first of 3 displayed historical
years**; the forecast year is always the year immediately after (`startYear
+ 3`) — the continuation of the visible timeline, not tied to the absolute
latest data available. The forecast itself is computed from a material's
**entire** sales history regardless of which 3 years are currently on
screen, so forecast quality doesn't depend on the selected window.

**Forecast Engine (v1) — weighted moving average with seasonal matching:**
for each quarter position (Q1–Q4), it takes that specific quarter's values
across every historical year, weighted toward recency, as a seasonal
baseline; then applies the material's average year-over-year growth rate
(clamped to -30%/+50% so one volatile year can't produce a wild
extrapolation) to project forward. Confidence is derived from how
consistent (low-variance) that quarter's historical values have been — a
material with erratic history gets a lower confidence score, not a
fabricated one.

**Monthly forecast is computed and returned even though the table only
shows quarters** — each forecast quarter's payload includes a 3-month
breakdown (Apr/May/Jun for Q1, etc., following this project's April-start
financial year convention), specifically so a future Distribution Master
can consume it directly without Planning Master needing to change.

**Recommended Stock** = Safety Stock + the forecast's nearest quarter (Q1)
demand — a target stock level, not an order quantity. Documented in
`services/planningService.js`'s `computeRecommendedStock` since the spec
left the exact formula open.

Clicking any forecast quarter cell opens a right-side drawer
(`components/ForecastDrawer.jsx`) with the quantity, confidence, growth %,
monthly breakdown, and a plain-language reason — all already present in the
`/api/planning` response, so no extra request fires on click.

**Two things worth knowing:**

1. **Safety Stock isn't a real stored field anywhere.** Stock Master tracks
   quantities, not a safety-stock threshold. Rather than invent one,
   `utils/safetyStock.js` computes it as half of average quarterly sales — a
   standard planning heuristic, isolated in its own function so it's a
   one-line swap if a real Safety Stock value gets captured somewhere later.
2. **Material/Stock/Sales dummy data now comes from one shared generator.**
   `seed/seedMasterData.js` defines a single material list (`MAT0001`,
   `MAT0002`, ...) and derives Material, Stock, and Sales Master from it, so
   every Stock/Sales row is guaranteed to reference a real Material Number.
   This replaced two earlier, less complete fixes — first a mismatch against
   fictional `MAT001`-style placeholders, then a mismatch against the
   NWA-prefixed numbers Material Master used to generate — both of which
   made Planning Master show mostly zeros. Stock/Sales imports also now
   reject any row whose `MatNo` isn't already in Material Master. See
   `npm run seed:masterdata` above for the full explanation.

## What's next

Steps 1–21 of the master spec are complete; Material Master is simplified to 7
fields; Depot, Stock, Sales, and Planning Master are all implemented — the
first three as full CRUD+import/export/history modules sharing the same
snapshot-based architecture (`models/DatasetHistory.js`), and Planning as a
read-only analytical/forecasting view (`services/planningService.js`).
Distribution Master is a sidebar entry + placeholder page only, by design.
Remaining ideas, roughly in order of value:

1. **Distribution Master** — not implemented yet, deliberately. When its
   fields are provided, `services/planningService.js`'s monthly forecast
   breakdown (already computed and returned on every forecast quarter) is
   meant to be consumed directly — see the Planning Master section above.
2. **Reports module** — the Reports/Products/Branches/Warehouses pages are
   still placeholders; Reports is the most natural next real page (e.g.
   low-stock and near-expiry summaries, export).
3. **A real Safety Stock value** — see the note above; once one exists
   (added to Material or Stock Master), swap it in for
   `utils/safetyStock.js`'s heuristic.
4. **Depot/Stock/Sales ↔ Inventory relationships** — deliberately not
   implemented yet; these are independent master-data modules for now.
5. Column-visibility toggling on the wide tables (Material/Stock/Sales/
   Planning) — currently all columns always show — sortable/scrollable/
   frozen, but not hideable.
6. Batch imports run row-by-row (not in a single Mongo transaction) since
   this project targets a standalone `mongod`, where multi-document
   transactions aren't available without a replica set. Each row's
   add/update is still independently safe (Mongoose validation), but a
   mid-import crash could leave a batch partially applied. If you deploy
   against a replica set / Atlas, wrapping each import controller's loop in
   a `mongoose.startSession()` transaction is a contained upgrade.
7. `nextBatchId()` generates ids via a document count — fine for a single
   admin importing at a time, but two simultaneous imports on the *same*
   module could theoretically race to the same batch id. An atomic counter
   document would remove that edge case if concurrent admin imports become
   common.
