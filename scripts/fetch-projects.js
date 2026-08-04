#!/usr/bin/env node
/**
 * ANSIR Sheet-to-JSON Sync
 *
 * Fetches the published (filtered, public-safe) CSV view of the ANSIR project
 * master list, normalises it to the JSON shape consumed by the website, and
 * writes data/data.json - but only when the content has actually changed.
 *
 * This replaces the Google Apps Script "publish to GitHub" step. The mapping
 * from sheet columns to JSON is a faithful port of transformProjectForExport()
 * in the retired dashboard script (2026_code_18.gs).
 *
 * Environment:
 *   ANSIR_PROJECTS_CSV_URL  Required. Published CSV URL of the filtered tab.
 *                           Supports http(s):// and file:// (file:// is for
 *                           local testing only).
 *
 * Usage:
 *   ANSIR_PROJECTS_CSV_URL="https://docs.google.com/.../pub?gid=0&single=true&output=csv" \
 *     node scripts/fetch-projects.js
 *
 * Exit codes:
 *   0  Success (data written, or already up to date)
 *   1  Failure (missing config, fetch/HTTP error, HTML response, zero rows,
 *      write error). Fails loudly rather than publishing an empty file.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');

const DATA_PATH = path.join(__dirname, '..', 'data', 'data.json');
const SOURCE_NAME = process.env.ANSIR_PROJECTS_SHEET_NAME || 'ANSIR_Projects_MasterList';
const FETCH_TIMEOUT_MS = 30000;

// ---------------------------------------------------------------------------
// Column allowlist
// ---------------------------------------------------------------------------
// The master sheet has 73 columns. Only the columns below are ever read.
// Everything else (contributor_email, description_indigenous_data_governance,
// indigenous_data_sensitivity_flag, internal review notes, and so on) is
// deliberately private and must never reach data/data.json.
//
// This allowlist is a second line of defence: even if someone accidentally
// widens the published =FILTER() range in the Sheet, private columns are
// dropped here before any transform runs.
const PUBLIC_COLUMNS = new Set([
  // Filter flag (consumed, never exported)
  'visible',
  // Identifiers
  'alternative_identifier_id',
  'alternative_identifier_ansir_code',
  // Project basics
  'title_primary',
  'title_acronym',
  'description_primary',
  'project_status',
  'project_keywords',
  'methods_field',
  // Dates
  'date_start_date',
  'date_end_date',
  // Location
  'location_region',
  'location_country',
  'location_coordinates',
  'location_polygon',
  // Contributors
  'contributor_name',
  'contributor_honoury_title',
  'contributor_id',
  'contributor_position_id',
  'contributor_is_contact',
  'contributor_leader',
  // Organisations
  'organisation_name',
  'organisation_id',
  'organisation_role_id',
  // Funding
  'funding_agency_name',
  'funding_title',
  'funding_identifier',
  'funding_identifier_type',
  'funding_agency_ror',
  'funding_agency_location',
  // Instrumentation
  'instrumentation_type',
  'instrumentation_numbers',
  // Collection
  'collection_quantity',
  'collection_site_names',
  'collection_site_lats',
  'collection_site_longs',
  'collection_site_alt',
  'collection_site_start_time',
  'collection_site_finish_time',
  'collection_site_instrument',
  'collection_site_instrument_serial',
  // Related objects
  'related_object_identifier',
  'related_object_type',
  // Access and Indigenous governance (public-facing summaries only)
  'data_access',
  'indigenous_involvement_flag',
  'description_indigenous_engagement_summary',
  'description_indigenous_acknowledgement'
]);

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

const warnings = [];

function warn(rowLabel, message) {
  const line = rowLabel ? `[warn] ${rowLabel}: ${message}` : `[warn] ${message}`;
  warnings.push(line);
  process.stderr.write(line + '\n');
}

function info(message) {
  process.stdout.write(message + '\n');
}

function fail(message) {
  process.stderr.write(`[error] ${message}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// CSV parser (RFC 4180)
// ---------------------------------------------------------------------------

/**
 * Parses CSV text into an array of string arrays.
 *
 * Handles:
 *   - quoted fields containing commas
 *   - embedded newlines (LF and CRLF) inside quoted fields
 *   - escaped double quotes ("") inside quoted fields
 *   - a UTF-8 byte order mark at the start of the file
 *   - a trailing newline at end of file
 *
 * @param {string} text Raw CSV text
 * @returns {string[][]} Rows of fields
 */
function parseCSV(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let fieldWasQuoted = false;
  let i = 0;
  const len = text.length;

  function endField() {
    row.push(fieldWasQuoted ? field : field.trim());
    field = '';
    fieldWasQuoted = false;
  }

  function endRow() {
    endField();
    // Drop rows that are entirely empty (e.g. a trailing blank line).
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  }

  while (i < len) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'; // escaped double quote
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      fieldWasQuoted = true;
      i++;
      continue;
    }

    if (ch === ',') {
      endField();
      i++;
      continue;
    }

    if (ch === '\r') {
      // CRLF or lone CR both terminate the record
      if (text[i + 1] === '\n') i++;
      endRow();
      i++;
      continue;
    }

    if (ch === '\n') {
      endRow();
      i++;
      continue;
    }

    field += ch;
    i++;
  }

  if (inQuotes) {
    warn(null, 'CSV ended inside an unterminated quoted field; the final record may be truncated');
  }

  // Flush the last record if the file did not end with a newline.
  if (field !== '' || row.length > 0) endRow();

  return rows;
}

// ---------------------------------------------------------------------------
// Value helpers (ported from transformProjectForExport)
// ---------------------------------------------------------------------------

function splitSemicolon(val) {
  if (val === null || val === undefined || val === '') return [];
  return String(val).split(';').map(s => s.trim()).filter(Boolean);
}

function splitComma(val) {
  if (val === null || val === undefined || val === '') return [];
  return String(val).split(',').map(s => s.trim()).filter(Boolean);
}

function parseBool(val) {
  return String(val === null || val === undefined ? '' : val).toUpperCase().trim() === 'TRUE';
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SLASH_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/; // Australian d/m/yyyy

/**
 * Normalises a date cell to YYYY-MM-DD. Google's CSV export renders dates as
 * text, so this accepts ISO, ISO datetime, and d/m/yyyy. Anything else is
 * passed through unchanged and reported as a data-quality warning.
 */
function formatDate(val, rowLabel, fieldName) {
  const raw = String(val === null || val === undefined ? '' : val).trim();
  if (!raw) return '';

  if (ISO_DATE.test(raw)) {
    const d = new Date(raw + 'T00:00:00Z');
    if (Number.isNaN(d.getTime())) {
      warn(rowLabel, `${fieldName} "${raw}" is not a valid calendar date`);
    }
    return raw;
  }

  const iso = raw.match(/^(\d{4}-\d{2}-\d{2})T/);
  if (iso) return iso[1];

  const slash = raw.match(SLASH_DATE);
  if (slash) {
    const day = slash[1].padStart(2, '0');
    const month = slash[2].padStart(2, '0');
    return `${slash[3]}-${month}-${day}`;
  }

  warn(rowLabel, `${fieldName} "${raw}" could not be parsed as a date; exported verbatim`);
  return raw;
}

/**
 * Validates a "lat, lon" coordinate string. Returns the string unchanged
 * (the site consumes it as text) but warns when it is malformed.
 */
function checkCoordinates(val, rowLabel, fieldName) {
  const raw = String(val === null || val === undefined ? '' : val).trim();
  if (!raw) return '';

  const parts = raw.split(',').map(s => s.trim());
  if (parts.length !== 2) {
    warn(rowLabel, `${fieldName} "${raw}" is not a "latitude, longitude" pair`);
    return raw;
  }

  const lat = Number(parts[0]);
  const lon = Number(parts[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    warn(rowLabel, `${fieldName} "${raw}" contains a non-numeric value`);
  } else if (lat < -90 || lat > 90) {
    warn(rowLabel, `${fieldName} latitude ${lat} is outside the range -90 to 90`);
  } else if (lon < -180 || lon > 180) {
    warn(rowLabel, `${fieldName} longitude ${lon} is outside the range -180 to 180`);
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Transform
// ---------------------------------------------------------------------------

/**
 * Transforms one allowlisted sheet row into the published project object.
 * Field order matters: it is preserved so git diffs stay minimal.
 */
function transformProject(raw, rowLabel) {
  const get = key => {
    const v = raw[key];
    return v === null || v === undefined ? '' : String(v);
  };

  // --- Contributors: parallel columns zipped positionally -----------------
  const names = splitSemicolon(get('contributor_name'));
  const titles = splitSemicolon(get('contributor_honoury_title'));
  const ids = splitSemicolon(get('contributor_id'));
  const positions = splitSemicolon(get('contributor_position_id'));
  const contacts = splitSemicolon(get('contributor_is_contact'));
  const leaders = splitSemicolon(get('contributor_leader'));
  const orgs = splitSemicolon(get('organisation_name'));
  const orgRors = splitSemicolon(get('organisation_id'));
  const orgRoles = splitSemicolon(get('organisation_role_id'));

  const maxContrib = Math.max(names.length, titles.length, ids.length);
  if (names.length && orgs.length && orgs.length !== names.length) {
    warn(rowLabel, `contributor_name has ${names.length} entries but organisation_name has ${orgs.length}; positional pairing may be wrong`);
  }

  const contributors = [];
  for (let i = 0; i < maxContrib; i++) {
    if (!names[i]) continue;
    contributors.push({
      name: names[i] || '',
      title: titles[i] || '',
      orcid: ids[i] || '',
      position: positions[i] || '',
      organisation: orgs[i] || '',
      organisationRor: orgRors[i] || '',
      organisationRole: orgRoles[i] || '',
      isContact: parseBool(contacts[i]),
      isLeader: parseBool(leaders[i])
    });
  }

  // --- Funding -------------------------------------------------------------
  const fundAgencies = splitSemicolon(get('funding_agency_name'));
  const fundTitles = splitSemicolon(get('funding_title'));
  const fundIds = splitSemicolon(get('funding_identifier'));
  const fundIdTypes = splitSemicolon(get('funding_identifier_type'));
  const fundAgencyRors = splitSemicolon(get('funding_agency_ror'));
  const fundAgencyLocations = splitSemicolon(get('funding_agency_location'));

  const maxFund = Math.max(fundAgencies.length, fundTitles.length, fundIds.length);
  const funding = [];
  for (let f = 0; f < maxFund; f++) {
    if (!fundAgencies[f] && !fundTitles[f] && !fundIds[f]) continue;
    funding.push({
      agency: fundAgencies[f] || '',
      title: fundTitles[f] || '',
      identifier: fundIds[f] || '',
      identifierType: fundIdTypes[f] || '',
      agencyRor: fundAgencyRors[f] || '',
      agencyLocation: fundAgencyLocations[f] || ''
    });
  }

  // --- Instruments ---------------------------------------------------------
  // instrumentation_numbers is either "Name: 5" or a bare "5".
  const instTypes = splitSemicolon(get('instrumentation_type'));
  const instNums = splitSemicolon(get('instrumentation_numbers'));
  const instruments = [];
  for (let n = 0; n < instTypes.length; n++) {
    if (!instTypes[n]) continue;
    let count = 1;
    const numStr = (instNums[n] || '').trim();
    const numMatch = numStr.match(/:?\s*(\d+)\s*$/);
    if (numMatch) {
      count = parseInt(numMatch[1], 10) || 1;
    } else if (!Number.isNaN(parseInt(numStr, 10))) {
      count = parseInt(numStr, 10);
    }
    instruments.push({ name: instTypes[n], count: count });
  }

  // --- Collection sites ----------------------------------------------------
  const siteNames = splitSemicolon(get('collection_site_names'));
  const siteLats = splitSemicolon(get('collection_site_lats'));
  const siteLongs = splitSemicolon(get('collection_site_longs'));
  const siteAlts = splitSemicolon(get('collection_site_alt'));
  const siteStarts = splitSemicolon(get('collection_site_start_time'));
  const siteFinishes = splitSemicolon(get('collection_site_finish_time'));
  const siteInstruments = splitSemicolon(get('collection_site_instrument'));
  const siteSerials = splitSemicolon(get('collection_site_instrument_serial'));

  const maxSites = Math.max(siteNames.length, siteLats.length, siteLongs.length);
  if (siteNames.length && siteLats.length && siteNames.length !== siteLats.length) {
    warn(rowLabel, `collection_site_names has ${siteNames.length} entries but collection_site_lats has ${siteLats.length}; positional pairing may be wrong`);
  }

  const collectionSites = [];
  for (let s = 0; s < maxSites; s++) {
    if (!siteNames[s] && !siteLats[s] && !siteLongs[s]) continue;
    const lat = parseFloat(siteLats[s]);
    const lon = parseFloat(siteLongs[s]);
    if (siteLats[s] && (!Number.isFinite(lat) || lat < -90 || lat > 90)) {
      warn(rowLabel, `collection site "${siteNames[s] || s + 1}" latitude "${siteLats[s]}" is invalid or outside -90 to 90`);
    }
    if (siteLongs[s] && (!Number.isFinite(lon) || lon < -180 || lon > 180)) {
      warn(rowLabel, `collection site "${siteNames[s] || s + 1}" longitude "${siteLongs[s]}" is invalid or outside -180 to 180`);
    }
    const site = {
      name: siteNames[s] || '',
      latitude: Number.isFinite(lat) ? lat : null,
      longitude: Number.isFinite(lon) ? lon : null
    };
    // Optional keys are only present when populated, matching the published shape.
    if (siteAlts[s]) site.altitude = siteAlts[s];
    if (siteStarts[s]) site.startTime = siteStarts[s];
    if (siteFinishes[s]) site.finishTime = siteFinishes[s];
    if (siteInstruments[s]) site.instrument = siteInstruments[s];
    if (siteSerials[s]) site.serial = siteSerials[s];
    collectionSites.push(site);
  }

  // --- Related objects -----------------------------------------------------
  // title/authors/journal/year are added later by scripts/resolve-dois.js.
  const relIds = splitSemicolon(get('related_object_identifier'));
  const relTypes = splitSemicolon(get('related_object_type'));
  const relatedObjects = [];
  for (let r = 0; r < relIds.length; r++) {
    if (!relIds[r]) continue;
    relatedObjects.push({
      identifier: relIds[r],
      type: (relTypes[r] || '').toLowerCase()
    });
  }

  return {
    id: get('alternative_identifier_id'),
    ansirCode: get('alternative_identifier_ansir_code'),
    title: get('title_primary'),
    acronym: get('title_acronym'),
    description: get('description_primary'),
    status: get('project_status'),
    startDate: formatDate(get('date_start_date'), rowLabel, 'date_start_date'),
    endDate: formatDate(get('date_end_date'), rowLabel, 'date_end_date'),
    methods: splitComma(get('methods_field')),
    keywords: splitComma(get('project_keywords')),
    location: {
      region: get('location_region'),
      country: get('location_country'),
      coordinates: checkCoordinates(get('location_coordinates'), rowLabel, 'location_coordinates'),
      polygon: get('location_polygon')
    },
    contributors: contributors,
    funding: funding,
    instruments: instruments,
    collectionQuantity: parseInt(get('collection_quantity'), 10) || 0,
    collectionSites: collectionSites,
    relatedObjects: relatedObjects,
    dataAccess: get('data_access'),
    indigenousInvolvement: parseBool(get('indigenous_involvement_flag')),
    indigenousEngagement: get('description_indigenous_engagement_summary'),
    indigenousAcknowledgement: get('description_indigenous_acknowledgement')
  };
}

// ---------------------------------------------------------------------------
// Data-quality checks
// ---------------------------------------------------------------------------

const REQUIRED_FIELDS = [
  ['id', 'alternative_identifier_id'],
  ['ansirCode', 'alternative_identifier_ansir_code'],
  ['title', 'title_primary'],
  ['status', 'project_status']
];

function checkRequiredFields(project, rowLabel) {
  for (const [key, column] of REQUIRED_FIELDS) {
    if (!String(project[key] || '').trim()) {
      warn(rowLabel, `required field ${column} is empty`);
    }
  }
  if (!project.contributors.length) {
    warn(rowLabel, 'no contributors listed');
  }
  if (!project.description.trim()) {
    warn(rowLabel, 'description_primary is empty');
  }
}

/**
 * Collapses a controlled-vocabulary value so that entries differing only by
 * case, internal whitespace, punctuation or a dangling conjunction land on the
 * same key. "SA Department for Energy and Mining and" collapses onto
 * "SA Department for Energy and Mining".
 */
function normaliseVocab(value) {
  let v = String(value).toLowerCase().trim().replace(/\s+/g, ' ');
  v = v.replace(/[.,;:]+$/, '');
  // Strip repeated trailing conjunctions ("... and", "... &", "... and and").
  let previous;
  do {
    previous = v;
    v = v.replace(/\s+(and|&|\+|or)$/, '').trim();
  } while (v !== previous);
  return v;
}

/** Levenshtein distance, capped for speed. */
function editDistance(a, b) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 2) return 99;
  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

/**
 * Reports controlled-vocabulary values that look like accidental variants of
 * one another: same value after normalisation, or within a small edit distance
 * (catches misspellings such as "Antartica" alongside "Antarctica").
 */
function checkVocabulary(label, occurrences) {
  // occurrences: Map<rawValue, Set<rowLabel>>
  const groups = new Map();
  for (const raw of occurrences.keys()) {
    const key = normaliseVocab(raw);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(raw);
  }

  for (const [, variants] of groups) {
    if (variants.length > 1) {
      warn(null, `${label} values differ only by case, spacing or a trailing conjunction: ${variants.map(v => `"${v}"`).join(', ')}`);
    }
  }

  const keys = [...groups.keys()].sort();
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      if (keys[i].length < 5 || keys[j].length < 5) continue;
      const d = editDistance(keys[i], keys[j]);
      if (d > 0 && d <= 2) {
        const a = groups.get(keys[i]).join('/');
        const b = groups.get(keys[j]).join('/');
        warn(null, `${label} values "${a}" and "${b}" are near-identical (edit distance ${d}); one is probably a misspelling`);
      }
    }
  }

  // A trailing conjunction is always a data-entry slip, even if unique.
  for (const raw of occurrences.keys()) {
    if (/\s+(and|&|\+|or)\s*$/i.test(raw)) {
      const rows = [...occurrences.get(raw)].join(', ');
      warn(null, `${label} value "${raw}" ends in a dangling conjunction (rows: ${rows})`);
    }
  }
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

async function loadCSV(url) {
  if (url.startsWith('file://')) {
    // Local testing path. Node's fetch() does not implement the file: scheme.
    const filePath = fileURLToPath(url);
    info(`Reading local CSV: ${filePath}`);
    return fs.readFileSync(filePath, 'utf8');
  }

  if (!/^https?:\/\//i.test(url)) {
    fail(`ANSIR_PROJECTS_CSV_URL must be an http://, https:// or file:// URL (got "${url}")`);
  }

  info(`Fetching CSV: ${url.replace(/([?&](key|token)=)[^&]*/gi, '$1REDACTED')}`);

  let response;
  try {
    response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        'User-Agent': 'ANSIR-GitHubAction/1.0 (+https://github.com/AuScope)',
        'Accept': 'text/csv,text/plain'
      }
    });
  } catch (err) {
    fail(`could not reach the published sheet: ${err.message}. Check that ANSIR_PROJECTS_CSV_URL is correct and that the network is available.`);
  }

  if (!response.ok) {
    let hint = '';
    if (response.status === 401 || response.status === 403) {
      hint = ' The tab is not published to the web, or publishing was revoked. Re-publish it via File > Share > Publish to web.';
    } else if (response.status === 404) {
      hint = ' The gid in the URL no longer matches a published tab.';
    }
    fail(`HTTP ${response.status} ${response.statusText} fetching the published sheet.${hint}`);
  }

  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  const body = await response.text();

  const looksLikeHTML = contentType.includes('text/html') ||
    /^\s*(<!doctype html|<html\b)/i.test(body);
  if (looksLikeHTML) {
    fail(
      'the sheet returned an HTML page instead of CSV. This almost always means the tab is not actually published to the web, ' +
      'or the URL points at the Sheets editor rather than the published CSV. Use File > Share > Publish to web, choose the ' +
      'single public tab, select "Comma-separated values (.csv)", and copy that URL.'
    );
  }

  info(`Received ${body.length} bytes (content-type: ${contentType || 'unknown'})`);
  return body;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/**
 * Carries forward DOI metadata that scripts/resolve-dois.js previously
 * resolved. Without this, every sync would strip title/authors/journal/year
 * from relatedObjects and force a full re-resolution against CrossRef and
 * DataCite, producing a second commit every single day.
 */
function preserveResolvedDOIs(projects, existing) {
  if (!existing || !Array.isArray(existing.data)) return 0;

  const cache = new Map();
  for (const project of existing.data) {
    for (const obj of project.relatedObjects || []) {
      if (!obj || !obj.identifier) continue;
      if (obj.title || obj.authors || obj.year) {
        cache.set(String(obj.identifier).trim().toLowerCase(), obj);
      }
    }
  }

  let restored = 0;
  for (const project of projects) {
    for (const obj of project.relatedObjects) {
      const hit = cache.get(String(obj.identifier).trim().toLowerCase());
      if (!hit) continue;
      if (hit.title !== undefined) obj.title = hit.title;
      if (hit.authors !== undefined) obj.authors = hit.authors;
      if (hit.journal !== undefined) obj.journal = hit.journal;
      if (hit.year !== undefined) obj.year = hit.year;
      restored++;
    }
  }
  return restored;
}

/** Compares payloads ignoring the volatile 'exported' timestamp. */
function contentEquals(a, b) {
  if (!a || !b) return false;
  const strip = payload => {
    const { exported, ...rest } = payload;
    return JSON.stringify(rest);
  };
  return strip(a) === strip(b);
}

function readExisting() {
  try {
    return JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      warn(null, `could not read the existing ${path.relative(process.cwd(), DATA_PATH)}: ${err.message}`);
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const url = (process.env.ANSIR_PROJECTS_CSV_URL || '').trim();
  if (!url) {
    fail('ANSIR_PROJECTS_CSV_URL is not set. In GitHub Actions this comes from the repository variable of the same name (Settings > Secrets and variables > Actions > Variables).');
  }

  const csv = await loadCSV(url);
  const rows = parseCSV(csv);

  if (rows.length === 0) {
    fail('the published sheet contained no rows at all. Refusing to write an empty data.json.');
  }

  const headers = rows[0].map(h => String(h).trim().toLowerCase());
  const dataRows = rows.slice(1);

  const known = headers.filter(h => PUBLIC_COLUMNS.has(h));
  const dropped = headers.filter(h => h && !PUBLIC_COLUMNS.has(h));
  info(`Parsed ${dataRows.length} data rows, ${headers.length} columns (${known.length} recognised).`);
  if (dropped.length) {
    warn(null, `ignoring ${dropped.length} column(s) not on the public allowlist: ${dropped.join(', ')}`);
  }

  const missingCore = ['alternative_identifier_id', 'title_primary'].filter(c => !known.includes(c));
  if (missingCore.length) {
    fail(`the published sheet is missing essential column(s): ${missingCore.join(', ')}. The =FILTER() formula on the public tab has probably been changed.`);
  }

  const hasVisibleColumn = headers.includes('visible');
  const projects = [];
  const countries = new Map();
  const agencies = new Map();
  const seenIds = new Map();

  dataRows.forEach((row, index) => {
    const sheetRow = index + 2; // 1-based, accounting for the header row

    // Skip completely blank rows (common at the bottom of a =FILTER() range).
    if (row.every(cell => String(cell).trim() === '')) return;

    const raw = {};
    headers.forEach((header, col) => {
      if (PUBLIC_COLUMNS.has(header)) raw[header] = row[col] !== undefined ? row[col] : '';
    });

    // Defence in depth: the public tab should already filter on visible=TRUE,
    // but honour the column if it is present.
    if (hasVisibleColumn && !parseBool(raw.visible)) return;

    const rowLabel = `row ${sheetRow}` +
      (raw.alternative_identifier_ansir_code ? ` (${String(raw.alternative_identifier_ansir_code).trim()})` : '');

    const project = transformProject(raw, rowLabel);
    checkRequiredFields(project, rowLabel);

    if (project.id) {
      if (seenIds.has(project.id)) {
        warn(rowLabel, `duplicate id "${project.id}" (also used by ${seenIds.get(project.id)})`);
      } else {
        seenIds.set(project.id, rowLabel);
      }
    }

    const country = project.location.country.trim();
    if (country) {
      if (!countries.has(country)) countries.set(country, new Set());
      countries.get(country).add(rowLabel);
    }
    for (const f of project.funding) {
      const agency = f.agency.trim();
      if (!agency) continue;
      if (!agencies.has(agency)) agencies.set(agency, new Set());
      agencies.get(agency).add(rowLabel);
    }

    projects.push(project);
  });

  if (projects.length === 0) {
    fail('zero projects were parsed from the published sheet. Refusing to write an empty data.json. Check the =FILTER() formula and the visible column.');
  }

  checkVocabulary('location_country', countries);
  checkVocabulary('funding_agency_name', agencies);

  const existing = readExisting();
  const restored = preserveResolvedDOIs(projects, existing);
  if (restored) info(`Carried forward resolved DOI metadata for ${restored} related object(s).`);

  const payload = {
    success: true,
    exported: new Date().toISOString(),
    source: SOURCE_NAME,
    projectCount: projects.length,
    data: projects
  };

  info(`Transformed ${projects.length} project(s). Warnings: ${warnings.length}.`);

  if (contentEquals(existing, payload)) {
    info('No content change since the last sync; leaving data/data.json untouched.');
    return;
  }

  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  // 2-space indent, no trailing newline: matches the file the dashboard wrote,
  // so the first git diff after the migration is content-only.
  fs.writeFileSync(DATA_PATH, JSON.stringify(payload, null, 2), 'utf8');
  info(`Wrote ${path.relative(process.cwd(), DATA_PATH)} (${projects.length} projects).`);
}

main().catch(err => {
  fail(err && err.stack ? err.stack : String(err));
});
