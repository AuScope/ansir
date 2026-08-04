# AuScope instrument register (PIDINST)

The AuScope instrument register is the authoritative source for ANSIR fleet
totals. This document describes the register, the script that harvests it, and
how the resulting figures reach the schedule page.

## What the register is

<https://pidinst.data.auscope.org.au/> publishes AuScope instruments and survey
platforms as DataCite DOIs under the prefix `10.82388`, following the PIDINST
schema. Every record carries `resourceTypeGeneral: Instrument` and
`resourceType: Geophysics`.

One DOI is one physical instrument. A model's fleet total is therefore simply
the number of instrument records carrying that model.

The whole register is retrievable from the public DataCite API with no
authentication, which is what makes it usable from the git pipeline:

```bash
curl -s -H "Accept: application/json" \
  "https://api.datacite.org/dois?prefix=10.82388&page%5Bsize%5D=500"
```

At the time of writing the prefix holds 160 DOIs: 8 survey platforms and 152
individual instruments.

## Survey platforms

A platform record represents a survey campaign. It links to the instruments used
on that survey through `HasPart` relations, and carries funding references, a
hosting institution with a ROR identifier, and a fieldwork date range as a
`Coverage` date. The eight platform records carry 324 `HasPart` links between
them, so instruments are shared across surveys; a single instrument can be a
member of as many as six.

| Platform DOI | Survey | Instruments |
|---|---|---:|
| `10.82388/ssw0j868` | Western Gawler Craton MT and Passive Seismic | 62 |
| `10.82388/bt6orvhn` | Vulcan IOCG Prospect MT and Passive Seismic (2022) | 62 |
| `10.82388/nu632xx4` | Newer Volcanic Province broadband MT (2019) | 51 |
| `10.82388/f90v7ksa` | Tumby Bay broadband MT (2018-2019) | 45 |
| `10.82388/pz3p45bk` | Curnamona Province broadband MT (2017) | 39 |
| `10.82388/rgourskg` | Burra Region broadband MT (2017-18) | 38 |
| `10.82388/e15apc8f` | Jupiter prospect ultra-wideband MT (2021) | 24 |
| `10.82388/k33a47bn` | Kapunda audio-MT (2019-20) | 3 |

Each registered platform corresponds to an ANSIR project:

| Platform | ANSIR project |
|---|---|
| Vulcan IOCG (2022) | `ANSIR-2022-001` Vulcan Magnetotelluric and Passive Seismic Array |
| Western Gawler Craton | `ANSIR-2022-002` Western Gawler Magnetotelluric and Passive Seismic Project |
| Jupiter prospect (2021) | `MT03-2020` Jupiter Anomaly Magnetotelluric Study |
| Curnamona Province (2017) | `MT02-2020` Curnamona Cube MT Project |
| Burra Region (2017-18) | `UA-2017-001` Burra MT Project |
| Kapunda (2019-20) | `MT05-2020` MT imaging near the Kapunda Mine |
| Newer Volcanic Province (2019) | `Placeholder-32` Newer Volcanic Province MT Program |
| Tumby Bay (2018-2019) | `Placeholder-31` Tumby Bay MT Traverse |

That correspondence is recorded here for reference. The pipeline does not
fuzzy-match survey titles against project titles.

## Harvest: `scripts/fetch-instruments.js`

The script is one of the feeds in the pure-git pipeline. It runs in
`.github/workflows/sync-sheets.yml` alongside the sheet feeds and writes
`data/instrument-register.json`.

It fetches the whole DataCite prefix rather than a curated subset:

```
https://api.datacite.org/dois?prefix=10.82388&page[size]=1000
```

It must talk to `api.datacite.org`. The register website at
<https://pidinst.data.auscope.org.au/> serves HTML only, and the script stops
with an explicit message if pointed at it. There is no authentication, no
repository variable and no secret involved, which is why this feed fits the
pure-git model.

Pagination follows `links.next` until it stops appearing, and the harvest is
checked against `meta.total` before anything is written. A single page of 1000
covers the register several times over, and the pagination is there because the
register grows.

### Running it

| Invocation | Effect |
|---|---|
| `node scripts/fetch-instruments.js` | Fetch live, write the JSON |
| `node scripts/fetch-instruments.js --from-file F` | Read a saved DataCite response instead of the network |
| `node scripts/fetch-instruments.js --out FILE` | Write somewhere other than the default path |
| `node scripts/fetch-instruments.js --stdout` | Print the JSON, write nothing |
| `node scripts/fetch-instruments.js --strict` | Treat warnings as fatal |

| Environment variable | Effect |
|---|---|
| `ANSIR_PIDINST_API` | DataCite DOIs endpoint |
| `ANSIR_PIDINST_PREFIX` | DataCite prefix to harvest |
| `ANSIR_PIDINST_PAGE_SIZE` | Page size, used to exercise pagination offline |

All three hold public values. Node 22 or later, no npm dependencies, built-in
`fetch`.

### Telling platforms from instruments

`resourceTypeGeneral` and `resourceType` do not separate the two: every record
is `Instrument` / `Geophysics`. Two other signals do, and they agree across all
160 records.

| Signal | Platform (8) | Instrument (152) |
|---|---|---|
| `HasPart` relations | present | absent |
| `Instrument Type:` description | `FIELD SURVEYS` | a device taxonomy term |

A record is treated as a platform if either signal fires. If the two signals
disagree the script warns and errs towards platform, because counting a survey
campaign as a device would inflate a published fleet total.

Platform records also carry a `Model:` line holding the survey name
(`Model: Vulcan`, `Model: Kapunda`) rather than a device model. Platforms are
excluded from model grouping before that line is ever read.

### Platform membership

Platform membership is derived only from the platform side's `HasPart` links,
which are the authoritative statement of which instruments a survey used.
Relations declared on instrument records are not used as a source of membership.
Any `HasPart` link that points at the platform itself, at another platform, or
outside the harvested prefix is reported to stderr and excluded from the member
list, as are duplicates.

### Model grouping

Models are grouped case-insensitively on the extracted model string. The string
is taken in descending order of trust, and each group records the route used in
`modelSource`:

| `modelSource` | Rule |
|---|---|
| `model-field` | An explicit `Model: X` technical description. Authoritative. |
| `title-vocabulary` | A model string that another record declares explicitly, found in this record's title. Attested by the data, not guessed. |
| `title-pattern` | A model-shaped code (`LETTERS-DIGITS`) in the title, and nothing better. |
| `none` | No model string available. The record is grouped under its title, `modelResolved` is `false`, and a reader-facing warning is emitted. |

A group can combine routes: the PR6-24 group is resolved from an explicit
`Model:` line on one record plus title matches against that attested vocabulary
on the rest. Current output, 152 instruments in 6 model groups:

| Model | Count | `modelSource` |
|---|---:|---|
| LEMI-120 | 53 | `model-field` |
| LEMI-423 | 27 | `model-field` |
| PR6-24 | 25 | `model-field` + `title-vocabulary` |
| LEMI-424 | 20 | `model-field` |
| MTC-150 | 18 | `model-field` |
| MTU-5C | 9 | `model-field` |

Groups are sorted by count descending, then model name ascending. Platforms are
sorted by instrument count descending, then DOI. The ordering is deterministic
because the no-change check compares serialised JSON.

### Output: `data/instrument-register.json`

| Key | Contents |
|---|---|
| `fetched` | ISO timestamp of the run |
| `source`, `sourceUrl`, `api`, `prefix`, `generatedBy` | Provenance of the harvest |
| `counts` | `records`, `instruments`, `platforms`, `models`, `unresolvedModels` |
| `models[]` | `model`, `modelResolved`, `modelSource`, `classification`, `owner`, `ownerRor`, `count`, `title`, `dois[]` |
| `platforms[]` | `doi`, `title`, `classification`, `owner`, `ownerRor`, `instrumentDois[]`, `instrumentCount` |
| `warnings[]` | Reader-facing warnings only |

`classification` (the DataCite `resourceType`, `Geophysics` throughout today)
and `owner` (normalised from the `HostingInstitution` contributor, with its ROR)
are carried per group and per platform as facets, so consumers filter rather
than the script hardcoding what to keep. Where a group's records name more than
one hosting institution the most common one is shown and a warning is emitted.
Raw DOIs are kept on every group and every platform so later joins are possible
without re-fetching.

The technical form of every warning, DOIs and field paths included, goes to
stderr, which is what the workflow log captures. Only the reader-facing form
reaches the JSON.

### Failure behaviour

The file is rewritten only when something other than the `fetched` timestamp has
changed, so an unchanged register produces no commit.

| Exit code | Meaning |
|---:|---|
| `0` | Success: the file was written, or it was already up to date |
| `1` | The register does not match the expected shape (zero instruments parsed, incomplete pagination, no `data` array). Nothing is written |
| `2` | Network or I/O failure |

The workflow step runs with `continue-on-error: true` and has its own
failure-summary step. If the API is unreachable the harvest stops and reports
the cause, the last published `data/instrument-register.json` stays in place,
and the projects publish continues.

## How fleet totals reach the schedule page

The schedule page (`schedule/index.html`) loads
`../data/instrument-register.json` and builds the Magnetotellurics availability
accordion from it. The register supplies what is owned; the project data at
`data/data.json` supplies what is committed.

The join is by instrument name. Both sides are free text, so the page normalises
each name to a comparison key: lower case, whitespace collapsed, and spaces or
hyphens between letters and digits removed, so `LEMI 120`, `LEMI-120` and
`lemi120` all compare equal. A project instrument line is assigned to the first
register model whose key appears in the line's name, so a name is never counted
against two models.

| Figure | Rule |
|---|---|
| `registered` | The model's `count` from the register |
| On loan now | Sum of matched line counts from projects with status `In Progress` whose end date is empty or on or after today |
| `available` | `registered` minus on loan now, clamped at zero |

Every matched line becomes a row on that model's card whatever its dates say,
because the table shows what is committed; only the on-loan-now lines move the
availability figure. A missing end date counts as still out, because instruments
are not back until a return is recorded. Dates are compared as ISO strings, so
no time zone can shift the boundary.

The card is designed to hold both sides of an incomplete join. A registered
model with no matching project line shows its full fleet as available. A project
instrument name matching no registered model is collected in an unmatched list
rather than dropped silently. Where committed figures exceed the registered
fleet the card shows zero available and says plainly that the numbers do not add
up, rather than displaying a negative.

The register is a tertiary feed for the page. If it fails to load, the
Magnetotellurics availability accordion is absent and the rest of the schedule
renders normally.

## Scope

The register covers registered instruments only, so the fleet totals here
describe what carries a DOI rather than everything the facility operates, and
they say nothing about condition, location or field readiness.

Nothing in the harvest script is specialised to a discipline, an institution or
the currently registered surveys. New models, new classifications and new
hosting institutions appear in the output automatically as they are registered,
which is why `classification` and `owner` are emitted as filterable facets
rather than assumed.

Questions about the ANSIR pipeline: <ansir@auscope.org.au>. Repository:
<https://github.com/AuScope/ansir>.
