const multer = require('multer');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// Storage: write to /tmp with unique filenames
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, os.tmpdir());
  },
  filename: (req, file, cb) => {
    const uniqueId = crypto.randomUUID();
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `auditflow-framework-${uniqueId}${ext}`);
  },
});

// File filter: only allow PDF, CSV, XLSX
const fileFilter = (req, file, cb) => {
  const allowedMimes = [
    'application/pdf',
    'text/csv',
    'text/plain', // some systems send CSV as text/plain
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ];
  const allowedExts = ['.pdf', '.csv', '.xls', '.xlsx'];

  const ext = path.extname(file.originalname).toLowerCase();
  const mimeOk = allowedMimes.includes(file.mimetype);
  const extOk = allowedExts.includes(ext);

  if (mimeOk || extOk) {
    cb(null, true);
  } else {
    cb(
      new Error(
        `Unsupported file type: ${file.mimetype} (${ext}). Accepted: PDF, CSV, XLSX`
      )
    );
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 20 * 1024 * 1024, // 20MB max
    files: 1,
  },
});

module.exports = { upload };
