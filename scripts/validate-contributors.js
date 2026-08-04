#!/usr/bin/env node
/**
 * validate-contributors.js
 *
 * Resolves every ORCID in data/data.json against the public ORCID register and
 * reports any identifier attached to a researcher it does not belong to.
 *
 * Why this exists
 * ---------------
 * Contributor fields are stored as parallel semicolon-delimited columns and
 * zipped together by position. If a person has no ORCID and the gap is omitted
 * rather than left empty, every entry after it shifts up by one and researchers
 * silently inherit each other's identifiers. See docs/DATA_QUALITY.md.
 *
 * Checksums do not catch this - the shifted values are all valid ORCIDs. The
 * only reliable check is resolving each one and comparing the registered name.
 *
 * The ORCID public API needs no authentication, so this runs in CI the same way
 * the DataCite enrichment does.
 *
 * What "verified" means here
 * -------------------------
 * A pair, not an identifier. The shift copies one researcher's ORCID onto other
 * researchers, and the identifier still belongs to the first of them, so this
 * script publishes the claimants whose names the register's name matches rather
 * than condemning the identifier wholesale. Withholding an ORCID from the person
 * it genuinely belongs to punishes the victim of the data error.
 *
 * Usage:
 *   node scripts/validate-contributors.js            # exits 1 on misattribution
 *   node scripts/validate-contributors.js --warn     # always exits 0
 *   node scripts/validate-contributors.js --json     # machine-readable report
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data', 'data.json');
const VERIFICATION_FILE = path.join(__dirname, '..', 'data', 'contributor-verification.json');
const ORCID_API = 'https://pub.orcid.org/v3.0/';
const REQUEST_GAP_MS = 350;    // be a courteous client of a free public service
const REQUEST_TIMEOUT_MS = 20000;
const MAX_RETRIES = 2;

const argv = process.argv.slice(2);
const WARN_ONLY = argv.includes('--warn');
const AS_JSON = argv.includes('--json');

function log(message) {
  if (!AS_JSON) console.log(message);
}

function fail(message) {
  console.error('[error] ' + message);
  process.exit(1);
}

/** Normalise a name for comparison: letters only, lowercased. */
function normalise(name) {
  return String(name || '').toLowerCase().replace(/[^a-z]/g, '');
}

/** Last alphabetic token of a name, used to spot spelling variants. */
function familyName(name) {
  const parts = String(name || '').replace(/[^A-Za-z \-]/g, '').trim().split(/\s+/);
  return parts.length ? parts[parts.length - 1].toLowerCase() : '';
}

/**
 * Does one claimed name refer to the person the register names?
 *
 * This is the existing rule, unchanged in substance and merely lifted out of
 * main() so it can be asked about one claimant at a time: an exact match after
 * normalisation, a shared family name, or one name being a prefix of the other.
 * The last two are spelling variants of the same person ("Tom Ostersen" for
 * "Thomas Ostersen", "Brian Kennet" for "Brian Kennett"), not a different
 * researcher. Do not loosen it - every relaxation here hands somebody else's
 * identifier to the application form.
 */
function nameMatches(claimed, registered) {
  const a = normalise(claimed);
  const b = normalise(registered);
  if (!a || !b) return false;
  if (a === b) return true;
  const fa = familyName(claimed);
  const fb = familyName(registered);
  if (fa && fa === fb) return true;
  return a.indexOf(b) === 0 || b.indexOf(a) === 0;
}

/** Pull a bare ORCID out of whatever shape the sheet supplied. */
function extractOrcid(raw) {
  const match = String(raw || '').toUpperCase().match(/(\d{4}-\d{4}-\d{4}-\d{3}[\dX])/);
  return match ? match[1] : null;
}

/** ISO 7064 MOD 11-2 check digit. Valid format does not imply correct owner. */
function checksumValid(orcid) {
  const digits = orcid.replace(/-/g, '');
  if (digits.length !== 16) return false;
  let total = 0;
  for (let i = 0; i < 15; i++) {
    const digit = Number(digits[i]);
    if (Number.isNaN(digit)) return false;
    total = (total + digit) * 2;
  }
  const remainder = (12 - (total % 11)) % 11;
  return (remainder === 10 ? 'X' : String(remainder)) === digits[15];
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/** Look up the registered name for an ORCID. null means "could not determine". */
async function registeredName(orcid, attempt) {
  attempt = attempt || 0;
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(ORCID_API + orcid + '/person', {
      headers: { Accept: 'application/json', 'User-Agent': 'ANSIR-contributor-check' },
      signal: controller.signal
    });
    clearTimeout(timer);

    if (response.status === 404) return { state: 'not-found', name: null };
    if (response.status === 429 || response.status >= 500) {
      if (attempt < MAX_RETRIES) {
        await sleep(1000 * (attempt + 1));
        return registeredName(orcid, attempt + 1);
      }
      return { state: 'unavailable', name: null };
    }
    if (!response.ok) return { state: 'unavailable', name: null };

    const body = await response.json();
    const nameBlock = body && body.name;
    // A record with no public name is a privacy setting, not an error.
    if (!nameBlock) return { state: 'private', name: null };
    const given = (nameBlock['given-names'] || {}).value || '';
    const family = (nameBlock['family-name'] || {}).value || '';
    const full = (given + ' ' + family).trim();
    return full ? { state: 'ok', name: full } : { state: 'private', name: null };
  } catch (err) {
    clearTimeout(timer);
    if (attempt < MAX_RETRIES) {
      await sleep(1000 * (attempt + 1));
      return registeredName(orcid, attempt + 1);
    }
    return { state: 'unavailable', name: null };
  }
}

async function main() {
  if (!fs.existsSync(DATA_FILE)) {
    fail('data/data.json not found. Run the sync first.');
  }

  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) {
    fail('data/data.json is not valid JSON: ' + err.message);
  }

  const projects = payload.data || [];
  if (!projects.length) fail('data/data.json contains no projects.');

  // Collect: orcid -> names it is attached to, and where.
  const claims = new Map();
  const malformed = [];
  let entries = 0;

  projects.forEach(function (project) {
    (project.contributors || []).forEach(function (contributor) {
      const name = String(contributor.name || '').trim();
      const rawOrcid = String(contributor.orcid || '').trim();
      if (!name || !rawOrcid) return;
      entries++;

      const orcid = extractOrcid(rawOrcid);
      if (!orcid) {
        malformed.push({ value: rawOrcid, name: name, project: project.ansirCode || '?' });
        return;
      }
      if (rawOrcid !== 'https://orcid.org/' + orcid) {
        malformed.push({ value: rawOrcid, name: name, project: project.ansirCode || '?', parsedAs: orcid });
      }
      if (!claims.has(orcid)) claims.set(orcid, { names: new Set(), projects: new Set() });
      claims.get(orcid).names.add(name);
      claims.get(orcid).projects.add(project.ansirCode || '?');
    });
  });

  log('Checking ' + claims.size + ' distinct ORCIDs from ' + entries + ' contributor entries.');
  log('');

  const misattributed = [];
  const variants = [];
  const shared = [];
  const badChecksum = [];
  const unresolved = [];
  // Identifiers whose true owner is among the claimants, but which other
  // claimants also carry. These are recoverable: the owner keeps the ORCID and
  // only the other claimants lose it.
  const wrongPerson = [];
  // Per-orcid verdicts, keyed by orcid: who the register names, which claimants
  // that name matches, and which claimants it does not.
  const verdicts = new Map();

  const orcids = Array.from(claims.keys()).sort();
  for (let i = 0; i < orcids.length; i++) {
    const orcid = orcids[i];
    const claim = claims.get(orcid);
    const names = Array.from(claim.names);

    if (!checksumValid(orcid)) {
      badChecksum.push({ orcid: orcid, names: names });
    }
    if (names.length > 1) {
      shared.push({ orcid: orcid, names: names, projects: Array.from(claim.projects) });
    }

    const result = await registeredName(orcid);
    if (result.state !== 'ok') {
      unresolved.push({ orcid: orcid, names: names, reason: result.state });
    } else {
      const registered = result.name;
      // The question is asked once per claimant, not once per identifier. An
      // ORCID that several names carry belongs to exactly one of them; the
      // register says which, and the others are simply wrong about it.
      const matched = names.filter(function (n) { return nameMatches(n, registered); });
      const unmatched = names.filter(function (n) { return !nameMatches(n, registered); });
      const record = { orcid: orcid, registered: registered, names: names, projects: Array.from(claim.projects) };

      verdicts.set(orcid, { registered: registered, matched: matched, unmatched: unmatched });

      if (!matched.length) {
        // Nobody it is attached to is the person it belongs to.
        misattributed.push(record);
      } else {
        const exact = matched.some(function (n) { return normalise(n) === normalise(registered); });
        // Matched only through the family-name or prefix rule: same person,
        // spelled differently. Cosmetic, and reported as such.
        if (!exact) variants.push({ orcid: orcid, registered: registered, names: matched, projects: record.projects });
        if (unmatched.length) {
          wrongPerson.push({ orcid: orcid, registered: registered, owner: matched, others: unmatched, projects: record.projects });
        }
      }
    }
    if (i < orcids.length - 1) await sleep(REQUEST_GAP_MS);
  }

  // Publish the verification result so the application form can consult it.
  //
  // This exists because "the previous records agree with each other" is NOT the
  // same as "this identifier is correct". Five of the six misattributions found
  // here appear exactly once each, so they look perfectly consistent and would
  // be autofilled with a confident provenance line. Only an ORCID whose
  // registered name actually matches the person may be offered.
  //
  // Verification is per (identifier, person), not per identifier. An ORCID that
  // the positional shift copied onto other people is still that one researcher's
  // ORCID, and withholding it from its rightful owner punishes the victim of the
  // data error. So "verified" carries the claimants the register's name matches
  // and every other claimant of the same identifier is rejected for it.
  const verified = {};
  const rejected = {};
  const unknown = {};
  orcids.forEach(function (orcid) {
    const names = Array.from(claims.get(orcid).names);
    const wasUnresolved = unresolved.some(function (u) { return u.orcid === orcid; });
    const verdict = verdicts.get(orcid);

    if (wasUnresolved || !verdict) {
      unknown[orcid] = { reason: 'not-verified', names: names };
      return;
    }
    if (!verdict.matched.length) {
      // The register names somebody who is not among the claimants at all.
      rejected[orcid] = { reason: 'misattributed', names: names };
      return;
    }
    verified[orcid] = { name: verdict.registered, matchedClaimants: verdict.matched };
    if (verdict.unmatched.length) {
      rejected[orcid] = { reason: 'not-this-person', names: verdict.unmatched };
    }
  });

  const verifiedPairs = Object.keys(verified).reduce(function (total, orcid) {
    return total + verified[orcid].matchedClaimants.length;
  }, 0);
  const rejectedPairs = Object.keys(rejected).reduce(function (total, orcid) {
    return total + rejected[orcid].names.length;
  }, 0);

  const verificationPayload = {
    generatedBy: 'scripts/validate-contributors.js',
    source: 'https://pub.orcid.org/v3.0/',
    note: 'Verification is per (ORCID, person), not per ORCID. An ORCID may be offered by application-form autofill only to a contributor named in its "matchedClaimants" list, which holds the ANSIR names the public ORCID register\'s name for that identifier matches. Every other claimant of the same identifier is listed under "rejected" and must never be offered it. "misattributed" means the register names nobody the identifier is attached to, so it is offered to no one.',
    counts: {
      verified: Object.keys(verified).length,
      rejected: Object.keys(rejected).length,
      unknown: Object.keys(unknown).length,
      verifiedPairs: verifiedPairs,
      rejectedPairs: rejectedPairs
    },
    verified: verified,
    rejected: rejected,
    unknown: unknown
  };

  // Write only when the substance changes, so CI does not create empty commits.
  let previous = null;
  try {
    previous = JSON.parse(fs.readFileSync(VERIFICATION_FILE, 'utf8'));
  } catch (err) { /* first run, or unreadable - treat as changed */ }
  const stripVolatile = function (obj) {
    if (!obj) return null;
    const copy = JSON.parse(JSON.stringify(obj));
    delete copy.generated;
    return JSON.stringify(copy);
  };
  if (stripVolatile(previous) !== stripVolatile(verificationPayload)) {
    fs.writeFileSync(VERIFICATION_FILE, JSON.stringify(verificationPayload, null, 2) + '\n');
    log('Wrote data/contributor-verification.json (' + verificationPayload.counts.verified +
        ' verified, ' + verificationPayload.counts.rejected + ' rejected, ' +
        verificationPayload.counts.unknown + ' unknown; ' + verifiedPairs +
        ' offerable person-ORCID pairs, ' + rejectedPairs + ' withheld).');
    log('');
  } else {
    log('data/contributor-verification.json unchanged.');
    log('');
  }

  if (AS_JSON) {
    console.log(JSON.stringify({
      checked: claims.size,
      misattributed: misattributed,
      variants: variants,
      wrongPerson: wrongPerson,
      sharedAcrossNames: shared,
      malformed: malformed,
      badChecksum: badChecksum,
      unresolved: unresolved
    }, null, 2));
  } else {
    if (misattributed.length) {
      log('MISATTRIBUTED - this identifier belongs to a different researcher:');
      misattributed.forEach(function (m) {
        log('  ' + m.orcid);
        log('      registered to: ' + m.registered);
        log('      attached to:   ' + m.names.join(', '));
        log('      on projects:   ' + m.projects.join(', '));
      });
      log('');
    }
    if (wrongPerson.length) {
      log('WRONG PERSON - the owner is among the claimants, the others are not:');
      wrongPerson.forEach(function (w) {
        log('  ' + w.orcid);
        log('      registered to: ' + w.registered);
        log('      offered to:    ' + w.owner.join(', '));
        log('      withheld from: ' + w.others.join(', '));
      });
      log('');
    }
    if (shared.length) {
      log('SHARED - one ORCID attached to more than one name:');
      shared.forEach(function (s) { log('  ' + s.orcid + '  ' + s.names.join(' | ')); });
      log('');
    }
    if (variants.length) {
      log('NAME VARIANTS - same person, spelled differently (cosmetic):');
      variants.forEach(function (v) {
        log('  ' + v.orcid + '  registered "' + v.registered + '" vs "' + v.names.join('", "') + '"');
      });
      log('');
    }
    if (malformed.length) {
      log('MALFORMED VALUES:');
      malformed.forEach(function (m) {
        log('  ' + JSON.stringify(m.value) + '  (' + m.name + ', ' + m.project + ')');
      });
      log('');
    }
    if (badChecksum.length) {
      log('FAILED CHECKSUM - not a valid ORCID at all:');
      badChecksum.forEach(function (b) { log('  ' + b.orcid + '  ' + b.names.join(', ')); });
      log('');
    }
    if (unresolved.length) {
      log('NOT VERIFIED (' + unresolved.length + ') - register unreachable, record private, or no such ORCID:');
      unresolved.forEach(function (u) { log('  ' + u.orcid + '  [' + u.reason + ']  ' + u.names.join(', ')); });
      log('');
    }

    log('Summary: ' + misattributed.length + ' misattributed, ' + shared.length + ' shared (' +
        wrongPerson.length + ' of them recoverable for their owner), ' +
        variants.length + ' name variants, ' + malformed.length + ' malformed, ' +
        badChecksum.length + ' invalid, ' + unresolved.length + ' unverified.');
  }

  // Only a genuine misattribution is worth breaking a build over. Name variants
  // and privacy-restricted records are not errors.
  if (misattributed.length && !WARN_ONLY) {
    console.error('');
    console.error('[error] ' + misattributed.length + ' ORCID(s) are attached to the wrong researcher.');
    console.error('        Correct them in the master sheet. See docs/DATA_QUALITY.md.');
    process.exit(1);
  }
}

main().catch(function (err) {
  fail('Unexpected failure: ' + (err && err.message ? err.message : String(err)));
});
