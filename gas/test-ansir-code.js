/**
 * Regression test for the ANSIR reference-number sequencing logic.
 *
 * Run from the repository root:
 *   node gas/test-ansir-code.js
 *
 * This does NOT re-implement nextAnsirCode_. It extracts that function verbatim
 * from gas/Code.gs, between the sentinel comments, and evaluates that exact
 * source. If the shipped logic changes, this tests the change. Sequencing is
 * the one piece of this endpoint where a silent mistake issues two applicants
 * the same reference number, so it is worth a test.
 *
 * Real codes come from data/data.json, the same file the public site is built
 * from, so the legacy non-conforming identifiers in the live data (2005-S01,
 * ANU-2021, SX-2023, Placeholder-01 and the rest) are exercised for real.
 */
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const SRC = path.join(REPO, 'gas', 'Code.gs');

const source = fs.readFileSync(SRC, 'utf8');
const BEGIN = '// ---- BEGIN PURE LOGIC: nextAnsirCode_ (extracted verbatim by the test harness) ----';
const END = '// ---- END PURE LOGIC ----';
const start = source.indexOf(BEGIN);
const end = source.indexOf(END);
if (start < 0 || end < 0) {
  throw new Error('Could not find the sentinel comments in ' + SRC);
}
const extracted = source.slice(start + BEGIN.length, end);
console.log('Extracted ' + extracted.split('\n').length + ' lines of real source from gas/Code.gs\n');

const nextAnsirCode_ = new Function(extracted + '\nreturn nextAnsirCode_;')();

const REAL = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'data.json'), 'utf8'))
  .data.map(p => p.ansirCode).filter(Boolean);

const cases = [
  { name: 'Real published data, year 2026 (highest live code is ANSIR-2026-006)',
    codes: REAL, year: 2026, expect: 'ANSIR-2026-007' },
  { name: 'Real published data, year 2025 (highest live code is ANSIR-2025-010)',
    codes: REAL, year: 2025, expect: 'ANSIR-2025-011' },
  { name: 'Real published data, year 2023 (includes two-digit legacy ANSIR-2023-06)',
    codes: REAL, year: 2023, expect: 'ANSIR-2023-007' },
  { name: 'Real published data, year 2027 (no codes yet for that year)',
    codes: REAL, year: 2027, expect: 'ANSIR-2027-001' },
  { name: 'Empty sheet',
    codes: [], year: 2026, expect: 'ANSIR-2026-001' },
  { name: 'Null input (a missing column degrades to the start of the sequence)',
    codes: null, year: 2026, expect: 'ANSIR-2026-001' },
  { name: 'ONLY legacy non-conforming codes - every one must be ignored',
    codes: ['2005-S01', 'ANU-2021', 'SX-2023', 'Placeholder-01', 'S01-2019',
            'MT03-2020', '2008-M01', 'UA-2017-001', 'ANU-2023-02'],
    year: 2026, expect: 'ANSIR-2026-001' },
  { name: 'Blank and whitespace cells mixed with real codes',
    codes: ['', '   ', null, undefined, 'ANSIR-2026-004', ''],
    year: 2026, expect: 'ANSIR-2026-005' },
  { name: 'Whitespace-padded code (spreadsheet cells often carry stray spaces)',
    codes: ['  ANSIR-2026-012  '], year: 2026, expect: 'ANSIR-2026-013' },
  { name: 'Out-of-order codes - the maximum wins, not the last row',
    codes: ['ANSIR-2026-009', 'ANSIR-2026-002', 'ANSIR-2026-007'],
    year: 2026, expect: 'ANSIR-2026-010' },
  { name: 'An adjacent year must not leak into this year',
    codes: ['ANSIR-2025-099', 'ANSIR-2027-050'], year: 2026, expect: 'ANSIR-2026-001' },
  { name: 'Suffixed variant ANSIR-2026-003-REV is ignored, not mis-parsed',
    codes: ['ANSIR-2026-003-REV', 'ANSIR-2026-001'], year: 2026, expect: 'ANSIR-2026-002' },
  { name: 'Rolls past 999 without truncating the padding',
    codes: ['ANSIR-2026-999'], year: 2026, expect: 'ANSIR-2026-1000' },
  { name: 'Master list plus pending applications combined (the collision case)',
    codes: REAL.concat(['ANSIR-2026-007', 'ANSIR-2026-008']),
    year: 2026, expect: 'ANSIR-2026-009' }
];

let pass = 0;
let fail = 0;
cases.forEach(function (c) {
  const got = nextAnsirCode_(c.codes, c.year);
  const ok = got === c.expect;
  if (ok) { pass++; } else { fail++; }
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + c.name);
  console.log('        expected ' + c.expect + ', got ' + got);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
