#!/usr/bin/env node
/**
 * fetch-schedule.js
 *
 * Fetches the published CSV views of the ANSIR Seismic Fleet Status Google Sheet
 * and normalises them into data/schedule.json for the static schedule page.
 *
 * The sheet is a hand-maintained, visually formatted workbook, not a clean table.
 * This script therefore validates every structural assumption it relies on and
 * exits non-zero with a specific message if the layout has shifted. It must never
 * emit a partially understood file: a wrong number here is published to funders.
 *
 * Node 22+. No npm dependencies. Uses built-in fetch.
 *
 * Usage:
 *   node scripts/fetch-schedule.js                  fetch live, write data/schedule.json
 *   node scripts/fetch-schedule.js --from-dir DIR   read avail.csv / supported.csv /
 *                                                   rapid.csv from DIR instead of the
 *                                                   network (offline tests)
 *   node scripts/fetch-schedule.js --out FILE       write somewhere else
 *   node scripts/fetch-schedule.js --strict         treat warnings as fatal
 *   node scripts/fetch-schedule.js --stdout         print JSON, do not write a file
 *
 * Exit codes:
 *   0  success (file written, or already up to date)
 *   1  structural validation failure - the sheet layout changed
 *   2  network or I/O failure
 *
 * See docs/SCHEDULE_DATA.md for the full layout contract.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Configuration - the layout contract. Change here AND in docs/SCHEDULE_DATA.md.
// ---------------------------------------------------------------------------

// The published base URL. Public by design (the sheet is published to the web),
// so it is committed rather than held as a secret. ANSIR_SCHEDULE_PUB_URL
// overrides it if the workbook is ever republished under a new key.
const PUB_BASE =
  process.env.ANSIR_SCHEDULE_PUB_URL ||
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vRyK1XUmYMXIHt-5BWhoZchVtMD3Lxtgqi69WoxEuWgUem7Ob_VzdG8L1OHlBjD7g/pub';

const FETCH_TIMEOUT_MS = 30000;

const TABS = {
  availability: { gid: '1494686323', file: 'avail.csv', label: 'Availability' },
  supported: { gid: '641289421', file: 'supported.csv', label: 'Supported Experiments' },
  rapid: { gid: '1151195930', file: 'rapid.csv', label: 'Rapid Response' }
};

// Availability tab: zero-based row offsets.
const AV = {
  BAND_ROW: 3, // "Deployed Instruments" / "Reserved Instruments (and EOI*)"
  HEADER_ROW: 4, // fixed column labels + experiment names + Testing / Repair
  OUT_ROW: 5, // "Out:" label in COL_LABEL, then per-experiment dates
  DUE_ROW: 6, // "Due:" label in COL_LABEL, then per-experiment dates
  FIRST_DATA_ROW: 7,
  COL_CATEGORY: 0,
  COL_INSTRUMENT: 1,
  COL_TOTAL_FLEET: 2,
  COL_TOTAL_AVAILABLE: 3,
  COL_ON_LOAN: 4,
  COL_LABEL: 5, // spacer column holding the "Out:" / "Due:" labels
  FIRST_EXPERIMENT_COL: 6
};

const AV_LABELS = {
  totalFleet: 'Total Fleet',
  totalAvailable: 'Total Available',
  onLoan: 'On Loan',
  testing: 'Testing',
  repair: 'Repair',
  out: 'Out:',
  due: 'Due:',
  bandDeployed: 'Deployed Instruments',
  bandReserved: 'Reserved Instruments' // prefix match: "(and EOI*)" suffix may change
};

// Supported Experiments tab: column labels, located by name not by index.
const SUP_HEADER_LABEL = 'Application Ref. [FDSN link]';
const SUP_LABELS = ['Funding Source', 'Start Date', 'End Date', 'Description', 'Research Applicant(s)'];
const SUP_FIRST_INSTRUMENT_COL = 6;

// Rapid Response tab.
const RR_LABELS = ['Institute', 'FDSN Network Code', 'Start', 'End', 'Earthquake', 'Location', 'Equipment'];

// Minimum sizes. If the sheet drops below these, something has gone wrong
// upstream (wrong gid, truncated publish, cleared tab) and we must not publish.
const MIN = {
  instrumentRows: 10,
  categories: 2,
  namedExperiments: 3,
  supportedRows: 10,
  rapidRows: 1
};

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

class LayoutError extends Error {
  constructor(tab, message, hint) {
    super(message);
    this.tab = tab;
    this.hint = hint;
  }
}

/**
 * Data-quality warnings carry two forms of the same problem.
 *
 *   technical - names the exact cell, for whoever maintains the sheet. Printed
 *               to stderr so it lands in the CI log for the run that produced it.
 *   reader    - plain words, naming the instrument or experiment rather than a
 *               row or a column. This is the only form written into the JSON,
 *               because the schedule page shows it to researchers, for whom
 *               "cell E10" means nothing.
 *
 * A warning with no reader form (a build-infrastructure problem, say) stays in
 * the log and is not published.
 */
const warnings = [];
function warn(tab, technical, reader) {
  warnings.push({
    tab: tab,
    technical: '[' + tab + '] ' + technical,
    reader: reader ? String(reader).replace(/\s+/g, ' ').trim() : null
  });
}

function fail(tab, message, hint) {
  throw new LayoutError(tab, message, hint);
}

/** Human-readable spreadsheet reference, e.g. row 5 -> "row 6" (sheets are 1-based). */
function rowRef(i) {
  return `row ${i + 1}`;
}

const COL_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function colRef(i) {
  return i < 26 ? COL_LETTERS[i] : COL_LETTERS[Math.floor(i / 26) - 1] + COL_LETTERS[i % 26];
}

function cellRef(r, c) {
  return `${colRef(c)}${r + 1}`;
}

// ---------------------------------------------------------------------------
// CSV parsing (RFC 4180: quoted fields, doubled quotes, embedded newlines)
// ---------------------------------------------------------------------------

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM

  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      quoted = true;
      i += 1;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (c === '\r') {
      i += 1;
      continue;
    }
    if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }
  row.push(field);
  rows.push(row);

  // Drop a single trailing empty row created by a final newline.
  if (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop();
  return rows;
}

/** Cell accessor: always returns a trimmed string, with runs of whitespace collapsed. */
function cell(rows, r, c) {
  const row = rows[r];
  if (!row) return '';
  const v = row[c];
  if (v === undefined || v === null) return '';
  return String(v).replace(/\s+/g, ' ').trim();
}

/** Cell accessor preserving internal newlines (for long prose fields). */
function textCell(rows, r, c) {
  const row = rows[r];
  if (!row) return '';
  const v = row[c];
  if (v === undefined || v === null) return '';
  return String(v).replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

function rowIsBlank(row) {
  return !row || row.every((v) => String(v ?? '').trim() === '');
}

// ---------------------------------------------------------------------------
// Value normalisation
// ---------------------------------------------------------------------------

const TENTATIVE_MARK = '*';

/**
 * A count cell. The sheet uses '*' to mean "expression of interest / tentative,
 * quantity not committed". That is not zero and not a number, so it is modelled
 * explicitly rather than coerced.
 *
 * `subject` names the thing the cell belongs to (an instrument, an application)
 * so the reader-facing warning can say which one, without a cell reference.
 */
function parseCount(raw, tab, r, c, subject) {
  const v = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (v === '') return null;
  if (v === TENTATIVE_MARK) return { count: null, tentative: true };
  const n = Number(v.replace(/,/g, ''));
  if (Number.isInteger(n) && n >= 0) return { count: n, tentative: false };
  warn(
    tab,
    `${cellRef(r, c)} contains "${v}", which is neither a whole number nor "${TENTATIVE_MARK}"; treated as no allocation.`,
    (subject || 'One instrument type') + ': an allocation was recorded as "' + v +
      '", which is not a whole number, so those instruments are not counted here.'
  );
  return null;
}

/** A strictly numeric column (Total Fleet, Total Available, On Loan, Testing, Repair). */
function parseInteger(raw, tab, r, c, label, subject) {
  const who = subject || 'One instrument type';
  const v = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (v === '') {
    warn(
      tab,
      `${cellRef(r, c)} ("${label}") is empty; recorded as null.`,
      who + ': the "' + label + '" figure is blank in the source sheet, so it is shown as not recorded.'
    );
    return null;
  }
  const n = Number(v.replace(/,/g, ''));
  if (!Number.isInteger(n) || n < 0) {
    warn(
      tab,
      `${cellRef(r, c)} ("${label}") contains "${v}", which is not a whole number; recorded as null.`,
      who + ': the "' + label + '" figure reads "' + v +
        '", which is not a whole number, so it is shown as not recorded.'
    );
    return null;
  }
  return n;
}

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12
};

/**
 * A date cell. The sheet mixes MM-YYYY, YYYY-MM-DD and bare YYYY, and uses '*'
 * for "open ended / to be confirmed". Returns a stable shape so a page can
 * display `raw` verbatim but sort and filter on `iso`.
 */
function parseDate(raw, tab, r, c, subject) {
  const v = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (v === '') return null;
  if (v === TENTATIVE_MARK) return { raw: v, iso: null, precision: null, tentative: true };

  // Plausibility band for the leading year, whatever the format below
  // matches. A well-formed date can still be a century typo (the projects
  // register shipped a 2121 for an experiment that ended in 2021), and one
  // absurd year quietly stretches the rendered timeline by a century.
  const yearIn = /^(\d{4})/.exec(v) || /-(\d{4})$/.exec(v);
  if (yearIn) {
    const year = Number(yearIn[1]);
    const maxYear = new Date().getUTCFullYear() + 10;
    if (year !== 0 && (year < 1990 || year > maxYear)) {
      warn(
        tab,
        `${cellRef(r, c)} date "${v}" has year ${year}, outside the plausible range 1990-${maxYear}; likely a typo.`,
        (subject || 'One entry') + ': the date "' + v +
          '" looks like a typo (year ' + year + '). Please check it in the sheet.'
      );
    }
  }

  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (m) return { raw: v, iso: v, precision: 'day', tentative: false };

  m = /^(\d{2})-(\d{4})$/.exec(v);
  if (m) {
    const month = Number(m[1]);
    if (month >= 1 && month <= 12) {
      return { raw: v, iso: `${m[2]}-${m[1]}`, precision: 'month', tentative: false };
    }
  }

  m = /^(\d{4})-(\d{2})$/.exec(v);
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) {
    return { raw: v, iso: v, precision: 'month', tentative: false };
  }

  m = /^(\d{4})$/.exec(v);
  if (m) return { raw: v, iso: v, precision: 'year', tentative: false };

  warn(
    tab,
    `${cellRef(r, c)} contains the date "${v}", which is not MM-YYYY, YYYY-MM-DD, YYYY or "${TENTATIVE_MARK}"; kept as text with no sortable value.`,
    (subject || 'One entry') + ': the date "' + v +
      '" is not in a form this page can read, so it is shown as written and left off the timeline.'
  );
  return { raw: v, iso: null, precision: null, tentative: false };
}

/**
 * ANSIR project codes.
 * Availability headers carry a short form: "Paralana #2026-004".
 * Supported Experiments carries the full form: "ANSIR-2026-004 [Z1 2025]".
 * Both normalise to ANSIR-YYYY-NNN so the schedule page can join to the
 * projects data without any further cleaning.
 */
function normaliseCode(raw) {
  const v = String(raw ?? '');
  let m = /ANSIR\s*-?\s*(\d{4})\s*-\s*(\d{3,})/i.exec(v);
  if (m) return `ANSIR-${m[1]}-${m[2]}`;
  m = /#\s*(\d{4})\s*-\s*(\d{3,})/.exec(v);
  if (m) return `ANSIR-${m[1]}-${m[2]}`;
  return null;
}

/** Strip the trailing "#2026-004" from an availability column header. */
function stripCode(label) {
  return String(label ?? '').replace(/#\s*\d{4}\s*-\s*\d{3,}/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Instrument names occasionally carry a stock annotation on the end, the live
 * case being "ANU TerraSAWR +50 units in production". That is a note about the
 * fleet, not part of the instrument's name, and reading it as a name makes the
 * TerraSAWR row look like a different instrument from "ANU TerraSAWR (NZ)".
 * It is split off into `note` and published beside the name instead.
 *
 * Deliberately conservative: only a trailing segment beginning with "+" is
 * treated as an annotation, bare or inside brackets. Trailing brackets are
 * otherwise left strictly alone, because "(NZ)" and "(Indoor/vault only)" are
 * the only thing telling two real fleet rows apart. Losing one of those would
 * merge two instrument types in the reader's mind, which is far worse than
 * carrying an annotation through.
 */
function splitInstrumentName(raw) {
  const full = String(raw ?? '').replace(/\s+/g, ' ').trim();
  let m = /^(.*?\S)\s*\(\s*(\+\s*\S[^)]*?)\s*\)$/.exec(full); // "... (+50 units in production)"
  if (m) return { name: m[1], note: m[2].replace(/^\+\s*/, '+') };
  m = /^(.*?\S)\s+(\+\s*\S.*)$/.exec(full); // "... +50 units in production"
  if (m) return { name: m[1], note: m[2].replace(/^\+\s*/, '+') };
  return { name: full, note: null };
}

/** Pull "Z1 2025" out of "ANSIR-2025-009 [Z1 2025]" and split off the network code. */
function parseFdsn(raw) {
  const m = /\[([^\]]*)\]/.exec(String(raw ?? ''));
  const label = m ? m[1].replace(/\s+/g, ' ').trim() : '';
  if (!label) return { fdsnLabel: null, fdsnNetwork: null };
  const net = /^([A-Z0-9]{1,2})\b/.exec(label);
  return { fdsnLabel: label, fdsnNetwork: net ? net[1] : null };
}

// ---------------------------------------------------------------------------
// Availability tab
// ---------------------------------------------------------------------------

function parseAvailability(rows) {
  const TAB = TABS.availability.label;

  if (rows.length < AV.FIRST_DATA_ROW + MIN.instrumentRows) {
    fail(
      TAB,
      `Only ${rows.length} rows were returned, but the layout needs at least ${AV.FIRST_DATA_ROW + MIN.instrumentRows}.`,
      'The tab may have been cleared, renamed, or the published gid may no longer point at it.'
    );
  }

  // --- 1. Fixed column headers -------------------------------------------
  const fixed = [
    [AV.COL_TOTAL_FLEET, AV_LABELS.totalFleet],
    [AV.COL_TOTAL_AVAILABLE, AV_LABELS.totalAvailable],
    [AV.COL_ON_LOAN, AV_LABELS.onLoan]
  ];
  for (const [col, label] of fixed) {
    const got = cell(rows, AV.HEADER_ROW, col);
    if (got.toLowerCase() !== label.toLowerCase()) {
      fail(
        TAB,
        `Expected the header "${label}" in cell ${cellRef(AV.HEADER_ROW, col)} but found "${got || '(empty)'}".`,
        `The fixed columns must stay in this order: A category, B instrument, C ${AV_LABELS.totalFleet}, D ${AV_LABELS.totalAvailable}, E ${AV_LABELS.onLoan}. Update AV.COL_* in scripts/fetch-schedule.js if the sheet is restructured deliberately.`
      );
    }
  }

  // --- 2. Out: / Due: label column ----------------------------------------
  for (const [row, label] of [[AV.OUT_ROW, AV_LABELS.out], [AV.DUE_ROW, AV_LABELS.due]]) {
    const got = cell(rows, row, AV.COL_LABEL);
    if (got.toLowerCase() !== label.toLowerCase()) {
      fail(
        TAB,
        `Expected the label "${label}" in cell ${cellRef(row, AV.COL_LABEL)} but found "${got || '(empty)'}".`,
        `The experiment date rows must stay directly under the header row: ${rowRef(AV.HEADER_ROW)} experiment names, ${rowRef(AV.OUT_ROW)} "${AV_LABELS.out}", ${rowRef(AV.DUE_ROW)} "${AV_LABELS.due}". Inserting or deleting a row above the table breaks this.`
      );
    }
  }

  // --- 3. Testing / Repair columns, located by label ----------------------
  const headerRow = rows[AV.HEADER_ROW] || [];
  const findHeaderCol = (label) => {
    for (let c = AV.FIRST_EXPERIMENT_COL; c < headerRow.length; c += 1) {
      if (cell(rows, AV.HEADER_ROW, c).toLowerCase() === label.toLowerCase()) return c;
    }
    return -1;
  };
  const testingCol = findHeaderCol(AV_LABELS.testing);
  const repairCol = findHeaderCol(AV_LABELS.repair);
  for (const [col, label] of [[testingCol, AV_LABELS.testing], [repairCol, AV_LABELS.repair]]) {
    if (col === -1) {
      fail(
        TAB,
        `No column headed "${label}" was found in ${rowRef(AV.HEADER_ROW)}.`,
        `"${AV_LABELS.testing}" and "${AV_LABELS.repair}" must remain the last two labelled columns of the header row, to the right of every experiment column.`
      );
    }
  }
  if (testingCol >= repairCol) {
    fail(
      TAB,
      `"${AV_LABELS.testing}" (${colRef(testingCol)}) must sit to the left of "${AV_LABELS.repair}" (${colRef(repairCol)}).`,
      'The two service-status columns have been reordered or duplicated.'
    );
  }
  const experimentColEnd = testingCol; // experiment columns are strictly left of Testing

  // --- 4. Deployed / Reserved bands ---------------------------------------
  let deployedBandCol = -1;
  let reservedBandCol = -1;
  for (let c = 0; c < (rows[AV.BAND_ROW] || []).length; c += 1) {
    const v = cell(rows, AV.BAND_ROW, c).toLowerCase();
    if (!v) continue;
    if (v.startsWith(AV_LABELS.bandDeployed.toLowerCase())) deployedBandCol = c;
    if (v.startsWith(AV_LABELS.bandReserved.toLowerCase())) reservedBandCol = c;
  }
  if (deployedBandCol === -1 || reservedBandCol === -1) {
    fail(
      TAB,
      `${rowRef(AV.BAND_ROW)} must contain the band labels "${AV_LABELS.bandDeployed}" and "${AV_LABELS.bandReserved}...", marking where the deployed columns end and the reserved/EOI columns begin. Found deployed=${deployedBandCol === -1 ? 'missing' : colRef(deployedBandCol)}, reserved=${reservedBandCol === -1 ? 'missing' : colRef(reservedBandCol)}.`,
      'Without these labels an experiment that is only reserved would be published as already deployed. Restore the labels, or change AV_LABELS.bandDeployed / bandReserved in scripts/fetch-schedule.js.'
    );
  }
  if (reservedBandCol <= deployedBandCol) {
    fail(
      TAB,
      `The "${AV_LABELS.bandReserved}" band (${colRef(reservedBandCol)}) must sit to the right of the "${AV_LABELS.bandDeployed}" band (${colRef(deployedBandCol)}).`,
      'The two column bands have been swapped.'
    );
  }

  // --- 5. Experiment columns ----------------------------------------------
  const experiments = [];
  const experimentByCol = new Map();
  for (let c = AV.FIRST_EXPERIMENT_COL; c < experimentColEnd; c += 1) {
    const label = cell(rows, AV.HEADER_ROW, c);
    if (label === '') continue; // deliberate spacer column
    const status = c >= reservedBandCol ? 'reserved' : 'deployed';
    if (label === TENTATIVE_MARK) {
      // Unnamed placeholder column: an expression of interest with no project
      // attached yet. Counted per instrument as `unnamedInterest`, not listed
      // as an experiment, because it has no name to display.
      experimentByCol.set(c, { placeholder: true, status });
      continue;
    }
    const ansirCode = normaliseCode(label);
    const name = stripCode(label);
    if (!name) {
      warn(
        TAB,
        `Column ${colRef(c)} has a header of "${label}" with no usable name; column ignored.`,
        'One experiment column in the source sheet has no readable name, so any instruments booked to it are not shown here.'
      );
      continue;
    }
    const subject = 'Experiment "' + name + '"';
    const experiment = {
      name,
      label,
      ansirCode,
      status,
      column: colRef(c),
      outDate: parseDate(cell(rows, AV.OUT_ROW, c), TAB, AV.OUT_ROW, c, subject),
      dueDate: parseDate(cell(rows, AV.DUE_ROW, c), TAB, AV.DUE_ROW, c, subject)
    };
    experiments.push(experiment);
    experimentByCol.set(c, { placeholder: false, experiment });
  }

  if (experiments.length < MIN.namedExperiments) {
    fail(
      TAB,
      `Only ${experiments.length} named experiment columns were found between ${colRef(AV.FIRST_EXPERIMENT_COL)} and ${colRef(experimentColEnd - 1)}, expected at least ${MIN.namedExperiments}.`,
      `Experiment names live in ${rowRef(AV.HEADER_ROW)}, starting at column ${colRef(AV.FIRST_EXPERIMENT_COL)} and ending before the "${AV_LABELS.testing}" column.`
    );
  }

  const seenNames = new Set();
  for (const e of experiments) {
    const key = e.name.toLowerCase();
    if (seenNames.has(key)) {
      warn(
        TAB,
        `Two experiment columns are both named "${e.name}"; allocations cannot be told apart.`,
        'Two experiments are both recorded as "' + e.name +
          '", so the instruments booked to each of them cannot be told apart.'
      );
    }
    seenNames.add(key);
  }

  // --- 6. Data rows --------------------------------------------------------
  // A data row is one with an instrument name in column B. The trailing prose
  // rows leave column B empty and put their text further right, so this cleanly
  // separates the table from the commentary below it. Detection deliberately
  // does NOT depend on Total Fleet being numeric: a typo there must produce a
  // loud warning and a null, not a silently disappearing instrument.
  const categories = [];
  const categoryIndex = new Map();
  const notes = [];
  let currentCategory = null;
  let instrumentCount = 0;
  let lastDataRow = -1;

  for (let r = AV.FIRST_DATA_ROW; r < rows.length; r += 1) {
    if (rowIsBlank(rows[r])) continue;

    const categoryCell = cell(rows, r, AV.COL_CATEGORY);
    const instrumentCell = cell(rows, r, AV.COL_INSTRUMENT);
    const MAX_INSTRUMENT_NAME = 90;
    let isData = instrumentCell !== '';
    if (isData && instrumentCell.length > MAX_INSTRUMENT_NAME) {
      warn(
        TAB,
        `${cellRef(r, AV.COL_INSTRUMENT)} holds ${instrumentCell.length} characters, too long to be an instrument name; the row was treated as commentary, not as an instrument.`,
        null
      );
      isData = false;
    }

    if (!isData) {
      // Trailing prose. Collect any long free text as a note.
      for (let c = 0; c < (rows[r] || []).length; c += 1) {
        const v = textCell(rows, r, c);
        if (v.length >= 25) notes.push(v);
      }
      continue;
    }

    if (lastDataRow !== -1 && notes.length > 0) {
      fail(
        TAB,
        `An instrument row was found at ${rowRef(r)} ("${instrumentCell}") after free-text notes had already started.`,
        'Instrument rows must form one unbroken block. Notes and commentary belong below the last instrument row, not between rows.'
      );
    }
    lastDataRow = r;

    if (categoryCell) currentCategory = categoryCell;
    if (!currentCategory) {
      fail(
        TAB,
        `The first instrument row (${rowRef(r)}, "${instrumentCell}") has no category in column ${colRef(AV.COL_CATEGORY)}.`,
        'Column A carries the category (RECORDERS, SEISMOMETERS, FIBRE-OPTIC) on the first row of each group only; the parser carries it down. The first instrument row of the table must always name its category.'
      );
    }

    let category = categoryIndex.get(currentCategory);
    if (!category) {
      category = { name: currentCategory, instruments: [] };
      categoryIndex.set(currentCategory, category);
      categories.push(category);
    }

    const { name: instrumentName, note: instrumentNote } = splitInstrumentName(instrumentCell);

    const totalFleet = parseInteger(cell(rows, r, AV.COL_TOTAL_FLEET), TAB, r, AV.COL_TOTAL_FLEET, AV_LABELS.totalFleet, instrumentName);
    const available = parseInteger(cell(rows, r, AV.COL_TOTAL_AVAILABLE), TAB, r, AV.COL_TOTAL_AVAILABLE, AV_LABELS.totalAvailable, instrumentName);
    const onLoan = parseInteger(cell(rows, r, AV.COL_ON_LOAN), TAB, r, AV.COL_ON_LOAN, AV_LABELS.onLoan, instrumentName);
    const testing = parseInteger(cell(rows, r, testingCol), TAB, r, testingCol, AV_LABELS.testing, instrumentName);
    const repair = parseInteger(cell(rows, r, repairCol), TAB, r, repairCol, AV_LABELS.repair, instrumentName);

    const allocations = [];
    let unnamedInterest = 0;
    let unnamedInterestUnits = null;
    let deployedSum = 0;
    let deployedSumKnown = true;

    for (const [c, meta] of experimentByCol) {
      const parsed = parseCount(cell(rows, r, c), TAB, r, c, instrumentName);
      if (!parsed) continue;
      if (meta.placeholder) {
        // One mark, one expression of interest. The sheet writes '*' here, which
        // means "interested, quantity not committed", so the number of marks is
        // a count of interests and NOT a count of instruments. If a quantity is
        // ever typed in instead, it is kept separately in unnamedInterestUnits
        // so that a stated number is never lost - and so that nothing invents
        // one when the sheet has not stated it.
        unnamedInterest += 1;
        if (parsed.count !== null) unnamedInterestUnits = (unnamedInterestUnits || 0) + parsed.count;
        continue;
      }
      allocations.push({
        experiment: meta.experiment.name,
        ansirCode: meta.experiment.ansirCode,
        status: meta.experiment.status,
        count: parsed.count,
        tentative: parsed.tentative
      });
      if (meta.experiment.status === 'deployed') {
        if (parsed.count === null) deployedSumKnown = false;
        else deployedSum += parsed.count;
      }
    }

    // Not a hard invariant in this sheet, but a genuine data-entry check worth
    // surfacing to whoever maintains it.
    if (deployedSumKnown && onLoan !== null && deployedSum !== onLoan) {
      warn(
        TAB,
        `${rowRef(r)} "${instrumentCell}": deployed allocations total ${deployedSum} but "${AV_LABELS.onLoan}" says ${onLoan}.`,
        instrumentName + ': the deployment list accounts for ' + deployedSum +
          ' instruments on loan but the sheet\'s on-loan figure is ' + onLoan + '.'
      );
    }

    category.instruments.push({
      name: instrumentName,
      note: instrumentNote,
      category: currentCategory,
      totalFleet,
      available,
      onLoan,
      testing,
      repair,
      allocations,
      unnamedInterest,
      unnamedInterestUnits
    });
    instrumentCount += 1;
  }

  if (instrumentCount < MIN.instrumentRows) {
    fail(
      TAB,
      `Only ${instrumentCount} instrument rows were parsed, expected at least ${MIN.instrumentRows}.`,
      `An instrument row is recognised by a name in column ${colRef(AV.COL_INSTRUMENT)} and a whole number in column ${colRef(AV.COL_TOTAL_FLEET)}. If "${AV_LABELS.totalFleet}" now holds text, or the instrument names moved column, every row is skipped.`
    );
  }
  if (categories.length < MIN.categories) {
    fail(
      TAB,
      `Only ${categories.length} instrument categories were found, expected at least ${MIN.categories}.`,
      `Categories are read from column ${colRef(AV.COL_CATEGORY)} on the first row of each group.`
    );
  }

  // Every allocation must join back to a row in `experiments`. The page joins
  // the two by name to put an allocation's out and due dates on its card and its
  // units on the timeline, so an allocation naming an experiment that is not in
  // the list is a silent failure: the units simply vanish from the timeline with
  // nothing on screen to say so. Both sides are built from the same column index
  // here, so this should never fire; it is a tripwire on the join, not a guess.
  const experimentNames = new Set(experiments.map((e) => e.name));
  for (const category of categories) {
    for (const instrument of category.instruments) {
      for (const allocation of instrument.allocations) {
        if (experimentNames.has(allocation.experiment)) continue;
        warn(
          TAB,
          `"${instrument.name}" carries an allocation to "${allocation.experiment}", which is not one of the ${experiments.length} experiment columns.`,
          instrument.name + ': instruments are recorded against "' + allocation.experiment +
            '", which is not listed as an experiment, so they are missing from the deployment timeline.'
        );
      }
    }
  }

  // "Total Available" carries a definition in the row below its header.
  const availableDefinition = cell(rows, AV.OUT_ROW, AV.COL_TOTAL_AVAILABLE) || null;

  return {
    categories,
    experiments,
    notes: [...new Set(notes)],
    definitions: availableDefinition ? { totalAvailable: availableDefinition } : {},
    instrumentCount
  };
}

// ---------------------------------------------------------------------------
// Supported Experiments tab
// ---------------------------------------------------------------------------

function parseSupported(rows) {
  const TAB = TABS.supported.label;

  let headerRow = -1;
  for (let r = 0; r < Math.min(rows.length, 12); r += 1) {
    if (cell(rows, r, 0).toLowerCase() === SUP_HEADER_LABEL.toLowerCase()) {
      headerRow = r;
      break;
    }
  }
  if (headerRow === -1) {
    fail(
      TAB,
      `No header row was found. Column A of the header row must read exactly "${SUP_HEADER_LABEL}", somewhere in the first 12 rows.`,
      'This label is how the parser finds the table. If it is reworded, update SUP_HEADER_LABEL in scripts/fetch-schedule.js.'
    );
  }

  for (let i = 0; i < SUP_LABELS.length; i += 1) {
    const col = i + 1;
    const got = cell(rows, headerRow, col);
    if (got.toLowerCase() !== SUP_LABELS[i].toLowerCase()) {
      fail(
        TAB,
        `Expected the header "${SUP_LABELS[i]}" in cell ${cellRef(headerRow, col)} but found "${got || '(empty)'}".`,
        `Columns A to F must stay in this order: ${SUP_HEADER_LABEL}, ${SUP_LABELS.join(', ')}.`
      );
    }
  }

  // The row directly below the header names each loanable instrument.
  const instrumentRow = headerRow + 1;
  const instrumentCols = [];
  for (let c = SUP_FIRST_INSTRUMENT_COL; c < (rows[instrumentRow] || []).length; c += 1) {
    const name = cell(rows, instrumentRow, c);
    if (name) instrumentCols.push({ col: c, name });
  }
  if (instrumentCols.length < 8) {
    fail(
      TAB,
      `Only ${instrumentCols.length} instrument columns were found in ${rowRef(instrumentRow)} from column ${colRef(SUP_FIRST_INSTRUMENT_COL)} onwards, expected at least 8.`,
      `The instrument names must sit on the row immediately below "${SUP_HEADER_LABEL}", starting in column ${colRef(SUP_FIRST_INSTRUMENT_COL)}.`
    );
  }

  const items = [];
  for (let r = instrumentRow + 1; r < rows.length; r += 1) {
    if (rowIsBlank(rows[r])) continue;

    const ref = cell(rows, r, 0);
    // The table repeats its header partway down to separate ANSIR-referenced
    // applications from the earlier, pre-ANSIR-code ones. Skip those dividers.
    if (ref.toLowerCase() === SUP_HEADER_LABEL.toLowerCase()) continue;

    const description = textCell(rows, r, 4);
    if (!description) {
      warn(
        TAB,
        `${rowRef(r)} has no description; row skipped.`,
        'An entry in the approved-application register has no description recorded, so it is not listed here.'
      );
      continue;
    }

    const { fdsnLabel, fdsnNetwork } = parseFdsn(ref);
    const ansirCode = normaliseCode(ref);
    const subject = 'Approved application ' + (ansirCode || ref || description.split('\n')[0].slice(0, 60));
    const loans = [];
    for (const { col, name } of instrumentCols) {
      const parsed = parseCount(cell(rows, r, col), TAB, r, col, subject);
      if (!parsed) continue;
      loans.push({ instrument: name, count: parsed.count, tentative: parsed.tentative });
    }

    items.push({
      ref: ref ? ref.replace(/\s*\[[^\]]*\]\s*$/, '').trim() || null : null,
      ansirCode,
      fdsnLabel,
      fdsnNetwork,
      fundingSource: textCell(rows, r, 1) || null,
      startDate: parseDate(cell(rows, r, 2), TAB, r, 2, subject),
      endDate: parseDate(cell(rows, r, 3), TAB, r, 3, subject),
      description,
      applicants: textCell(rows, r, 5) || null,
      loans
    });
  }

  if (items.length < MIN.supportedRows) {
    fail(
      TAB,
      `Only ${items.length} supported experiments were parsed, expected at least ${MIN.supportedRows}.`,
      'A row is kept when column E holds a description. If the description column moved, every row is dropped.'
    );
  }

  return items;
}

// ---------------------------------------------------------------------------
// Rapid Response tab
// ---------------------------------------------------------------------------

function parseRapid(rows) {
  const TAB = TABS.rapid.label;

  let headerRow = -1;
  for (let r = 0; r < Math.min(rows.length, 12); r += 1) {
    if (cell(rows, r, 0).toLowerCase() === RR_LABELS[0].toLowerCase()) {
      headerRow = r;
      break;
    }
  }
  if (headerRow === -1) {
    fail(
      TAB,
      `No header row was found. Column A of the header row must read exactly "${RR_LABELS[0]}", somewhere in the first 12 rows.`,
      `The expected header row is: ${RR_LABELS.join(', ')}.`
    );
  }
  for (let i = 0; i < RR_LABELS.length; i += 1) {
    const got = cell(rows, headerRow, i);
    if (got.toLowerCase() !== RR_LABELS[i].toLowerCase()) {
      fail(
        TAB,
        `Expected the header "${RR_LABELS[i]}" in cell ${cellRef(headerRow, i)} but found "${got || '(empty)'}".`,
        `Columns A to G must stay in this order: ${RR_LABELS.join(', ')}.`
      );
    }
  }

  const items = [];
  for (let r = headerRow + 1; r < rows.length; r += 1) {
    if (rowIsBlank(rows[r])) continue;
    const institute = cell(rows, r, 0);
    const earthquake = textCell(rows, r, 4);
    if (!institute && !earthquake) continue;

    const netRaw = cell(rows, r, 1);
    const netMatch = /^([A-Z0-9]{1,2})\b/.exec(netRaw);
    const doiMatch = /\b(10\.\d{4,9}\/[^\s)]+)/.exec(netRaw);

    const subject = 'Rapid response deployment ' + (earthquake ? '"' + earthquake.split('\n')[0].slice(0, 60) + '"' : 'by ' + institute);

    const locRaw = cell(rows, r, 5);
    const locMatch = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/.exec(locRaw);
    let location = null;
    if (locRaw) {
      location = {
        raw: locRaw,
        latitude: locMatch ? Number(locMatch[1]) : null,
        longitude: locMatch ? Number(locMatch[2]) : null
      };
      if (!locMatch) {
        warn(
          TAB,
          `${cellRef(r, 5)} location "${locRaw}" is not "latitude, longitude"; no coordinates extracted.`,
          subject + ': the location is not recorded as a latitude and longitude, so it is shown as written.'
        );
      }
    }

    items.push({
      institute: institute || null,
      fdsnNetwork: netMatch ? netMatch[1] : null,
      doi: doiMatch ? doiMatch[1] : null,
      startDate: parseDate(cell(rows, r, 2), TAB, r, 2, subject),
      endDate: parseDate(cell(rows, r, 3), TAB, r, 3, subject),
      earthquake: earthquake || null,
      location,
      equipment: textCell(rows, r, 6) || null
    });
  }

  if (items.length < MIN.rapidRows) {
    fail(
      TAB,
      `No rapid response rows were parsed, expected at least ${MIN.rapidRows}.`,
      `Data rows must sit directly below the "${RR_LABELS[0]}" header row.`
    );
  }
  return items;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

function csvUrl(gid) {
  return `${PUB_BASE}?gid=${gid}&single=true&output=csv`;
}

async function fetchText(url, what, expectCsv = true) {
  let res;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': 'ansir-web fetch-schedule.js' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
  } catch (err) {
    const e = new Error(`Could not reach Google Sheets for ${what}: ${err.message}`);
    e.networkFailure = true;
    throw e;
  }
  if (!res.ok) {
    const e = new Error(`Google Sheets returned HTTP ${res.status} for ${what}. The sheet may have been unpublished or the gid changed.`);
    e.networkFailure = true;
    throw e;
  }
  const body = await res.text();
  const head = body.slice(0, 200).trim().toLowerCase();
  if (expectCsv && (head.startsWith('<!doctype') || head.startsWith('<html'))) {
    const e = new Error(`Google Sheets returned an HTML page instead of CSV for ${what}. The "publish to the web" setting has almost certainly been turned off.`);
    e.networkFailure = true;
    throw e;
  }
  if (body.trim() === '') {
    const e = new Error(`Google Sheets returned an empty body for ${what}.`);
    e.networkFailure = true;
    throw e;
  }
  return body;
}

/**
 * The Availability tab carries its as-at date in the tab name, e.g.
 * "Availability (July 21, 2026)". Tab names are not in the CSV export, so they
 * come from the pubhtml page. This is presentation metadata: if it cannot be
 * read the build still succeeds, with a warning.
 */
async function fetchTabNames() {
  const names = new Map();
  try {
    const html = await fetchText(`${PUB_BASE}html`, 'the sheet tab names', false);
    const re = /\{name:\s*"((?:[^"\\]|\\.)*)"[^}]*?gid:\s*"(\d+)"/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      names.set(m[2], m[1].replace(/\\x3d/g, '=').replace(/\\\//g, '/'));
    }
  } catch (err) {
    // Build-infrastructure detail, not a fleet fact: no reader-facing form. The
    // page already says "a date not stated in the sheet" when asOf is null.
    warn('workbook', `Tab names could not be read (${err.message}). "availabilityAsOf" will be null.`, null);
  }
  return names;
}

function parseAsOf(tabName) {
  if (!tabName) return null;
  const m = /\(([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})\)/.exec(tabName);
  if (m) {
    // Accept full or abbreviated month names: staff have used both
    // "Availability (July 21, 2026)" and "Availability (Aug 04, 2026)".
    const token = m[1].toLowerCase();
    const monthKey = Object.keys(MONTHS).find(function (name) {
      return name === token || (token.length >= 3 && name.startsWith(token));
    });
    if (monthKey) {
      const month = MONTHS[monthKey];
      return `${m[3]}-${String(month).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
    }
  }
  const iso = /(\d{4}-\d{2}-\d{2})/.exec(tabName);
  if (iso) return iso[1];
  warn('workbook', `The Availability tab is named "${tabName}"; no "(Month D, YYYY)" date could be read from it, so "availabilityAsOf" is null.`, null);
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { fromDir: null, out: null, strict: false, stdout: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--from-dir') opts.fromDir = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--strict') opts.strict = true;
    else if (a === '--stdout') opts.stdout = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

async function loadTab(key, opts) {
  const tab = TABS[key];
  if (opts.fromDir) {
    const file = path.join(opts.fromDir, tab.file);
    if (!fs.existsSync(file)) {
      const e = new Error(`Local CSV not found: ${file}`);
      e.networkFailure = true;
      throw e;
    }
    return fs.readFileSync(file, 'utf8');
  }
  return fetchText(csvUrl(tab.gid), `the "${tab.label}" tab`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    const header = fs.readFileSync(__filename, 'utf8').split('*/')[0];
    console.log(header.replace(/^#!.*\n/, '').replace(/^\/\*\*?\s*\n/, '').replace(/^ \* ?/gm, '').trim());
    return 0;
  }

  const repoRoot = path.resolve(__dirname, '..');
  const outPath = path.resolve(opts.out || path.join(repoRoot, 'data', 'schedule.json'));

  const [availCsv, supportedCsv, rapidCsv] = await Promise.all([
    loadTab('availability', opts),
    loadTab('supported', opts),
    loadTab('rapid', opts)
  ]);
  const tabNames = opts.fromDir ? new Map() : await fetchTabNames();

  const availability = parseAvailability(parseCsv(availCsv));
  const supportedExperiments = parseSupported(parseCsv(supportedCsv));
  const rapidResponse = parseRapid(parseCsv(rapidCsv));

  // Cross-tab integrity: every ANSIR code shown on the Availability tab should
  // also appear on the Supported Experiments tab. A mismatch is normally a typo
  // in one of the two, so it is worth surfacing, but it is not fatal - an
  // approval can legitimately be recorded on one tab before the other.
  const supportedCodes = new Set(supportedExperiments.map((s) => s.ansirCode).filter(Boolean));
  for (const e of availability.experiments) {
    if (e.ansirCode && !supportedCodes.has(e.ansirCode)) {
      warn(
        TABS.availability.label,
        `Experiment "${e.label}" carries code ${e.ansirCode}, which has no matching row on the "${TABS.supported.label}" tab.`,
        'Experiment "' + e.name + '" is recorded with the ANSIR reference ' + e.ansirCode +
          ', which has no matching entry in the approved-application register.'
      );
    }
  }

  const availabilityTabName = tabNames.get(TABS.availability.gid) || null;

  const payload = {
    fetched: new Date().toISOString(),
    source: 'ANSIR Seismic Fleet Status',
    sourceUrl: PUB_BASE,
    generatedBy: 'scripts/fetch-schedule.js',
    availabilityTabName,
    availabilityAsOf: parseAsOf(availabilityTabName),
    definitions: availability.definitions,
    totals: {
      categories: availability.categories.length,
      instruments: availability.instrumentCount,
      experiments: availability.experiments.length,
      supportedExperiments: supportedExperiments.length,
      rapidResponse: rapidResponse.length,
      fleetInstruments: availability.categories
        .flatMap((c) => c.instruments)
        .reduce((sum, i) => sum + (i.totalFleet || 0), 0)
    },
    categories: availability.categories,
    experiments: availability.experiments,
    supportedExperiments,
    rapidResponse,
    notes: availability.notes,
    // Reader-facing only. The technical form of every warning, cell references
    // and all, goes to stderr just below, which is what the CI log captures.
    warnings: warnings.filter((w) => w.reader).map((w) => w.reader)
  };

  if (warnings.length) {
    for (const w of warnings) console.error(`warning: ${w.technical}`);
    if (opts.strict) {
      console.error(`\n${warnings.length} warning(s) and --strict was set. Nothing was written.`);
      return 1;
    }
  }

  const json = JSON.stringify(payload, null, 2) + '\n';

  if (opts.stdout) {
    process.stdout.write(json);
    return 0;
  }

  // Avoid a pointless daily commit: if the only difference is the `fetched`
  // timestamp, leave the file alone.
  if (fs.existsSync(outPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      const a = { ...existing, fetched: null };
      const b = { ...payload, fetched: null };
      if (JSON.stringify(a) === JSON.stringify(b)) {
        console.log(`No change since the last run; ${path.relative(repoRoot, outPath)} left untouched.`);
        return 0;
      }
    } catch {
      // Unparseable existing file: overwrite it.
    }
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, json);
  console.log(
    `Wrote ${path.relative(repoRoot, outPath)}: ` +
      `${payload.totals.categories} categories, ${payload.totals.instruments} instruments, ` +
      `${payload.totals.experiments} current experiments, ` +
      `${payload.totals.supportedExperiments} supported experiments, ` +
      `${payload.totals.rapidResponse} rapid response deployments, ` +
      `${payload.totals.fleetInstruments} instruments in the fleet.`
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    if (err instanceof LayoutError) {
      console.error('');
      console.error('ANSIR schedule build failed: the source spreadsheet no longer matches the expected layout.');
      console.error('');
      console.error(`  Tab:     ${err.tab}`);
      console.error(`  Problem: ${err.message}`);
      if (err.hint) console.error(`  Fix:     ${err.hint}`);
      console.error('');
      console.error('  Nothing was written. See docs/SCHEDULE_DATA.md for the full layout contract.');
      console.error('');
      process.exit(1);
    }
    if (err && err.networkFailure) {
      console.error('');
      console.error('ANSIR schedule build failed before any parsing was attempted.');
      console.error(`  ${err.message}`);
      console.error('');
      process.exit(2);
    }
    console.error('ANSIR schedule build failed with an unexpected error:');
    console.error(err && err.stack ? err.stack : err);
    process.exit(2);
  });
