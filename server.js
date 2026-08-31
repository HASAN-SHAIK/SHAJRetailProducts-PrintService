require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 5000);
const CORS_ORIGIN =
  process.env.CORS_ORIGIN || "https://pos.shajtech.in,http://localhost:3000";
const PRINTER_NAME =
  process.env.PRINTER_NAME || "POSPrinter POS58" || "POS58 Printer";
const SUMATRA_PATH =
  process.env.SUMATRA_PATH ||
  "C:\\Users\\DELL\\AppData\\Local\\SumatraPDF\\SumatraPDF.exe";
const USE_ESC_POS = process.env.USE_ESC_POS === "1";
const SUMATRA_PRINT_SETTINGS = process.env.SUMATRA_PRINT_SETTINGS || "noscale";
const CENTER_HEADER = process.env.CENTER_HEADER !== "0";
const LEFT_MARGIN_SPACES = Number(process.env.LEFT_MARGIN_SPACES || 0);

const app = express();

const allowedOrigins = CORS_ORIGIN.split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("Not allowed by CORS"));
    },
  }),
);

app.use(bodyParser.json({ limit: "1mb" }));

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

/* ================= FORMAT ================= */

const ESC = "\x1B";

const PAPER_CONFIG = {
  58: {
    charsPerLine: 32,
    columns: { name: 16, qty: 5, rate: 5, amt: 6 },
  },
  80: {
    charsPerLine: 48,
    columns: { name: 26, qty: 6, rate: 6, amt: 10 },
  },
};

const DEFAULT_PRINT_CONFIG = {
  paperWidth: 58,
  fontStyle: "A",
  fontScale: 1,
};

const normalizePrintConfig = (cfg = {}) => {
  const paperWidth = Number(cfg.paperWidth) || DEFAULT_PRINT_CONFIG.paperWidth;
  const fontStyle =
    String(cfg.fontStyle || DEFAULT_PRINT_CONFIG.fontStyle).toUpperCase() ===
    "B"
      ? "B"
      : "A";
  const scaleNum = Number(cfg.fontScale);
  const fontScale = [1, 2, 3].includes(scaleNum)
    ? scaleNum
    : DEFAULT_PRINT_CONFIG.fontScale;
  return {
    paperWidth: PAPER_CONFIG[paperWidth]
      ? paperWidth
      : DEFAULT_PRINT_CONFIG.paperWidth,
    fontStyle,
    fontScale,
  };
};

const getPaperConfig = (paperWidth) =>
  PAPER_CONFIG[paperWidth] || PAPER_CONFIG[DEFAULT_PRINT_CONFIG.paperWidth];

const setFont = (style = "A") =>
  style === "B" ? `${ESC}M\x01` : `${ESC}M\x00`;

const setFontSize = (scale = 1) => {
  const sizeMap = { 1: "\x00", 2: "\x11", 3: "\x22" };
  return `${ESC}!${sizeMap[scale] || sizeMap[1]}`;
};

const padRight = (v, w) => String(v ?? "").padEnd(w, " ");
const padLeft = (v, w) => String(v ?? "").padStart(w, " ");

const wrapText = (text, width) => {
  const words = String(text || "").split(/\s+/);
  const lines = [];
  let line = "";

  words.forEach((word) => {
    const next = line ? line + " " + word : word;
    if (next.length <= width) {
      line = next;
    } else {
      if (line) lines.push(line);
      if (word.length <= width) {
        line = word;
      } else {
        for (let i = 0; i < word.length; i += width) {
          lines.push(word.slice(i, i + width));
        }
        line = "";
      }
    }
  });

  if (line) lines.push(line);
  return lines;
};

const line = (width) => "-".repeat(width);

const center = (text, width) => {
  text = String(text || "");
  const space = Math.floor((width - text.length) / 2);
  return " ".repeat(space > 0 ? space : 0) + text;
};

const addLeftMargin = (text) => {
  const pad =
    Number.isFinite(LEFT_MARGIN_SPACES) && LEFT_MARGIN_SPACES > 0
      ? LEFT_MARGIN_SPACES
      : 0;
  return pad ? " ".repeat(pad) + String(text) : String(text);
};

const maybeCenter = (text, width) =>
  CENTER_HEADER ? center(text, width) : String(text || "");

const formatAmount = (v) => {
  const n = Number(v || 0);
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
};

/* ================= RECEIPT ================= */

const buildReceipt = (data, printConfig) => {
  const items = Array.isArray(data.items) ? data.items : [];
  const cfg = normalizePrintConfig(printConfig);
  const paper = getPaperConfig(cfg.paperWidth);

  const nameWidth = paper.columns.name;
  const qtyWidth = paper.columns.qty;
  const rateWidth = paper.columns.rate;
  const amtWidth = paper.columns.amt;

  const out = [];

  if (USE_ESC_POS) {
    out.push(setFont(cfg.fontStyle) + setFontSize(cfg.fontScale));
  }

  out.push(maybeCenter(data.shopName || "My Store", paper.charsPerLine));
  out.push(maybeCenter(line(paper.charsPerLine), paper.charsPerLine));

  out.push(`Bill No: ${data.billNo || "-"}`);
  if (data.date) out.push(`Date: ${data.date}`);
  if (data.time) out.push(`Time: ${data.time}`);
  out.push(`Payment: ${(data.payment || "CASH").toUpperCase()}`);
  out.push(line(paper.charsPerLine));

  out.push(
    `${padRight("ITEM", nameWidth)}${padLeft("QTY", qtyWidth)}${padLeft("RATE", rateWidth)}${padLeft("AMT", amtWidth)}`,
  );
  out.push(line(paper.charsPerLine));

  items.forEach((item) => {
    const nameLines = wrapText(item.name, nameWidth);
    const qty = formatAmount(item.qty);
    const rate = formatAmount(item.rate);
    const amt = formatAmount(item.qty * item.rate);

    nameLines.forEach((ln, i) => {
      if (i === 0) {
        out.push(
          `${padRight(ln, nameWidth)}${padLeft(qty, qtyWidth)}${padLeft(rate, rateWidth)}${padLeft(amt, amtWidth)}`,
        );
      } else {
        out.push(padRight(ln, nameWidth));
      }
    });
  });

  out.push(line(paper.charsPerLine));
  out.push(`Subtotal: ${formatAmount(data.subtotal)}`);
  out.push(`GST: ${formatAmount(data.gst)}`);
  out.push(`Discount: ${formatAmount(data.discount)}`);
  out.push(line(paper.charsPerLine));
  out.push(
    maybeCenter(`TOTAL: ${formatAmount(data.total)}`, paper.charsPerLine),
  );
  out.push(maybeCenter("Thank you! Visit again", paper.charsPerLine));
  out.push("\n");

  const withMargin = out.map(addLeftMargin).join("\n");
  return { text: withMargin, printConfig: cfg };
};

/* ================= ROUTES ================= */

app.get("/status", (req, res) => {
  res.json({
    connected: true,
    printer: PRINTER_NAME,
    mode: "windows-spooler",
  });
});

const getWindowsPrinters = () =>
  new Promise((resolve) => {
    const cmd =
      'powershell -NoProfile -Command "Get-Printer | Select-Object -ExpandProperty Name"';
    exec(cmd, (err, stdout) => {
      if (err) return resolve([]);
      const list = String(stdout || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      resolve(list);
    });
  });

app.get("/printers", async (req, res) => {
  const printers = await getWindowsPrinters();
  res.json({ printers });
});

app.post("/print", async (req, res) => {
  try {
    const data = req.body || {};
    const { text: receipt } = buildReceipt(data, data.printConfig);

    /* ===== WRITE FILE ===== */

    const filePath = path.join(__dirname, "temp.txt");
    fs.writeFileSync(filePath, receipt, "utf8");

    /* ===== PRINT ===== */

    if (!fs.existsSync(SUMATRA_PATH)) {
      return res.status(500).json({
        error: `SumatraPDF not found at ${SUMATRA_PATH}. Set SUMATRA_PATH in .env.`,
      });
    }

    const availablePrinters = await getWindowsPrinters();
    if (
      PRINTER_NAME &&
      availablePrinters.length &&
      !availablePrinters.includes(PRINTER_NAME)
    ) {
      return res.status(400).json({
        error: `Printer not found: ${PRINTER_NAME}`,
        printers: availablePrinters,
      });
    }

    const sumatraPath = `"${SUMATRA_PATH}"`;

    const command = `${sumatraPath} -print-to "${PRINTER_NAME}" -print-settings "${SUMATRA_PRINT_SETTINGS}" -silent "${filePath}"`;

    exec(command, (err) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: err.message });
      }

      res.json({ success: true });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
/* ================= START ================= */

app.listen(PORT, () => {
  console.log(`🚀 Local print service running on http://localhost:${PORT}`);
  console.log(`🖨️ Printer: ${PRINTER_NAME}`);
});
