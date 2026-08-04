# ANSIR application intake endpoint - deployment guide

This directory contains the **only** server-side code left in the ANSIR web
stack. Everything else - the project data, the public pages, the publishing
pipeline - is plain files in git.

This exists because three things in the equipment loan application genuinely
need a server, and cannot be done from a static page:

1. accepting a form submission from an anonymous member of the public,
2. storing uploaded PDFs somewhere durable,
3. sending email.

Nothing else lives here. If you find yourself adding a function to `Code.gs`
that does not serve one of those three jobs, it belongs in the git pipeline
instead.

---

## 1. The security property, and why it is the whole point

In Google Apps Script, **any top-level function whose name does not end in an
underscore is callable by anyone who can reach the deployment.** With
"Who has access: Anyone", that means callable by anybody on the internet, with
no authentication, simply by knowing the function name.

The previous ANSIR Apps Script web app exposed **37** such functions on an
anonymously accessible deployment, including one, `getContributorProfiles`,
that returned a deduplicated roster of researcher names **with their email
addresses**. That was the worst of the exposure, and it is why this rewrite
exists.

`Code.gs` exposes exactly **four**, and every other function ends in an
underscore, which Apps Script refuses to expose at all. This table is the
auditable proof.

### Function table

| # | Function | Web-callable | Purpose |
|---|---|---|---|
| 1 | `doGet` | **YES** | Serves the form HTML (fallback transport) |
| 2 | `doPost` | **YES** | JSON transport for a form served from GitHub Pages |
| 3 | `saveUploadedFile` | **YES** | Accepts one PDF per call, stages it, returns a Drive file ID |
| 4 | `submitApplication` | **YES** | Validates, records, allocates a reference, files, emails |
| 5 | `sheetId_` | no | Reads the sheet ID from script properties |
| 6 | `facilityRecipients_` | no | Facility addresses for the selected methods |
| 7 | `sendMail_` | no | Sends as the configured address when it is available |
| 8 | `handleUpload_` | no | Shared upload implementation |
| 9 | `handleSubmit_` | no | Shared submit implementation |
| 10 | `allocateAnsirCode_` | no | Lock, scan, allocate reference, create folder, append row |
| 11 | `readCodeColumn_` | no | Reads the ANSIR code column from a sheet |
| 12 | `nextAnsirCode_` | no | Pure sequencing logic (unit tested) |
| 13 | `getApplicationsSheet_` | no | Returns or creates the intake tab |
| 14 | `writeApplicationsHeaderRow_` | no | Writes and formats the intake header row |
| 15 | `headerMismatch_` | no | Describes the first differing column |
| 16 | `applicationsHeaders_` | no | The intake tab column order |
| 17 | `buildApplicationRecord_` | no | Form data to sheet row |
| 18 | `buildInternalNotes_` | no | Submission timestamp and one attachment note per document |
| 19 | `fileInfoField_` | no | Joins one field of every document into a semicolon-delimited cell |
| 20 | `buildContributorColumns_` | no | Flattens contributors to sheet columns |
| 21 | `isUploadFolderConfigured_` | no | Guards against the placeholder staging folder ID |
| 22 | `normaliseFileIds_` | no | Document IDs as an array, from either field shape |
| 23 | `getUploadedFiles_` | no | Retrieves every PDF, verifies each is in the staging folder, enforces the count and total-size caps |
| 24 | `getStagedFile_` | no | The containment check for one file |
| 25 | `buildUploadFileName_` | no | Builds a readable stored file name that keeps the applicant's own |
| 26 | `looksLikePdf_` | no | Checks the `%PDF-` magic number |
| 27 | `isApplicationFolderConfigured_` | no | Guards against the placeholder parent folder ID |
| 28 | `createApplicationFolder_` | no | Creates the folder named after the reference |
| 29 | `folderUrl_` | no | A folder's URL, or empty |
| 30 | `moveStagedFiles_` | no | Moves each staged document into that folder, wrapped one by one |
| 31 | `fileApplicationPdf_` | no | Writes the application PDF into that folder |
| 32 | `buildApplicationPdf_` | no | Renders the application as a PDF blob |
| 33 | `applicationPdfHtml_` | no | The HTML wrapper the PDF is rendered from |
| 34 | `pdfMetaRow_` | no | One row of the PDF heading table |
| 35 | `htmlEscape_` | no | Escapes a value into HTML |
| 36 | `validateFileData_` | no | Server-side PDF constraint checks |
| 37 | `validateSubmission_` | no | Server-side required-field checks |
| 38 | `isEmailAddress_` | no | Email format check |
| 39 | `rateLimitOk_` | no | Submissions-per-hour cap |
| 40 | `sendNotifications_` | no | Sends the three emails |
| 41 | `buildApplicantEmail_` | no | The applicant's copy |
| 42 | `buildInternalEmail_` | no | The admin and facility notification |
| 43 | `applicationTranscript_` | no | The application content, shared by both emails and the PDF |
| 44 | `contributorLines_` | no | Team member lines for the transcript |
| 45 | `equipmentCatalogue_` | no | Equipment key to display name map |
| 46 | `equipmentNames_` | no | Requested equipment, names only |
| 47 | `equipmentLines_` | no | Requested equipment, name and quantity |
| 48 | `formatPolygon_` | no | GeoJSON to plain lat, lon pairs |
| 49 | `safeText_` | no | Coerce, trim, cap length |
| 50 | `sheetSafe_` | no | Neutralises spreadsheet formula injection |
| 51 | `joinNonEmpty_` | no | Join non-blank parts |
| 52 | `orNotProvided_` | no | Display fallback |
| 53 | `formatBytes_` | no | A byte count as something a person can read |
| 54 | `formatDateTime_` | no | Human-readable timestamp |
| 55 | `jsonResponse_` | no | Builds the JSON `TextOutput` |
| 56 | `logLine_` | no | Operator log line |
| 57 | `logError_` | no | Operator error log |

**57 functions total. 4 web-callable. 53 private.**

Confirm the count as well as the names:

```
grep -c '^function ' gas/Code.gs
```

Verify this yourself at any time, without trusting the table:

```
grep -oE '^function [A-Za-z0-9_]*[^_(]\(' gas/Code.gs | sed 's/^function //;s/(//'
```

If that command prints anything other than `doGet`, `doPost`,
`saveUploadedFile` and `submitApplication`, something has been added that the
whole internet can now call. Treat it as an incident.

---

## 2. Prerequisites

- A Google account that has edit access to the ANSIR project sheet.
- The sheet's ID, which you will store as a script property rather than in
  code. It is the part of the sheet URL between `/d/` and `/edit`.
- Two folders in that same account's Drive: one to stage uploaded PDFs, and one
  to file completed applications in. See section 3.

Use an account whose daily email quota you are happy to spend. A consumer
`@gmail.com` account gets roughly 100 `MailApp` recipients per day; a Google
Workspace account gets roughly 1500. Each submission sends up to three emails,
so an ordinary Workspace account is comfortable and a consumer account is fine
for the volumes ANSIR sees.

### Sender identity

Outgoing mail is configured to be sent as **ansir@auscope.org.au**
(`MAIL_FROM_ADDRESS`), so the address applicants see stays stable across staff
changes. Apps Script cannot invent a sender, so this works in exactly two
setups:

1. **Deploy the script from the ansir@auscope.org.au account itself** (the
   clean long-term arrangement: that account then also owns the Drive folders
   and the deployment), or
2. **Deploy from a personal account that has ansir@auscope.org.au as a
   verified Gmail "Send mail as" alias** (Gmail Settings > Accounts > Send
   mail as; if the address is a Workspace group, the group must first allow
   members to post as the group).

If neither is true at send time, the application is NOT lost: the email still
goes out, sent from the deploying account, and the execution log records
exactly what to configure. Watch the log after the first real submission.

Note that sending as an alias uses `GmailApp`, so the one-time authorisation
prompt asks for Gmail permission in addition to the basic send-mail scope.
That is expected.

---

## 3. Create the Drive folders

Two folders, with different jobs. Both live in the Drive of the account that
will own the script.

### 3a. The staging folder (required)

1. Create a folder, for example `ANSIR Application Uploads`.
2. Open it and copy the ID from the URL:
   `https://drive.google.com/drive/folders/`**`<THIS_IS_THE_ID>`**
3. This is where `saveUploadedFile` writes supporting documents, before an ANSIR
   reference exists for them. At submission each document is moved out of it and
   into its application's folder, so in normal running it holds only documents
   from uploads that were never submitted.
4. Keep uploads and nothing else in it. `getUploadedFiles_` treats membership of
   this folder as proof that the intake itself created a file, applies that test
   to every document on a submission, and that proof is what stops a caller
   naming any other Drive file and having it emailed.

### 3b. The application filing folder (optional)

1. Create a second folder, for example `ANSIR Applications`.
2. Copy its ID the same way.
3. This is the parent that per-application folders are created inside. Each
   submission gets a folder named after its reference, for example
   `ANSIR-2026-008`, holding the supporting documents and a PDF copy of the
   application.
4. It must be a **different** folder from the staging one, and it must not be
   nested inside it, for the reason in step 3a.4.

Do **not** share either folder publicly. Applications and supporting documents
are private research material. The endpoint attaches them to emails and files
them in Drive; it does not publish them.

Leaving 3b unset is a supported configuration. Filing is then skipped, one line
is logged saying so, and everything else behaves exactly as before: the document
documents stay in the staging folder, the application is recorded, and the
emails go out with the PDF attached.

---

## 4. Create the Apps Script project

1. Go to <https://script.google.com> and create a new project.
2. Name it something obvious, for example `ANSIR Application Intake`.
3. **Set the project timezone to Australia/Sydney** (Project Settings, the
   gear icon, then "Time zone"). New Apps Script projects default to a US
   timezone, and the ANSIR reference year is read from the script's clock:
   left on the default, an application submitted on the morning of 1 January
   in Australia would still be numbered in the old year, because it is still
   31 December in New York. The `TIMEZONE` constant in the code only formats
   timestamps for display; this project setting is what governs the year.
4. Delete the stub `Code.gs` contents and paste in the entire contents of
   `gas/Code.gs` from this repository.
5. Edit the configuration block at the top:

   | Constant | Set it to |
   |---|---|
   | (sheet ID) | **Not in the file.** Set the script property `ANSIR_SHEET_ID` - see step 5 below |
   | `MASTER_SHEET_NAME` | Already correct - `ANSIR_Projects_MasterList` |
   | `APPLICATIONS_SHEET_NAME` | Already correct - `ANSIR_Applications` |
   | `UPLOAD_FOLDER_ID` | **Required.** The staging folder ID from step 3a |
   | `APPLICATION_FOLDER_ID` | Optional. The parent folder ID from step 3b. Left as the placeholder, per-application folders are not created and nothing else changes |
   | `ADMIN_EMAILS` | Already `ben@auscope.org.au`; add others as needed |
   | `FACILITY_ROUTES` | Facility addresses per research method (Seismic/Nodal Seismic/DAS, Magnetotelluric, Petrophysical). Every route deliberately empty; fill in per method when the addresses are agreed |
   | `MAIL_FROM_ADDRESS` | Already `ansir@auscope.org.au` - see "Sender identity" below |
   | `MAX_SUBMISSIONS_PER_HOUR` | `20` is a sensible starting point |

   The two folder constants fail in deliberately opposite ways, because they
   carry different consequences. If you leave `UPLOAD_FOLDER_ID` as the
   placeholder, uploads fail with a clear configuration error rather than
   silently succeeding: the previous version discarded every PDF it was given
   and told the applicant it had worked. If you leave `APPLICATION_FOLDER_ID` as
   the placeholder, nothing fails at all. Filing is convenience, so it is never
   allowed to cost an application; the execution log records that filing is not
   configured, and `application_folder_url` is written empty.

6. Save.

### 4a. Set the sheet ID as a script property

The sheet ID is deliberately **not** in `Code.gs`: this repository is public,
and an internal identifier committed to git cannot be un-published.

1. In the Apps Script editor, open **Project Settings** (the gear icon).
2. Scroll to **Script Properties** and click **Add script property**.
3. Property `ANSIR_SHEET_ID`, value = the ANSIR sheet ID, which is the part of
   the sheet URL between `/d/` and `/edit`.
4. Save.

If it is missing, the endpoint throws a message naming the property rather
than failing obscurely. Script properties belong to the deployment, not the
code, so anyone forking this repository gets an inert copy until they supply
their own sheet.

### The intake tab

You do not need to create `ANSIR_Applications` by hand. The first submission
creates it, with the correct headers and a frozen bold header row. If you would
rather see it in advance, submit one test application and inspect the result.

---

## 5. Deploy as a web app

**Deploy > New deployment > Web app.**

| Setting | Value | Why |
|---|---|---|
| Execute as | **Me** (the script owner) | The endpoint has to write to a private Google Sheet, write to a private Drive folder, and send email. An applicant is an anonymous member of the public with no access to any of that. "Execute as: User accessing the web app" would fail immediately, and would also force every applicant through a Google sign-in, which is not acceptable for a public research-facility application form. |
| Who has access | **Anyone** | Applicants are researchers at universities across Australia and overseas. Requiring a Google account to apply would exclude people and is not the access model ANSIR wants. |

Understand exactly what those two settings mean together: **anonymous callers
run code with the script owner's full authority.** That is precisely why the
web-callable surface has to stay at four functions, and why every one of them
re-validates its input server-side. The form is not a security boundary; anyone
can post whatever they like straight at the endpoint.

Note "Anyone", not "Anyone with Google account", and definitely not the legacy
"Anyone, even anonymous" wording from older Apps Script versions - the modern
editor calls the public option simply **Anyone**.

On first deployment Google will ask you to authorise the script for Sheets,
Drive and Gmail. Review the scopes and accept. You will see an "unverified app"
interstitial because this is an internal script rather than a published
add-on; click through **Advanced > Go to (project name)**.

Copy the deployment URL. It looks like:

```
https://script.google.com/macros/s/AKfycb.../exec
```

**Every time you change `Code.gs` you must click Deploy > Manage deployments >
edit > New version.** Saving the editor alone does not update the live
deployment. This trips everyone up at least once.

---

## 6. Wire up the form

### 6a. Preferred transport - `doPost` from GitHub Pages

This is the transport the pure-git move exists for: the form lives in git, is
served from GitHub Pages, and talks to the endpoint over plain HTTP.

The client **must** post with `Content-Type: text/plain` and a JSON string as
the body:

```js
var ENDPOINT = 'https://script.google.com/macros/s/AKfycb.../exec';

function callEndpoint(action, payload) {
  return fetch(ENDPOINT, {
    method: 'POST',
    // text/plain is one of the three CORS "simple" content types, so the
    // browser sends this request with NO preflight OPTIONS call. That matters:
    // an Apps Script web app cannot answer a preflight, because there is no way
    // to make it return the Access-Control-Allow-* headers OPTIONS requires.
    // Using application/json WILL trigger a preflight and WILL fail.
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: action, payload: payload }),
    redirect: 'follow'
  }).then(function (response) {
    return response.json();
  });
}
```

Two actions are accepted:

```js
// 1. Upload each supporting PDF first, ONE PER CALL, in sequence. Each
//    returns a Drive file ID.
callEndpoint('saveUploadedFile', {
  fileData: {
    fileName: 'proposal.pdf',
    mimeType: 'application/pdf',
    size: 1234567,
    data: '<base64 without the data: URI prefix>'
  },
  projectTitle: 'My project title'
});
// -> { success: true, fileId: '1AbC...', fileName: 'ANSIR_Application_..._20260803_142530_proposal.pdf', url: '...' }

// 2. Submit the application, passing those file IDs through.
callEndpoint('submitApplication', formDataObjectWith_uploaded_file_ids);
// -> { success: true, ansirCode: 'ANSIR-2026-007', emailsSent: ['applicant','admin'], message: '...' }
```

The file IDs go into the form data as `uploaded_file_ids`, either as an array or
as a semicolon-delimited string; both are accepted. The singular
`uploaded_file_id` this endpoint took before multiple documents existed is still
accepted too, so a browser holding an older cached copy of the form keeps
working. There is no cross-execution state anywhere: each upload call returns an
ID, and the submit call fetches the files back out of Drive by those IDs.

### Upload limits

| Limit | Value | Enforced |
|---|---|---|
| Documents per application | 5 | Client before an upload starts; `getUploadedFiles_` at submission |
| Size of one document | 10 MB | Client before an upload starts; `validateFileData_` on the claimed size, then again on the decoded byte length in `handleUpload_` |
| Total size of all documents | 10 MB | Client tracks the running total; `getUploadedFiles_` re-checks it at submission against the sizes Drive reports |
| File type | PDF only | Client on the MIME type; server on the `%PDF-` magic number of the decoded bytes, every file |

**The total cap is the load-bearing one, and it is a mail limit, not a storage
limit.** Every supporting document is attached to all three notification emails
alongside the generated application PDF. Gmail rejects a message over roughly
25 MB, so without a total cap an application carrying five 10 MB documents would
produce three messages that simply never send: the applicant would have a
reference number and nobody would be told. Ten megabytes of documents plus the
application PDF leaves ample headroom. If you raise `MAX_UPLOAD_TOTAL_BYTES`,
you are spending that headroom, and three emails are what pay for it.

The client refuses to start an upload that would breach the total, so the
applicant is told at the moment they attach the file. That is a courtesy, not a
control: the form is not a security boundary, and `getUploadedFiles_` checks the
count and the total again, independently, on what Drive reports.

`submitApplication` always responds HTTP 200. Success or failure is in the JSON
body's `success` field. An Apps Script web app cannot set an HTTP status code,
so do not branch on `response.ok`.

> ### VERIFY THIS ON YOUR FIRST REAL DEPLOYMENT
>
> This cross-origin path is the one part of the design that could not be tested
> before deployment, and you must confirm it yourself.
>
> When an Apps Script web app responds to a POST it issues a redirect to
> `script.googleusercontent.com`, and the browser follows that redirect to fetch
> the actual body. The CORS headers on that second, redirected response are set
> by Google, not by this code, and their behaviour has changed between Apps
> Script runtime versions. It usually works. It cannot be proven from here.
>
> **How to verify, in about two minutes:**
> 1. Publish the form to GitHub Pages (or run it from any origin that is not
>    `script.google.com`).
> 2. Open the browser developer tools, Network tab, and submit a test
>    application.
> 3. Look for exactly this:
>    - one `POST` to `/exec` returning `302`,
>    - one `GET` to `script.googleusercontent.com` returning `200`,
>    - **no** `OPTIONS` request at all,
>    - the JSON body visible in the Response tab.
> 4. Check the Console for any message containing
>    `blocked by CORS policy` or `No 'Access-Control-Allow-Origin' header`.
>
> If you see an `OPTIONS` request, your client is not sending
> `Content-Type: text/plain`. Fix the client first - that is by far the most
> likely cause.
>
> If there is no `OPTIONS` request and it is still blocked, the redirected
> response is not returning permissive CORS headers, and you should fall back
> to 6b below.

### 6b. Fallback transport - `doGet` and `google.script.run`

If `doPost` misbehaves cross-origin, fall back to the transport that is already
proven in production. Nothing in `Code.gs` needs to change.

1. In the Apps Script editor, add a file named `Form.html` and paste the
   application form into it. `doGet` picks it up automatically; until it exists,
   `doGet` returns a short plain-text notice.
2. Serve the form from the `/exec` URL itself instead of from GitHub Pages.
   Because the page is now served by Apps Script, it is same-origin with the
   endpoint and CORS does not apply at all.
3. Call the endpoint with `google.script.run` instead of `fetch`:

```js
google.script.run
  .withSuccessHandler(function (result) { /* result.fileId */ })
  .withFailureHandler(function (error) { /* ... */ })
  .saveUploadedFile(fileData, projectTitle);

google.script.run
  .withSuccessHandler(function (result) { /* result.ansirCode */ })
  .withFailureHandler(function (error) { /* ... */ })
  .submitApplication(formData);
```

The cost of the fallback is that the form HTML then lives in the Apps Script
project rather than in git, which is exactly what the pure-git move is trying
to get away from. Mitigate it by keeping `Form.html` in this repository as the
source of truth and pasting it into Apps Script on each change. Annoying, but
it keeps the source in git and version-controlled.

### 6c. Replacing the autofill (`getContributorProfiles` is gone)

The old form called `getContributorProfiles()` to populate contributor
autofill. That function is **deleted and must not be recreated.** It returned
researcher names paired with email addresses to any anonymous caller.

Build the autofill client-side from the already-public data file instead:

```js
var DATA_URL = 'https://auscope.github.io/ansir/data/data.json';

var contributorProfiles = new Map();

function loadContributorProfiles(callback) {
  fetch(DATA_URL)
    .then(function (r) { return r.json(); })
    .then(function (payload) {
      (payload.data || []).forEach(function (project) {
        (project.contributors || []).forEach(function (c) {
          if (c.name && !contributorProfiles.has(c.name)) {
            contributorProfiles.set(c.name, c);
          }
        });
      });
      if (callback) { callback(); }
    })
    .catch(function () {
      // Autofill is a convenience. If the data file cannot be fetched, the
      // form must still work - just without autofill.
      if (callback) { callback(); }
    });
}
```

Each contributor object carries `name`, `title`, `orcid`, `position`,
`organisation`, `organisationRor`, `organisationRole`, `isContact`,
`isLeader` - and **no email field**. Verified against the live file on
3 August 2026: 191 contributor entries across 51 projects, zero occurrences of
the string `email`, zero occurrences of `@`.

Therefore the `autoFillContributor` branch that fills the email field will
simply not fire, because `profile.email` is undefined. Applicants type their
own email address, which is correct: an application form should not be
volunteering other researchers' contact details to whoever opened it.

---

## 7. Test end to end

Work through this in order. Do it on the real deployment, once.

1. **Configuration guard.** Before setting `UPLOAD_FOLDER_ID`, submit a test
   application with a PDF. The upload should fail with a clear configuration
   message. Then set the folder ID, redeploy a new version, and continue.
2. **Application with no attachment.** Submit with the required fields only.
   Confirm:
   - the response carries an `ansirCode` in the `ANSIR-<year>-NNN` format,
   - a new row appears in the `ANSIR_Applications` tab (created automatically
     if this is the first run),
   - **no** new row appears in `ANSIR_Projects_MasterList`,
   - the applicant address receives a copy of the application,
   - `ben@auscope.org.au` receives the internal notification,
   - the execution log records that no facility addresses are configured for the selected methods (`FACILITY_ROUTES` empty by design).
3. **Application with attachments.** Attach three small PDFs with different
   names. Confirm:
   - the form lists all three with their sizes and a running total against the
     10 MB cap, removing one updates both, and choosing more files adds to the
     list rather than replacing it,
   - the review step lists every attached document with its size,
   - during the upload step, and before you submit, all three appear in the
     **staging** folder under neutral staged names (`staged_<timestamp>.pdf`);
     they are renamed to `<reference> file_upload_<n>.pdf`, in attachment
     order, as they are filed into the application folder at submission,
   - the browser made one `saveUploadedFile` POST per document, in sequence,
     and one `submitApplication` POST carrying `uploaded_file_ids` and no
     base64 data,
   - after submitting, a folder named after the reference, for example
     `ANSIR-2026-008`, exists inside the application filing folder, and holds
     all three supporting documents and `ANSIR-2026-008 Application.pdf`,
   - the staging folder is now empty again,
   - all four PDFs are attached to the applicant copy and to the internal
     notification,
   - the application PDF opens and reads as the whole application: the
     reference, the submission time, every attached document with its size, and
     every section in the order the form asks them,
   - `supporting_document_file_id`, `supporting_document_url` and
     `supporting_document_name` each hold three semicolon-delimited values in
     the same order, `application_folder_url` is populated, and the folder URL
     opens the folder.
   - the intake tab still has **94** columns. This change added no column.
4. **Filing switched off.** Set `APPLICATION_FOLDER_ID` back to the placeholder,
   deploy a new version, and submit once more. Confirm the application is still
   recorded and still emailed with its PDF attached, that
   `application_folder_url` is empty, that the supporting document is still in
   the staging folder, and that the execution log carries one line saying folder
   filing is not configured. Then set the folder ID back and redeploy.
5. **Sequencing.** Submit twice in a row. Confirm the two reference numbers are
   consecutive and neither collides with anything in the master list.
6. **Server-side validation.** Post directly at the endpoint with `curl`,
   bypassing the form entirely, and confirm it is rejected:

   ```
   curl -L -X POST 'https://script.google.com/macros/s/AKfycb.../exec' \
     -H 'Content-Type: text/plain;charset=utf-8' \
     -d '{"action":"submitApplication","payload":{"title_primary":"x"}}'
   ```

   Expect `{"success":false,"message":"The following required fields are missing: ..."}`.
7. **Non-PDF upload.** Base64 a `.txt` file but claim `application/pdf` in the
   MIME type. The magic-number check should reject it.
7a. **Upload limits.** Try to attach a sixth document, and confirm the form
   refuses it naming the five-document limit. Attach documents adding up to
   more than 10 MB, and confirm the form refuses the one that would breach the
   total and says why. Then bypass the form with `curl` and post
   `uploaded_file_ids` with six IDs, and with IDs whose files come to more than
   10 MB, and confirm the endpoint refuses both before a reference is
   allocated: no new row, no gap in the sequence.
8. **Rate limit.** Optionally, drop `MAX_SUBMISSIONS_PER_HOUR` to `2`, submit
   three times, confirm the third is refused politely, then set it back and
   redeploy.

Run the sequencing regression test locally at any time:

```
node gas/test-ansir-code.js
```

---

## 8. Operational notes

**The rate limit is global, not per-caller.** Apps Script does not expose the
caller's IP address to `google.script.run` or to `doPost`, so there is no way
to rate limit per person. `MAX_SUBMISSIONS_PER_HOUR` is a brake on automated
flooding shared by everybody using the endpoint. It is documented as such
rather than dressed up as something stronger. If you set it too low you will
block real applicants during a grant deadline; `20` is deliberately generous.

**The counter can be evicted.** It lives in `CacheService`, which Google may
evict under memory pressure. Eviction fails open - the counter restarts rather
than locking everyone out. That is the right trade-off: a legitimate researcher
must never be blocked from applying because a cache entry disappeared.

**Emailed attachments are restricted to the staging folder.** `submitApplication`
receives Drive file IDs from the client and attaches those files to emails going
to a client-supplied address. Without a check, anyone could pass the ID of any
file the script owner can read and have it mailed to themselves.
`getUploadedFiles_` therefore verifies that **every** file's parents include
`UPLOAD_FOLDER_ID` and refuses the whole submission if any one of them fails.
One unchecked ID in a list of five is exactly as dangerous as one unchecked ID
on its own, so there is no partial acceptance. **Do not remove that check, do
not let it become a check on only the first file, and do not point
`UPLOAD_FOLDER_ID` at a folder containing anything other than uploads.**

**That check runs before the files are moved, and the order is not negotiable.**
Filing moves the supporting documents out of the staging folder, so the
containment check is only true beforehand. `handleSubmit_` therefore verifies
every file first and files them afterwards. If the check is ever moved after the
move it will simply always fail, and widening the accepted parents to make it
pass again would give the whole control away. A useful side effect of the
current order: once a document has been filed against a reference, its ID is no
longer accepted, because it is no longer in the staging folder. One upload
belongs to one application.

**Filing never costs an application.** Creating the folder, moving each
document, building the PDF and writing it into the folder are each wrapped
separately, and the moves are wrapped one document at a time so a single
stubborn file cannot strand the rest. Any of them can fail, and the row is
already on the sheet by then, so the failure costs at most an empty
`application_folder_url`, a document left in the staging folder, or one fewer
email attachment. Failures are logged with the
`[ANSIR INTAKE]` prefix, and the applicant still gets their reference number.

**The application PDF is generated from the same text as the emails.**
`applicationTranscript_` is the single source of the application content;
`applicationPdfHtml_` only wraps it for print. A section added to the transcript
appears in the applicant's copy, the internal notification and the filed PDF at
once, so the three cannot disagree about what was submitted.

**Sheet values are protected against formula injection.** A submitted value
starting with `=`, `+`, `-` or `@` is prefixed with an apostrophe before being
written, so it cannot execute as a formula when a reviewer opens the tab.

**Emails never block a submission.** The row is written first, inside the lock.
Each of the three sends is wrapped individually, so a bounce or a quota
exhaustion loses a notification, never an application. If someone reports
applying and you have no email, check the `ANSIR_Applications` tab before
assuming it was lost.

**Watch the email quota.** `MailApp.getRemainingDailyQuota()` in the editor will
tell you where you stand.

**Reviewing what actually ran.** Apps Script editor, left sidebar, Executions.
Every log line from this file is prefixed `[ANSIR INTAKE]`.

---

## 9. What happens next

Submissions land in `ANSIR_Applications` and stop there. They are **not**
projects, they are **not** in the master list, and they are **not** published.
Turning an approved application into a project is a deliberate manual step,
documented in [`docs/INTAKE.md`](../docs/INTAKE.md).
