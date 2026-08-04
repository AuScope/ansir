# ANSIR equipment loan application intake

How an application travels from a researcher's browser to an approved ANSIR
project, and what happens to it at every step.

The form itself is documented in [`FORM.md`](FORM.md). Deployment and
configuration of the intake endpoint are in
[`gas/README.md`](../gas/README.md).

---

## 1. Why there is an endpoint at all

The ANSIR web stack is static. Project data is edited in the ANSIR project
sheet, a GitHub Action publishes a filtered public view to `data/data.json`,
and GitHub Pages serves the HTML. No server is involved in that path.

The application form is the exception: accepting a submission from an anonymous
member of the public, storing an uploaded PDF and sending email all have to
execute server-side. That is what [`gas/Code.gs`](../gas/Code.gs) is for, and it
is all it does. It exposes four web-callable functions and nothing else:

| Function | Purpose |
|---|---|
| `doGet` | Returns a short plain-text notice. The endpoint is not a page |
| `doPost` | The transport the form uses. Dispatches on an `action` field |
| `saveUploadedFile` | Accepts one supporting PDF, stages it in Drive, returns its file ID |
| `submitApplication` | Validates, allocates a reference, records the row, files the application in Drive, sends the emails |

Every other function in the file ends in an underscore, which makes it
unreachable from the web.

### The `doPost` contract

The client posts with `Content-Type: text/plain` and a JSON string as the body.
`text/plain` is a CORS simple content type, so the browser sends the request
without a preflight `OPTIONS` call. An Apps Script web app cannot answer a
preflight, because it cannot return `Access-Control-Allow-*` headers, so
posting as `application/json` fails.

```
{ "action": "saveUploadedFile",  "payload": { fileData, projectTitle } }
{ "action": "submitApplication", "payload": { ...form fields... } }
```

The endpoint always responds `200` with a JSON body of
`{ success: boolean, ... }`. Failures are reported in the body, because an Apps
Script web app cannot set an HTTP status code.

---

## 2. The flow

```
Researcher completes the 5-step form (GitHub Pages, source in apply/index.html)
      |
      | 1. optional: upload one supporting PDF
      v
saveUploadedFile  -->  PDF written to the STAGING folder in Drive
      |                returns a Drive file ID
      | 2. submit the application, carrying that file ID
      v
submitApplication
      |
      +-- re-validates every required field, server-side
      +-- checks the submissions-per-hour cap
      +-- fetches the PDF back out of Drive by ID, and confirms it is in the
      |   staging folder. This runs BEFORE anything is moved
      |
      +-- [ SCRIPT LOCK ] ---------------------------------------+
      |     scans ANSIR_Projects_MasterList for existing codes   |
      |     scans ANSIR_Applications for pending codes           |
      |     allocates the next ANSIR-<year>-NNN                  |
      |     creates the folder named after it                    |
      |     appends one row to ANSIR_Applications                |
      +----------------------------------------------------------+
      |
      |   the application is now recorded. Everything below is best effort
      |
      +-- moves the staged supporting document into that folder
      +-- renders the application as <reference> Application.pdf
      +-- writes that PDF into that folder
      |
      +-- emails a copy of the application to the applicant
      +-- emails a notification to ADMIN_EMAILS
      +-- emails a notification to the facility addresses matching the
          selected methods (FACILITY_ROUTES)
      |
      v
Applicant sees their ANSIR reference number
      |
      |  ... human review ...
      v
Promotion to ANSIR_Projects_MasterList (section 7)
      |
      v
GitHub Action publishes the filtered public view
```

Server-side validation requires `title_primary`, `description_primary`,
`lead_given_name`, `lead_family_name` and a syntactically valid `lead_email`,
and caps free text at 20,000 characters per field and additional contributors
at 50. The form validates too, but the form is not a security boundary:
anything can be posted to the endpoint, so every check is repeated server-side.

`MAX_SUBMISSIONS_PER_HOUR` caps submissions and uploads, counted in separate
buckets, as a brake on automated flooding. Apps Script does not expose the
caller's IP address, so the cap is global across all callers rather than per
person. The counter lives in `CacheService` and fails open if evicted, so a
cache eviction cannot lock a legitimate applicant out.

---

## 3. Where the submission is recorded

**In the `ANSIR_Applications` tab of the ANSIR project sheet, and nowhere
else.**

The separation is structural. `ANSIR_Projects_MasterList` is the tab the
publishing pipeline reads, so anything in it is one automated run away from the
public internet. The intake endpoint **only ever reads** the master list, to
keep reference numbering globally correct; it has no code path that writes to
it.

`ANSIR_Applications` is created automatically on the first submission, with
headers, a frozen first row and bold header text.

### The column layout

The tab has 94 columns in three blocks. The order is what makes promotion a
copy rather than a re-typing exercise.

**Block 1 - review workflow (columns 1 to 8).** Intake-only. A reviewer opening
the tab sees these before any application content.

| Column | Meaning |
|---|---|
| `submission_timestamp` | ISO 8601, when the submission was received |
| `review_status` | `New` on arrival; maintained by hand thereafter |
| `reviewed_by` | Who assessed it |
| `review_notes` | Free text for the assessment |
| `supporting_document_file_id` | Drive file ID of the uploaded PDF |
| `supporting_document_url` | Drive link to the uploaded PDF. Unaffected by filing, because a Drive link is built from the file ID and survives a move |
| `supporting_document_name` | File name of the uploaded PDF |
| `application_folder_url` | Drive link to the folder holding this application. Empty when filing is not configured, or when the folder could not be created |

**Block 2 - the master list (columns 9 to 80).** Every column of
`ANSIR_Projects_MasterList`, using the master list's exact header spellings and
its exact order, starting at `title_primary` and ending at `internal_notes`.
The allocated `alternative_identifier_ansir_code` sits at its master position,
column 13.

Block 2 contains **every** master column, including the many the form does not
collect. Those are written empty. An empty column that lines up is what makes
promotion a single contiguous copy: select block 2, paste it into the master
list, and every value lands under the header it belongs to. Leaving an
uncollected column out would save nothing and would shift every column after it
by one, without any visible sign that it had happened.

The form fills 35 of the 72 master columns:

`title_primary`, `alternative_identifier_ansir_code`, `title_acronym`,
`date_start_date`, `date_end_date`, the flattened `contributor_honoury_title`,
`contributor_name`, `contributor_id`, `contributor_email`,
`contributor_position_id`, `contributor_leader`, `contributor_is_contact`,
`organisation_name`, `organisation_id`, `organisation_role_id`,
`funding_identifier`, `funding_title`, `funding_agency_name`,
`description_primary`, `description_objectives`, `project_keywords`,
`methods_field`, `methods_description`, `instrumentation_type`,
`instrumentation_numbers`, `location_region`, `location_country`,
`location_polygon`, `indigenous_involvement_flag`,
`description_indigenous_engagement_summary`,
`description_indigenous_data_governance`,
`description_indigenous_acknowledgement`, `indigenous_data_sensitivity_flag`,
`data_access` and `internal_notes`.

The remaining 37 are present and empty. Most are simply not asked at intake:
`raid_identifier`, `related_raid_relation`, `contributor_role_id`,
`funding_agency_location`, `funding_agency_ror`, `funding_identifier_type`,
`methods_analytical`, `methods_computational`, `instrumentation_method`,
`instrumentation_owner`, `instrumentation_location`, `instrument_provider_ror`,
`location_coordinates`, the `collection_*` columns and the `related_object_*`
columns.

Six more are left empty **on purpose**, because they are the reviewer's to set
and not the applicant's:

| Column | Why the intake leaves it empty |
|---|---|
| `alternative_identifier_id` | The master list's own row identity. A pending application is not a row in the master list, and a pre-assigned identity would collide as the list grows |
| `project_status` | A submitted application is not a project |
| `visible` | Publication is a decision, not a submission |
| `visbility` | As above. Spelt as it appears in the master list header |
| `project_approval` | The approval is the reviewer's, recorded at promotion |
| `project_approval_by` | As above |

`record_last_updated` and `record_last_updated_by` are also empty. They describe
edits to the master list, so they are meaningless for a row that has not
reached it.

**Block 3 - intake-only answers (columns 81 to 94).** Questions the form asks
that the master list has no column for:

`application_type`, `application_type_other`, `timing_constraints`,
`equipment_availability_confirmed`, `field_team_experience`,
`training_required`, `fdsn_network_code`, `estimated_data_volume`,
`data_submission_confirmed`, `embargo_duration`, `embargo_reason`,
`restricted_reason`, `cultural_heritage_check` and `funding_status`.

These are review-supporting answers. They are not published and they are not
copied at promotion, but several of them carry the review decision: the embargo
answers say how long the applicant expects data to be withheld and why,
`cultural_heritage_check` and `restricted_reason` bear on whether the work can
proceed as described, and `equipment_availability_confirmed`,
`field_team_experience` and `training_required` bear on whether the loan is
practical. Read them before approving. They sit after block 2 so that block 2
stays a single unbroken range.

### Changing the columns

The column set is written down in exactly two places in `gas/Code.gs`:
`applicationsHeaders_()` and `buildApplicationRecord_()`. Rows are written by
position, so those two must change together.

If the header row of an existing `ANSIR_Applications` tab does not match
`applicationsHeaders_()`, the endpoint **refuses to write** and reports the
first differing column. It does not attempt to migrate the tab or guess at a
mapping, because writing new values into old columns would mis-file every field
without any error. To recover, rename the existing tab, for example to
`ANSIR_Applications_archive`; the next submission creates a fresh tab with the
correct headers, and the renamed tab keeps its rows. Do not add or reorder
columns in the tab by hand.

---

## 4. Where the application is filed

Two Drive folders, both owned by the account that owns the script, both private:
nothing in either is published, linked from a public page, or committed to git.

| Folder | Constant | What is in it |
|---|---|---|
| Staging | `UPLOAD_FOLDER_ID` | Supporting documents that have been uploaded but not yet submitted. Required |
| Application filing | `APPLICATION_FOLDER_ID` | One folder per application, named after its ANSIR reference. Optional |

### Why staging exists

The per-application folder is named after the ANSIR reference, and the reference
is allocated at submission. The supporting document, though, is uploaded
earlier, by a separate `saveUploadedFile` call, at a point where no reference
exists and no folder could be named after one.

So uploads land in the staging folder. At submission, once the reference has
been allocated, the endpoint creates a folder named after it, moves the staged
document into it, and writes a PDF copy of the application alongside:

```
ANSIR Applications/                    (APPLICATION_FOLDER_ID)
  ANSIR-2026-008/
    ANSIR-2026-008 Application.pdf     the PDF copy of the application
    ANSIR_Application_<title>_<timestamp>.pdf   the applicant's document
```

In steady state the staging folder is empty. What remains in it are uploads from
sessions that were never submitted.

### The containment check, and why the order matters

`submitApplication` confirms that the supplied file ID names a file inside the
staging folder and refuses anything outside it. The ID arrives from the client
and the file is about to be emailed to an address that also arrived from the
client, so that check is what confines the attachment to files the intake itself
created.

It runs **before** the file is moved, and that position is part of the control
rather than an accident of ordering. The check is only true while the document
is still in the staging folder; filing moves it out. Verify first, move
afterwards. It also runs **before** a reference number is allocated, so an
unusable file ID fails without consuming a reference.

One consequence is worth knowing: a document that has already been filed against
a reference is no longer in the staging folder, so its file ID is refused by any
later submission. One upload belongs to one application.

Uploads are checked server-side after decoding, not on the client's word: the
actual decoded byte length is measured against the 10 MB limit, and the leading
bytes are inspected to confirm the file really is a PDF. No state is held
between executions anywhere in the design; the upload call returns an ID and the
submit call fetches the file back by that ID.

### The PDF copy of the application

Named `<reference> Application.pdf`, and attached to all three notification
emails as well as filed. It is a printable transcript of the whole application:
the reference, the submission time, then every section in the order the form
asks them, including all contributors and the itemised equipment request, and
the supporting document's filename where one was attached.

Its content comes from the same function that builds the body of the emails, so
the filed PDF and the two notifications cannot disagree about what was
submitted.

### When filing is not configured

`APPLICATION_FOLDER_ID` is optional. Left unset, the endpoint behaves as it did
before filing existed:

- no per-application folder is created,
- the supporting document stays in the staging folder,
- `application_folder_url` is written empty,
- the application is recorded and the emails still go out, with the PDF copy
  still attached,
- one line is written to the execution log saying folder filing is not
  configured.

The same applies if a filing step fails rather than being unconfigured. Folder
creation, the move, PDF generation and writing the PDF into the folder are
wrapped separately, and all of them run after the row has been written. A Drive
outage costs tidiness, never an application.

### What the row records

`supporting_document_file_id`, `supporting_document_url`,
`supporting_document_name` and `application_folder_url`. The URLs are ordinary
Drive links, openable only by people with access to those folders. The document
URL is unaffected by filing, because a Drive link is built from the file ID and
survives a move.

---

## 5. Who is emailed

Three notifications per submission, all plain text.

| Recipient | Content | Attachments |
|---|---|---|
| The applicant (`lead_email`) | Acknowledgement, their ANSIR reference, next steps and a full transcript of the submission | The application PDF, and the uploaded document if there was one |
| `ADMIN_EMAILS` | The same full transcript, plus where the row was recorded and a note that the row is an application, not a project. Reply-to is the applicant | As above |
| `FACILITY_ROUTES` | Identical to the administrator notification | As above |

Either attachment can be absent: there may have been no supporting document, and
PDF generation may have failed. The send goes ahead with whatever exists, because
an email with one attachment is a smaller loss than no email at all.

Subjects are `ANSIR equipment loan application received - <code>` to the
applicant and `New ANSIR equipment loan application - <code>` internally. Mail
is sent under the display name `ANSIR Equipment Loans`.

### Method-based facility routing

`FACILITY_ROUTES` at the top of `gas/Code.gs` maps each of the form's method
checkbox values (`Seismic`, `Nodal Seismic`, `DAS`, `Magnetotelluric`,
`Petrophysical`) to a list of addresses. `methods_field` arrives
semicolon-delimited; the recipient list is the union of the addresses for the
methods the applicant selected, deduplicated. A single-method application
therefore reaches only the facility that operates that method, and a
mixed-method application reaches each of them once.

A method with no addresses configured produces no facility send, and the
execution log names the methods that had no address. A method string that is
not a key in `FACILITY_ROUTES` is logged by name rather than dropped in
silence, so a renamed form checkbox is visible rather than quietly unrouted.

To route a method, add its addresses to that method's list and deploy a new
version. Nothing else changes.

### Order of operations

The sheet row is written first, inside the lock; the emails are sent
afterwards, each send wrapped individually. A bounce, an exhausted mail quota
or a mistyped address therefore costs a notification, never an application. If
an applicant reports applying and no email arrived, check the
`ANSIR_Applications` tab first.

---

## 6. The ANSIR reference number

Format `ANSIR-<year>-NNN`, sequence zero-padded to three digits, allocated at
submission time and quoted back to the applicant immediately.

The scan covers **both** tabs: the master list, so numbering stays globally
correct against real projects, and the intake tab, so two pending applications
can never be issued the same reference.

Read, increment and write happen inside `LockService.getScriptLock()`, with a
30 second timeout, held across the row append as well as the scan. Holding it
across both means a reference is never handed out without a row recording that
it was. If the lock cannot be obtained, no reference is allocated, no row is
written, and the applicant is asked to try again in a moment.

Matching rules:

- A code counts only if it begins with `ANSIR-<year>-` and the remainder is
  digits and nothing else. Suffixed variants such as `ANSIR-2026-003a` or
  `ANSIR-2026-003-REV` do not count as plain sequence numbers.
- Identifiers outside the `ANSIR-<year>-NNN` scheme, such as `2005-S01`,
  `2008-M01`, `ANU-2021`, `ANU-2023-001`, `SX-2023`, `S01-2019`, `MT03-2020`,
  `OB01-2019` and `UA-2017-001`, are ignored rather than parsed.
- A shorter digit sequence, such as `ANSIR-2023-06`, is counted when the year
  matches, and its successor is padded back out to three digits.

The allocation logic is unit tested against the published data:

```
node gas/test-ansir-code.js
```

---

## 7. Contributor autofill

The form offers autofill when the applicant starts typing a contributor name.

It is built client-side from the already-public
`https://auscope.github.io/ansir/data/data.json`, which passes through the same
publishing filter as every other public page. Each entry in `contributors[]`
carries `name`, `title`, `orcid`, `position`, `organisation`,
`organisationRor`, `organisationRole`, `isContact` and `isLeader`, and no email
field.

ORCID autofill is allow-listed. `scripts/validate-contributors.js` resolves
every ORCID in the published data against the public ORCID register at
`https://pub.orcid.org/v3.0/` and writes `data/contributor-verification.json`,
which the form loads at start-up. Each verified entry records the names the
register's own name for that identifier matches, so an identifier is offered to
a contributor only where the register confirms it for that person. Anything the
list does not vouch for is left blank for the applicant to type, under a short
line saying the identifier was withheld. If the verification file cannot be
loaded, no ORCID is offered at all, and name, title, organisation and ROR
autofill carry on as normal.

Autofill therefore completes name, title, confirmed ORCID and organisation, and
the applicant types their own email address. If you change the publishing
pipeline, keep email out of the public `contributors[]`: the autofill design
depends on its absence.

---

## 8. Promoting an application to a project

**This step is manual by design.** Nothing automated moves a row from
`ANSIR_Applications` into `ANSIR_Projects_MasterList`. The master list feeds the
public site, and an application arriving from an anonymous form is unverified
input, so a person reads it before it crosses that boundary.

1. **Assess.** Open the `ANSIR_Applications` tab, find the row by its ANSIR
   reference, and read it alongside the emailed transcript. Follow
   `application_folder_url` to the application's folder, which holds the PDF
   copy of the application and the applicant's supporting document.
2. **Record the assessment.** Fill in `review_status`, `reviewed_by` and
   `review_notes`. Use `Under Review`, then `Approved` or `Declined`.
3. **If declined:** set `review_status` to `Declined`, note the reason, and
   reply to the applicant. The row stays where it is as the record.
4. **If approved, promote it.** This is a range copy followed by the columns
   the reviewer owns.

   **Step 1 - copy the master-aligned range.** In `ANSIR_Applications`, select
   columns 9 to 80 of the application's row, from `title_primary` to
   `internal_notes`. That range is the master list's full column set, in the
   master list's order. Copy it, then paste it into a new row in
   `ANSIR_Projects_MasterList` starting at the first column. Every value lands
   under the header it belongs to, including the empty ones. Paste values only,
   not formatting.

   Nothing outside that range is copied. Block 1 records how the application
   was handled and block 3 holds answers the master list has no column for;
   both stay in the intake tab, where they remain the record of what was
   submitted.

   **Step 2 - set the columns the reviewer owns.** The pasted row arrives with
   these empty by design. Fill them in:

   - `alternative_identifier_id` - the next value: take the highest existing
     one and add one.
   - `project_status`.
   - `visible` - `FALSE` until the project should be public.
   - `visbility` - spelt as it appears in the master list header.
   - `project_approval` and `project_approval_by`.
   - `record_last_updated` and `record_last_updated_by`.

   Leave `alternative_identifier_ansir_code` exactly as it arrived. The
   applicant already holds that reference in writing.

   **Step 3 - fill in what the form does not collect.** These arrive empty
   because intake never asks for them, and can be completed now or as the
   project progresses: `raid_identifier`, `related_raid_relation`,
   `contributor_role_id`, `funding_agency_location`, `funding_agency_ror`,
   `funding_identifier_type`, `methods_analytical`, `methods_computational`,
   `instrumentation_method`, `instrumentation_owner`, `instrumentation_location`,
   `instrument_provider_ror`, `location_coordinates`, the `collection_*`
   columns and the `related_object_*` columns.

   **Step 4 - check the paste landed square.** Confirm that `title_primary` in
   the new master row holds the project title and that `internal_notes` holds
   the intake note, then spot-check one column in the middle, such as
   `location_region`. If any of those is holding a neighbour's value, the range
   was off by a column: delete the row and paste again rather than correcting
   it by hand.
5. **Close the loop on the intake row.** Set `review_status` to `Promoted` and
   record the master list row number in `review_notes`. Keep the intake row: it
   is the record of what was submitted, as submitted.
6. **Move the application's folder** to wherever approved project documents are
   kept, and update the master list if you hold a document reference there. The
   folder already holds both the application PDF and the supporting document, so
   it moves as one item, and `application_folder_url` keeps working afterwards
   because a Drive link survives a move.
7. **Publish when ready.** Set `visible` to `TRUE` and let the GitHub Action
   publish. Confirm what appeared on the public site: the pipeline filters
   fields, and that filter is the last line of defence.

---

## 9. Behaviour on failure

| Situation | Designed behaviour and where to look |
|---|---|
| Applicant reports applying, no email arrived | The row is written before any email is sent, so the application is in the `ANSIR_Applications` tab. Check there first |
| Upload returns a configuration message | `UPLOAD_FOLDER_ID` has not been set to a real folder. See `gas/README.md` |
| The log says folder filing is not configured | `APPLICATION_FOLDER_ID` is still the placeholder. Nothing is wrong: the application is recorded and emailed, and the document stays in the staging folder. Set the folder ID and deploy a new version to switch filing on |
| `application_folder_url` is empty on a row | Either filing is not configured, or the folder could not be created. The application is unaffected. Check the Executions log for a `createApplicationFolder_` error |
| The supporting document is still in the staging folder | The move failed after the folder was created. The document is still attached to the emails and `supporting_document_url` still opens it. Move it by hand and check the log for a `moveStagedFile_` error |
| No application PDF in the folder or on the emails | PDF generation or the write into the folder failed. The application, the row and the email bodies are unaffected, and the email bodies carry the same transcript the PDF would have. Check the log for `buildApplicationPdf_` or `fileApplicationPdf_` |
| A previously used file ID is refused | The document has already been filed against another reference, so it is no longer in the staging folder. That is the intended behaviour. Upload it again |
| Submission answered with "the service is busy" | The hourly cap was reached. It is global, not per person. Raise `MAX_SUBMISSIONS_PER_HOUR` and deploy a new version |
| Reference allocation reports the service is busy | The script lock was not obtained within 30 seconds. No reference was issued and no row was written. Check the Executions log for lock timeouts |
| Supporting document cannot be found at submission | The file ID does not name a file in the staging folder. The applicant is asked to upload again; no reference is consumed |
| Form submits but the console shows a CORS error | The request was not posted as `text/plain`. See `gas/README.md` |
| Sheet cannot be opened | The script property `ANSIR_SHEET_ID` is not set. The endpoint reports the cause and writes nothing |
| Submissions fail and the log reports a header mismatch | The `ANSIR_Applications` tab was created under a different column layout, or its headers were edited by hand. Nothing was written, deliberately. Rename the tab so a correctly headed one is created. See section 3 |
| Edits to `Code.gs` have no effect | Saving in the editor is not deploying. Deploy > Manage deployments > edit > New version |

Every log line from the endpoint is prefixed `[ANSIR INTAKE]` and is visible in
the Apps Script editor under Executions.
