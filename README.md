# ANSIR web

Public web pages and data pipeline for **ANSIR**, the Australian National
Seismic Imaging Resource - a national research facility of
[AuScope](https://www.auscope.org.au/), funded under the National
Collaborative Research Infrastructure Strategy (NCRIS).

ANSIR provides seismic, magnetotelluric and related instrumentation to
researchers at Australian and international universities, publicly funded
research organisations, and their industry partners.

## What is here

Four public pages, each served by GitHub Pages and embedded in the AuScope
website through an iframe:

| Page | Path | What it shows |
|---|---|---|
| Research projects | `/` | Every project on the ANSIR register: map, filters, search, deep links |
| Instrument availability and schedule | `/schedule/` | What is available now, what is committed to which experiment, and when it is due back |
| Portfolio statistics | `/stats/` | Projects, researchers, institutions, instrument deployments and published outputs |
| Equipment loan application | `/apply/` | The application form for instrument time |

Live on the AuScope site at
[/ansir-projects](https://www.auscope.org.au/ansir-projects),
[/ansir-schedule](https://www.auscope.org.au/ansir-schedule) and
[/ansir-application-form](https://www.auscope.org.au/ansir-application-form).

## How it works

Everything public is a static file in this repository. Data is refreshed by
scheduled GitHub Actions, not by a server.

```
Google Sheets (maintained by ANSIR staff)        Public APIs
  |  project register (published CSV view)         |  DataCite, ORCID, CrossRef
  |  seismic fleet status (published tabs)         |
  v                                                v
      GitHub Actions, nightly and on demand
                      |
                      v
        data/*.json committed to this repo
                      |
                      v
              GitHub Pages serves the pages
                      |
                      v
        embedded in the AuScope Squarespace site
```

The pages hold no data of their own: each one fetches the JSON files below and
renders whatever it finds. When staff update a sheet, the next sync run
publishes the change with no code edit and no manual step.

### Data files

| File | Built by | Source |
|---|---|---|
| `data/data.json` | `scripts/fetch-projects.js` | The project register: a published, filtered view of the master sheet holding only rows and columns approved for publication |
| `data/schedule.json` | `scripts/fetch-schedule.js` | The ANSIR Seismic Fleet Status sheet: availability, deployments and rapid-response records |
| `data/instrument-register.json` | `scripts/fetch-instruments.js` | The [AuScope instrument register](https://pidinst.data.auscope.org.au/): one DataCite DOI per physical instrument, under prefix `10.82388` |
| `data/contributor-verification.json` | `scripts/validate-contributors.js` | The public [ORCID](https://orcid.org/) register: which identifiers are confirmed to belong to which researcher |
| `ro-crate-metadata.json` | `scripts/generate-ro-crate.js` | Generated from `data/data.json` after DOI enrichment |

Each fetch script validates what it receives and **exits with a named error
rather than publishing something wrong**. A sheet that has been restructured,
unpublished, or emptied stops the sync and leaves the last good data in place;
the failure is reported in the workflow run summary. Every page displays the
date its data was gathered, so stale data is visible rather than silent.

### Research metadata

`ro-crate-metadata.json` is [RO-Crate 1.1](https://www.researchobject.org/ro-crate/specification/1.1/)
compliant, using Schema.org JSON-LD to describe the project collection, each
project, its contributors (linked by ORCID), organisations, funding, instruments,
publications, FDSN networks, and spatial and temporal coverage. This supports
discovery by ARDC Research Data Australia, institutional repositories and other
RO-Crate-aware harvesters.

Publication and dataset metadata is resolved from DOIs through the
[CrossRef](https://www.crossref.org/) and [DataCite](https://datacite.org/) APIs.

## Repository structure

```
.
├── index.html                  Research projects page
├── schedule/index.html         Instrument availability and schedule
├── stats/index.html            Portfolio statistics
├── apply/index.html            Equipment loan application form
├── data/                       Published JSON, rebuilt by the workflows
├── scripts/                    The fetch, enrichment and validation scripts
├── lib/                        Self-hosted Leaflet and Leaflet.draw
├── assets/                     Images
├── gas/                        Google Apps Script source for the intake endpoint
└── .github/workflows/          Scheduled sync and DOI enrichment
```

### The one piece that is not static

`gas/Code.gs` is the application intake endpoint. Accepting a form submission
from a member of the public, storing an uploaded PDF and sending email all
require a server, so this single Apps Script deployment remains. It exposes
exactly four web-callable functions and writes submissions to a separate
review tab, never to the published project data. `gas/README.md` is the
deployment guide.

## Working on it locally

No build step, no package manager, no framework. Serve the directory and open
a page:

```bash
python3 -m http.server 8000
```

Then <http://localhost:8000/>, `/schedule/`, `/stats/` or `/apply/`.

To rebuild a data file locally (Node 20 or newer, no dependencies):

```bash
node scripts/fetch-schedule.js       # fleet schedule, from the published sheet
node scripts/fetch-instruments.js    # instrument register, from DataCite
node scripts/validate-contributors.js --warn   # ORCID verification
```

`scripts/fetch-projects.js` additionally needs `ANSIR_PROJECTS_CSV_URL` in the
environment, matching the repository variable of the same name.

### Conventions

- Vanilla HTML, CSS and JavaScript. No frameworks, no build tooling, no CDNs:
  every dependency is vendored under `lib/`.
- Pages are embedded in iframes and report their height to the parent page, so
  each one is written to work standalone and embedded.
- No credentials or internal identifiers in this repository. The intake
  endpoint reads its sheet ID from an Apps Script property; the workflows read
  the published sheet URL from a repository variable.
- Detailed operator documentation - pipeline setup, spreadsheet layout
  contracts, intake procedures and data-quality notes - is maintained by
  AuScope outside this repository. Comments and error messages that reference
  `docs/*.md` refer to those internal documents.

## Licence

[CC BY 4.0](LICENSE). Data sourced from ANSIR research projects; publication
metadata resolved via CrossRef and DataCite.
