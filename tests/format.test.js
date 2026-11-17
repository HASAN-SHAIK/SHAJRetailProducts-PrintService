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
    // name 16 | qty 5 | rate 5 | amt 6
    assert.equal(row, "Rice" + " ".repeat(12) + "    2   50   100");
  } finally {
    s.restore();
  }
});

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

// ---- Known gaps vs V1 Gate 4 (reported as TODO, not as passing) ----
test(
  "V1 Gate 4: GSTIN / CGST / SGST lines",
  { todo: "receipt builder has no gstin/cgst/sgst fields; only one GST line" },
  () => {
    const s = loadServer();
    try {
      const { text } = s.buildReceipt(
        { shopName: "S", gstin: "33ABCDE1234F1Z5", cgst: 2.5, sgst: 2.5 },
        {},
      );
      assert.match(text, /GSTIN/);
      assert.match(text, /CGST/);
      assert.match(text, /SGST/);
    } finally {
      s.restore();
    }
  },
);

test(
  "V1 Gate 4: shop name longer than paper width is wrapped, not clipped",
  { todo: "header is not wrapped; long shop name is emitted as one over-wide line" },
  () => {
    const s = loadServer();
    try {
      const name = "SHAJ Retail Products Private Limited Chennai";
      const lines = s
        .buildReceipt({ shopName: name }, { paperWidth: 58 })
        .text.split("\n");
      assert.ok(lines.every((l) => l.length <= 32));
    } finally {
      s.restore();
    }
  },
);
