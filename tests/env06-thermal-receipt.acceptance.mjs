import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const port = 43106;
const base = `http://127.0.0.1:${port}`;
const repo = process.cwd();
const tempPath = path.join(repo, "temp.txt");

const child = spawn(process.execPath, ["server.js"], {
  cwd: repo,
  env: {
    ...process.env,
    PORT: String(port),
    PRINTER_NAME: "ENV06_VIRTUAL_POS58",
    SUMATRA_PATH: path.join(repo, "definitely-missing-sumatra.exe"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => (stdout += chunk));
child.stderr.on("data", (chunk) => (stderr += chunk));

async function waitForStatus() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`${base}/status`);
      if (res.ok) return await res.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Service did not become ready. stdout=${stdout} stderr=${stderr}`);
}

try {
  const status = await waitForStatus();
  if (status.mode !== "windows-spooler") {
    throw new Error(`Unexpected mode: ${JSON.stringify(status)}`);
  }

  const payload = {
    shopName: "SHAJ TEST MART",
    billNo: "ENV06-001",
    date: "2026-09-01",
    time: "15:15",
    payment: "cash",
    items: [
      { name: "Premium Basmati Rice Five Kilogram Bag", qty: 2, rate: 125.5 },
      { name: "Milk 500ml", qty: 1, rate: 32 },
    ],
    subtotal: 283,
    gst: 14.15,
    discount: 3,
    total: 294.15,
    printConfig: { paperWidth: 58, fontStyle: "A", fontScale: 1 },
  };

  const response = await fetch(`${base}/print`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (response.status !== 500 || !String(body.error || "").includes("SumatraPDF not found")) {
    throw new Error(`Expected missing-Sumatra boundary after receipt generation, got ${response.status}: ${JSON.stringify(body)}`);
  }

  if (!fs.existsSync(tempPath)) throw new Error("temp.txt receipt output was not created");
  const receipt = fs.readFileSync(tempPath, "utf8").replace(/\r/g, "");
  const required = [
    "SHAJ TEST MART",
    "Bill No: ENV06-001",
    "Payment: CASH",
    "ITEM",
    "Premium Basmati",
    "Rice Five",
    "Milk 500ml",
    "Subtotal: 283",
    "GST: 14.15",
    "Discount: 3",
    "TOTAL: 294.15",
    "Thank you! Visit again",
  ];
  for (const token of required) {
    if (!receipt.includes(token)) throw new Error(`Receipt missing token: ${token}`);
  }

  const printableLines = receipt.split("\n").filter((line) => line.length > 0);
  const overWidth = printableLines.filter((line) => line.length > 32);
  if (overWidth.length) {
    throw new Error(`58mm receipt contains lines wider than 32 chars: ${JSON.stringify(overWidth)}`);
  }

  const header = printableLines.find((line) => line.includes("ITEM") && line.includes("QTY") && line.includes("RATE") && line.includes("AMT"));
  if (!header || header.length !== 32) {
    throw new Error(`Expected exact 32-column item header, got ${JSON.stringify(header)}`);
  }

  console.log("ENV06_AUTOMATED_RECEIPT_CONTRACT_PASS=true");
  console.log(`ENV06_MAX_LINE_LENGTH=${Math.max(...printableLines.map((line) => line.length))}`);
  console.log(`ENV06_RECEIPT_LINES=${printableLines.length}`);
} finally {
  child.kill();
  if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
}
