# Testing

```bash
npm install
npm test        # node --test tests/*.test.js (built-in runner, no extra deps)
```

Tests never touch a real printer: `child_process.exec` (SumatraPDF + PowerShell
`Get-Printer`) is stubbed and the spool file is redirected to an OS temp dir via
`RECEIPT_TEMP_PATH` (unset in production => `temp.txt` next to `server.js`).
The app is exported from `server.js` and only listens when run directly
(`require.main === module`), so `npm start` is unchanged.

Covered: `/status`, `/printers`, `/print` (happy path, unknown printer, missing
SumatraPDF, spooler failure, bad/oversized JSON, hostile shapes), CORS, receipt
layout at 58mm (32 cols) and 80mm (48 cols), wrapping, defaults, ESC/POS init,
margin/centering env options, temp-file overwrite, GST lines and long shop
names (see below).

## Optional GST fields on `POST /print`

All optional; a field counts as sent only when it is not `null`, `undefined`
or blank. A payload that sends none of them prints byte-for-byte the
owner-approved layout (pinned by a golden test at 58mm and 80mm).

| Field   | Printed as                    | Where                                  |
|---------|-------------------------------|----------------------------------------|
| `gstin` | `GSTIN: <value>` (centred)    | directly under the shop name           |
| `cgst`  | `CGST: <amount>`              | after `Subtotal`, replaces `GST:`      |
| `sgst`  | `SGST: <amount>`              | after `CGST`, replaces `GST:`          |
| `igst`  | `IGST: <amount>`              | after `SGST`, replaces `GST:`          |
| `gst`   | `GST: <amount>` (as before)   | only when none of cgst/sgst/igst sent  |

Each of `cgst`/`sgst`/`igst` prints only if sent. A shop name (or GSTIN) wider
than the paper wraps onto several centred lines; every line stays within 32
columns at 58mm and 48 at 80mm.

`todo` tests mark remaining known gaps (V1 Gate 4): empty payload not
rejected, no barcode-label endpoint exists.
Physical 58/80mm print quality still needs real hardware.
