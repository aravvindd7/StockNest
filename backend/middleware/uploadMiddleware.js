const multer = require("multer");

const ALLOWED_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/vnd.ms-excel", // .xls
  "text/csv",
  "application/csv",
]);

const ALLOWED_EXTENSIONS = /\.(xlsx|xls|csv)$/i;

const storage = multer.memoryStorage(); // small files, parsed immediately — no need to touch disk

function fileFilter(req, file, cb) {
  const extOk = ALLOWED_EXTENSIONS.test(file.originalname);
  const mimeOk = ALLOWED_MIME_TYPES.has(file.mimetype) || file.mimetype === "application/octet-stream";
  if (extOk && mimeOk) return cb(null, true);
  cb(new Error("Only .xlsx, .xls, or .csv files are allowed."));
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

module.exports = upload;
