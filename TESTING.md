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
margin/centering env options, temp-file overwrite.

`todo` tests mark known gaps (V1 Gate 4): no GSTIN/CGST/SGST fields, shop name
not wrapped, empty payload not rejected, no barcode-label endpoint exists.
Physical 58/80mm print quality still needs real hardware.
