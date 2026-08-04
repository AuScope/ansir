# ANSIR application intake endpoint - deployment guide

This directory contains the **only** server-side code left in the ANSIR web
stack. Everything else - the project data, the public pages, the publishing
pipeline - is plain files in git.

This exists because three things in the equipment loan application genuinely
need a server, and cannot be done from a static page:

1. accepting a form submission from an anonymous member of the public,
2. storing an uploaded PDF somewhere durable,
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
| 3 | `saveUploadedFile` | **YES** | Accepts one PDF, returns a Drive file ID |
| 4 | `submitApplication` | **YES** | Validates, records, allocates a reference, emails |
| 5 | `handleUpload_` | no | Shared upload implementation |
| 6 | `handleSubmit_` | no | Shared submit implementation |
| 7 | `allocateAnsirCode_` | no | Lock, scan, allocate reference, append row |
| 8 | `readCodeColumn_` | no | Reads the ANSIR code column from a sheet |
| 9 | `nextAnsirCode_` | no | Pure sequencing logic (unit tested) |
| 10 | `getApplicationsSheet_` | no | Returns or creates the intake tab |
| 11 | `applicationsHeaders_` | no | The intake tab column order |
| 12 | `buildApplicationRecord_` | no | Form data to sheet row |
| 13 | `buildInternalNotes_` | no | Submission timestamp and attachment note |
| 14 | `buildContributorColumns_` | no | Flattens contributors to sheet columns |
| 15 | `isUploadFolderConfigured_` | no | Guards against the placeholder folder ID |
| 16 | `getUploadedFile_` | no | Retrieves the PDF, verifies it is in the folder |
| 17 | `buildUploadFileName_` | no | Builds a readable stored file name |
| 18 | `looksLikePdf_` | no | Checks the `%PDF-` magic number |
| 19 | `validateFileData_` | no | Server-side PDF constraint checks |
| 20 | `validateSubmission_` | no | Server-side required-field checks |
| 21 | `isEmailAddress_` | no | Email format check |
| 22 | `rateLimitOk_` | no | Submissions-per-hour cap |
| 23 | `sendNotifications_` | no | Sends the three emails |
| 24 | `buildApplicantEmail_` | no | The applicant's copy |
| 25 | `buildInternalEmail_` | no | The admin and facility notification |
| 26 | `applicationTranscript_` | no | Shared email body |
| 27 | `contributorLines_` | no | Team member lines for the emails |
| 28 | `equipmentCatalogue_` | no | Equipment key to display name map |
| 29 | `equipmentNames_` | no | Requested equipment, names only |
| 30 | `equipmentLines_` | no | Requested equipment, name and quantity |
| 31 | `formatPolygon_` | no | GeoJSON to plain lat, lon pairs |
| 32 | `safeText_` | no | Coerce, trim, cap length |
| 33 | `sheetSafe_` | no | Neutralises spreadsheet formula injection |
| 34 | `joinNonEmpty_` | no | Join non-blank parts |
| 35 | `orNotProvided_` | no | Display fallback |
| 36 | `formatDateTime_` | no | Human-readable timestamp |
| 37 | `jsonResponse_` | no | Builds the JSON `TextOutput` |
| 38 | `logLine_` | no | Operator log line |
| 39 | `logError_` | no | Operator error log |

**39 functions total. 4 web-callable. 35 private.**

Verify this yourself at any time, without trusting the table:

```
grep -oE '^function [A-Za-z0-9_]*[^_(]\(' gas/Code.gs | sed 's/^function //;s/(//'
```

If that command prints anything other than `doGet`, `doPost`,
`saveUploadedFile` and `submitApplication`, something has been added that the
whole internet can now call. Treat it as an incident.

---

## 2. Prerequisites

- A Google account that has edit access to the ANSIR project sheet
  (`REDACTED_SEE_SCRIPT_PROPERTY`).
- Somewhere in that same account's Drive to store uploaded PDFs.

Use an account whose daily email quota you are happy to spend. A consumer
`@gmail.com` account gets roughly 100 `MailApp` recipients per day; a Google
Workspace account gets roughly 1500. Each submission sends up to three emails,
so an ordinary Workspace account is comfortable and a consumer account is fine
for the volumes ANSIR sees.

---

## 3. Create the Drive folder

1. In the Drive of the account that will own the script, create a folder, for
   example `ANSIR Application Uploads`.
2. Open it and copy the ID from the URL:
   `https://drive.google.com/drive/folders/`**`<THIS_IS_THE_ID>`**
3. Do **not** share this folder publicly. Uploaded documents are private
   research material. The endpoint attaches them to emails; it does not
   publish them.

---

## 4. Create the Apps Script project

1. Go to <https://script.google.com> and create a new project.
2. Name it something obvious, for example `ANSIR Application Intake`.
3. Delete the stub `Code.gs` contents and paste in the entire contents of
   `gas/Code.gs` from this repository.
4. Edit the configuration block at the top:

   | Constant | Set it to |
   |---|---|
   | `SHEET_ID` | Already correct - the ANSIR project sheet |
   | `MASTER_SHEET_NAME` | Already correct - `ANSIR_Projects_MasterList` |
   | `APPLICATIONS_SHEET_NAME` | Already correct - `ANSIR_Applications` |
   | `UPLOAD_FOLDER_ID` | **Required.** The folder ID from step 3 |
   | `ADMIN_EMAILS` | Already `ben@auscope.org.au`; add others as needed |
   | `FACILITY_ROUTES` | Facility addresses per research method (Seismic/Nodal Seismic/DAS, Magnetotelluric, Petrophysical). Every route deliberately empty; fill in per method when the addresses are agreed |
   | `MAX_SUBMISSIONS_PER_HOUR` | `20` is a sensible starting point |

   If you leave `UPLOAD_FOLDER_ID` as the placeholder, uploads will fail with a
   clear configuration error rather than silently succeeding. That is
   intentional: the previous version discarded every PDF it was given and told
   the applicant it had worked.

5. Save.

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
// 1. Upload the supporting PDF first. Returns a Drive file ID.
callEndpoint('saveUploadedFile', {
  fileData: {
    fileName: 'proposal.pdf',
    mimeType: 'application/pdf',
    size: 1234567,
    data: '<base64 without the data: URI prefix>'
  },
  projectTitle: 'My project title'
});
// -> { success: true, fileId: '1AbC...', fileName: 'ANSIR_Application_..._20260803_142530.pdf', url: '...' }

// 2. Submit the application, passing that file ID through.
callEndpoint('submitApplication', formDataObjectWith_uploaded_file_id);
// -> { success: true, ansirCode: 'ANSIR-2026-007', emailsSent: ['applicant','admin'], message: '...' }
```

The file ID goes into the form data as `uploaded_file_id`. There is no
cross-execution state anywhere: the upload call returns an ID, the submit call
fetches the file back out of Drive by that ID.

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
var DATA_URL = 'https://bvkay.github.io/ansir-data/data/data.json';

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
3. **Application with an attachment.** Attach a small PDF. Confirm:
   - the file appears in the Drive upload folder with a name like
     `ANSIR_Application_<title>_<timestamp>.pdf`,
   - the PDF is attached to both the applicant copy and the internal
     notification,
   - `supporting_document_file_id`, `supporting_document_url` and
     `supporting_document_name` are populated in the sheet row.
4. **Sequencing.** Submit twice in a row. Confirm the two reference numbers are
   consecutive and neither collides with anything in the master list.
5. **Server-side validation.** Post directly at the endpoint with `curl`,
   bypassing the form entirely, and confirm it is rejected:

   ```
   curl -L -X POST 'https://script.google.com/macros/s/AKfycb.../exec' \
     -H 'Content-Type: text/plain;charset=utf-8' \
     -d '{"action":"submitApplication","payload":{"title_primary":"x"}}'
   ```

   Expect `{"success":false,"message":"The following required fields are missing: ..."}`.
6. **Non-PDF upload.** Base64 a `.txt` file but claim `application/pdf` in the
   MIME type. The magic-number check should reject it.
7. **Rate limit.** Optionally, drop `MAX_SUBMISSIONS_PER_HOUR` to `2`, submit
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

**Emailed attachments are restricted to the upload folder.** `submitApplication`
receives a Drive file ID from the client and attaches that file to emails going
to a client-supplied address. Without a check, anyone could pass the ID of any
file the script owner can read and have it mailed to themselves.
`getUploadedFile_` therefore verifies the file's parents include
`UPLOAD_FOLDER_ID` and refuses anything else. **Do not remove that check, and do
not point `UPLOAD_FOLDER_ID` at a folder containing anything other than
uploads.**

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
