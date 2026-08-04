# ANSIR data pipeline

How ANSIR project records travel from the ANSIR project sheet to the public
website. Written for someone taking over the facility's web publishing with no
prior context.

Repository: <https://github.com/AuScope/ansir>
Published site: <https://auscope.github.io/ansir/>
Published project data: <https://auscope.github.io/ansir/data/data.json>

---

## 1. What the pipeline does

```
ANSIR project sheet (master list, ~73 columns, staff editing surface)
        |
        |  a =FILTER() formula on the Public_Export tab exposes only the
        |  public-safe columns, for rows where visible = TRUE
        v
Public_Export tab  --published to the web as CSV-->  a public CSV URL
        |
        |  GitHub Actions (.github/workflows/sync-sheets.yml)
        |  runs nightly and on demand
        v
scripts/fetch-projects.js      parses the CSV, maps columns to JSON
scripts/resolve-dois.js        looks up DOI titles, authors, journals, years
scripts/generate-ro-crate.js   rebuilds the RO-Crate metadata record
        |
        v
data/data.json + ro-crate-metadata.json committed to main
        |
        v
GitHub Pages serves the repository. index.html and the stats page read
data/data.json at load time. Squarespace pages are thin iframe shells
pointing at the Pages URLs.
```

| Piece | Purpose |
| --- | --- |
| ANSIR project sheet (master tab) | Where staff edit project records. Holds private columns: contact emails, Indigenous data-governance notes, sensitivity flags, internal review notes. Never published. |
| `Public_Export` tab | A formula-driven, read-only projection of the master tab. The only thing that is ever published. |
| `ANSIR_PROJECTS_CSV_URL` | Repository variable holding the published CSV URL. |
| `scripts/fetch-projects.js` | Fetch, parse, validate, transform, write. Will not write an empty or malformed file. |
| `data/data.json` | The single source of truth the website reads. Committed to git, so every change is auditable and revertible. |

---

## 2. Privacy model

Two independent barriers keep private columns off the public site.

1. **The `=FILTER()` formula** on the `Public_Export` tab selects only
   public-safe columns, and only rows where `visible = TRUE`. Only that one tab
   is published.
2. **The allowlist in `scripts/fetch-projects.js`** (the `PUBLIC_COLUMNS` set,
   near the top of the file). Any column arriving in the CSV that is not on that
   list is discarded before the transform runs, and a note is written to the log.
   If the formula is ever widened, the script still drops the extra columns.

The script also re-checks `visible` for each row, so the row-level filter applies
twice.

To publish a genuinely public new column, update **both** the formula and
`PUBLIC_COLUMNS`, in that order. Adding it to the formula alone has no effect:
the script logs `ignoring 1 column(s) not on the public allowlist` and continues.

---

## 3. Setting up the published view

The live sheet is already configured. These steps let the export tab be rebuilt
from scratch.

### 3.1 Create the `Public_Export` tab

1. Open the ANSIR project sheet.
2. At the bottom of the window, click **+** to add a sheet.
3. Double-click the new tab, rename it to `Public_Export`, press Enter.
4. In row 1, type the public column names, one per cell, starting at `A1`. Keep
   `visible` first so the script's second row-level check works:

   ```
   visible
   alternative_identifier_id
   alternative_identifier_ansir_code
   title_primary
   title_acronym
   description_primary
   project_status
   project_keywords
   methods_field
   date_start_date
   date_end_date
   location_region
   location_country
   location_coordinates
   location_polygon
   contributor_name
   contributor_honoury_title
   contributor_id
   contributor_position_id
   contributor_is_contact
   contributor_leader
   organisation_name
   organisation_id
   organisation_role_id
   funding_agency_name
   funding_title
   funding_identifier
   funding_identifier_type
   funding_agency_ror
   funding_agency_location
   instrumentation_type
   instrumentation_numbers
   collection_quantity
   collection_site_names
   collection_site_lats
   collection_site_longs
   collection_site_alt
   collection_site_start_time
   collection_site_finish_time
   collection_site_instrument
   collection_site_instrument_serial
   related_object_identifier
   related_object_type
   data_access
   indigenous_involvement_flag
   description_indigenous_engagement_summary
   description_indigenous_acknowledgement
   ```

   That is 47 columns, so the header row runs `A1` to `AU1`. Every other column
   in the master tab is private and must not appear here. In particular, do
   **not** list `contributor_email`,
   `description_indigenous_data_governance`, `indigenous_data_sensitivity_flag`,
   `contributor_role_id`, or `methods_description`.

5. Click cell `A2` and enter this formula. It pulls each column by **name**, so
   it keeps working if columns are reordered or inserted in the master tab:

   ```
   =FILTER(
      CHOOSECOLS(
        ANSIR_Projects_MasterList!$A$2:$BU,
        ARRAYFORMULA(MATCH($A$1:$AU$1, ANSIR_Projects_MasterList!$A$1:$BU$1, 0))
      ),
      ANSIR_Projects_MasterList!$A$2:$A <> "",
      UPPER(TRIM(
        INDEX(ANSIR_Projects_MasterList!$A$2:$BU, 0,
              MATCH("visible", ANSIR_Projects_MasterList!$A$1:$BU$1, 0))
      )) = "TRUE"
   )
   ```

   Read from the inside out: `MATCH` finds where each header name sits in the
   master tab, `CHOOSECOLS` pulls exactly those columns in exactly that order,
   and `FILTER` keeps only non-blank rows whose `visible` cell reads TRUE.

   Adjust `$BU` if the master tab grows beyond 73 columns, and `$AU$1` if the
   number of public columns changes.

6. Confirm the result: row 1 is the typed headers, row 2 down is live data, and
   no private column appears anywhere.

### 3.2 Publish that single tab as CSV

1. **File** > **Share** > **Publish to web**.
2. Stay on the **Link** tab.
3. In the first dropdown, change **Entire document** to **Public_Export**. This
   step matters: publishing the entire document would expose the master tab.
4. In the second dropdown, change **Web page** to
   **Comma-separated values (.csv)**.
5. Click **Publish**, then **OK** in the confirmation dialog.
6. Copy the URL that appears. It has this shape:

   ```
   https://docs.google.com/spreadsheets/d/e/2PACX-.../pub?gid=<gid>&single=true&output=csv
   ```

7. Open that URL in a private browser window and confirm it returns raw CSV
   text. A Google sign-in page means publishing has not taken effect.

Publishing a tab makes it readable by anyone with the link. That is the intent,
and it is why only public-safe columns sit on that tab.

### 3.3 Store the URL in the repository

1. Open <https://github.com/AuScope/ansir>.
2. **Settings** > **Secrets and variables** > **Actions**.
3. Select the **Variables** tab (not Secrets).
4. **New repository variable**.
5. Name: `ANSIR_PROJECTS_CSV_URL`. Value: the URL from step 3.2.6.
6. **Add variable**.

It is a variable rather than a secret by design. The published URL is public, and
keeping it visible means workflow logs stay readable.

---

## 4. Day-to-day operation

### Normal flow

1. Staff edit a project record in the ANSIR project sheet.
2. To publish a project, set its `visible` cell to `TRUE`.
3. Wait for the nightly sync (20:00 UTC, which is 06:00 AEST or 07:00 AEDT), or
   run it on demand.

Only rows approved for publication should carry `visible = TRUE`, and only
public-safe columns belong on the `Public_Export` tab.

### Running the sync on demand

1. Repository > **Actions** tab.
2. In the left sidebar, click **Sync Projects from Google Sheet**.
3. Click **Run workflow** on the right, leave the branch as `main`, then click
   the green **Run workflow** button.
4. Refresh after a few seconds and open the run to watch it.

### Running it locally

Useful for checking data before publishing.

```
export ANSIR_PROJECTS_CSV_URL="https://docs.google.com/spreadsheets/d/e/2PACX-.../pub?gid=<gid>&single=true&output=csv"
node scripts/fetch-projects.js
```

Node 18 or later is required; the workflow runs Node 22. There are no npm
dependencies. The script writes `data/data.json` in place, so run `git diff`
afterwards to see what changed, and `git checkout data/data.json` to discard it.

---

## 5. Confirming a sync worked

In the workflow run, check in order:

1. **Fetch projects from the published sheet** ends with either
   `Wrote data/data.json (N projects)` or
   `No content change since the last sync; leaving data/data.json untouched.`
   Both are success; the second means the sheet has not changed.
2. The project count matches expectations. A large change in count normally
   reflects `visible` flags being changed in the sheet; confirm it was intended.
3. Lines beginning `[warn]` are data-quality notes about the sheet, not
   failures. The sync still publishes. See section 6.
4. **Check for changes** prints a diff stat when something changed.
5. On the repository home page, `data/data.json` shows a recent
   `Auto-sync: update project data from Google Sheet` commit.
6. Load <https://auscope.github.io/ansir/> and confirm the project appears.
   GitHub Pages redeploys within a minute or two of the commit.

### Designed behaviour when the sync cannot complete

The script stops and reports the cause rather than publishing partial data. In
every one of these cases `data/data.json` is left exactly as it was, and the
site continues to serve the last published data.

| Message | Cause and action |
| --- | --- |
| `ANSIR_PROJECTS_CSV_URL is not set` | The repository variable is missing. Redo section 3.3. |
| `the sheet returned an HTML page instead of CSV` | The tab is not published, or the URL points at the editor rather than the published CSV. Redo section 3.2. |
| `HTTP 401` or `HTTP 403` | Publishing is off, commonly after a change to the spreadsheet's sharing settings. Redo section 3.2. |
| `HTTP 404` | The `gid` in the URL no longer matches a published tab, usually after the tab was recreated. Republish and update the variable. |
| `zero projects were parsed` | The formula returned nothing, or no row has `visible = TRUE`. Open the `Public_Export` tab and check. |
| `missing essential column(s)` | The `Public_Export` header row or formula has changed. Redo section 3.1. |
| `could not reach the published sheet` | Transient network condition. Re-run the workflow. |

---

## 6. Data-quality notes

The sheet is hand-edited, so the script checks each row and reports anything
that would render poorly on the site. These notes go to stderr, appear in the
workflow log, and never stop the sync.

| Note | Meaning |
| --- | --- |
| `required field ... is empty` | A project is missing an id, ANSIR code, title, or status. |
| `no contributors listed` | The `contributor_name` cell is blank. |
| `... could not be parsed as a date` | The date cell is free text. It is exported verbatim; set it to `YYYY-MM-DD`. |
| `latitude ... outside the range -90 to 90` | Latitude and longitude values are likely transposed. |
| `values differ only by case, spacing or a trailing conjunction` | Two spellings of the same country or agency. Variants split the site's grouping and filtering. |
| `are near-identical (edit distance N)` | Two values differ by a small number of characters. Reconcile them to one spelling. |
| `ends in a dangling conjunction` | For example, an agency name ending in ` and`. |
| `positional pairing may be wrong` | Parallel semicolon-separated lists in a row have different lengths, for example three contributor names against two organisations. Pairing is positional, so the list lengths must match. |
| `ignoring N column(s) not on the public allowlist` | Expected when the `Public_Export` tab carries a helper column. If it names a column added on purpose, add it to `PUBLIC_COLUMNS` in `scripts/fetch-projects.js`. |
| `duplicate id` | Two rows share an `alternative_identifier_id`. |

Resolve these in the sheet, then re-run the sync.

---

## 7. DOI enrichment and RO-Crate generation

`scripts/resolve-dois.js` reads the `relatedObjects` entries in `data/data.json`,
looks each DOI up against CrossRef and DataCite, and writes back the resolved
title, authors, journal and year.

To avoid re-querying those services nightly, `fetch-projects.js` carries forward
DOI metadata already present in `data/data.json`, matching on the DOI. DOIs newly
added in the sheet are resolved on the next run.

`scripts/generate-ro-crate.js` then rebuilds `ro-crate-metadata.json` from the
enriched data, giving the published dataset a machine-readable RO-Crate record
alongside `data/data.json`.

Both steps run inside the sync job, so a single commit carries `data/data.json`
and `ro-crate-metadata.json` together.

---

## 8. Workflows

| Workflow | Trigger |
| --- | --- |
| `.github/workflows/sync-sheets.yml` | Nightly schedule (20:00 UTC) and manual dispatch. Runs fetch, DOI resolution and RO-Crate generation in one job, then commits. |
| `.github/workflows/resolve-dois.yml` | Pushes that change `data/data.json`. Covers the case of `data/data.json` being edited and pushed directly. |

GitHub does not start a new workflow run from a push made with the default
`GITHUB_TOKEN`, so the sync's own commit starts nothing. That is why the sync
runs `resolve-dois.js` and `generate-ro-crate.js` itself, and why the two
workflows cannot trigger each other in a loop.

Both share the concurrency group `data-enrichment`, so they are serialised and
cannot race each other into a push conflict.

---

## 9. Reverting a sync

Every sync is an ordinary git commit, so one can be undone with `git revert`.
This restores the previous `data/data.json` and republishes the site within a
minute or two.

```
# 1. Find the commit.
git log --oneline -- data/data.json

# 2. Inspect it before deciding.
git show <commit> -- data/data.json

# 3. Revert it. This creates a new commit that undoes the change,
#    leaving history intact.
git revert <commit>

# 4. Publish the revert.
git push origin main
```

Reverting the whole commit, which is the default above, covers `data/data.json`
and `ro-crate-metadata.json` together. The same can be done in the browser: open
the commit on GitHub, click **Revert**, and merge the pull request it creates.

A revert changes the repository only. The next scheduled sync republishes
whatever the sheet contains, so update the sheet first, or set the affected rows'
`visible` to `FALSE`, and then revert.

To pause syncing while working on the sheet, go to **Actions** > **Sync Projects
from Google Sheet** > the **...** menu at the top right > **Disable workflow**.

---

## 10. File reference

| Path | Purpose |
| --- | --- |
| `scripts/fetch-projects.js` | Sheet CSV to `data/data.json`. Holds the column allowlist and the transform. |
| `scripts/resolve-dois.js` | Enriches `relatedObjects` with DOI metadata. |
| `scripts/generate-ro-crate.js` | Builds `ro-crate-metadata.json`. |
| `.github/workflows/sync-sheets.yml` | Nightly and on-demand sync. |
| `.github/workflows/resolve-dois.yml` | Enrichment on direct pushes to `data/data.json`. |
| `data/data.json` | Published project data. Not hand-edited; the next sync overwrites it. |
| `ro-crate-metadata.json` | RO-Crate record for the published dataset. |
| `index.html` | The site. Reads `data/data.json` at load time. |

Questions about the pipeline go to ansir@auscope.org.au.
