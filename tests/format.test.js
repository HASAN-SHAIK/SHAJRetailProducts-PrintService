"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadServer } = require("./helpers");

const sample = {
  shopName: "SHAJ Retail",
  billNo: "INV-2024-0001",
  date: "2024-05-01",
  time: "10:30",
  payment: "upi",
  items: [
    { name: "Rice", qty: 2, rate: 50 },
    { name: "Extra Long Product Name That Must Wrap", qty: 1.5, rate: 10.25 },
  ],
  subtotal: 115.38,
  gst: 5.77,
  discount: 0,
  total: 121.15,
};

test("normalizePrintConfig defaults and sanitises", () => {
  const s = loadServer();
  try {
    assert.deepEqual(s.normalizePrintConfig(), {
      paperWidth: 58,
      fontStyle: "A",
      fontScale: 1,
    });
    assert.deepEqual(
      s.normalizePrintConfig({ paperWidth: "80", fontStyle: "b", fontScale: 3 }),
      { paperWidth: 80, fontStyle: "B", fontScale: 3 },
    );
    assert.deepEqual(
      s.normalizePrintConfig({ paperWidth: 72, fontStyle: "Z", fontScale: 9 }),
      { paperWidth: 58, fontStyle: "A", fontScale: 1 },
    );
  } finally {
    s.restore();
  }
});

test("helpers: formatAmount, center, wrapText", () => {
  const s = loadServer();
  try {
    assert.equal(s.formatAmount(5), "5");
    assert.equal(s.formatAmount(5.5), "5.50");
    assert.equal(s.formatAmount(undefined), "0");
    assert.equal(s.center("ab", 6), "  ab");
    assert.equal(s.center("toolongtext", 4), "toolongtext");
    assert.deepEqual(s.wrapText("aa bb cc", 5), ["aa bb", "cc"]);
    // word longer than the column is hard-split, nothing is dropped
    assert.deepEqual(s.wrapText("abcdefghij", 4), ["abcd", "efgh", "ij"]);
  } finally {
    s.restore();
  }
});

for (const [width, chars] of [
  [58, 32],
  [80, 48],
]) {
  test(`receipt at ${width}mm: no line exceeds ${chars} chars`, () => {
    const s = loadServer();
    try {
      const { text } = s.buildReceipt(sample, { paperWidth: width });
      const lines = text.split("\n");
      assert.ok(lines.length > 10);
      for (const l of lines) {
        assert.ok(l.length <= chars, `line too long (${l.length}): "${l}"`);
      }
    } finally {
      s.restore();
    }
  });

  test(`receipt at ${width}mm: key fields present`, () => {
    const s = loadServer();
    try {
      const { text } = s.buildReceipt(sample, { paperWidth: width });
      assert.match(text, /SHAJ Retail/);
      assert.match(text, /Bill No: INV-2024-0001/);
      assert.match(text, /Date: 2024-05-01/);
      assert.match(text, /Time: 10:30/);
      assert.match(text, /Payment: UPI/);
      assert.match(text, /GST: 5\.77/);
      assert.match(text, /Subtotal: 115\.38/);
      assert.match(text, /TOTAL: 121\.15/);
      assert.match(text, /Thank you/);
    } finally {
      s.restore();
    }
  });

  test(`receipt at ${width}mm: long item name wraps without losing characters`, () => {
    const s = loadServer();
    try {
      const { text } = s.buildReceipt(sample, { paperWidth: width });
      const nameCol = s.PAPER_CONFIG[width].columns.name;
      const lines = text.split("\n");
      const start = lines.findIndex((l) => l.startsWith("Extra"));
      assert.ok(start >= 0);
      const rebuilt = [];
      for (let i = start; i < lines.length && !lines[i].startsWith("-"); i++) {
        rebuilt.push(lines[i].slice(0, nameCol).trim());
      }
      assert.equal(rebuilt.join(" "), "Extra Long Product Name That Must Wrap");
      assert.ok(rebuilt.length > 1, "expected wrapping");
    } finally {
      s.restore();
    }
  });
}

test("receipt: item row columns align and compute amount", () => {
  const s = loadServer();
  try {
    const { text } = s.buildReceipt(sample, { paperWidth: 58 });
    const row = text.split("\n").find((l) => l.startsWith("Rice"));
    // name 14 | qty 4 | rate 7 | amt 7 (every number column keeps a leading gutter)
    assert.equal(row, "Rice" + " ".repeat(10) + "   2     50    100");
  } finally {
    s.restore();
  }
});

for (const width of [58, 80]) {
  test(`receipt at ${width}mm: decimal qty/rate/amount never run together`, () => {
    const s = loadServer();
    try {
      const data = {
        shopName: "T",
        billNo: "1",
        items: [
          { name: "Sugar 1kg", qty: 3, rate: 48.5 }, // 48.50 -> 145.50
          { name: "Dal", qty: 12.5, rate: 1234.56 },
        ],
        total: 0,
      };
      const { text } = s.buildReceipt(data, { paperWidth: width });
      const max = s.PAPER_CONFIG[width].charsPerLine;
      const lines = text.split("\n");
      for (const l of lines) assert.ok(l.length <= max, `line too wide (${l.length}): ${l}`);
      // A row's numbers are either three separate columns, or (when they do not
      // fit with a gutter) a right-aligned "qty x rate = amount" line below the name.
      const numeric = lines.filter(
        (l) => /^\S.*\s\d+(?:\.\d+)?\s+\d+(?:\.\d+)?\s+\d+(?:\.\d+)?$/.test(l) || / x .+ = /.test(l),
      );
      assert.equal(numeric.length, 2, `expected both items to show qty/rate/amount: ${lines.join("|")}`);
      for (const l of numeric) {
        // qty, rate and amount must be separate numbers: more than two decimals
        // means two columns ran together (e.g. 348.50145.50).
        assert.ok(!/\d\.\d{3,}/.test(l.replace(/^\S.*?(\d+\.\d{3}) x/, "x")), `merged numbers: ${l}`);
      }
      assert.ok(lines.some((l) => /^Sugar 1kg\s+3\s+48\.50\s+145\.50$/.test(l)), "Sugar row columns");
      if (width === 58) {
        assert.ok(lines.some((l) => /12\.5 x 1234\.56 = 15432$/.test(l)), "Dal falls back to a numbers line");
      } else {
        assert.ok(lines.some((l) => /^Dal\s+12\.5\s+1234\.56\s+15432$/.test(l)), "Dal fits normal columns at 80mm");
      }
    } finally {
      s.restore();
    }
  });
}

test("receipt: defaults for missing fields", () => {
  const s = loadServer();
  try {
    const { text } = s.buildReceipt({}, undefined);
    assert.match(text, /My Store/);
    assert.match(text, /Bill No: -/);
    assert.match(text, /Payment: CASH/);
    assert.match(text, /TOTAL: 0/);
    assert.doesNotMatch(text, /Date:/);
  } finally {
    s.restore();
  }
});

test("receipt: non-array items is tolerated", () => {
  const s = loadServer();
  try {
    assert.doesNotThrow(() => s.buildReceipt({ items: "oops" }, {}));
  } finally {
    s.restore();
  }
});

test("receipt: header centered by default, left-aligned when CENTER_HEADER=0", () => {
  let s = loadServer();
  try {
    const first = s.buildReceipt({ shopName: "Shop" }, {}).text.split("\n")[0];
    assert.equal(first, " ".repeat(14) + "Shop");
  } finally {
    s.restore();
  }
  s = loadServer({ CENTER_HEADER: "0" });
  try {
    const first = s.buildReceipt({ shopName: "Shop" }, {}).text.split("\n")[0];
    assert.equal(first, "Shop");
  } finally {
    s.restore();
  }
});

test("receipt: LEFT_MARGIN_SPACES prefixes every line", () => {
  const s = loadServer({ LEFT_MARGIN_SPACES: "3", CENTER_HEADER: "0" });
  try {
    const lines = s.buildReceipt(sample, {}).text.split("\n");
    assert.ok(lines.filter(Boolean).every((l) => l.startsWith("   ")));
  } finally {
    s.restore();
  }
});

test("receipt: USE_ESC_POS=1 emits font + size init, otherwise none", () => {
  let s = loadServer({ USE_ESC_POS: "1" });
  try {
    const { text } = s.buildReceipt(
      { shopName: "S" },
      { fontStyle: "B", fontScale: 2 },
    );
    assert.ok(text.startsWith("\x1BM\x01\x1B!\x11"));
  } finally {
    s.restore();
  }
  s = loadServer();
  try {
    assert.ok(!s.buildReceipt({ shopName: "S" }, {}).text.includes("\x1B"));
  } finally {
    s.restore();
  }
});

// ---- V1 Gate 4: GSTIN / CGST / SGST / IGST and long shop names ----

// Output captured from main (owner-approved 58mm layout) before the GST fields
// existed: payloads without the new fields must print byte-for-byte the same.
const GOLDEN = {
  58: "          SHAJ Retail\n--------------------------------\nBill No: INV-2024-0001\nDate: 2024-05-01\nTime: 10:30\nPayment: UPI\n--------------------------------\nITEM           QTY   RATE    AMT\n--------------------------------\nRice             2     50    100\nExtra Long     1.5  10.25  15.38\nProduct Name  \nThat Must Wrap\n--------------------------------\nSubtotal: 115.38\nGST: 5.77\nDiscount: 0\n--------------------------------\n         TOTAL: 121.15\n     Thank you! Visit again\n\n",
  80: "                  SHAJ Retail\n------------------------------------------------\nBill No: INV-2024-0001\nDate: 2024-05-01\nTime: 10:30\nPayment: UPI\n------------------------------------------------\nITEM                       QTY    RATE       AMT\n------------------------------------------------\nRice                         2      50       100\nExtra Long Product Name    1.5   10.25     15.38\nThat Must Wrap          \n------------------------------------------------\nSubtotal: 115.38\nGST: 5.77\nDiscount: 0\n------------------------------------------------\n                 TOTAL: 121.15\n             Thank you! Visit again\n\n",
};

const gstSample = {
  ...sample,
  gstin: "33ABCDE1234F1Z5",
  cgst: 2.89,
  sgst: 2.88,
};

const assertWithin = (text, max) => {
  for (const l of text.split("\n")) {
    assert.ok(l.length <= max, `line too long (${l.length} > ${max}): "${l}"`);
  }
};

for (const [width, chars] of [
  [58, 32],
  [80, 48],
]) {
  test(`receipt at ${width}mm: absent GST fields => output identical to the approved layout`, () => {
    const s = loadServer();
    try {
      assert.equal(s.buildReceipt(sample, { paperWidth: width }).text, GOLDEN[width]);
      // blank / null optional fields count as absent
      assert.equal(
        s.buildReceipt(
          { ...sample, gstin: "", cgst: null, sgst: undefined, igst: " " },
          { paperWidth: width },
        ).text,
        GOLDEN[width],
      );
    } finally {
      s.restore();
    }
  });

  test(`receipt at ${width}mm: GSTIN under shop name, CGST/SGST replace GST`, () => {
    const s = loadServer();
    try {
      const { text } = s.buildReceipt(gstSample, { paperWidth: width });
      const lines = text.split("\n");
      assert.equal(lines[0].trim(), "SHAJ Retail");
      assert.equal(lines[1].trim(), "GSTIN: 33ABCDE1234F1Z5");
      assert.match(lines[2], /^-+$/);
      assert.ok(!lines.some((l) => l.startsWith("GST:")), "single GST line must be replaced");
      assert.ok(!lines.some((l) => l.startsWith("IGST:")));
      const sub = lines.indexOf("Subtotal: 115.38");
      assert.deepEqual(lines.slice(sub, sub + 4), [
        "Subtotal: 115.38",
        "CGST: 2.89",
        "SGST: 2.88",
        "Discount: 0",
      ]);
      assertWithin(text, chars);
    } finally {
      s.restore();
    }
  });

  test(`receipt at ${width}mm: IGST printed in place of GST`, () => {
    const s = loadServer();
    try {
      const { text } = s.buildReceipt({ ...sample, igst: 5.77 }, { paperWidth: width });
      const lines = text.split("\n");
      assert.ok(lines.includes("IGST: 5.77"));
      assert.ok(!lines.some((l) => /^(GST|CGST|SGST):/.test(l)));
      assertWithin(text, chars);
    } finally {
      s.restore();
    }
  });

  test(`receipt at ${width}mm: long shop name and GSTIN never exceed ${chars} chars`, () => {
    const s = loadServer();
    try {
      const shopName = "SHAJ Retail Products Private Limited Chennai Main Road Branch";
      const gstin = "33ABCDE1234F1Z5-EXTRA-LONG-IDENTIFIER-VALUE-0000000000";
      const { text } = s.buildReceipt({ ...gstSample, shopName, gstin }, { paperWidth: width });
      assertWithin(text, chars);
      const lines = text.split("\n");
      const rule = lines.findIndex((l) => /^-+$/.test(l));
      const header = lines.slice(0, rule).map((l) => l.trim());
      // nothing is dropped: name and GSTIN rebuild from the wrapped lines
      const g = header.findIndex((l) => l.startsWith("GSTIN:"));
      assert.ok(g > 1, "shop name should span several lines");
      assert.equal(header.slice(0, g).join(" "), shopName);
      assert.equal(header.slice(g).join(""), `GSTIN:${gstin}`);
    } finally {
      s.restore();
    }
  });
}

test("V1 Gate 4: GSTIN / CGST / SGST lines", () => {
  const s = loadServer();
  try {
    const { text } = s.buildReceipt(
      { shopName: "S", gstin: "33ABCDE1234F1Z5", cgst: 2.5, sgst: 2.5 },
      {},
    );
    assert.match(text, /GSTIN: 33ABCDE1234F1Z5/);
    assert.match(text, /^CGST: 2\.50$/m);
    assert.match(text, /^SGST: 2\.50$/m);
    assert.doesNotMatch(text, /^GST:/m);
  } finally {
    s.restore();
  }
});

test("V1 Gate 4: shop name longer than paper width is wrapped, not clipped", () => {
  const s = loadServer();
  try {
    const name = "SHAJ Retail Products Private Limited Chennai";
    const lines = s.buildReceipt({ shopName: name }, { paperWidth: 58 }).text.split("\n");
    assert.ok(lines.every((l) => l.length <= 32));
    assert.equal(lines[0], "  SHAJ Retail Products Private");
    assert.equal(lines[1], "        Limited Chennai");
  } finally {
    s.restore();
  }
});

test("receipt: GST-only payload keeps the single GST line", () => {
  const s = loadServer();
  try {
    const { text } = s.buildReceipt({ shopName: "S", gst: 5 }, {});
    assert.match(text, /^GST: 5$/m);
    assert.doesNotMatch(text, /GSTIN|CGST|SGST|IGST/);
  } finally {
    s.restore();
  }
});
