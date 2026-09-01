/**
 * Generic MongoDB filter/sort builder shared by every module's list
 * endpoint — the "Express Controller -> MongoDB Query" step in the
 * architecture diagram. One implementation, reused everywhere, so there
 * isn't a subtly-different filtering system per module.
 *
 * fieldConfig: [{ dbField, type: "text" | "number" }]
 *
 * type "text" (Section "Filter Types" — Text Filters: Contains, Starts
 * With, Value Selection):
 *   ?dbField=a,b,c                    -> value selection: { $in: [a,b,c] }
 *   ?dbFieldMode=contains&dbFieldText=ab   -> { $regex: "ab", $options: "i" }
 *   ?dbFieldMode=startsWith&dbFieldText=ab -> { $regex: "^ab", $options: "i" }
 *
 * type "number" (Numeric Filters: Equals, Greater Than, Less Than, Between):
 *   ?dbFieldOp=equals&dbFieldValue=5   -> { $eq: 5 }
 *   ?dbFieldOp=gt&dbFieldValue=5       -> { $gt: 5 }
 *   ?dbFieldOp=lt&dbFieldValue=5       -> { $lt: 5 }
 *   ?dbFieldMin=&dbFieldMax=           -> { $gte, $lte } (Between; also the
 *                                          default when no dbFieldOp is given)
 */
function buildMongoFilter(query, fieldConfig) {
  const filter = {};

  fieldConfig.forEach(({ dbField, type }) => {
    if (type === "text") {
      const mode = query[`${dbField}Mode`];
      const text = query[`${dbField}Text`];

      if (mode === "contains" && text) {
        filter[dbField] = { $regex: escapeRegex(text), $options: "i" };
        return;
      }
      if (mode === "startsWith" && text) {
        filter[dbField] = { $regex: `^${escapeRegex(text)}`, $options: "i" };
        return;
      }

      // Default / "Select Values" mode: multiselect via $in.
      const raw = query[dbField];
      if (raw) {
        const values = String(raw)
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean);
        if (values.length > 0) filter[dbField] = { $in: values };
      }
    } else if (type === "number") {
      const op = query[`${dbField}Op`];
      const value = query[`${dbField}Value`];
      const min = query[`${dbField}Min`];
      const max = query[`${dbField}Max`];

      if (op === "equals" && value !== undefined && value !== "") {
        filter[dbField] = Number(value);
      } else if (op === "gt" && value !== undefined && value !== "") {
        filter[dbField] = { $gt: Number(value) };
      } else if (op === "lt" && value !== undefined && value !== "") {
        filter[dbField] = { $lt: Number(value) };
      } else if ((min !== undefined && min !== "") || (max !== undefined && max !== "")) {
        // Between — also the default range shape used before this upgrade.
        const range = {};
        if (min !== undefined && min !== "") range.$gte = Number(min);
        if (max !== undefined && max !== "") range.$lte = Number(max);
        if (Object.keys(range).length > 0) filter[dbField] = range;
      }
    }
  });

  return filter;
}

/** Builds a Mongoose sort object, restricted to an allow-list to prevent arbitrary field sorting. */
function buildSort(query, allowedFields, defaultField) {
  const sortBy = allowedFields.includes(query.sortBy) ? query.sortBy : defaultField;
  const sortDir = query.sortDir === "desc" ? -1 : 1;
  return { [sortBy]: sortDir, _id: 1 };
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Distinct values for a column filter's live-search dropdown. Capped at
 * 50 so a very high-cardinality field doesn't dump thousands of options
 * into the popup — the search box narrows it down instead.
 */
async function getDistinctValues(Model, field, search, baseQuery = {}) {
  const query = { ...baseQuery };
  if (search) query[field] = { $regex: escapeRegex(search), $options: "i" };
  const values = await Model.distinct(field, query);
  return values.filter((v) => v !== null && v !== undefined && v !== "").sort().slice(0, 50);
}

module.exports = { buildMongoFilter, buildSort, getDistinctValues, escapeRegex };
