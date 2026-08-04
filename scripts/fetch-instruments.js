#!/usr/bin/env node
/**
 * fetch-instruments.js
 *
 * Fetches the AuScope instrument registry (PIDINST) from the public DataCite
 * API and normalises it into data/instrument-register.json.
 *
 * Every physical instrument in the registry has its own DOI, so a model's fleet
 * total is simply the number of instrument records carrying that model. This
 * script fetches the whole DataCite prefix, splits platform records from
 * instrument records, extracts a model string per instrument, and groups.
 *
 * It is deliberately GENERIC. The registry holds the University of Adelaide
 * magnetotelluric gear today and will grow: nothing here is hardcoded to MT, to
 * Adelaide, or to the eight surveys currently registered. Classification and
 * owner are carried through as facets so consumers can filter.
 *
 * Node 22+. No npm dependencies. Uses built-in fetch.
 *
 * Usage:
 *   node scripts/fetch-instruments.js                 fetch live, write the JSON
 *   node scripts/fetch-instruments.js --from-file F   read a saved DataCite
 *                                                     response instead of the
 *                                                     network (offline tests)
 *   node scripts/fetch-instruments.js --out FILE      write somewhere else
 *   node scripts/fetch-instruments.js --strict        treat warnings as fatal
 *   node scripts/fetch-instruments.js --stdout        print JSON, do not write
 *
 * Environment overrides (all optional, all public values):
 *   ANSIR_PIDINST_API        DataCite DOIs endpoint
 *   ANSIR_PIDINST_PREFIX     DataCite prefix to harvest
 *   ANSIR_PIDINST_PAGE_SIZE  page size (used to exercise pagination in tests)
 *
 * Exit codes:
 *   0  success (file written, or already up to date)
 *   1  the registry no longer matches the expected shape - nothing written
 *   2  network or I/O failure
 *
 * See docs/PIDINST.md for the registry contract and the known upstream defect.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// DataCite's public API. No authentication: the registry is open data, which is
// what makes this usable from the pure-git pipeline with no credentials.
const API = process.env.ANSIR_PIDINST_API || 'https://api.datacite.org/dois';
const PREFIX = process.env.ANSIR_PIDINST_PREFIX || '10.82388';
const PAGE_SIZE = Number(process.env.ANSIR_PIDINST_PAGE_SIZE || 1000);

const REGISTRY_URL = 'https://pidinst.data.auscope.org.au/';
const FETCH_TIMEOUT_MS = 30000;

// Defensive pagination. The prefix holds ~160 DOIs today, so one page of 1000
// covers it many times over, but the registry is expected to grow and DataCite
// caps page[size] at 1000. links.next is followed until it stops appearing.
const MAX_PAGES = 100;

// If the registry ever returns fewer instruments than this, something has gone
// wrong upstream (wrong prefix, a truncated response, an API change) and we must
// not publish a number that would understate the fleet on a public page.
const MIN_INSTRUMENTS = 1;

// A platform record is a survey campaign, not a device. Two independent signals
// identify one in the live data, and both are checked so that a disagreement is
// surfaced rather than silently resolved:
//
//   1. it carries HasPart relations naming its member instruments (8/8 today);
//   2. its "Instrument Type:" technical description reads FIELD SURVEYS,
//      where instrument records carry a device taxonomy term instead.
//
// resourceTypeGeneral and resourceType do NOT distinguish them: all 160 records
// are Instrument / Geophysics.
const PLATFORM_INSTRUMENT_TYPE = /field\s+surveys/i;

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

class RegistryError extends Error {
  constructor(message, hint) {
    super(message);
    this.hint = hint;
  }
}

/**
 * Warnings carry two forms, matching scripts/fetch-schedule.js.
 *
 *   technical - names the DOI and the exact field, for whoever maintains the
 *               registry. Printed to stderr so it lands in the CI log.
 *   reader    - plain words naming the instrument rather than a field path.
 *               This is the only form written into the JSON, because the
 *               schedule page shows it to researchers.
 *
 * A warning with no reader form (an upstream metadata defect, say) stays in the
 * log and is not published.
 */
const warnings = [];
function warn(technical, reader) {
  warnings.push({
    technical,
    reader: reader ? String(reader).replace(/\s+/g, ' ').trim() : null
  });
}

function fail(message, hint) {
  throw new RegistryError(message, hint);
}

// ---------------------------------------------------------------------------
// Field accessors
// ---------------------------------------------------------------------------

function clean(v) {
  return String(v ?? '').replace(/\s+/g, ' ').trim();
}

/** Normalise any DOI form - bare, http, https, doi.org, dx.doi.org - to "10.x/suffix". */
function normaliseDoi(raw) {
  const v = clean(raw)
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^doi:/i, '');
  return v.toLowerCase();
}

function titleOf(record) {
  const titles = record.attributes && record.attributes.titles;
  if (!Array.isArray(titles)) return '';
  for (const t of titles) {
    const v = clean(t && t.title);
    if (v) return v;
  }
  return '';
}

/** All TechnicalInfo/other description strings, for "Key: value" scanning. */
function descriptionLines(record) {
  const descs = (record.attributes && record.attributes.descriptions) || [];
  if (!Array.isArray(descs)) return [];
  return descs.map((d) => clean(d && d.description)).filter(Boolean);
}

/**
 * Pull the value of a "Key: value" technical description, dropping any trailing
 * "(URI: ...)" or "(URL: ...)" vocabulary reference. The registry uses both
 * spellings, sometimes on the same record.
 */
function technicalValues(record, key) {
  const re = new RegExp('^' + key + '\\s*:\\s*(.+)$', 'i');
  const out = [];
  for (const line of descriptionLines(record)) {
    const m = re.exec(line);
    if (!m) continue;
    const value = clean(m[1].replace(/\s*\(UR[LI]\s*:.*$/i, ''));
    if (value) out.push(value);
  }
  return out;
}

function relatedIdentifiers(record, relationType) {
  const rel = (record.attributes && record.attributes.relatedIdentifiers) || [];
  if (!Array.isArray(rel)) return [];
  return rel.filter((r) => r && clean(r.relationType).toLowerCase() === relationType.toLowerCase());
}

/**
 * The owning organisation. PIDINST records it as a contributor with
 * contributorType HostingInstitution; the ROR identifier is kept alongside so a
 * future consumer can join on something better than a name string.
 */
function ownerOf(record) {
  const contributors = (record.attributes && record.attributes.contributors) || [];
  if (!Array.isArray(contributors)) return { name: null, ror: null };
  for (const c of contributors) {
    if (!c || clean(c.contributorType) !== 'HostingInstitution') continue;
    const name = clean(c.name);
    if (!name) continue;
    let ror = null;
    for (const id of c.nameIdentifiers || []) {
      if (id && clean(id.nameIdentifierScheme).toUpperCase() === 'ROR') {
        ror = clean(id.nameIdentifier) || null;
        break;
      }
    }
    return { name, ror };
  }
  return { name: null, ror: null };
}

/** The classification facet: DataCite resourceType, e.g. "Geophysics". */
function classificationOf(record) {
  const types = (record.attributes && record.attributes.types) || {};
  return clean(types.resourceType) || null;
}

// ---------------------------------------------------------------------------
// Platform / instrument classification
// ---------------------------------------------------------------------------

function isPlatform(record) {
  const hasPart = relatedIdentifiers(record, 'HasPart').length > 0;
  const fieldSurvey = technicalValues(record, 'Instrument Type').some((v) => PLATFORM_INSTRUMENT_TYPE.test(v));

  // The two signals agree on every record in the live registry. If they ever
  // disagree, treat the record as a platform - counting a survey as a device
  // would inflate a published fleet total, which is the worse error - and say so
  // in the log rather than resolving it silently.
  if (hasPart !== fieldSurvey) {
    warn(
      `${record.id}: platform signals disagree - ` +
        `${hasPart ? 'has' : 'has no'} HasPart relations but ` +
        `${fieldSurvey ? 'is' : 'is not'} typed "FIELD SURVEYS". ` +
        'Treated as a platform, so it is NOT counted towards any model fleet total.',
      null
    );
  }
  return hasPart || fieldSurvey;
}

// ---------------------------------------------------------------------------
// Model extraction
// ---------------------------------------------------------------------------

// A manufacturer model code: letters, then a hyphen, then digits, with optional
// trailing suffix. Matches LEMI-120, MTC-150, MTU-5C, PR6-24.
const MODEL_CODE = /\b([A-Za-z]{2,}[A-Za-z0-9]*-[0-9]+[A-Za-z0-9]*)\b/;

/**
 * A record's model, in descending order of trust.
 *
 *   model-field       an explicit "Model: X" technical description. Authoritative.
 *   title-vocabulary  a model string that some OTHER record stated explicitly,
 *                     found in this record's title. Data-attested, not guessed:
 *                     this is what rescues the 24 "Earth Data PR6-24 Logger"
 *                     records that omit the Model field, and unites them with
 *                     the one sibling record that declares "Model: PR6-24".
 *   title-pattern     a model-shaped code in the title and nothing better.
 *   null              no model at all - the caller groups it under its title
 *                     and flags it.
 *
 * `vocabulary` is the set of model strings collected from every explicit Model
 * field in the whole harvest, so the pass order is: collect, then resolve.
 */
function extractModel(record, vocabulary) {
  const declared = technicalValues(record, 'Model');
  if (declared.length) {
    if (declared.length > 1) {
      const unique = [...new Set(declared.map((v) => v.toLowerCase()))];
      if (unique.length > 1) {
        warn(
          `${record.id}: ${declared.length} different "Model:" values (${declared.join(', ')}); the first was used.`,
          null
        );
      }
    }
    return { model: declared[0], source: 'model-field' };
  }

  const title = titleOf(record);
  if (title) {
    // Longest first, so "LEMI-4231" would never be shadowed by "LEMI-423".
    const known = [...vocabulary.values()].sort((a, b) => b.length - a.length);
    for (const candidate of known) {
      const re = new RegExp('(?:^|[^A-Za-z0-9])' + candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9])', 'i');
      if (re.test(title)) return { model: candidate, source: 'title-vocabulary' };
    }
    const m = MODEL_CODE.exec(title);
    if (m) return { model: m[1], source: 'title-pattern' };
  }

  return { model: null, source: null };
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

async function fetchJson(url, what) {
  let res;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      headers: { accept: 'application/json', 'user-agent': 'ansir-web fetch-instruments.js' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
  } catch (err) {
    const e = new Error(`Could not reach the DataCite API for ${what}: ${err.message}`);
    e.networkFailure = true;
    throw e;
  }
  if (!res.ok) {
    const e = new Error(
      `The DataCite API returned HTTP ${res.status} for ${what} (${url}). ` +
        'The prefix may have changed, or the API may be unavailable.'
    );
    e.networkFailure = true;
    throw e;
  }
  const body = await res.text();
  if (body.trim() === '') {
    const e = new Error(`The DataCite API returned an empty body for ${what}.`);
    e.networkFailure = true;
    throw e;
  }
  try {
    return JSON.parse(body);
  } catch (err) {
    const head = body.slice(0, 120).replace(/\s+/g, ' ').trim();
    const e = new Error(
      `The DataCite API returned something that is not JSON for ${what}. ` +
        `The response began: "${head}". ` +
        'Note the registry website itself serves HTML only; this script must talk to api.datacite.org.'
    );
    e.networkFailure = true;
    throw e;
  }
}

function pageUrl(page) {
  const u = new URL(API);
  u.searchParams.set('prefix', PREFIX);
  u.searchParams.set('page[size]', String(PAGE_SIZE));
  if (page > 1) u.searchParams.set('page[number]', String(page));
  return u.toString();
}

/** Harvest every DOI under the prefix, following links.next defensively. */
async function fetchAllRecords() {
  const records = [];
  const seen = new Set();
  let url = pageUrl(1);
  let page = 0;
  let reportedTotal = null;

  while (url) {
    page += 1;
    if (page > MAX_PAGES) {
      fail(
        `Pagination did not terminate after ${MAX_PAGES} pages.`,
        'The DataCite API kept offering a "next" link. Either the registry has grown enormously, ' +
          'or the API is looping. Nothing was written.'
      );
    }
    if (seen.has(url)) {
      warn(`Pagination revisited ${url}; stopped following "next" links there.`, null);
      break;
    }
    seen.add(url);

    const body = await fetchJson(url, `page ${page} of prefix ${PREFIX}`);
    if (!Array.isArray(body.data)) {
      fail(
        `Page ${page} of the DataCite response has no "data" array.`,
        'The API response shape has changed. Nothing was written.'
      );
    }
    if (reportedTotal === null && body.meta && Number.isInteger(body.meta.total)) {
      reportedTotal = body.meta.total;
    }
    records.push(...body.data);
    console.error(`fetched page ${page}: ${body.data.length} record(s), ${records.length} so far`);

    const next = body.links && body.links.next;
    url = next && typeof next === 'string' ? next : null;
  }

  // The API states how many DOIs the prefix holds. If what we assembled does not
  // match, the harvest is incomplete and every count downstream would be wrong.
  if (reportedTotal !== null && records.length !== reportedTotal) {
    fail(
      `DataCite reports ${reportedTotal} DOIs under prefix ${PREFIX} but only ${records.length} were harvested.`,
      'Pagination stopped early. Publishing now would understate every fleet total. Nothing was written.'
    );
  }

  return records;
}

function loadFromFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const e = new Error(`Could not read ${file}: ${err.message}`);
    e.networkFailure = true;
    throw e;
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch (err) {
    const e = new Error(`${file} is not valid JSON: ${err.message}`);
    e.networkFailure = true;
    throw e;
  }
  // Accept either a full DataCite response or a bare array of records.
  const data = Array.isArray(body) ? body : body.data;
  if (!Array.isArray(data)) {
    fail(
      `${file} has no "data" array.`,
      'Expected a saved DataCite /dois response, or a bare JSON array of DOI records.'
    );
  }
  return data;
}

// ---------------------------------------------------------------------------
// Building the register
// ---------------------------------------------------------------------------

function build(records) {
  // --- 1. Split platforms from instruments --------------------------------
  const platformRecords = [];
  const instrumentRecords = [];
  for (const record of records) {
    if (!record || typeof record !== 'object' || !record.id) {
      warn('A record in the DataCite response has no "id"; skipped.', null);
      continue;
    }
    (isPlatform(record) ? platformRecords : instrumentRecords).push(record);
  }

  if (instrumentRecords.length < MIN_INSTRUMENTS) {
    fail(
      `${instrumentRecords.length} instrument records were parsed from ${records.length} DOIs, expected at least ${MIN_INSTRUMENTS}.`,
      'Either the prefix returned nothing, or every record now looks like a platform. ' +
        'Check how platforms are identified (HasPart relations, or an "Instrument Type: FIELD SURVEYS" ' +
        'description) in scripts/fetch-instruments.js. Nothing was written.'
    );
  }

  // --- 2. The known-model vocabulary --------------------------------------
  // Collected before any grouping, so a record that omits its Model field can
  // still be matched against a model string a sibling record declared.
  const vocabulary = new Map(); // lowercase -> canonical casing
  for (const record of instrumentRecords) {
    for (const value of technicalValues(record, 'Model')) {
      const key = value.toLowerCase();
      if (!vocabulary.has(key)) vocabulary.set(key, value);
    }
  }

  // --- 3. Group instruments by model ---------------------------------------
  const groups = new Map(); // lowercase key -> group
  let unresolvedModels = 0;

  for (const record of instrumentRecords) {
    const doi = normaliseDoi(record.id);
    const title = titleOf(record) || null;
    const { model, source } = extractModel(record, vocabulary);
    const owner = ownerOf(record);
    const classification = classificationOf(record);

    let label = model;
    let modelResolved = true;
    if (!label) {
      // No model anywhere. Group under the title instead so the record is still
      // counted and still visible, and flag the group so no consumer mistakes
      // a title for a manufacturer's model designation.
      modelResolved = false;
      unresolvedModels += 1;
      label = title || `Unidentified instrument ${doi}`;
      warn(
        `${doi}: no "Model:" description and no model code in the title ${title ? `"${title}"` : '(no title)'}; ` +
          'grouped under its title and flagged.',
        (title || 'One registered instrument') +
          ': the register does not state a model for this instrument, so it is grouped under its ' +
          'record title rather than a model name.'
      );
    }

    const key = label.toLowerCase();
    let group = groups.get(key);
    if (!group) {
      group = {
        label,
        modelResolved,
        sources: new Set(),
        classifications: new Map(),
        owners: new Map(),
        titles: new Map(),
        dois: []
      };
      groups.set(key, group);
    }
    if (source) group.sources.add(source);
    if (!modelResolved) group.modelResolved = false;
    if (classification) group.classifications.set(classification, (group.classifications.get(classification) || 0) + 1);
    if (owner.name) {
      const existing = group.owners.get(owner.name) || { count: 0, ror: owner.ror };
      existing.count += 1;
      if (!existing.ror && owner.ror) existing.ror = owner.ror;
      group.owners.set(owner.name, existing);
    }
    if (title) group.titles.set(title, (group.titles.get(title) || 0) + 1);
    group.dois.push(doi);
  }

  /** The most frequent value in a count map, ties broken alphabetically for stability. */
  function dominant(map) {
    let best = null;
    for (const [value, count] of map) {
      const n = typeof count === 'object' ? count.count : count;
      if (!best || n > best.n || (n === best.n && value < best.value)) best = { value, n };
    }
    return best ? best.value : null;
  }

  const models = [];
  for (const group of groups.values()) {
    const classification = dominant(group.classifications);
    const ownerName = dominant(group.owners);
    const ownerEntry = ownerName ? group.owners.get(ownerName) : null;

    if (group.classifications.size > 1) {
      warn(
        `Model "${group.label}" spans ${group.classifications.size} classifications ` +
          `(${[...group.classifications.keys()].join(', ')}); "${classification}" published.`,
        group.label +
          ': the register classifies these instruments inconsistently, so the most common classification is shown.'
      );
    }
    if (group.owners.size > 1) {
      warn(
        `Model "${group.label}" spans ${group.owners.size} hosting institutions ` +
          `(${[...group.owners.keys()].join(', ')}); "${ownerName}" published.`,
        group.label +
          ': these instruments are recorded against more than one hosting institution, so the most common one is shown.'
      );
    }
    if (!ownerName) {
      warn(`Model "${group.label}": no HostingInstitution contributor on any of its ${group.dois.length} record(s).`, null);
    }

    models.push({
      model: group.label,
      // false means `model` is a record title, not a manufacturer's designation.
      modelResolved: group.modelResolved,
      // How the string was obtained: model-field (declared), title-vocabulary
      // (a model another record declared, found in this title), title-pattern
      // (a model-shaped code in the title), or none.
      modelSource: [...group.sources].sort().join('+') || 'none',
      classification: classification || null,
      owner: ownerName || null,
      ownerRor: ownerEntry ? ownerEntry.ror || null : null,
      count: group.dois.length,
      title: dominant(group.titles),
      // Raw DOIs are kept so future joins - to platforms, to projects, to
      // utilisation reporting - stay possible without re-fetching.
      dois: group.dois.slice().sort()
    });
  }

  // Count descending, then name ascending. Deterministic ordering matters: the
  // no-change check below compares serialised JSON.
  models.sort((a, b) => b.count - a.count || a.model.localeCompare(b.model));

  // --- 4. Platforms ---------------------------------------------------------
  const instrumentDoiSet = new Set(instrumentRecords.map((r) => normaliseDoi(r.id)));
  const platformDoiSet = new Set(platformRecords.map((r) => normaliseDoi(r.id)));

  const platforms = [];
  for (const record of platformRecords) {
    const doi = normaliseDoi(record.id);
    const members = new Set();
    let dangling = 0;
    let duplicates = 0;

    for (const rel of relatedIdentifiers(record, 'HasPart')) {
      const target = normaliseDoi(rel.relatedIdentifier);
      if (!target) continue;
      if (members.has(target)) {
        duplicates += 1;
        continue;
      }
      if (target === doi) {
        warn(`${doi}: a HasPart relation points at the platform itself; ignored.`, null);
        continue;
      }
      if (platformDoiSet.has(target)) {
        warn(`${doi}: HasPart points at ${target}, which is itself a platform; kept, but it is not an instrument.`, null);
      } else if (!instrumentDoiSet.has(target)) {
        dangling += 1;
      }
      members.add(target);
    }

    if (dangling) {
      warn(
        `${doi} ("${titleOf(record)}"): ${dangling} HasPart link(s) point outside the harvested prefix ${PREFIX}.`,
        null
      );
    }
    if (duplicates) {
      warn(`${doi} ("${titleOf(record)}"): ${duplicates} duplicate HasPart link(s) were collapsed.`, null);
    }

    const owner = ownerOf(record);
    platforms.push({
      doi,
      title: titleOf(record) || null,
      classification: classificationOf(record),
      owner: owner.name,
      ownerRor: owner.ror,
      instrumentDois: [...members].sort(),
      instrumentCount: members.size
    });
  }
  platforms.sort((a, b) => b.instrumentCount - a.instrumentCount || a.doi.localeCompare(b.doi));

  // --- 5. The known upstream defect ----------------------------------------
  // Instrument records carry IsPartOf relations that point at their OWN DOI
  // rather than at the survey platform they belong to. Platform membership is
  // therefore derived from the platform side's HasPart links ONLY, above, and
  // never from the instrument side. This block exists purely to keep the defect
  // visible in every CI run until it is fixed upstream. See docs/PIDINST.md.
  let isPartOfRecords = 0;
  let selfReferential = 0;
  let usableIsPartOf = 0;
  for (const record of instrumentRecords) {
    const links = relatedIdentifiers(record, 'IsPartOf');
    if (!links.length) continue;
    isPartOfRecords += 1;
    const own = normaliseDoi(record.id);
    const targets = links.map((l) => normaliseDoi(l.relatedIdentifier));
    if (targets.some((t) => t === own)) selfReferential += 1;
    if (targets.some((t) => t !== own)) usableIsPartOf += 1;
  }

  return {
    models,
    platforms,
    instrumentCount: instrumentRecords.length,
    platformCount: platformRecords.length,
    unresolvedModels,
    defect: { isPartOfRecords, selfReferential, usableIsPartOf }
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { fromFile: null, out: null, strict: false, stdout: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--from-file') opts.fromFile = argv[++i];
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

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    const header = fs.readFileSync(__filename, 'utf8').split('*/')[0];
    console.log(header.replace(/^#!.*\n/, '').replace(/^\/\*\*?\s*\n/, '').replace(/^ \* ?/gm, '').trim());
    return 0;
  }

  const repoRoot = path.resolve(__dirname, '..');
  const outPath = path.resolve(opts.out || path.join(repoRoot, 'data', 'instrument-register.json'));

  const records = opts.fromFile ? loadFromFile(opts.fromFile) : await fetchAllRecords();
  const built = build(records);

  // The defect report. Loud, counted, and on stderr every single run, so it
  // cannot quietly become normal while it is still wrong upstream.
  if (built.defect.selfReferential > 0) {
    console.error('');
    console.error('warning: KNOWN REGISTRY DEFECT - self-referential IsPartOf relations');
    console.error(`  ${built.defect.selfReferential} of ${built.defect.isPartOfRecords} instrument record(s) carrying an`);
    console.error('  IsPartOf relation point that relation at their OWN DOI instead of at the');
    console.error('  survey platform they belong to.');
    console.error(`  Instrument records with a usable (non-self) IsPartOf target: ${built.defect.usableIsPartOf}`);
    console.error('  Platform membership in this file is derived ONLY from the platform side\'s');
    console.error('  HasPart links, which are correct. See docs/PIDINST.md.');
    console.error('');
  }

  const payload = {
    fetched: new Date().toISOString(),
    source: 'AuScope Instrument Registry (PIDINST)',
    sourceUrl: REGISTRY_URL,
    api: API,
    prefix: PREFIX,
    generatedBy: 'scripts/fetch-instruments.js',
    counts: {
      records: built.instrumentCount + built.platformCount,
      instruments: built.instrumentCount,
      platforms: built.platformCount,
      models: built.models.length,
      unresolvedModels: built.unresolvedModels
    },
    // Upstream metadata defects, reported as data so a consumer can decide
    // whether to trust the instrument-to-platform direction. It should not.
    dataQuality: {
      selfReferentialIsPartOf: built.defect.selfReferential,
      isPartOfRecords: built.defect.isPartOfRecords,
      usableIsPartOf: built.defect.usableIsPartOf,
      platformMembershipSource: 'platform HasPart relations only'
    },
    models: built.models,
    platforms: built.platforms,
    // Reader-facing only. The technical form of every warning, DOIs and field
    // paths and all, goes to stderr, which is what the CI log captures.
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
      `${payload.counts.instruments} instruments in ${payload.counts.models} model group(s), ` +
      `${payload.counts.platforms} survey platforms, from ${payload.counts.records} DOIs under ${PREFIX}.`
  );
  for (const m of payload.models) {
    console.log(`  ${String(m.count).padStart(4)}  ${m.model}${m.modelResolved ? '' : '  (no model stated - grouped by title)'}`);
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    if (err instanceof RegistryError) {
      console.error('');
      console.error('ANSIR instrument register build failed: the PIDINST registry no longer matches the expected shape.');
      console.error('');
      console.error(`  Problem: ${err.message}`);
      if (err.hint) console.error(`  Fix:     ${err.hint}`);
      console.error('');
      console.error('  Nothing was written. See docs/PIDINST.md.');
      console.error('');
      process.exit(1);
    }
    if (err && err.networkFailure) {
      console.error('');
      console.error('ANSIR instrument register build failed before any parsing was attempted.');
      console.error(`  ${err.message}`);
      console.error('');
      process.exit(2);
    }
    console.error('ANSIR instrument register build failed with an unexpected error:');
    console.error(err && err.stack ? err.stack : err);
    process.exit(2);
  });
