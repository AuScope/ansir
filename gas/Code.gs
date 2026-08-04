/**
 * ANSIR - Equipment Loan Application Intake Endpoint
 * Australian National Seismic Imaging Resource (AuScope / NCRIS)
 *
 * ============================================================================
 * THE CORE SECURITY PROPERTY OF THIS FILE
 * ============================================================================
 * In Google Apps Script, ANY top-level function without a trailing underscore
 * in its name is callable from the client by google.script.run, and on an
 * "Anyone" deployment that means callable by anybody on the internet. A
 * function whose name ENDS IN AN UNDERSCORE is private: Apps Script refuses to
 * expose it to google.script.run at all.
 *
 * Therefore, in this file, EXACTLY FOUR functions have no trailing underscore:
 *
 *   doGet               - serves the form HTML (optional fallback transport)
 *   doPost              - JSON transport for a form served from GitHub Pages
 *   saveUploadedFile    - accepts one PDF, returns a Drive file ID
 *   submitApplication   - accepts the application, writes it, emails it
 *
 * EVERY other function in this file ends in an underscore and is unreachable
 * from the web. If you add a function, it MUST end in an underscore unless you
 * have deliberately decided to expose it to the entire internet. The previous
 * generation of this codebase exposed 37 functions this way, including one that
 * returned a full roster of researcher names with their email addresses. That
 * is the mistake this file exists to not repeat.
 *
 * There is deliberately NO getContributorProfiles here. Form autofill is now
 * built client-side from the already-public data.json, which carries no email
 * addresses. See gas/README.md and docs/INTAKE.md.
 *
 * ============================================================================
 * STYLE RULES FOR THIS FILE (project house rules - please keep to them)
 * ============================================================================
 * - Vanilla JavaScript only.
 * - NO template literals anywhere. Not even un-nested ones. A backtick inside
 *   a backtick makes the Caja sanitiser throw a SyntaxError that silently kills
 *   all JavaScript on the page, and this project has been bitten by it before.
 *   This file uses string concatenation and array joins exclusively, so the
 *   rule is trivially checkable: there should be zero backticks in this file.
 * - Regular hyphens, never em-dashes, in anything a person will read.
 * - No emojis. The audience is NCRIS, researchers and AuScope staff.
 */


// ============================================================================
// CONFIGURATION
// ============================================================================

/** Google Sheet holding both the master project list and the intake tab. */
var SHEET_ID = 'REDACTED_SEE_SCRIPT_PROPERTY';

/**
 * The master project list. THIS FILE ONLY EVER READS FROM IT.
 * It is the sheet that feeds the public git publishing pipeline, so nothing
 * unreviewed is ever allowed to land in it.
 */
var MASTER_SHEET_NAME = 'ANSIR_Projects_MasterList';

/**
 * The intake tab. Public submissions are written here and nowhere else.
 * Created automatically with headers on first run if it does not exist.
 */
var APPLICATIONS_SHEET_NAME = 'ANSIR_Applications';

/**
 * REQUIRED CONFIGURATION - YOU MUST SET THIS BEFORE THE ENDPOINT WILL WORK.
 *
 * The ID of the Google Drive folder that uploaded supporting PDFs are written
 * into. Create a folder in the Drive of the account that owns this script,
 * open it, and copy the ID out of the URL:
 *   https://drive.google.com/drive/folders/<THIS_IS_THE_ID>
 *
 * Leave it as the placeholder and saveUploadedFile will fail loudly with a
 * configuration error, which is the intended behaviour. It must never fail
 * quietly: the previous version silently discarded every PDF it was given.
 */
var UPLOAD_FOLDER_ID = 'REPLACE_WITH_UPLOAD_FOLDER_ID';

/** Who gets the internal notification. */
var ADMIN_EMAILS = [
  'ben@auscope.org.au'
];

/**
 * The ANSIR facility distribution list.
 *
 * DELIBERATELY EMPTY. It is wired up end to end - the notification is built
 * and addressed exactly like the admin one - so filling this array in is the
 * only change needed to switch facility notifications on. While it is empty,
 * that email is skipped and a line is written to the execution log saying so.
 *
 * Example once you know the addresses:
 *   var FACILITY_EMAILS = ['ansir@anu.edu.au'];
 */
var FACILITY_EMAILS = [];

/**
 * Abuse control. See rateLimitOk_ for the important caveat: Apps Script does
 * not expose a client IP address, so this cap is necessarily GLOBAL across all
 * callers, not per-caller.
 */
var MAX_SUBMISSIONS_PER_HOUR = 20;

/** Upload constraints, re-checked server-side. Never trust the client. */
var MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
var ALLOWED_UPLOAD_MIME = 'application/pdf';

/** Defensive caps on free text so a single request cannot be enormous. */
var MAX_TEXT_FIELD_CHARS = 20000;
var MAX_ADDITIONAL_CONTRIBUTORS = 50;

/**
 * The header name used for the ANSIR code. It is deliberately IDENTICAL in the
 * master list and in the intake tab, so the sequence scan can read both with
 * the same code and so promoting a row to a project is a header-name match.
 */
var ANSIR_CODE_HEADER = 'alternative_identifier_ansir_code';

/** How long to wait for the code-allocation lock before giving up. */
var LOCK_TIMEOUT_MS = 30000;

/** Timezone used for human-readable timestamps and generated file names. */
var TIMEZONE = 'Australia/Sydney';

/** Display name on outgoing mail. */
var MAIL_FROM_NAME = 'ANSIR Equipment Loans';

/** Contact address quoted to applicants in the confirmation email. */
var CONTACT_EMAIL = 'ben@auscope.org.au';


// ============================================================================
// WEB-CALLABLE SURFACE - THESE FOUR FUNCTIONS AND NO OTHERS
// ============================================================================

/**
 * doGet - fallback transport.
 *
 * Serves the application form as Apps Script HTML if a file named Form.html
 * has been added to this project, which keeps the proven google.script.run
 * path available. If there is no Form.html, it returns a short plain notice
 * rather than an error, so a stray GET does not look like a broken service.
 *
 * @param {Object} e Apps Script event object (unused).
 * @return {HtmlOutput|TextOutput}
 */
function doGet(e) {
  try {
    return HtmlService.createHtmlOutputFromFile('Form')
      .setTitle('ANSIR Equipment Loan Application');
  } catch (err) {
    return ContentService
      .createTextOutput('ANSIR application intake endpoint. Submit applications through the ANSIR website.')
      .setMimeType(ContentService.MimeType.TEXT);
  }
}

/**
 * doPost - preferred transport, for a form served from GitHub Pages.
 *
 * The client MUST post with Content-Type: text/plain and a JSON string as the
 * body. text/plain is one of the three CORS "simple" content types, so the
 * browser sends the request without a preflight OPTIONS call. That matters
 * because Apps Script web apps cannot answer a preflight: there is no way to
 * return the Access-Control-Allow-* headers an OPTIONS request needs. Posting
 * as application/json WILL trigger a preflight and WILL fail.
 *
 * Expected body, as a JSON string:
 *   { "action": "saveUploadedFile",  "payload": { fileData, projectTitle } }
 *   { "action": "submitApplication", "payload": { ...form fields... } }
 *
 * Always responds 200 with a JSON body of { success: boolean, ... }. Errors are
 * reported in the body, not as HTTP status codes, because an Apps Script web
 * app cannot set a status code.
 *
 * @param {Object} e Apps Script event object.
 * @return {TextOutput} JSON.
 */
function doPost(e) {
  var request;
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse_({ success: false, message: 'Empty request body.' });
    }
    request = JSON.parse(e.postData.contents);
  } catch (parseError) {
    return jsonResponse_({ success: false, message: 'Request body was not valid JSON.' });
  }

  var action = request && request.action ? String(request.action) : '';
  var payload = request && request.payload ? request.payload : {};

  try {
    if (action === 'submitApplication') {
      return jsonResponse_(handleSubmit_(payload));
    }
    if (action === 'saveUploadedFile') {
      return jsonResponse_(handleUpload_(payload.fileData, payload.projectTitle));
    }
    return jsonResponse_({ success: false, message: 'Unknown action.' });
  } catch (err) {
    logError_('doPost', err);
    return jsonResponse_({ success: false, message: 'The request could not be processed.' });
  }
}

/**
 * saveUploadedFile - web-callable. Accepts ONE supporting PDF, writes it to the
 * configured Drive folder, and RETURNS ITS DRIVE FILE ID.
 *
 * The returned fileId is what the client passes back to submitApplication as
 * uploaded_file_id. There is no cross-execution state of any kind. The previous
 * implementation stashed the blob in a module-global and read it back in a
 * later, separate execution; Apps Script globals do not survive between
 * executions, and the Drive write had been commented out, so every uploaded PDF
 * was validated, acknowledged and then silently lost.
 *
 * @param {Object} fileData { fileName, mimeType, data (base64), size }.
 * @param {string} projectTitle Used only to build a readable file name.
 * @return {Object} { success, fileId, fileName, url } or { success:false, message }.
 */
function saveUploadedFile(fileData, projectTitle) {
  try {
    return handleUpload_(fileData, projectTitle);
  } catch (err) {
    logError_('saveUploadedFile', err);
    return { success: false, message: 'The file could not be saved.' };
  }
}

/**
 * submitApplication - web-callable. Validates, allocates the next ANSIR
 * reference, writes one row to the ANSIR_Applications tab, and sends the three
 * notification emails.
 *
 * @param {Object} formData Application fields from the form.
 * @return {Object} { success, ansirCode, message } or { success:false, message }.
 */
function submitApplication(formData) {
  try {
    return handleSubmit_(formData);
  } catch (err) {
    logError_('submitApplication', err);
    return { success: false, message: 'The application could not be submitted. Please try again, or contact ' + CONTACT_EMAIL + '.' };
  }
}


// ============================================================================
// EVERYTHING BELOW THIS LINE ENDS IN AN UNDERSCORE AND IS NOT WEB-CALLABLE
// ============================================================================

// ---------------------------------------------------------------------------
// Request handlers
// ---------------------------------------------------------------------------

/**
 * Shared implementation behind saveUploadedFile and the doPost upload action.
 * @private
 */
function handleUpload_(fileData, projectTitle) {
  if (!isUploadFolderConfigured_()) {
    logLine_('CONFIGURATION ERROR: UPLOAD_FOLDER_ID has not been set. See gas/README.md.');
    return { success: false, message: 'The upload destination has not been configured. Please contact ' + CONTACT_EMAIL + '.' };
  }

  if (!rateLimitOk_('upload')) {
    return { success: false, message: 'The service is busy. Please try again in a few minutes.' };
  }

  var check = validateFileData_(fileData);
  if (!check.ok) {
    return { success: false, message: check.message };
  }

  var decoded = Utilities.base64Decode(fileData.data);

  // Re-check the ACTUAL decoded length. fileData.size is client-supplied and
  // therefore meaningless on its own.
  if (decoded.length > MAX_UPLOAD_BYTES) {
    return { success: false, message: 'The file exceeds the 10 MB limit.' };
  }

  // Re-check that the bytes really are a PDF. A client can claim any MIME type.
  if (!looksLikePdf_(decoded)) {
    return { success: false, message: 'Only PDF files are accepted.' };
  }

  var name = buildUploadFileName_(projectTitle);
  var blob = Utilities.newBlob(decoded, ALLOWED_UPLOAD_MIME, name);

  var folder = DriveApp.getFolderById(UPLOAD_FOLDER_ID);
  var file = folder.createFile(blob);

  logLine_('Supporting document stored: ' + file.getId() + ' (' + name + ')');

  return {
    success: true,
    fileId: file.getId(),
    fileName: name,
    originalFileName: safeText_(fileData.fileName),
    url: file.getUrl()
  };
}

/**
 * Shared implementation behind submitApplication and the doPost submit action.
 * @private
 */
function handleSubmit_(formData) {
  if (!formData || typeof formData !== 'object') {
    return { success: false, message: 'No application data was received.' };
  }

  if (!rateLimitOk_('submit')) {
    return { success: false, message: 'The service is busy. Please try again in a few minutes, or contact ' + CONTACT_EMAIL + '.' };
  }

  // Server-side re-validation. The form validates too, but the form is not a
  // security boundary: anyone can post whatever they like to this endpoint.
  var check = validateSubmission_(formData);
  if (!check.ok) {
    return { success: false, message: check.message };
  }

  var spreadsheet = SpreadsheetApp.openById(SHEET_ID);
  var applicationsSheet = getApplicationsSheet_(spreadsheet);

  // Retrieve the supporting document, if one was uploaded, BEFORE allocating a
  // code, so that a bad file ID fails before it consumes a reference number.
  var fileInfo = null;
  var fileId = safeText_(formData.uploaded_file_id);
  if (fileId) {
    fileInfo = getUploadedFile_(fileId);
    if (!fileInfo) {
      return { success: false, message: 'The uploaded supporting document could not be found. Please upload it again.' };
    }
  }

  var ansirCode = allocateAnsirCode_(spreadsheet, applicationsSheet, formData, fileInfo);
  if (!ansirCode) {
    return { success: false, message: 'The service is busy allocating a reference number. Please try again in a moment.' };
  }

  // The row is already written by allocateAnsirCode_, inside the lock, so that
  // the code cannot be allocated without also being recorded.

  var emailResult = sendNotifications_(formData, ansirCode, fileInfo);

  return {
    success: true,
    ansirCode: ansirCode,
    emailsSent: emailResult.sent,
    message: 'Application received. Your ANSIR reference is ' + ansirCode + '.'
  };
}


// ---------------------------------------------------------------------------
// ANSIR reference number allocation
// ---------------------------------------------------------------------------

/**
 * Allocates the next ANSIR code and writes the application row, both inside a
 * single script lock.
 *
 * Read-increment-write MUST be atomic. Without the lock, two applications
 * submitted seconds apart both read the same maximum sequence and both get
 * issued the same code, which is exactly the race the previous implementation
 * had. The lock is held across the row append as well, so a code is never
 * handed out without a row recording that it was.
 *
 * The scan covers BOTH the master list (so numbering stays globally correct
 * against real projects) AND the intake tab (so two pending applications can
 * never collide).
 *
 * @private
 * @return {string|null} The allocated code, or null if the lock was not obtained.
 */
function allocateAnsirCode_(spreadsheet, applicationsSheet, formData, fileInfo) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(LOCK_TIMEOUT_MS);
  } catch (lockError) {
    logLine_('Could not obtain the script lock within ' + LOCK_TIMEOUT_MS + ' ms.');
    return null;
  }

  try {
    var codes = readCodeColumn_(spreadsheet.getSheetByName(MASTER_SHEET_NAME))
      .concat(readCodeColumn_(applicationsSheet));

    var ansirCode = nextAnsirCode_(codes, new Date().getFullYear());

    var record = buildApplicationRecord_(formData, ansirCode, fileInfo);
    var headers = applicationsHeaders_();
    var row = [];
    for (var i = 0; i < headers.length; i++) {
      row.push(sheetSafe_(record[headers[i]]));
    }
    applicationsSheet.appendRow(row);
    SpreadsheetApp.flush();

    logLine_('Allocated ' + ansirCode + ' and wrote row ' + applicationsSheet.getLastRow() + '.');
    return ansirCode;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Reads every value from the ANSIR code column of a sheet.
 * Returns an empty array if the sheet or the column is missing, so a rename
 * degrades to "start at 001" rather than throwing.
 * @private
 */
function readCodeColumn_(sheet) {
  if (!sheet) {
    return [];
  }
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) {
    return [];
  }
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var index = headers.indexOf(ANSIR_CODE_HEADER);
  if (index < 0) {
    logLine_('Column ' + ANSIR_CODE_HEADER + ' not found in ' + sheet.getName() + '.');
    return [];
  }
  var values = sheet.getRange(2, index + 1, lastRow - 1, 1).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    out.push(String(values[i][0] === null || values[i][0] === undefined ? '' : values[i][0]));
  }
  return out;
}

// ---- BEGIN PURE LOGIC: nextAnsirCode_ (extracted verbatim by the test harness) ----
/**
 * Works out the next ANSIR code for a given year.
 *
 * Format is ANSIR-YYYY-NNN, sequence zero-padded to three digits.
 *
 * Matching is a strict prefix match on "ANSIR-<year>-" followed by digits only.
 * The real data contains legacy identifiers that are NOT in this scheme -
 * 2005-S01, ANU-2021, SX-2023, Placeholder-01, S01-2019, MT03-2020 and others -
 * and every one of them must continue to be ignored rather than parsed. It also
 * contains ANSIR-2023-06, a two-digit sequence from an earlier convention:
 * that one IS counted when the year matches, and the successor is padded to
 * three digits.
 *
 * @param {Array} codes Every existing code, from the master list and the intake tab.
 * @param {number} year The four-digit year to allocate within.
 * @return {string} The next code, for example ANSIR-2026-007.
 */
function nextAnsirCode_(codes, year) {
  var prefix = 'ANSIR-' + year + '-';
  var max = 0;
  var list = codes || [];

  for (var i = 0; i < list.length; i++) {
    var code = String(list[i] === null || list[i] === undefined ? '' : list[i]).trim();
    if (code.indexOf(prefix) !== 0) {
      continue;
    }
    var tail = code.substring(prefix.length);
    // Digits and nothing else. This rejects suffixed variants such as
    // ANSIR-2026-003a or ANSIR-2026-003-REV, which must not be mistaken for
    // a plain sequence number.
    if (!/^[0-9]+$/.test(tail)) {
      continue;
    }
    var value = parseInt(tail, 10);
    if (value > max) {
      max = value;
    }
  }

  var next = String(max + 1);
  while (next.length < 3) {
    next = '0' + next;
  }
  return prefix + next;
}
// ---- END PURE LOGIC ----


// ---------------------------------------------------------------------------
// The intake sheet
// ---------------------------------------------------------------------------

/**
 * Returns the ANSIR_Applications tab, creating it with headers if it is absent.
 * @private
 */
function getApplicationsSheet_(spreadsheet) {
  var sheet = spreadsheet.getSheetByName(APPLICATIONS_SHEET_NAME);
  var headers = applicationsHeaders_();

  if (!sheet) {
    sheet = spreadsheet.insertSheet(APPLICATIONS_SHEET_NAME);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    logLine_('Created tab ' + APPLICATIONS_SHEET_NAME + ' with ' + headers.length + ' headers.');
    return sheet;
  }

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  }

  return sheet;
}

/**
 * The intake tab column order.
 *
 * Names deliberately match the master list wherever the same field exists, so
 * promoting an approved application to a project is a header-name match rather
 * than a manual re-typing exercise. The first five columns are intake-only
 * review workflow columns and have no counterpart in the master list.
 * @private
 */
function applicationsHeaders_() {
  return [
    'submission_timestamp',
    ANSIR_CODE_HEADER,
    'review_status',
    'reviewed_by',
    'review_notes',

    'title_primary',
    'title_acronym',
    'description_primary',
    'description_objectives',
    'project_keywords',

    'contributor_honoury_title',
    'contributor_name',
    'contributor_email',
    'contributor_id',
    'contributor_position_id',
    'contributor_leader',
    'contributor_is_contact',
    'organisation_name',
    'organisation_id',
    'organisation_role_id',

    'date_start_date',
    'date_end_date',
    'timing_constraints',

    'location_region',
    'location_country',
    'location_polygon',

    'methods_field',
    'methods_description',
    'instrumentation_type',
    'instrumentation_numbers',
    'equipment_availability_confirmed',
    'field_team_experience',
    'training_required',

    'fdsn_network_code',
    'estimated_data_volume',
    'data_submission_confirmed',
    'data_access',
    'embargo_duration',
    'embargo_reason',
    'restricted_reason',

    'cultural_heritage_check',
    'indigenous_involvement_flag',
    'description_indigenous_engagement_summary',
    'description_indigenous_data_governance',
    'description_indigenous_acknowledgement',
    'indigenous_data_sensitivity_flag',

    'application_type',
    'application_type_other',
    'funding_status',
    'funding_title',
    'funding_agency_name',
    'funding_identifier',

    'supporting_document_file_id',
    'supporting_document_url',
    'supporting_document_name',
    'internal_notes'
  ];
}

/**
 * Builds the intake row from the submitted form data.
 * Ported from mapApplicationToProject, reduced to intake fields only. Nothing
 * here decides project status or visibility, because nothing here creates a
 * project: promotion is a deliberate human step, documented in docs/INTAKE.md.
 * @private
 */
function buildApplicationRecord_(formData, ansirCode, fileInfo) {
  var people = buildContributorColumns_(formData);

  return {
    'submission_timestamp': new Date().toISOString(),
    'alternative_identifier_ansir_code': ansirCode,
    'review_status': 'New',
    'reviewed_by': '',
    'review_notes': '',

    'title_primary': safeText_(formData.title_primary),
    'title_acronym': safeText_(formData.title_acronym),
    'description_primary': safeText_(formData.description_primary),
    'description_objectives': safeText_(formData.description_objectives),
    'project_keywords': safeText_(formData.project_keywords),

    'contributor_honoury_title': people.titles,
    'contributor_name': people.names,
    'contributor_email': people.emails,
    'contributor_id': people.orcids,
    'contributor_position_id': people.positions,
    'contributor_leader': people.leaders,
    'contributor_is_contact': people.contacts,
    'organisation_name': people.organisations,
    'organisation_id': people.organisationRors,
    'organisation_role_id': people.organisationRoles,

    'date_start_date': safeText_(formData.date_start_date),
    'date_end_date': safeText_(formData.date_end_date),
    'timing_constraints': safeText_(formData.timing_constraints),

    'location_region': safeText_(formData.location_region),
    'location_country': safeText_(formData.location_country) || 'Australia',
    'location_polygon': formatPolygon_(formData.location_polygon),

    'methods_field': safeText_(formData.methods_field),
    'methods_description': safeText_(formData.methods_description),
    'instrumentation_type': equipmentNames_(formData.instrumentation_request).join('; '),
    'instrumentation_numbers': equipmentLines_(formData.instrumentation_request).join('; '),
    'equipment_availability_confirmed': safeText_(formData.equipment_availability_confirmed) || 'No',
    'field_team_experience': safeText_(formData.field_team_experience),
    'training_required': safeText_(formData.training_required),

    'fdsn_network_code': safeText_(formData.fdsn_network_code),
    'estimated_data_volume': safeText_(formData.estimated_data_volume),
    'data_submission_confirmed': safeText_(formData.data_submission_confirmed),
    'data_access': safeText_(formData.data_access),
    'embargo_duration': safeText_(formData.embargo_duration),
    'embargo_reason': safeText_(formData.embargo_reason),
    'restricted_reason': safeText_(formData.restricted_reason),

    'cultural_heritage_check': safeText_(formData.cultural_heritage_check),
    'indigenous_involvement_flag': safeText_(formData.indigenous_involvement_flag),
    'description_indigenous_engagement_summary': safeText_(formData.description_indigenous_engagement_summary),
    'description_indigenous_data_governance': safeText_(formData.description_indigenous_data_governance),
    'description_indigenous_acknowledgement': safeText_(formData.description_indigenous_acknowledgement),
    'indigenous_data_sensitivity_flag': safeText_(formData.indigenous_data_sensitivity_flag),

    'application_type': safeText_(formData.application_type),
    'application_type_other': safeText_(formData.application_type_other),
    'funding_status': safeText_(formData.funding_status),
    'funding_title': safeText_(formData.funding_title),
    'funding_agency_name': safeText_(formData.funding_agency_name),
    'funding_identifier': safeText_(formData.funding_identifier),

    'supporting_document_file_id': fileInfo ? fileInfo.id : '',
    'supporting_document_url': fileInfo ? fileInfo.url : '',
    'supporting_document_name': fileInfo ? fileInfo.name : '',
    'internal_notes': buildInternalNotes_(fileInfo)
  };
}

/**
 * Ported from buildInternalNotes. Submission timestamp and attached PDF only.
 * @private
 */
function buildInternalNotes_(fileInfo) {
  var notes = [];
  notes.push('[Application submitted: ' + formatDateTime_(new Date()) + ']');
  if (fileInfo) {
    notes.push('[Attached: ' + fileInfo.name + ']');
  }
  return notes.join('\n');
}

/**
 * Flattens the lead investigator and any additional contributors into the
 * semicolon-separated column format the master list uses.
 * @private
 */
function buildContributorColumns_(formData) {
  var names = [];
  var titles = [];
  var emails = [];
  var orcids = [];
  var positions = [];
  var organisations = [];
  var organisationRors = [];
  var organisationRoles = [];
  var leaders = [];
  var contacts = [];

  var leadName = joinNonEmpty_([formData.lead_given_name, formData.lead_family_name], ' ');
  var leadOrg = safeText_(formData.lead_organisation);

  if (leadName) {
    names.push(leadName);
    titles.push(safeText_(formData.lead_title));
    emails.push(safeText_(formData.lead_email));
    orcids.push(safeText_(formData.lead_orcid));
    positions.push('Principal or Chief Investigator');
    organisations.push(leadOrg);
    organisationRors.push(safeText_(formData.lead_org_ror));
    organisationRoles.push('Lead Research Organisation');
    leaders.push('TRUE');
    contacts.push('TRUE');
  }

  var extra = formData.additional_contributors;
  if (extra && extra.length) {
    var limit = Math.min(extra.length, MAX_ADDITIONAL_CONTRIBUTORS);
    for (var i = 0; i < limit; i++) {
      var c = extra[i] || {};
      var name = joinNonEmpty_([c.given_name, c.family_name], ' ');
      if (!name) {
        continue;
      }
      var org = safeText_(c.organisation);
      names.push(name);
      titles.push(safeText_(c.title));
      emails.push(safeText_(c.email));
      orcids.push(safeText_(c.orcid));
      positions.push('Co-investigator or Collaborator');
      organisations.push(org);
      organisationRors.push(safeText_(c.org_ror));
      organisationRoles.push(
        org.toLowerCase() === leadOrg.toLowerCase()
          ? 'Lead Research Organisation'
          : 'Other Research Organisation'
      );
      leaders.push('FALSE');
      contacts.push('FALSE');
    }
  }

  return {
    names: names.join('; '),
    titles: titles.join('; '),
    emails: emails.join('; '),
    orcids: orcids.join('; '),
    positions: positions.join('; '),
    organisations: organisations.join('; '),
    organisationRors: organisationRors.join('; '),
    organisationRoles: organisationRoles.join('; '),
    leaders: leaders.join('; '),
    contacts: contacts.join('; ')
  };
}


// ---------------------------------------------------------------------------
// Supporting document handling
// ---------------------------------------------------------------------------

/** @private */
function isUploadFolderConfigured_() {
  return !!UPLOAD_FOLDER_ID && UPLOAD_FOLDER_ID !== 'REPLACE_WITH_UPLOAD_FOLDER_ID';
}

/**
 * Retrieves a previously uploaded supporting document by its Drive file ID and
 * returns its blob plus metadata.
 *
 * SECURITY: the file ID arrives from the client, and the file it names is about
 * to be emailed to an address that also arrived from the client. Without a
 * check, anybody could pass the ID of ANY file this script's owner can read and
 * have it mailed to themselves. So the file's parents are verified to include
 * UPLOAD_FOLDER_ID, and anything outside that folder is refused.
 *
 * @private
 * @return {Object|null} { id, name, url, size, blob } or null.
 */
function getUploadedFile_(fileId) {
  if (!isUploadFolderConfigured_()) {
    return null;
  }

  var file;
  try {
    file = DriveApp.getFileById(fileId);
  } catch (err) {
    logLine_('Supporting document not retrievable: ' + fileId);
    return null;
  }

  var inFolder = false;
  var parents = file.getParents();
  while (parents.hasNext()) {
    if (parents.next().getId() === UPLOAD_FOLDER_ID) {
      inFolder = true;
      break;
    }
  }
  if (!inFolder) {
    logLine_('REFUSED: file ' + fileId + ' is not in the configured upload folder.');
    return null;
  }

  if (file.getMimeType() !== ALLOWED_UPLOAD_MIME) {
    logLine_('REFUSED: file ' + fileId + ' is not a PDF.');
    return null;
  }

  return {
    id: file.getId(),
    name: file.getName(),
    url: file.getUrl(),
    size: file.getSize(),
    blob: file.getBlob()
  };
}

/** @private */
function buildUploadFileName_(projectTitle) {
  var safeTitle = safeText_(projectTitle).replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
  if (!safeTitle) {
    safeTitle = 'Untitled';
  }
  var stamp = Utilities.formatDate(new Date(), TIMEZONE, 'yyyyMMdd_HHmmss');
  return 'ANSIR_Application_' + safeTitle + '_' + stamp + '.pdf';
}

/**
 * Checks the decoded bytes actually begin with the PDF magic number, %PDF-.
 * base64Decode returns signed bytes, so the comparison is against signed values.
 * @private
 */
function looksLikePdf_(bytes) {
  if (!bytes || bytes.length < 5) {
    return false;
  }
  return bytes[0] === 37 && bytes[1] === 80 && bytes[2] === 68 && bytes[3] === 70 && bytes[4] === 45;
}


// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** @private */
function validateFileData_(fileData) {
  if (!fileData || !fileData.data || !fileData.fileName) {
    return { ok: false, message: 'No file data was received.' };
  }
  if (fileData.mimeType !== ALLOWED_UPLOAD_MIME) {
    return { ok: false, message: 'Only PDF files are accepted.' };
  }
  if (Number(fileData.size) > MAX_UPLOAD_BYTES) {
    return { ok: false, message: 'The file exceeds the 10 MB limit.' };
  }
  // Base64 expands by 4/3, so refuse an oversized payload before decoding it.
  if (String(fileData.data).length > Math.ceil(MAX_UPLOAD_BYTES * 4 / 3) + 1024) {
    return { ok: false, message: 'The file exceeds the 10 MB limit.' };
  }
  return { ok: true, message: '' };
}

/**
 * Server-side re-validation of the required fields. The form checks these too,
 * but the form is not a security boundary.
 * @private
 */
function validateSubmission_(formData) {
  var required = [
    { field: 'title_primary', label: 'Project title' },
    { field: 'description_primary', label: 'Project summary' },
    { field: 'lead_given_name', label: 'Lead investigator given name' },
    { field: 'lead_family_name', label: 'Lead investigator family name' },
    { field: 'lead_email', label: 'Lead investigator email address' }
  ];

  var missing = [];
  for (var i = 0; i < required.length; i++) {
    if (!safeText_(formData[required[i].field])) {
      missing.push(required[i].label);
    }
  }
  if (missing.length) {
    return { ok: false, message: 'The following required fields are missing: ' + missing.join(', ') + '.' };
  }

  if (!isEmailAddress_(safeText_(formData.lead_email))) {
    return { ok: false, message: 'The lead investigator email address is not valid.' };
  }

  if (formData.additional_contributors && formData.additional_contributors.length > MAX_ADDITIONAL_CONTRIBUTORS) {
    return { ok: false, message: 'Too many additional contributors were supplied.' };
  }

  return { ok: true, message: '' };
}

/** @private */
function isEmailAddress_(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}


// ---------------------------------------------------------------------------
// Abuse control
// ---------------------------------------------------------------------------

/**
 * A simple submissions-per-hour cap.
 *
 * IMPORTANT AND DELIBERATE LIMITATION: Apps Script does not expose the caller's
 * IP address to google.script.run or to doPost. There is therefore no way to
 * rate limit per caller, and this cap is GLOBAL across everyone using the
 * endpoint. It is a brake on automated flooding, not a per-user quota, and it
 * is documented as such rather than dressed up as something stronger.
 *
 * The counter lives in CacheService, which can evict entries under memory
 * pressure. Eviction fails open, meaning the counter restarts rather than
 * locking everyone out. That is the right trade-off here: a legitimate
 * researcher must never be blocked from applying by a cache eviction.
 *
 * @private
 * @param {string} bucket 'submit' or 'upload' - counted separately.
 * @return {boolean} true if the request is allowed to proceed.
 */
function rateLimitOk_(bucket) {
  try {
    var cache = CacheService.getScriptCache();
    var hour = Utilities.formatDate(new Date(), 'UTC', 'yyyyMMddHH');
    var key = 'ansir_rate_' + bucket + '_' + hour;
    var current = parseInt(cache.get(key), 10);
    if (isNaN(current)) {
      current = 0;
    }
    if (current >= MAX_SUBMISSIONS_PER_HOUR) {
      logLine_('Rate limit reached for bucket ' + bucket + ' in hour ' + hour + '.');
      return false;
    }
    // 3900 seconds is one hour plus a margin, so the bucket outlives its hour.
    cache.put(key, String(current + 1), 3900);
    return true;
  } catch (err) {
    logError_('rateLimitOk_', err);
    return true;
  }
}


// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

/**
 * Sends the three notifications:
 *   1. a copy of the application to the applicant,
 *   2. an internal notification to ADMIN_EMAILS,
 *   3. the same internal notification to FACILITY_EMAILS.
 *
 * Every send is individually wrapped, because a failed email must never lose an
 * application that has already been written to the sheet.
 * @private
 */
function sendNotifications_(formData, ansirCode, fileInfo) {
  var sent = [];
  var attachments = fileInfo ? [fileInfo.blob] : [];

  var applicantAddress = safeText_(formData.lead_email);
  try {
    MailApp.sendEmail({
      to: applicantAddress,
      subject: 'ANSIR equipment loan application received - ' + ansirCode,
      body: buildApplicantEmail_(formData, ansirCode, fileInfo),
      name: MAIL_FROM_NAME,
      attachments: attachments
    });
    sent.push('applicant');
  } catch (err) {
    logError_('sendNotifications_ (applicant)', err);
  }

  var internalBody = buildInternalEmail_(formData, ansirCode, fileInfo);
  var internalSubject = 'New ANSIR equipment loan application - ' + ansirCode;

  if (ADMIN_EMAILS && ADMIN_EMAILS.length) {
    try {
      MailApp.sendEmail({
        to: ADMIN_EMAILS.join(','),
        subject: internalSubject,
        body: internalBody,
        name: MAIL_FROM_NAME,
        attachments: attachments,
        replyTo: applicantAddress
      });
      sent.push('admin');
    } catch (err) {
      logError_('sendNotifications_ (admin)', err);
    }
  } else {
    logLine_('ADMIN_EMAILS is empty. No administrator notification was sent.');
  }

  // The facility list is wired up identically to the admin list. It is empty by
  // design until the correct ANSIR facility addresses are known - add them to
  // FACILITY_EMAILS at the top of this file and this send starts working with
  // no other change.
  if (FACILITY_EMAILS && FACILITY_EMAILS.length) {
    try {
      MailApp.sendEmail({
        to: FACILITY_EMAILS.join(','),
        subject: internalSubject,
        body: internalBody,
        name: MAIL_FROM_NAME,
        attachments: attachments,
        replyTo: applicantAddress
      });
      sent.push('facility');
    } catch (err) {
      logError_('sendNotifications_ (facility)', err);
    }
  } else {
    logLine_('FACILITY_EMAILS is empty by design. No facility notification was sent.');
  }

  return { sent: sent };
}

/**
 * The applicant's copy: acknowledgement, reference number, next steps, and a
 * full transcript of what was submitted.
 * @private
 */
function buildApplicantEmail_(formData, ansirCode, fileInfo) {
  var salutation = joinNonEmpty_(
    [formData.lead_title, formData.lead_given_name, formData.lead_family_name], ' '
  );

  var lines = [];
  lines.push('Dear ' + (salutation || 'Applicant') + ',');
  lines.push('');
  lines.push('Thank you for submitting an equipment loan application to ANSIR, the Australian National Seismic Imaging Resource.');
  lines.push('');
  lines.push('Your application has been received and is pending review.');
  lines.push('');
  lines.push('ANSIR reference: ' + ansirCode);
  lines.push('');
  lines.push('NEXT STEPS');
  lines.push('----------');
  lines.push('1. Your application will be assessed by the ANSIR team.');
  lines.push('2. We may contact you if further information is required.');
  lines.push('3. You will be notified once a decision has been made.');
  lines.push('');
  lines.push('If you have any questions, please contact ' + CONTACT_EMAIL + ' and quote your ANSIR reference.');
  lines.push('');
  lines.push('Yours sincerely,');
  lines.push('The ANSIR team');
  lines.push('Australian National Seismic Imaging Resource');
  lines.push('An AuScope research facility funded under NCRIS');
  lines.push('');

  return lines.concat(applicationTranscript_(formData, ansirCode, fileInfo)).join('\n');
}

/**
 * The internal notification sent to ADMIN_EMAILS and FACILITY_EMAILS.
 * @private
 */
function buildInternalEmail_(formData, ansirCode, fileInfo) {
  var lines = [];
  lines.push('A new ANSIR equipment loan application has been submitted.');
  lines.push('');
  lines.push('ANSIR reference: ' + ansirCode);
  lines.push('Received: ' + formatDateTime_(new Date()));
  lines.push('Recorded in: ' + APPLICATIONS_SHEET_NAME + ' (Google Sheet ' + SHEET_ID + ')');
  lines.push('');
  lines.push('This application is NOT yet a project. It sits in the intake tab until it is');
  lines.push('reviewed and promoted. The promotion procedure is documented in docs/INTAKE.md.');
  lines.push('');

  return lines.concat(applicationTranscript_(formData, ansirCode, fileInfo)).join('\n');
}

/**
 * The shared body of both emails: everything the applicant submitted.
 * @private
 */
function applicationTranscript_(formData, ansirCode, fileInfo) {
  var rule = '================================================================';
  var lines = [];

  lines.push(rule);
  lines.push('APPLICATION DETAILS - ' + ansirCode);
  lines.push(rule);
  lines.push('');
  lines.push('PROJECT');
  lines.push('-------');
  lines.push('Title: ' + orNotProvided_(formData.title_primary));
  lines.push('Acronym: ' + orNotProvided_(formData.title_acronym));
  lines.push('Keywords: ' + orNotProvided_(formData.project_keywords));
  lines.push('');
  lines.push('Summary:');
  lines.push(orNotProvided_(formData.description_primary));
  lines.push('');
  lines.push('Scientific objectives:');
  lines.push(orNotProvided_(formData.description_objectives));
  lines.push('');

  lines.push('LEAD INVESTIGATOR');
  lines.push('-----------------');
  lines.push('Name: ' + orNotProvided_(joinNonEmpty_(
    [formData.lead_title, formData.lead_given_name, formData.lead_family_name], ' ')));
  lines.push('Email: ' + orNotProvided_(formData.lead_email));
  lines.push('ORCID: ' + orNotProvided_(formData.lead_orcid));
  lines.push('Organisation: ' + orNotProvided_(formData.lead_organisation));
  lines.push('Organisation ROR: ' + orNotProvided_(formData.lead_org_ror));
  lines.push('');

  lines.push('ADDITIONAL TEAM MEMBERS');
  lines.push('-----------------------');
  var team = contributorLines_(formData.additional_contributors);
  if (team.length) {
    lines = lines.concat(team);
  } else {
    lines.push('None listed.');
  }
  lines.push('');

  lines.push('TIMELINE');
  lines.push('--------');
  lines.push('Start date: ' + orNotProvided_(formData.date_start_date));
  lines.push('End date: ' + orNotProvided_(formData.date_end_date));
  lines.push('Timing constraints: ' + orNotProvided_(formData.timing_constraints));
  lines.push('');

  lines.push('LOCATION');
  lines.push('--------');
  lines.push('Region: ' + orNotProvided_(formData.location_region));
  lines.push('Country: ' + (safeText_(formData.location_country) || 'Australia'));
  lines.push('Coordinates: ' + (formatPolygon_(formData.location_polygon) || 'Not provided'));
  lines.push('');

  lines.push('METHODS AND EQUIPMENT');
  lines.push('---------------------');
  lines.push('Methods: ' + orNotProvided_(formData.methods_field));
  lines.push('');
  lines.push('Methods description:');
  lines.push(orNotProvided_(formData.methods_description));
  lines.push('');
  lines.push('Equipment requested:');
  var equipment = equipmentLines_(formData.instrumentation_request);
  if (equipment.length) {
    for (var i = 0; i < equipment.length; i++) {
      lines.push('  - ' + equipment[i]);
    }
  } else {
    lines.push('  None specified.');
  }
  lines.push('');
  lines.push('Availability confirmed with ANSIR: ' + (safeText_(formData.equipment_availability_confirmed) || 'No'));
  lines.push('Field team experience: ' + orNotProvided_(formData.field_team_experience));
  lines.push('Training required: ' + orNotProvided_(formData.training_required));
  lines.push('');

  lines.push('DATA MANAGEMENT AND ACCESS');
  lines.push('--------------------------');
  lines.push('FDSN network code: ' + orNotProvided_(formData.fdsn_network_code));
  lines.push('Estimated data volume: ' + orNotProvided_(formData.estimated_data_volume));
  lines.push('Data submission confirmed: ' + orNotProvided_(formData.data_submission_confirmed));
  lines.push('Data access level: ' + orNotProvided_(formData.data_access));
  lines.push('Embargo duration: ' + orNotProvided_(formData.embargo_duration));
  lines.push('Embargo reason: ' + orNotProvided_(formData.embargo_reason));
  lines.push('Restricted access reason: ' + orNotProvided_(formData.restricted_reason));
  lines.push('');

  lines.push('CULTURAL HERITAGE AND INDIGENOUS ENGAGEMENT');
  lines.push('-------------------------------------------');
  lines.push('Cultural heritage check: ' + orNotProvided_(formData.cultural_heritage_check));
  lines.push('Indigenous involvement: ' + orNotProvided_(formData.indigenous_involvement_flag));
  lines.push('Engagement summary: ' + orNotProvided_(formData.description_indigenous_engagement_summary));
  lines.push('Data governance: ' + orNotProvided_(formData.description_indigenous_data_governance));
  lines.push('Acknowledgement: ' + orNotProvided_(formData.description_indigenous_acknowledgement));
  lines.push('Data sensitivity flagged: ' + orNotProvided_(formData.indigenous_data_sensitivity_flag));
  lines.push('');

  lines.push('FUNDING');
  lines.push('-------');
  lines.push('Application type: ' + orNotProvided_(formData.application_type));
  lines.push('Application type (other): ' + orNotProvided_(formData.application_type_other));
  lines.push('Funding status: ' + orNotProvided_(formData.funding_status));
  lines.push('Grant or programme: ' + orNotProvided_(formData.funding_title));
  lines.push('Funding agency: ' + orNotProvided_(formData.funding_agency_name));
  lines.push('Grant identifier: ' + orNotProvided_(formData.funding_identifier));
  lines.push('');

  lines.push('SUPPORTING DOCUMENT');
  lines.push('-------------------');
  if (fileInfo) {
    lines.push('File: ' + fileInfo.name);
    lines.push('Size: ' + (fileInfo.size / 1024).toFixed(1) + ' KB');
    lines.push('Status: attached to this email and stored in the ANSIR applications folder.');
  } else {
    lines.push('No supporting document was uploaded.');
  }
  lines.push('');
  lines.push(rule);

  return lines;
}

/** @private */
function contributorLines_(contributors) {
  var lines = [];
  if (!contributors || !contributors.length) {
    return lines;
  }
  var limit = Math.min(contributors.length, MAX_ADDITIONAL_CONTRIBUTORS);
  for (var i = 0; i < limit; i++) {
    var c = contributors[i] || {};
    var name = joinNonEmpty_([c.title, c.given_name, c.family_name], ' ');
    if (!name) {
      continue;
    }
    lines.push('  ' + (lines.length + 1) + '. ' + name +
      ' (' + (safeText_(c.email) || 'no email supplied') + ') - ' +
      (safeText_(c.organisation) || 'no organisation supplied'));
  }
  return lines;
}


// ---------------------------------------------------------------------------
// Equipment naming
// ---------------------------------------------------------------------------

/**
 * The catalogue of equipment keys used by the application form, mapped to the
 * names people actually recognise. Ported unchanged from the previous
 * implementation so that emails and sheet entries read the same as before.
 * @private
 */
function equipmentCatalogue_() {
  return {
    // Broadband seismometers
    'inst_trillium_compact_120s': 'Nanometrics Trillium Compact 120s',
    'inst_trillium_compact_120s_nz': 'Nanometrics Trillium Compact 120s (NZ)',
    'inst_trillium_20s': 'Nanometrics Trillium Compact 20s',
    'inst_trillium_compact_horizon_120s': 'Nanometrics Trillium Compact Horizon 120s',
    'inst_trillium_compact_posthole_120s': 'Nanometrics Trillium Compact Posthole 120s',
    // Short-period seismometers
    'inst_lennartz_le3dlite_1hz': 'Lennartz LE-3Dlite 1Hz',
    'inst_lennartz_le3dlite_1hz_nz': 'Lennartz LE-3Dlite 1Hz (NZ)',
    'inst_sercel_l28_3d': 'Sercel L-28-3D',
    // Seismic data recorders
    'inst_anu_terrasawr': 'ANU TerraSAWR',
    'inst_anu_lpr200': 'ANU LPR-200',
    'inst_anu_lpr200_nz': 'ANU LPR-200 (NZ)',
    'inst_nanometrics_centaur': 'Nanometrics Centaur (indoor or vault only)',
    // Nodal seismic
    'inst_smartsolo_igubd3c5': 'Smartsolo IGU-BD3C-5',
    'inst_smartsolo_igu16hr_3c': 'Smartsolo IGU-16HR 3C',
    'inst_smartsolo_igu16hr_3c_nz': 'Smartsolo IGU-16HR 3C (NZ)',
    'inst_smartsolo_igu16_1c': 'Smartsolo IGU-16 1C',
    // Long-period magnetotellurics
    'inst_lemi424': 'LEMI-424',
    'inst_earthdata_pr624': 'EarthData PR6-24 Logger (LP)',
    // Broadband magnetotellurics
    'inst_earthdata_pr624_bb': 'EarthData PR6-24 Logger (BB)',
    'inst_lemi423': 'LEMI-423',
    'inst_phoenix_mtu5c': 'Phoenix MTU-5C',
    // Distributed acoustic sensing
    'inst_idas_24': 'Silixa iDAS 2.4',
    'inst_idas_25': 'Silixa iDAS 2.5',
    'inst_idas_25_nz': 'Silixa iDAS 2.5 (NZ)',
    // Petrophysical field-deployable tools
    'inst_petro_borehole_seismometer': 'Surface and borehole seismometer',
    'inst_petro_aftershock_seismometers': 'Broadband aftershock seismometers',
    'inst_petro_dts': 'Distributed Temperature Sensor (DTS)',
    'inst_petro_geo_dts': 'Geo-DTS sensing system (enhanced geothermal response testing)',
    'inst_petro_wireline_logger': 'Wireline temperature logger and natural gamma tool',
    'inst_petro_gphone': 'Gravity meter (gPhone)',
    'inst_petro_trimble_gnss': 'Trimble GNSS receiver',
    'inst_petro_acoustic_televiewer': 'Acoustic Televiewer (ALT)',
    'inst_petro_tilt_meters': 'Surface and borehole tilt-meters',
    'inst_petro_atmospheric_monitoring': 'Atmospheric monitoring tools'
  };
}

/**
 * Requested equipment as display names only.
 * @private
 */
function equipmentNames_(request) {
  var catalogue = equipmentCatalogue_();
  var out = [];
  if (!request) {
    return out;
  }
  for (var key in request) {
    if (!Object.prototype.hasOwnProperty.call(request, key)) {
      continue;
    }
    var qty = Number(request[key]);
    if (qty > 0) {
      out.push(catalogue[key] || key);
    }
  }
  return out;
}

/**
 * Requested equipment as "name: quantity" strings.
 * @private
 */
function equipmentLines_(request) {
  var catalogue = equipmentCatalogue_();
  var out = [];
  if (!request) {
    return out;
  }
  for (var key in request) {
    if (!Object.prototype.hasOwnProperty.call(request, key)) {
      continue;
    }
    var qty = Number(request[key]);
    if (qty > 0) {
      out.push((catalogue[key] || key) + ': ' + qty);
    }
  }
  return out;
}


// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/**
 * Formats a GeoJSON point or polygon as plain latitude, longitude pairs.
 * Ported from formatPolygonCoordinates.
 * @private
 */
function formatPolygon_(polygonData) {
  if (!polygonData) {
    return '';
  }
  try {
    var geo = polygonData;
    if (typeof polygonData === 'string') {
      if (!polygonData.trim()) {
        return '';
      }
      geo = JSON.parse(polygonData);
    }
    if (!geo || !geo.type) {
      return String(polygonData);
    }
    if (geo.type === 'Point' && geo.coordinates) {
      return geo.coordinates[1].toFixed(5) + ', ' + geo.coordinates[0].toFixed(5);
    }
    if (geo.type === 'Polygon' && geo.coordinates && geo.coordinates[0]) {
      var ring = geo.coordinates[0].slice(0, -1);
      var parts = [];
      for (var i = 0; i < ring.length; i++) {
        parts.push(ring[i][1].toFixed(5) + ', ' + ring[i][0].toFixed(5));
      }
      return parts.join('; ');
    }
    return JSON.stringify(geo);
  } catch (err) {
    return typeof polygonData === 'string' ? polygonData : '';
  }
}

/**
 * Coerces any input to a trimmed string and caps its length.
 * @private
 */
function safeText_(value) {
  if (value === null || value === undefined) {
    return '';
  }
  var text = String(value).trim();
  if (text.length > MAX_TEXT_FIELD_CHARS) {
    text = text.substring(0, MAX_TEXT_FIELD_CHARS);
  }
  return text;
}

/**
 * Neutralises spreadsheet formula injection before a value is written to the
 * sheet. A submitted value beginning with =, +, - or @ would otherwise be
 * evaluated as a formula when a reviewer opens the tab.
 * @private
 */
function sheetSafe_(value) {
  var text = safeText_(value);
  if (text && /^[=+\-@]/.test(text)) {
    return "'" + text;
  }
  return text;
}

/** @private */
function joinNonEmpty_(parts, separator) {
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var text = safeText_(parts[i]);
    if (text) {
      out.push(text);
    }
  }
  return out.join(separator);
}

/** @private */
function orNotProvided_(value) {
  var text = safeText_(value);
  return text ? text : 'Not provided';
}

/** @private */
function formatDateTime_(date) {
  return Utilities.formatDate(date, TIMEZONE, 'd MMMM yyyy, HH:mm') + ' (' + TIMEZONE + ')';
}

/** @private */
function jsonResponse_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

/** @private */
function logLine_(message) {
  console.log('[ANSIR INTAKE] ' + message);
}

/**
 * Logs an error for the operator without ever returning internals to the caller.
 * @private
 */
function logError_(where, error) {
  console.error('[ANSIR INTAKE] Error in ' + where + ': ' + (error && error.message ? error.message : error));
  if (error && error.stack) {
    console.error('[ANSIR INTAKE] Stack: ' + error.stack);
  }
}
