# The equipment loan application form

The ANSIR equipment loan application form lives at
[`apply/index.html`](../apply/index.html). It is a single, self-contained static
page: vanilla HTML, CSS and JavaScript, with no build step, no frameworks and no
CDNs. GitHub Pages serves it from the facility repository, the AuScope
Squarespace site embeds it in an iframe, and it talks to exactly one server
endpoint, the write-only intake web app in [`gas/Code.gs`](../gas/Code.gs).

- Repository: <https://github.com/AuScope/ansir>
- Published form: <https://auscope.github.io/ansir/apply/>
- Project data used by the form: <https://auscope.github.io/ansir/data/data.json>

The endpoint side is documented in [`INTAKE.md`](INTAKE.md).

---

## 1. The five steps

A progress bar across the top tracks five steps. Each step is a
`.form-section[data-step="N"]` block; the Next button validates the visible step
before advancing.

| Step | Heading | What it collects |
| --- | --- | --- |
| 1 | Project & People | Project title, acronym, project summary, scientific objectives, keywords (chips control writing to the hidden `project_keywords` field), the lead investigator block (title, given name, family name, email, ORCID, organisation, organisation ROR), and any number of additional team members |
| 2 | Where & When | Proposed start and end dates, alternative dates and timing constraints, location/region, country, and a drawn study area boundary stored as GeoJSON in the hidden `location_polygon` field |
| 3 | Equipment Request | Primary method(s), methods description, the equipment matrix, field team experience, training and technical assistance, and the equipment availability confirmation |
| 4 | Data & Declarations | Data archiving requirements, FDSN network code, estimated data volume, data submission acknowledgement, intended data access level with its conditional embargo or restriction detail, cultural heritage and Indigenous engagement questions, project funding, up to five optional supporting PDFs, and the terms declaration |
| 5 | Review & Submit | A read-only rendering of everything collected in steps 1 to 4, then submission |

A sixth section is shown only after a successful submission and displays the
reference in the `ANSIR-<year>-NNN` format.

### Mandatory fields

Required inputs carry the `required` attribute and a `.form-label.required`
label. Step 1 requires project title, project summary, scientific objectives,
and the lead investigator's given name, family name, email and organisation.
Step 2 requires the start date, end date and location/region. Step 3 requires at
least one primary method and the equipment availability confirmation. Step 4
requires an intended data access level, the Indigenous involvement answer, the
application type, the funding status, the data submission acknowledgement and
the terms declaration.

### The supporting documents control

Step 4 ends with a drag-and-drop zone over a `multiple` file input. Documents
**accumulate**: choosing files a second time adds to the list rather than
replacing it, and the input's value is cleared after every selection so that
re-choosing the same file still registers and the input can never disagree with
the list about what is attached. Each attached document is shown with its file
name, its size and its own Remove control, above a running total.

| Limit | Value | Why |
| --- | --- | --- |
| Documents per application | 5 | Enough for a proposal, a permit, a risk assessment, a site map and a letter of support, and still readable at a glance |
| Size of one document | 10 MB | Unchanged |
| Total across all documents | 10 MB | **A mail limit.** Every document is attached to all three ANSIR notification emails alongside the generated application PDF, and a message over roughly 25 MB is rejected outright. Without this cap an application with five 10 MB documents would produce three emails that never send: the applicant would have a reference number and nobody would be told |
| File type | PDF only | Unchanged. The endpoint re-checks the `%PDF-` magic number on the decoded bytes of every file |

A file that breaches any of these is refused with a message naming the limit,
and the files in the same selection that do fit are still attached: refusing a
whole selection because its last item was too large would be needlessly
punishing. Every one of these checks is repeated server-side. The form is a
courtesy, not a security boundary.

---

## 2. The equipment matrix

Equipment is organised into nine categories, each a
`div.equipment-category` with a `data-methods` attribute listing the research
methods it belongs to:

| Category element | Heading | `data-methods` |
| --- | --- | --- |
| `equip-seismic` | Broadband Seismometers | Seismic |
| `equip-shortperiod` | Short-Period Seismometers | Seismic |
| `equip-recorders` | Seismic Data Recorders | Seismic |
| `equip-mt-lp` | Long-Period MT | Magnetotelluric |
| `equip-mt-bb` | Broadband MT | Magnetotelluric |
| `equip-das` | Distributed Acoustic Sensing (DAS) | DAS |
| `equip-nodal-bb` | Broadband Node, 5s | Nodal Seismic |
| `equip-nodal-sp` | Short-Period Node, 5Hz | Nodal Seismic |
| `equip-petro` | Field Deployable Tools | Petrophysical |

Every category starts hidden. The five Primary Method checkboxes
(`methods_field`, values `Seismic`, `Nodal Seismic`, `DAS`, `Magnetotelluric`,
`Petrophysical`) each call `updateEquipmentVisibility()` on change. That function
reads the checked method values, then shows a category when any entry in its
comma-separated `data-methods` list is among them and hides it otherwise. While
no method is selected, the `no-method-message` prompt is displayed in place of
the matrix.

Each item inside a category is a quantity input named `inst_<item>`, defaulting
to `0`, with a `min` of `0` and an item-appropriate `max`. Category headers are
collapsible through `toggleEquipment()`.

**Layout contract.** A new instrument is added by placing an
`input[type="number"][name="inst_<item>"]` inside the appropriate
`.equipment-category`. A new category is added by giving the wrapper element a
`data-methods` attribute containing one or more of the five method values
exactly as they appear in the checkbox `value` attributes. Nothing else needs
changing: visibility, review rendering and submission all key off those two
conventions.

---

## 3. Contributor autofill

`loadContributorProfiles()` fetches [`../data/data.json`](../data/data.json), the
same public project data the projects page uses, and walks `contributors[]`
across every project to build one profile per person. The index-building and
derivation logic is in `buildProfileIndexes()`, `deriveProfile()` and
`resolveIdentifier()`.

The published data carries **no email field**, so autofill never writes an email
address. Email inputs are left blank for the applicant to complete, and the
suggestion card shows a person's name, title and organisation only.

Choosing a suggestion fills the fields and does nothing else: no summary panel,
no per-field breakdown, no toast. The fields are the feedback.

If either data fetch fails, the form degrades to a plain, un-autofilled form.
Suggestions are unavailable; everything else, including drafts and submission,
continues to work.

### 3.1 Most recent non-empty value wins

A person's entries are sorted by their project's `startDate`, newest first, and
each field takes the first non-empty value found. People move institutions and
organisations are renamed, so the newest record is the current one. Each profile
also records which project supplied each field, so provenance can be shown
rather than assumed.

`data.json` names the identifier field `organisationRor`; the form field is
`org_ror`. `autoFillContributor()` maps between them.

### 3.2 `position` is never autofilled

`position` describes a person's role on a given project, not an attribute of the
person, so it is not stored on the profile and not written by team recall. The
form has no position input, and none should be added on the assumption that
autofill would populate it. The applicant states the position for the
application in front of them.

### 3.3 ORCIDs are offered only when confirmed against the ORCID register

An ORCID is offered only when something outside this dataset vouches for it.

[`scripts/validate-contributors.js`](../scripts/validate-contributors.js)
resolves every ORCID in `data.json` against the public ORCID register at
`https://pub.orcid.org/v3.0/`, which needs no authentication, and writes
[`data/contributor-verification.json`](../data/contributor-verification.json)
with this shape:

```json
{
  "counts":   { "verified": 0, "rejected": 0, "unknown": 0,
                "verifiedPairs": 0, "rejectedPairs": 0 },
  "verified": { "<bare-orcid>": { "name": "<register name>",
                                  "matchedClaimants": ["<contributor name>"] } },
  "rejected": { "<bare-orcid>": { "reason": "<code>",
                                  "names": ["<contributor name>"] } },
  "unknown":  {}
}
```

The form loads that file alongside `data.json` at start-up and applies the gate
in `buildProfileIndexes()`, at the moment each contributor record is read. An
ORCID the file does not vouch for **on that record's name** becomes `''` there
and then, so it exists nowhere downstream: not in a profile, not on a suggestion
card, not in team recall.

**Confirmation is per person, not per identifier.** Each `verified` entry carries
`matchedClaimants`, the contributor names the register's own name for that
identifier matches. `orcidIsVerified(value, name)` requires both that the
identifier is present and that the name it is about to be offered to is in that
list. A `verified` entry with no usable `matchedClaimants` vouches for nobody and
is dropped on load, leaving the gate closed for that identifier.

**Comparison is on the bare identifier.** `bareOrcid()` reduces a stored value to
`NNNN-NNNN-NNNN-NNNX` with an uppercase check character before comparing. Stored
values vary in form, so comparing anything other than the bare identifier matches
nothing.

**The two sides compare names by different rules, deliberately.**
`validate-contributors.js` allows spelling variants when matching a register name
against a contributor name: an exact match after normalisation, a shared family
name, or one being a prefix of the other. The browser does not repeat that logic.
`matchedClaimants` is written from the same `data.json` strings the profile names
come from, so the client compares them trimmed, whitespace-collapsed and
lowercased (`nameKey()`), which is exact. Reimplementing the variant rule in the
browser, where the register's own name is not available, would only widen the
gate.

**It fails safe.** If `contributor-verification.json` is missing, returns a
non-200 or does not parse, `orcidGateAvailable` stays `false` and no ORCID is
offered at all, including ones that would otherwise pass. A quiet grey notice at
the top of the Team Members section says so. The `catch` has no fallback path to
the raw values in `data.json`: a gate that opens when it breaks is not a gate.
Name, title and organisation autofill, the organisation-to-ROR lookup, team
recall, drafts and submission are all unaffected in that state.

**What the applicant is told.** Where an ORCID is withheld, one line appears
directly under that row's ORCID input, and it clears as soon as anything is typed
into the field:

> ORCID left blank - could not be confirmed against the ORCID register. Please
> enter it yourself.

Nothing internal reaches the page, and the register's own name for an identifier
is never shown. Where a person simply has no ORCID recorded, nothing is said.
This line is the only message an applied profile leaves anywhere on the form.

**Conflicting identifiers are left blank, never guessed.** Applied to whatever
survives the gate: an ORCID identifies one person, so two distinct confirmed
ORCIDs against one name means two people sharing a name, which is not the form's
to resolve. The field is blanked with a note. `organisationRor` has no register
to check against and is governed by this rule alone; a blanked ROR is
recoverable, and the note points the applicant at the organisation lookup.

### 3.4 Placeholder strings are treated as absent

`cleanValue()` treats `NA`, `N/A`, `none`, `null`, `-`, `TBD` and `unknown` as
empty, so a placeholder is never written into a new application as though it were
an identifier and never counts as a second value under the conflict rule.
Identifiers are canonicalised before comparison, so a value that differs only in
punctuation or wrapping is not read as a distinct one.

### 3.5 Team recall

Once a known person is matched, a compact inline control appears under that
person: a select of the projects they appear on, and an "Add team" button. One
row, no heading and no explanatory prose. Adding a team writes one short line in
place:

> Added 5 team members from ANSIR-2023-06 (2023); 2 ORCIDs left blank - not
> confirmed against the ORCID register.

The second clause is appended only when the count is above zero. There is no
per-person list: the rows show what was filled, and any row whose ORCID was
withheld carries the one-line hint from section 3.3.

- It is **explicit opt-in**, never automatic.
- It is **additive**. Existing rows are never altered or removed, and anyone
  already named on the form, including the lead and including a row typed by
  hand, is skipped.
- It applies each person's **derived profile** rather than the raw record on the
  chosen project, so the newest known details win and conflicting identifiers
  stay blank.
- Every recalled ORCID passes the **same confirmation check** as any other path,
  re-applied at the point the field is written. This path writes fields directly
  rather than going through `autoFillContributor()`, so the check is repeated
  here on purpose: it costs one lookup per person and means no later edit to this
  function can quietly widen the gate.
- It carries **no position** and **no email**.

Projects are keyed internally by the project `id`, not by `ansirCode`, because
`ansirCode` is not unique across projects.

### 3.6 Organisation lookup

An index of the distinct organisation names is built from the same data, each
with the ROR identifiers seen against it. Choosing an organisation fills the
organisation name and its ROR together, which is the cheapest way to keep
free-text identifiers out of the field. It populates the `lead_org_dropdown`
element.

Where an organisation has no ROR on record, it is offered with the ROR field left
blank and a note saying so. Where a name maps to more than one ROR, each pairing
is offered as its own option rather than one being chosen automatically. If a ROR
field already holds something different, the applicant is asked before it is
replaced.

### 3.7 Matching and accessibility

Matching is case-insensitive, tolerates extra internal whitespace, and matches on
given name, family name or any substring. Exact and prefix matches rank above
internal substring matches. The list is capped at 8 suggestions and the count of
hidden matches is shown.

Both lookups use the ARIA combobox pattern: `role="combobox"` with
`aria-expanded` and `aria-activedescendant` on the input, and `role="listbox"`
with `role="option"` in the popup. They are fully operable with Down, Up, Home,
End, Enter, Escape and Tab. Because applying a suggestion changes several fields
at once, which is otherwise silent, the result is announced through the
`#autofillStatus` live region.

Applying a suggestion never overwrites a field the applicant has already filled
with a different value. Empty fields are filled, a differing field is left alone
with nothing said about it, and a value differing only in capitalisation is
corrected, since no information is lost.

---

## 4. Draft saving

Every field change schedules a debounced (800 ms) write to `localStorage` under
the key `ansir_application_draft_v1`. The draft holds field values, checkbox and
radio states, keywords, additional team members, the drawn study area and the
step the applicant was on.

On load, a saved draft is **offered, not applied**. A banner appears with the
save time and two buttons, "Restore my draft" and "Start fresh", and nothing is
repopulated until the applicant chooses.

The draft is cleared on successful submission and nowhere else, so an application
that failed to submit is never lost. Drafts older than 30 days expire rather than
being offered back.

The attached PDFs are deliberately not persisted: base64 file contents would
exceed the `localStorage` quota, and up to five of them makes that worse rather
than better; a research document should not be left sitting in browser storage
either way. The restore banner states that the documents will need to be
attached again, and the message shown after a restore says so too.

---

## 5. The review step

Step 5 displays every input the form collects, grouped under the form's own four
section headings (Project & People, Where & When, Equipment Request, Data &
Declarations) in the order the form asks for them.

**Rows are enumerated from the DOM, not hand-listed.** `collectReviewSections()`
walks `.form-section[data-step="1"]` through `[data-step="4"]` and picks up every
`input[name]`, `select[name]` and `textarea[name]` it finds, so a field added to
the form later appears on the review step with no further work.

Each row carries `data-field="<input name>"`, so the enumeration can be checked
against the form mechanically:

```js
// Zero missing is the assertion. Equipment at quantity 0 is excluded by design.
const collected = new Set(); const zero = new Set();
for (let s = 1; s <= 4; s++) {
    document.querySelector('.form-section[data-step="' + s + '"]')
        .querySelectorAll('input[name],select[name],textarea[name]').forEach(el => {
            const n = el.getAttribute('name'); if (!n) return;
            if (n.indexOf('inst_') === 0) { ((parseInt(el.value, 10) || 0) > 0 ? collected : zero).add(n); return; }
            collected.add(n);
        });
}
const shown = new Set([...document.querySelectorAll('#applicationSummary .summary-item[data-field]')]
    .map(e => e.getAttribute('data-field')));
[...collected].filter(n => !shown.has(n)); // must be []
```

How each kind of control is rendered:

- **Radio groups** show the selected option's `.radio-label` text spelled out,
  not the raw value: `Yes - cleared` displays as "Yes - Clearances Obtained".
- **Checkbox groups** (the five research methods) list the selected values.
- **Single required checkboxes** (the equipment availability confirmation, the
  data submission acknowledgement, the terms declaration) show "Confirmed", or
  "Not provided" if unticked. Optional ones show Yes or No.
- **Conditional detail fields** are shown whether or not their parent answer
  triggered them, so a value left over from a changed answer is visible rather
  than hidden.
- **The Other application type** free text has its own row, since it shares a
  group label with the radio set it qualifies.
- **Equipment** appears in place under an "Equipment requested" sub-heading, only
  where the quantity is above zero, labelled with the item name and its category.
  If nothing is requested, one row says so.
- **Additional contributors** appear in full, each under its own "Team Member N"
  sub-heading so that repeated labels such as "Given Name" stay unambiguous.
- **Supporting documents** appear under their own sub-heading: one summary row
  carrying the count and the combined size, then one row per document with its
  file name and size. The summary row is the one carrying
  `data-field="supporting_document"`, so the check above still finds exactly one
  row per named control however many documents are attached.
- **The drawn map area** shows the coordinates summary, not raw GeoJSON.
- **An attached file** shows its name and size.
- **Anything empty** shows "Not provided" in muted italic. Nothing is omitted:
  the point of the step is to let someone see what is missing while they can
  still fix it.

**Every value is written with `textContent` or `createTextNode`.** There is no
string of markup for a field value to be interpolated into, so field content
cannot become markup on the review step.

`cleanValue()` is deliberately not used for review values. It collapses newlines
and treats `Unknown`, `TBD` and `None` as absent, which is correct when reading
the published data set and wrong when showing an applicant what they typed.

---

## 6. Talking to the intake endpoint

One helper, `callEndpoint(action, payload)`, POSTs to the intake web app. Three
details are load-bearing and must not be tidied up:

- **`Content-Type: text/plain;charset=utf-8`.** This is one of the three CORS
  simple content types, so the browser issues no preflight `OPTIONS` request. An
  Apps Script web app cannot answer a preflight, because there is no way to make
  it return the `Access-Control-Allow-*` headers `OPTIONS` requires. Switching to
  `application/json` triggers a preflight and the form stops working.
- **`redirect: 'follow'`.** Apps Script answers a POST with a 302 to
  `script.googleusercontent.com`, and the browser must follow it to reach the
  body.
- **Never branch on `response.ok`.** An Apps Script web app cannot set an HTTP
  status code. It always replies 200 and reports the real outcome in the JSON
  body's `success` field, so the code checks `success`, not the status.

### 6.1 Submission with attachments

An application carrying supporting PDFs makes one call per document and then one
more:

1. `saveUploadedFile`, **once per document, sequentially**, each sending one
   file's base64 contents and returning a Drive **file ID**.
2. `submitApplication` sends the application, carrying those values as
   **`uploaded_file_ids`**, an array. The base64 contents are removed from this
   payload.

**One file per call, and not one large payload.** Base64 inflates a payload by
about a third, so a single request carrying five documents would be large, slow
and all-or-nothing: one unreadable file would fail the set. Per-file calls also
mean a failure can be reported naming the file that failed. Sequential rather
than concurrent, because five simultaneous base64 POSTs to one Apps Script
deployment is how a rate limit gets tripped by one honest applicant.

The endpoint fetches the PDFs back out of Drive by those IDs, so no state is
held between the calls. Each file lands in the Drive staging folder under a
neutral staged name; at submission each document is filed into the
application's folder and renamed to `<reference> file_upload_<n>.pdf`, in
attachment order. The applicant's original filenames still appear in the
notification emails' listing of what was submitted. All documents are attached
to all three notifications, and they populate
`supporting_document_file_id`, `supporting_document_url` and
`supporting_document_name` on the sheet row as semicolon-delimited lists in the
same order, which is the same multi-value convention the contributor columns
use. No column was added for the second document.

If an upload call fails, the chain stops there and the applicant is told which
document failed and asked whether to submit with the ones that did upload,
rather than losing the whole application. Documents already staged in Drive are
kept: throwing them away would punish the applicant twice for one failure.
Stopping rather than pressing on through the remaining documents is deliberate,
so that a systematic failure asks the applicant one question rather than five.

### 6.2 Configuration

The deployment URL of the intake web app is held in a single clearly marked
constant near the top of the `<script>` block in `apply/index.html`:

```js
var ENDPOINT_URL = 'PASTE_APPS_SCRIPT_DEPLOYMENT_URL_HERE';
```

Until a value beginning `https://` is present, the form works up to the point of
submission and then reports a clear configuration error. It never reports a
submission as successful when none was made.

Every change to `Code.gs` requires **Deploy > Manage deployments > edit > New
version** in the Apps Script editor. Saving the editor alone does not update the
live deployment.

---

## 7. Publishing and embedding

### 7.1 GitHub Pages

Pages serves from the repository root, so committing and pushing `apply/` and
`lib/` publishes the form at <https://auscope.github.io/ansir/apply/>. Confirm
that `apply/index.html`, `lib/leaflet/leaflet.js`,
`lib/leaflet-draw/leaflet.draw.js`, `lib/leaflet-draw/images/spritesheet.svg`,
`data/data.json` and `data/contributor-verification.json` all return 200 over
HTTPS.

Leaflet and Leaflet.draw are vendored under `lib/`, with the Leaflet.draw sprites
in `lib/leaflet-draw/images/`, which is the layout the unmodified upstream
stylesheet expects. The vendored CSS is untouched, so re-vendoring a later
release is a straight copy.

### 7.2 Squarespace iframe

The page matches the embedding pattern used by the projects and stats pages: a
`SQUARESPACE_PARENT_URL` constant, `PARENT_ORIGIN` derived through
`new URL().origin`, a `ResizeObserver` on both `documentElement` and `body`,
`{type: 'ansir-resize', height}` posted to the parent, and a short post-load poll
to catch late-rendering content.

`SQUARESPACE_PARENT_URL` is
`https://www.auscope.org.au/ansir-application-form`. It must match the slug of
the page the iframe sits on; height messages posted to a different origin are
dropped by the browser and the iframe does not resize.

The Squarespace page carries a code block:

```html
<iframe id="ansir-application"
        src="https://auscope.github.io/ansir/apply/"
        style="width:100%;border:0;overflow:hidden"
        height="2000"
        title="ANSIR equipment loan application"></iframe>
<script>
  window.addEventListener('message', function (event) {
    if (event.origin !== 'https://auscope.github.io') return;
    if (!event.data || event.data.type !== 'ansir-resize') return;
    document.getElementById('ansir-application').style.height = event.data.height + 'px';
  });
</script>
```

The origin check is the important line.

---

## 8. Checking a deployment

Run these once against the published form after the endpoint URL is set.

### 8.1 Transport

The CORS headers on the redirected response are set by Google, not by this code,
so this check can only be made against the real deployment.

1. Open the published form from any origin that is not `script.google.com`.
2. Open developer tools, Network tab, and submit a test application.
3. Expect exactly: one `POST` to `/exec` returning **302**, one `GET` to
   `script.googleusercontent.com` returning **200**, **no** `OPTIONS` request,
   and the JSON body visible in the Response tab.
4. Check the Console for `blocked by CORS policy` or
   `No 'Access-Control-Allow-Origin' header`.

An `OPTIONS` request means the client is not sending
`Content-Type: text/plain;charset=utf-8`.

### 8.2 Submission

Without an attachment, submit the required fields only and confirm the
confirmation step shows a reference in the `ANSIR-<year>-NNN` format, a new row
appears in the `ANSIR_Applications` tab of the ANSIR project sheet, no row
appears in `ANSIR_Projects_MasterList`, the applicant address receives a copy and
the facility address receives the internal notification.

With attachments, attach three small PDFs and confirm all three are listed with
their sizes and a running total, that removing one updates the list and the
total, that choosing more files adds rather than replaces, and that the review
step lists what remains. Then confirm the POSTs described in section 6.1: one
`saveUploadedFile` per document in sequence, and a `submitApplication` body
carrying `uploaded_file_ids` and no base64 data. Confirm the files appear in the
Drive upload folder under names that include the applicant's own file names,
that all of them are attached to the emails, and that the three
`supporting_document_*` columns each carry a semicolon-delimited list in the
same order.

### 8.3 Draft

Fill in fields across steps 1 and 2, including a team member and a drawn study
area, wait a second for the debounce, then reload. The banner appears with the
save time and the form is still empty. "Restore my draft" returns every value,
the keywords, the team member block and the map shape, on the step left off at.
Submit successfully, reload, and no banner appears.

### 8.4 Autofill

Type at least two characters of a known contributor's name into the lead
investigator given-name field. A suggestion card appears showing the name and a
title and organisation line, and nothing else. Picking it fills name, title,
organisation and ROR, and leaves the email field untouched. If an email address
ever appears there, an email field has entered `data.json` and must be removed.

Confirm that picking a suggestion draws no panel anywhere. Type a value into one
of those fields by hand, re-apply the same suggestion, and confirm the typed
value survives untouched with nothing said about it.

Pick a person whose ORCID is confirmed and confirm the field fills, with the
ORCID line present on the suggestion card. Pick one whose ORCID is not confirmed
and confirm the field is blank, that the one-line hint appears under that row's
ORCID input only, and that it disappears as soon as anything is typed there.

Recall a team from a project containing both kinds of person and confirm the new
rows fill name, title, organisation and ROR, that unconfirmed ORCID fields are
blank and each such row carries the hint, and that the single summary line counts
them.

**Fail-safe check.** Serve a copy of the repository with
`data/contributor-verification.json` removed; the network log shows a 404 for it.
Confirm that no ORCID is offered for anyone, that the grey notice appears at the
top of Team Members, and that name, title, organisation, ROR and team recall all
still work. Repeat with the file present but truncated mid-JSON: the behaviour
must be identical.

### 8.5 Server-side validation

The form is not a security boundary. Confirm the endpoint rejects a bad request
made without it:

```
curl -L -X POST '<endpoint /exec URL>' \
  -H 'Content-Type: text/plain;charset=utf-8' \
  -d '{"action":"submitApplication","payload":{"title_primary":"x"}}'
```

Expect `{"success":false,"message":"The following required fields are missing: ..."}`.

---

## 9. Operating characteristics

- **Map tiles are the one external request.** The basemap comes from
  `tile.openstreetmap.org`. Raster map tiles are a data service and are not
  self-hosted; every piece of code the page loads is served from this repository.
  If the tile host is unreachable the map still initialises and the polygon
  drawing tool still works, over a blank background.
- **Rate limiting is applied at the endpoint**, and its cap is global across all
  callers, because Apps Script does not expose a caller IP address.
- **The draft is per browser.** It is not synced and does not follow an applicant
  from one device to another.
