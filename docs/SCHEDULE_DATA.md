# Schedule data pipeline

How the ANSIR Seismic Fleet Status spreadsheet becomes `data/schedule.json`.

| Stage | What it is |
| --- | --- |
| Source of truth | The ANSIR Seismic Fleet Status sheet, maintained by hand by facility staff. |
| Transport | Three read-only CSV views of that workbook, published to the web. |
| Build step | `scripts/fetch-schedule.js` (Node 22, no dependencies). |
| Output | `data/schedule.json`, committed to `github.com/AuScope/ansir` and served from `https://auscope.github.io/ansir/`. |

The website never reads the spreadsheet directly. It reads the committed JSON.
The reasoning is set out under [Why a build step](#why-a-build-step).

## Running the script

```
node scripts/fetch-schedule.js
```

Fetches the three tabs, validates them, and writes `data/schedule.json`.

| Option | Effect |
| --- | --- |
| `--from-dir DIR` | Read `avail.csv`, `supported.csv` and `rapid.csv` from `DIR` instead of the network. Used for offline testing and for reproducing a run from a saved copy. |
| `--out FILE` | Write somewhere other than `data/schedule.json`. |
| `--stdout` | Print the JSON to standard output and write nothing. |
| `--strict` | Treat data-quality warnings as fatal. Used for a manual pre-publication check. |
| `--help` | Print the header comment from the script. |

| Environment variable | Purpose |
| --- | --- |
| `ANSIR_SCHEDULE_PUB_URL` | Overrides the published workbook base URL. Needed only if the workbook is republished under a new key. |

| Exit code | Meaning |
| --- | --- |
| `0` | Success. Either the file was written, or the data was unchanged and the file was left alone. |
| `1` | Structural validation failure. The spreadsheet layout no longer matches the contract below. Nothing was written. |
| `2` | Network or I/O failure. The workbook could not be fetched, or is not published. Nothing was written. |

The script does not rewrite `data/schedule.json` when the only difference would
be the `fetched` timestamp, so a scheduled daily run does not produce an empty
commit every morning.

### In the nightly workflow

`.github/workflows/sync-sheets.yml` runs `node scripts/fetch-schedule.js` as the
`Fetch fleet schedule` step on its nightly cron and on manual dispatch, and
commits `data/schedule.json` alongside the other data files when it changes.

The step carries `continue-on-error: true` so a hand-edited fleet sheet cannot
block the projects publish. On a non-zero exit the following step writes
`Fleet schedule sync failed` into the run summary, naming this document,
`data/schedule.json` keeps its last good content, and the schedule page carries
on serving the previously published figures while the sheet is corrected.

## The source workbook

The published base URL is held in `PUB_BASE` at the top of
`scripts/fetch-schedule.js` and can be overridden with `ANSIR_SCHEDULE_PUB_URL`.
Each tab is fetched as `?gid=<GID>&single=true&output=csv`; the tab-to-gid map is
the `TABS` constant in the same file.

| Tab | Purpose |
| --- | --- |
| `Availability (Month D, YYYY)` | The fleet matrix: instruments down, experiments across. |
| `Supported Experiments` | The approved-application register, 2020 to present. |
| `Rapid Response` | Short-term deployments following significant earthquakes. |

Tab **names** are not carried in the CSV export. The script reads them from the
workbook's `pubhtml` page so it can extract the as-at date from the Availability
tab name. If that page cannot be read, the build still succeeds:
`availabilityAsOf` is set to `null` and a warning is recorded.

**Publishing requirement.** The workbook stays published to the web
(File > Share > Publish to web) with all three tabs published. When publishing is
off, Google returns an HTML sign-in page rather than CSV. The script detects that
and exits `2` with a message naming the cause, rather than parsing HTML as a
spreadsheet.

**What the CSV export carries.** Cell formatting, colour, merged-cell structure
and hyperlink targets are all discarded; only hyperlink *text* survives. This
matters for the `[FDSN link]` column on Supported Experiments: the network code
text (for example `Z1 2025`) is preserved, the URL behind it is not. A clickable
FDSN link on the website needs the URL recorded as text in the sheet, or
reconstructed from the network code by the page.

## Availability tab: layout contract

Row numbers and column letters below are as shown in Google Sheets (1-based).

```
Row 1    A            Seismic Fleet Status (title, ignored)
Row 2-3               blank
Row 4    F            "Deployed Instruments"             <- band label
         T            "Reserved Instruments (and EOI*)"  <- band label
Row 5    C            "Total Fleet"
         D            "Total Available"
         E            "On Loan"
         G onwards    experiment names, one per column
         AB, AC       "Testing", "Repair"
Row 6    D            "Field-ready, not reserved."  (definition, optional)
         F            "Out:"
         G onwards    deployment start date per experiment
Row 7    F            "Due:"
         G onwards    expected return date per experiment
Row 8+   A            category, on the first row of its group only
         B            instrument name
         C, D, E      Total Fleet, Total Available, On Loan
         G onwards    allocation count per experiment
         AB, AC       Testing, Repair
...      B empty      free-text notes; end of the instrument table
```

Three structural devices do real work here.

**The band labels in row 4.** Everything from the `Deployed Instruments` label up
to, but not including, the `Reserved Instruments` label is a deployed experiment.
Everything from `Reserved Instruments` up to the `Testing` column is a reserved
experiment or an expression of interest. These labels are the only thing
distinguishing equipment physically in the field from equipment that is booked,
so a missing band label stops the build.

**The carried-down category in column A.** A category label appears once, on the
first row of its group, and is blank on the rows below. The parser carries the
last seen value down, so the first instrument row of the table must always carry
a category.

**Column F, the `Out:` / `Due:` spacer.** It is empty on every instrument row and
holds the two date-row labels. Those labels are how the parser confirms that rows
6 and 7 really are the date rows and that nothing has been inserted above the
table.

Blank spacer columns (currently P to S, and the columns between the last named
reserved experiment and `Testing`) are skipped: a column with no header is not an
experiment.

### The asterisk marker

Columns headed only `*` are **unnamed expressions of interest**: equipment has
been asked about, but no project has been approved. They are not published as
experiments, because there is no name to show. Instead each instrument row
records how many such marks it carries, as `unnamedInterest`.

`unnamedInterest` counts **interests, not instruments**. `*` means "interested,
quantity not committed", so three marks against one instrument type are three
separate enquiries of unstated size, not three units. The page says so in words
("3 expressions of interest") and shows `TBC` in its units column. Where a
quantity is typed into one of these cells instead of `*`, it is summed into
`unnamedInterestUnits` and the page shows that number instead. An expression of
interest is never added into the Reserved figure, which counts instruments
committed to approved projects.

## Adding an instrument category

The parser is category-agnostic. Column A is read verbatim (`currentCategory` in
`parseAvailability`), carried down the blank rows beneath it, and used as the key
of a map that grows a new group the first time a new value appears. The page
renders `payload.categories` in sheet order. The category names in use appear in
the code only inside one error message, as an example.

To publish a new category, for example magnetotelluric instruments:

1. Add the rows to the **Availability** tab in the same layout as every other
   instrument row: category label in column A on the first row of the group (for
   example `MAGNETOTELLURICS`), instrument name in column B, then `Total Fleet`,
   `Total Available`, `On Loan`, allocations against the existing experiment
   columns, and `Testing` / `Repair`.
2. Keep the rows inside the unbroken block of instrument rows, above the
   free-text notes. A row below the notes is a fatal error, by design.
3. Run the script. No code change is needed, and none should be made.

**The schedule page also carries a Magnetotellurics section built from
`data/data.json`**, the research project register: every current or upcoming
project whose `methods[]` contains `Magnetotelluric`, with its dates, location
and committed instruments. That section is commitments, not availability. The
register holds no fleet totals, so the page states no MT availability figure and
adds no MT tile to the headline, and its one-line intro says so. The selection
and status-mapping rules are in
[SCHEDULE_PAGE.md > Magnetotellurics](SCHEDULE_PAGE.md#magnetotellurics).

MT rows added to this sheet render as an ordinary category accordion under
"Availability by instrument type" with no code change, and the page then carries
two MT views at once. They answer different questions, so check that the two
cover the same projects and reword the magnetotellurics section's intro to say
what it sits next to. Keep the section: the register covers MT work this sheet
may never list.

## Supported Experiments tab: layout contract

```
Row 1    C            title (ignored)
Row 3    C            standing note (ignored)
Row 5    G            "Loaned Instruments" band label (ignored)
Row 6    A            "Application Ref. [FDSN link]"   <- locates the table
         B            "Funding Source"
         C            "Start Date"
         D            "End Date"
         E            "Description"
         F            "Research Applicant(s)"
Row 7    G onwards    instrument names, one per column
Row 8+                one row per approved application
```

The header row is found **by its column A label**, not by row number, and must
appear within the first 12 rows. Columns B to F must then match exactly, in
order. Instrument names must be on the row immediately below the header, from
column G onwards, and there must be at least 8 of them and at least 10 data
rows. New instrument columns may be added to the right.

The table repeats its own header partway down (currently row 18) to separate
applications carrying an ANSIR reference from those recorded before the
reference scheme. Repeated header rows are recognised and skipped, and both
blocks are parsed into the same list. A row with no `ANSIR-YYYY-NNN` reference
has `ansirCode: null` and keeps its own reference in `ref` (`S03-2023`,
`SX-2024`, `ANU-2021`, `OB01-2019` and similar).

A row is kept when column E holds a description. Rows with no description are
skipped with a warning. Column A may legitimately be empty.

## Rapid Response tab: layout contract

```
Row 1    C            title (ignored)
Row 3    C            standing note (ignored)
Row 5    A-G          Institute, FDSN Network Code, Start, End,
                      Earthquake, Location, Equipment
Row 6+                one row per deployment
```

The header row is found by its column A label `Institute` within the first 12
rows; all seven labels must then match, in order, and there must be at least one
data row.

`FDSN Network Code` is written as `VX (DOI 10.7914/w4yj-hd40)`. The
two-character network code and the DOI are extracted separately. `Location` is
written as `latitude, longitude` in decimal degrees, so the schedule page can
place a marker without further parsing. A location in any other form is kept
verbatim with null coordinates and a warning.

## Value conventions

| In the sheet | Meaning | In the JSON |
| --- | --- | --- |
| A whole number | A committed instrument count | `{ "count": 24, "tentative": false }` |
| `*` in an allocation cell | Expression of interest; quantity not committed | `{ "count": null, "tentative": true }` |
| `*` in a date cell | Open-ended or to be confirmed | `{ "raw": "*", "iso": null, "precision": null, "tentative": true }` |
| Empty allocation cell | No allocation | omitted from `allocations` entirely |
| `MM-YYYY` | Month precision | `{ "iso": "2026-09", "precision": "month" }` |
| `YYYY-MM-DD` | Day precision | `{ "iso": "2026-03-12", "precision": "day" }` |
| `YYYY` | Year precision | `{ "iso": "2022", "precision": "year" }` |

`*` is never coerced to a number and never treated as zero. A tentative
allocation and a zero allocation mean opposite things to a researcher planning a
deployment.

Every date is exposed twice: `raw` is exactly what the sheet says, for display,
and `iso` is a sortable prefix, for filtering and ordering. `precision` records
how much of the date is specified, so a page can render `06-2026` as "June 2026"
without implying a day that was never given.

**Instrument names carrying a stock annotation.** A name is sometimes written
with a note on the end, as in `ANU TerraSAWR +50 units in production`. The
annotation is split into a `note` field and the name is published clean, so the
card title reads `ANU TerraSAWR` with the annotation beneath it in small print.

The split is deliberately conservative: **only a trailing segment beginning with
`+`** is treated as an annotation, whether bare (`... +50 units in production`)
or bracketed (`... (+50 units in production)`). A trailing bracket is otherwise
left alone, because `(NZ)` and `(Indoor/vault only)` are the only thing
distinguishing two real fleet rows from each other. Reword a differently shaped
annotation in the sheet to start with `+` rather than loosening the rule.

Experiment names on the Availability tab carry their project reference inline, as
`Paralana #2026-004`. The reference is split out and normalised to
`ANSIR-2026-004`, matching the form used on Supported Experiments and in
`data/data.json`, so the schedule page can link a fleet row through to the
project page. Where no reference is present (`UTAS Antarctica`, `SPiRaL NT`,
`GSWA WA Array Phase 3`) `ansirCode` is `null`.

## Output format

`data/schedule.json`, top level:

| Key | Notes |
| --- | --- |
| `fetched` | ISO timestamp of the run that last changed the file. |
| `source`, `sourceUrl`, `generatedBy` | Provenance. |
| `availabilityTabName` | The tab name verbatim, for example `Availability (July 21, 2026)`. |
| `availabilityAsOf` | `YYYY-MM-DD` extracted from that name, or `null`. |
| `definitions` | Definitions lifted from the sheet, currently `totalAvailable`. |
| `totals` | Counts for quick display and for checking a sync at a glance. |
| `categories` | The fleet matrix, nested category > instrument > allocation. |
| `experiments` | The current experiment columns, in sheet order. |
| `supportedExperiments` | The approved-application register. |
| `rapidResponse` | Earthquake response deployments. |
| `notes` | Free text from below the fleet table, deduplicated. Rendered in the page footer, where the eligibility statement, the application-terms link and the ANSIR contact address live. |
| `warnings` | Data-quality warnings from this run, in reader-facing wording. Empty in a clean build. |

Shape of the main structures:

```jsonc
"categories": [{
  "name": "RECORDERS",
  "instruments": [{
    "name": "ANU TerraSAWR",              // annotation split off, see Value conventions
    "note": "+50 units in production",    // null when the name carried no annotation
    "category": "RECORDERS",
    "totalFleet": 63, "available": 4, "onLoan": 16, "testing": 10, "repair": 25,
    "allocations": [
      { "experiment": "SPiRaL NT", "ansirCode": null,
        "status": "deployed", "count": 11, "tentative": false }
    ],
    "unnamedInterest": 2,                 // marks, i.e. how many enquiries
    "unnamedInterestUnits": null          // instruments, only if the sheet states a number
  }]
}],

"experiments": [{
  "name": "Otway CO2 Monitoring",             // display name, reference stripped
  "label": "Otway CO2 Monitoring #2025-009",  // exactly as in the sheet
  "ansirCode": "ANSIR-2025-009",
  "status": "deployed",                       // or "reserved"
  "column": "H",                              // sheet column, for tracing a value back
  "outDate": { "raw": "09-2025", "iso": "2025-09", "precision": "month", "tentative": false },
  "dueDate": { "raw": "07-2026", "iso": "2026-07", "precision": "month", "tentative": false }
}],

"supportedExperiments": [{
  "ref": "ANSIR-2025-009", "ansirCode": "ANSIR-2025-009",
  "fdsnLabel": "Z1 2025", "fdsnNetwork": "Z1",
  "fundingSource": "...", "startDate": { }, "endDate": { },
  "description": "...", "applicants": "...",
  "loans": [{ "instrument": "SmartSolo IGU-16HR (5Hz Node)", "count": 24, "tentative": false }]
}],

"rapidResponse": [{
  "institute": "The Australian National University",
  "fdsnNetwork": "YB", "doi": "10.7914/g75f-4a16",
  "startDate": { }, "endDate": { },
  "earthquake": "MLa 4.4 Rugby, NSW (11/03/2026 08:09:33 UTC).",
  "location": { "raw": "-34.37, 148.89", "latitude": -34.37, "longitude": 148.89 },
  "equipment": "..."
}]
```

### Why this shape

- Categories nest their instruments because that is how the table is rendered:
  headed sections with rows beneath each, so no grouping pass is needed in the
  browser. `experiments` is separate because it is the column header set, and a
  page building a matrix needs the columns before it walks the rows.
- Allocations sit on the instrument, matching the reading direction of the sheet
  ("how many of this instrument are out, and where"). The reverse view is one
  `filter` away. Each allocation repeats `ansirCode` and `status` so a cell can
  be rendered, coloured by deployed or reserved, and linked to its project
  without a second lookup.
- `warnings` is published in the file, not only printed to the build log, so a
  degraded build shows up in the committed diff rather than only in a CI log that
  expires. The schedule page does not render the array; it is the maintainer's
  channel, and `--strict` turns its contents into a stopped build.
- Each warning exists in two wordings. The technical one names the exact cell
  (`E10`, `row 10`) and goes to stderr; the reader one names the instrument or
  experiment in plain words and is the only one written into `warnings`. A
  warning about the build itself, such as the tab names being unreadable, has no
  reader wording and stays in the log.

## What the parser validates on the Availability tab

A change to the sheet that breaks one of these stops the build.

1. Row 5 is the header row; the date rows are directly below it at rows 6 and 7;
   the first instrument row is row 8.
2. Column C is headed `Total Fleet`, D `Total Available`, E `On Loan`. Cell F6
   reads `Out:` and F7 reads `Due:`.
3. Columns headed `Testing` and `Repair` exist in row 5, in that order, to the
   right of every experiment column. Their exact position is found by label, not
   assumed.
4. Row 4 contains a cell beginning `Deployed Instruments` and, to its right, a
   cell beginning `Reserved Instruments`.
5. Experiment columns start at column G and end immediately before `Testing`. A
   column with an empty header is a spacer; a column headed `*` is an unnamed
   expression of interest.
6. An instrument row is any row with a value in column B, up to 90 characters;
   anything longer is treated as commentary. Free-text notes below the table
   leave column B empty.
7. Instrument rows form one unbroken block. Once free text has started, no
   further instrument rows may appear.
8. Column A carries the category on the first row of each group, and the first
   instrument row of the table always has one.
9. There are at least 10 instrument rows, at least 2 categories, and at least 3
   named experiment columns.

Across the whole workbook, all three gids remain published as CSV, and cell
values are trimmed with internal whitespace runs collapsed, so
` Maunakea  #2025-003` and `Maunakea #2025-003` are the same experiment. Prose
fields keep their line breaks.

## Validation: what stops the build, what only warns

**Exit 1, nothing written.** Anything that would change the *meaning* of the
published numbers: a missing or renamed header, a moved date row, a lost band
label, a table below the stated minimum, an instrument row stranded below the
notes, or a first instrument row with no category. The message names the tab, the
exact cell, what was expected, what was found and what to do about it, and the
last published `data/schedule.json` stays in place.

```
ANSIR schedule build failed: the source spreadsheet no longer matches the expected layout.

  Tab:     Availability
  Problem: Expected the header "On Loan" in cell E5 but found "Currently Out".
  Fix:     The fixed columns must stay in this order: A category, B instrument,
           C Total Fleet, D Total Available, E On Loan. Update AV.COL_* in
           scripts/fetch-schedule.js if the sheet is restructured deliberately.

  Nothing was written. See docs/SCHEDULE_DATA.md for the full layout contract.
```

**Exit 2, nothing written.** The workbook could not be fetched: network failure,
a non-200 response, an empty body, or an HTML page where CSV was expected, which
means publishing is switched off.

**Warning, exit 0, file still written.** Single-cell data-quality points that do
not invalidate the rest of the table:

- a count cell holding something that is neither a whole number nor `*`;
- an empty or non-numeric `Total Fleet`, `Total Available`, `On Loan`, `Testing`
  or `Repair` cell, whose value becomes `null`;
- a date in an unrecognised format, kept as text with `iso` set to `null`;
- deployed allocations for an instrument not summing to its `On Loan` figure;
- an ANSIR code on the Availability tab with no matching row on Supported
  Experiments;
- a supported-experiment row with no description, which is skipped;
- a location that is not `latitude, longitude`;
- an allocation naming an experiment that is not one of the experiment columns,
  which would otherwise leave the deployment timeline with nothing on screen to
  say so;
- the tab names being unreadable, so `availabilityAsOf` is `null`.

Every warning is printed to standard error in its technical wording, naming the
cell; those with a reader wording are also written into the JSON `warnings`
array. Stderr and the committed diff are where these are read: check them after a
sync, or run `--strict` by hand after a substantial edit to make them fatal.
`--strict` is not used for the nightly job, where one stray character would block
publication of an otherwise correct fleet table.

## Restructuring the sheet

The sheet is the human editing surface and should stay comfortable to edit. The
parser bends to it, not the other way round, but the two move together.

**Changes that are always safe**

- Adding, removing or renaming an instrument row.
- Adding, removing or renaming an experiment column, anywhere between column G
  and the `Testing` column, in either band.
- Adding a new category group in column A.
- Changing any number, date or `*`.
- Editing the notes below the fleet table.
- Adding, editing or removing rows on Supported Experiments or Rapid Response.
- Renaming the Availability tab, as long as the date stays in the form
  `Availability (July 21, 2026)`.
- Adding new instrument columns to Supported Experiments, to the right.

**Changes that stop the build until the script is updated**

Anything that breaks a validated assumption. In practice that means: inserting
or deleting a row above row 8 on the Availability tab; moving or
renaming the fixed columns, the `Testing` / `Repair` columns, the row 4 band
labels or the column F `Out:` / `Due:` labels; moving the category out of column
A or the instrument name out of column B; putting commentary in the middle of the
instrument rows; renaming the `Application Ref. [FDSN link]` header or reordering
columns A to F on Supported Experiments; or reordering the Rapid Response
columns.

**The procedure**

1. Make the change on a **copy** of the workbook first, and publish the copy.
2. Run the script against the copy:
   `ANSIR_SCHEDULE_PUB_URL="<copy's pub URL>" node scripts/fetch-schedule.js --stdout`
   Or save the three CSVs locally as `avail.csv`, `supported.csv` and `rapid.csv`
   and run `node scripts/fetch-schedule.js --from-dir <dir> --stdout`.
3. If it stops, the message names the cell. Update the matching constant at the
   top of `scripts/fetch-schedule.js`:

   | What changed | What to edit |
   | --- | --- |
   | A row was inserted or deleted above the table | `AV.HEADER_ROW`, `AV.OUT_ROW`, `AV.DUE_ROW`, `AV.FIRST_DATA_ROW` |
   | A fixed column moved | `AV.COL_*` |
   | A header was reworded | `AV_LABELS`, `SUP_HEADER_LABEL`, `SUP_LABELS`, `RR_LABELS` |
   | The first experiment column moved | `AV.FIRST_EXPERIMENT_COL` |
   | The instrument columns on Supported Experiments moved | `SUP_FIRST_INSTRUMENT_COL` |
   | The table got legitimately smaller | `MIN` |

4. Update this document in the same commit. The constants and this file are one
   contract in two places; if they disagree the next maintainer is stranded.
5. Diff the resulting `data/schedule.json` before committing. The build passing
   is not by itself proof that the numbers are right.

**The as-at date.** The Availability tab name carries the date the figures are
current to (`July 21, 2026`), and it is maintained by hand. Update it in the same
edit as the figures, so that `availabilityAsOf` and the date shown on the page
match the data.

## Why a build step

The page could in principle fetch the CSV itself and parse it in the browser. It
deliberately does not.

- **A hand-maintained sheet shifts.** A browser-side parser meeting a shifted
  layout either renders nonsense or renders nothing, with no explanation. The
  build step meets the same shift, stops with a named cell and a stated fix, and
  leaves the last published `data/schedule.json` in place and serving. The
  website keeps working while the sheet is corrected, and the signal lands in the
  Actions tab and the run summary, where people with write access see it.
- **What is published is auditable.** `data/schedule.json` is committed, so every
  change to the fleet figures has a diff, a timestamp and a commit. That matters
  for numbers that appear in NCRIS reporting.
- **The browser only ever sees normalised JSON**, shaped in the workflow, and the
  site makes no third-party request at view time, in keeping with the no-CDN
  rule.
