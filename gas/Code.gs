/**
 * ANSIR - Equipment Loan Application Intake Endpoint
 * ANSIR Research Facilities for Earth Sounding (AuScope / NCRIS)
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
 *   saveUploadedFile    - accepts ONE PDF per call, returns a Drive file ID
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

/**
 * The Google Sheet holding both the master project list and the intake tab.
 *
 * NOT STORED IN THIS FILE. This repository is public, and while a sheet ID
 * grants nobody access on its own (Google's sharing permissions are the actual
 * control), publishing internal identifiers in an organisation's public
 * repository is needless exposure: it tells an attacker exactly what to aim
 * social engineering at, and it cannot be un-published once it is in git
 * history.
 *
 * Set it once per deployment, in the Apps Script editor:
 *   Project Settings (gear icon) > Script Properties > Add script property
 *   Property: ANSIR_SHEET_ID
 *   Value:    the ID from the sheet URL, between /d/ and /edit
 *
 * Script Properties live with the deployment, not with the code, so a fork of
 * this repository is inert until its owner supplies their own sheet.
 * @private
 */
function sheetId_() {
  var id = PropertiesService.getScriptProperties().getProperty('ANSIR_SHEET_ID');
  if (!id) {
    throw new Error('Script property ANSIR_SHEET_ID is not set. In the Apps ' +
      'Script editor: Project Settings > Script Properties > Add script ' +
      'property, named ANSIR_SHEET_ID, with the ANSIR sheet ID as its value. ' +
      'See gas/README.md.');
  }
  return id;
}

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
 * The STAGING folder. Uploaded supporting PDFs are written here by
 * saveUploadedFile, before any ANSIR reference exists for them.
 *
 * Create a folder in the Drive of the account that owns this script, open it,
 * and copy the ID out of the URL:
 *   https://drive.google.com/drive/folders/<THIS_IS_THE_ID>
 *
 * Leave it as the placeholder and saveUploadedFile will fail loudly with a
 * configuration error, which is the intended behaviour. It must never fail
 * quietly: the previous version silently discarded every PDF it was given.
 *
 * This folder must contain uploads and nothing else. getUploadedFiles_ treats
 * membership of it as proof that the intake itself created a file, applies that
 * test to every document on a submission, and that is the only thing standing
 * between a client-supplied file ID and an arbitrary Drive file being emailed to
 * a client-supplied address.
 */
var UPLOAD_FOLDER_ID = 'REPLACE_WITH_UPLOAD_FOLDER_ID';

/**
 * OPTIONAL CONFIGURATION - filing is skipped, safely, until this is set.
 *
 * The PARENT folder that per-application folders are created inside. At
 * submission, once the ANSIR reference has been allocated, a folder named after
 * that reference (for example ANSIR-2026-008) is created here, the staged
 * supporting document is moved into it, and a PDF copy of the application is
 * written alongside.
 *
 * Get the ID the same way as UPLOAD_FOLDER_ID, from the folder's URL. It must
 * be a DIFFERENT folder from the staging one: the staging folder is the
 * containment check's whole basis and must hold uploads and nothing else.
 *
 * Left as the placeholder, the endpoint behaves exactly as it did before filing
 * existed. The staged document stays in the staging folder, no per-application
 * folder is created, application_folder_url is written empty, and one line is
 * logged saying filing is not configured. The application is still recorded and
 * still emailed. Filing is a convenience for the facility manager; it is never
 * a reason to fail an application.
 */
var APPLICATION_FOLDER_ID = 'REPLACE_WITH_APPLICATION_FOLDER_ID';

/** Who gets the internal notification. */
var ADMIN_EMAILS = [
  'ben@auscope.org.au'
];

/**
 * Facility notifications, routed by research method.
 *
 * DELIBERATELY EMPTY. Each key is one of the form's method checkbox values,
 * verbatim; the notification goes to the union of the addresses for the
 * methods the applicant ticked, deduplicated, so a seismic application never
 * reaches the MT operators and an MT application never reaches ANU. A
 * mixed-method application (say Seismic + Magnetotelluric) goes to both.
 *
 * Filling in an address list is the only change needed to switch that
 * method's notifications on. While every matched list is empty, the facility
 * email is skipped and a line is written to the execution log naming the
 * methods that had no address configured.
 *
 * Example once the addresses are confirmed:
 *   'Seismic':        ['ansir@anu.edu.au'],
 *   'Nodal Seismic':  ['ansir@anu.edu.au'],
 *   'DAS':            ['ansir@anu.edu.au'],
 *   'Magnetotelluric':['mt-facility@adelaide.edu.au'],
 *   'Petrophysical':  ['petrophysics@unimelb.edu.au'],
 */
var FACILITY_ROUTES = {
  'Seismic': [],
  'Nodal Seismic': [],
  'DAS': [],
  'Magnetotelluric': [],
  'Petrophysical': []
};

/**
 * The facility addresses for one application: the union of FACILITY_ROUTES
 * for every method the applicant selected (semicolon-delimited in
 * methods_field), deduplicated. Unknown method strings are logged rather
 * than silently dropped, so a renamed checkbox cannot quietly kill routing.
 * @private
 */
function facilityRecipients_(formData) {
  var methods = String(formData.methods_field || '').split(';');
  var seen = {};
  var recipients = [];
  var unrouted = [];
  for (var i = 0; i < methods.length; i++) {
    var method = methods[i].trim();
    if (!method) continue;
    if (!Object.prototype.hasOwnProperty.call(FACILITY_ROUTES, method)) {
      unrouted.push(method);
      continue;
    }
    var list = FACILITY_ROUTES[method] || [];
    for (var j = 0; j < list.length; j++) {
      var address = String(list[j]).trim();
      if (address && !seen[address]) {
        seen[address] = true;
        recipients.push(address);
      }
    }
  }
  if (unrouted.length) {
    logLine_('No facility route configured for method(s): ' + unrouted.join(', ') +
      '. Check FACILITY_ROUTES against the form checkbox values.');
  }
  return recipients;
}

/**
 * Abuse control. See rateLimitOk_ for the important caveat: Apps Script does
 * not expose a client IP address, so this cap is necessarily GLOBAL across all
 * callers, not per-caller.
 */
var MAX_SUBMISSIONS_PER_HOUR = 20;

/** Upload constraints, re-checked server-side. Never trust the client. */
var MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
var ALLOWED_UPLOAD_MIME = 'application/pdf';

/**
 * How many supporting documents one application may carry.
 *
 * A reviewer reading an application should be able to take in the attachments
 * at a glance, and five is enough for a proposal, a permit, a risk assessment,
 * a site map and a letter of support. It is also a cap on the number of Drive
 * round trips one submission can force this script to make.
 */
var MAX_UPLOAD_FILES = 5;

/**
 * The TOTAL size of all supporting documents in one application.
 *
 * THIS CAP EXISTS TO KEEP THE NOTIFICATION EMAILS DELIVERABLE, and that is the
 * reason it is the same size as the single-file cap rather than five times it.
 * Every supporting document is attached to all three notification emails
 * (applicant, administrators, facility) ALONGSIDE the generated application
 * PDF. Gmail refuses to send a message over roughly 25 MB including its
 * attachments and their transport encoding, so an application carrying, say,
 * five 10 MB documents would produce three emails that Gmail simply rejects.
 * The applicant would have a reference number and nobody would be told. Ten
 * megabytes of documents plus the application PDF leaves ample headroom under
 * that limit.
 *
 * The client tracks the running total and refuses to start an upload that would
 * breach this, so the applicant is told at the moment they attach the file
 * rather than at submission. The client is not a security boundary, so the
 * total is checked again, independently, in getUploadedFiles_ at submission,
 * against the sizes Drive reports rather than any number the client supplied.
 */
var MAX_UPLOAD_TOTAL_BYTES = 10 * 1024 * 1024;

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

/**
 * The address outgoing mail is sent FROM, for continuity across staff changes.
 *
 * Apps Script cannot invent a sender: mail can only leave AS this address if
 * the account that deployed the script either IS this account, or has it as a
 * verified Gmail "Send mail as" alias (Gmail Settings > Accounts > Send mail
 * as; for a Workspace group like ansir@auscope.org.au, the group must allow
 * members to post as the group before Gmail will verify it).
 *
 * sendMail_ below checks whether the alias is actually available at send time.
 * When it is, mail goes out as this address via GmailApp. When it is not, the
 * send still happens - from the deploying account, via MailApp - and a loud
 * line is written to the execution log saying exactly what to configure. An
 * application must never be lost to a sender-identity problem.
 *
 * Set to '' to skip the alias logic entirely and always send as the deploying
 * account.
 */
var MAIL_FROM_ADDRESS = 'ansir@auscope.org.au';

/**
 * Sends one email as MAIL_FROM_ADDRESS when possible, as the deploying
 * account when not. Options: to, subject, body, name, attachments, replyTo.
 * @private
 */
function sendMail_(options) {
  if (MAIL_FROM_ADDRESS) {
    try {
      var me = Session.getEffectiveUser().getEmail();
      var canSendAs = (MAIL_FROM_ADDRESS === me) ||
        (GmailApp.getAliases().indexOf(MAIL_FROM_ADDRESS) !== -1);
      if (canSendAs) {
        GmailApp.sendEmail(options.to, options.subject, options.body, {
          from: MAIL_FROM_ADDRESS,
          name: options.name,
          attachments: options.attachments,
          replyTo: options.replyTo
        });
        return;
      }
      logLine_('MAIL_FROM_ADDRESS (' + MAIL_FROM_ADDRESS + ') is not ' + me +
        ' and is not one of its verified Send-mail-as aliases. Sending from ' +
        me + ' instead. To send as ' + MAIL_FROM_ADDRESS + ', either deploy ' +
        'this script from that account or verify it as a Gmail alias.');
    } catch (err) {
      logError_('sendMail_ (alias check)', err);
    }
  }
  MailApp.sendEmail(options);
}

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
 * ONE FILE PER CALL, DELIBERATELY. An application may carry up to
 * MAX_UPLOAD_FILES documents, and the client uploads them one at a time,
 * sequentially, collecting the returned IDs. Base64 inflates a payload by about
 * a third, so a single multi-file request would be large, slow and
 * all-or-nothing: one unreadable file would fail the whole set. Per-file calls
 * also mean a failure can be reported to the applicant naming the file that
 * failed.
 *
 * This call cannot enforce the total-size cap, because there is no
 * cross-execution state to accumulate a total in. The client tracks the running
 * total, and getUploadedFiles_ re-checks it independently at submission.
 *
 * The returned fileId is what the client passes back to submitApplication in
 * uploaded_file_ids. There is no cross-execution state of any kind. The previous
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

  var name = buildUploadFileName_(projectTitle, fileData.fileName);
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

  var spreadsheet = SpreadsheetApp.openById(sheetId_());
  var applicationsSheet = getApplicationsSheet_(spreadsheet);

  // Retrieve the supporting documents, if any were uploaded, BEFORE allocating
  // a code, so that a bad file ID fails before it consumes a reference number.
  //
  // THIS CALL MUST STAY HERE, BEFORE ANY FILING HAPPENS. getUploadedFiles_
  // proves that EVERY file is inside the staging folder, and that proof is what
  // stops a caller naming an arbitrary Drive file and having it emailed to an
  // address of their choosing. One unchecked ID in a list of five would be
  // exactly as dangerous as one unchecked ID on its own, so the check is per
  // file and the whole submission is refused if any file fails it. Filing MOVES
  // the files out of the staging folder, so the check is only meaningful while
  // they are still there. Verify first, move afterwards; never the other way
  // round.
  //
  // The count cap and the total-size cap are enforced in the same place and at
  // the same moment, on the sizes Drive reports rather than on anything the
  // client said, and they refuse the whole submission before a reference is
  // allocated.
  var fileIds = normaliseFileIds_(formData);
  var fileInfos = [];
  if (fileIds.length) {
    var retrieval = getUploadedFiles_(fileIds);
    if (!retrieval.ok) {
      return { success: false, message: retrieval.message };
    }
    fileInfos = retrieval.files;
  }

  var allocation = allocateAnsirCode_(spreadsheet, applicationsSheet, formData, fileInfos);
  if (!allocation) {
    return { success: false, message: 'The service is busy allocating a reference number. Please try again in a moment.' };
  }
  var ansirCode = allocation.ansirCode;

  // The row is already written by allocateAnsirCode_, inside the lock, so that
  // the code cannot be allocated without also being recorded.
  //
  // EVERYTHING FROM HERE ON IS BEST EFFORT. The application is on the sheet.
  // Nothing below may throw its way out of this function, because an
  // application that has been recorded must never be lost or hidden by a Drive
  // or PDF failure. Each step logs and carries on.

  // The staged supporting documents, if there are any, join their application
  // in the per-application folder. Their Drive URLs are unchanged by the move,
  // so the links already written to the sheet stay correct either way. Each
  // move is wrapped on its own, so one failure cannot strand the others.

  // The PDF is built whether or not filing is configured, because it is
  // attached to the emails regardless. A null blob simply means one fewer
  // attachment.
  var applicationPdf = buildApplicationPdf_(formData, ansirCode, fileInfos);
  fileApplicationPdf_(allocation.folder, applicationPdf);

  var emailResult = sendNotifications_(formData, ansirCode, fileInfos, applicationPdf);

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
 * The per-application folder is created here too, and for one reason only: the
 * folder is named after the reference, the reference does not exist until this
 * function computes it, and the row records the folder's URL. Creating it here
 * keeps the row a single complete write rather than a write followed by a patch
 * that could itself fail. The call is wrapped, so a Drive failure costs an
 * empty application_folder_url cell and nothing else; the move and the PDF, the
 * slower Drive work, are done by the caller outside the lock.
 *
 * @private
 * @return {Object|null} { ansirCode, folder } where folder may be null, or null
 *     if the lock was not obtained.
 */
function allocateAnsirCode_(spreadsheet, applicationsSheet, formData, fileInfos) {
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

    var folder = createApplicationFolder_(ansirCode);
    var folderUrl = folderUrl_(folder);

    // Filing happens HERE, before the record is built, so the row records
    // the documents' final names. Every step inside moveStagedFiles_ fails
    // quietly, so a Drive problem cannot stop the row being written; it only
    // means a document keeps its staged name, and the record then quotes
    // that name, which is still the file's real name.
    moveStagedFiles_(fileInfos, folder, ansirCode);

    var record = buildApplicationRecord_(formData, ansirCode, fileInfos, folderUrl);
    var headers = applicationsHeaders_();
    var row = [];
    for (var i = 0; i < headers.length; i++) {
      row.push(sheetSafe_(record[headers[i]]));
    }
    applicationsSheet.appendRow(row);
    SpreadsheetApp.flush();

    logLine_('Allocated ' + ansirCode + ' and wrote row ' + applicationsSheet.getLastRow() + '.');
    return { ansirCode: ansirCode, folder: folder };
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
 *
 * If the tab already exists, its header row MUST match applicationsHeaders_()
 * exactly. Rows are written positionally: allocateAnsirCode_ walks
 * applicationsHeaders_() and pushes one value per header, so a tab created
 * under an older, differently ordered header row would take the new values into
 * the old columns and silently mis-file every field. This function therefore
 * refuses to write to a mismatched tab rather than corrupting it, and names the
 * first difference so the operator can see what happened.
 *
 * @private
 */
function getApplicationsSheet_(spreadsheet) {
  var sheet = spreadsheet.getSheetByName(APPLICATIONS_SHEET_NAME);
  var headers = applicationsHeaders_();

  if (!sheet) {
    sheet = spreadsheet.insertSheet(APPLICATIONS_SHEET_NAME);
    writeApplicationsHeaderRow_(sheet, headers);
    logLine_('Created tab ' + APPLICATIONS_SHEET_NAME + ' with ' + headers.length + ' headers.');
    return sheet;
  }

  if (sheet.getLastRow() === 0) {
    writeApplicationsHeaderRow_(sheet, headers);
    return sheet;
  }

  var mismatch = headerMismatch_(sheet, headers);
  if (mismatch) {
    logLine_('Header mismatch in ' + APPLICATIONS_SHEET_NAME + ': ' + mismatch);
    throw new Error(
      'The ' + APPLICATIONS_SHEET_NAME + ' tab does not match the expected column layout, so no row was written. ' +
      mismatch + ' ' +
      'To fix this, open the ANSIR project sheet and rename the existing ' + APPLICATIONS_SHEET_NAME +
      ' tab to something else, for example ' + APPLICATIONS_SHEET_NAME + '_archive. ' +
      'The next submission then creates a fresh ' + APPLICATIONS_SHEET_NAME +
      ' tab with the correct headers. The renamed tab keeps its rows and is still readable; ' +
      'nothing is deleted. Do not simply add or reorder columns by hand, because rows are ' +
      'written by position and a hand-edited header row will mis-file every later submission.'
    );
  }

  return sheet;
}

/**
 * Writes and formats the intake header row.
 * @private
 */
function writeApplicationsHeaderRow_(sheet, headers) {
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
}

/**
 * Compares a sheet's header row against the expected headers.
 * @private
 * @return {string} A sentence describing the first difference, or an empty
 *     string if the header row matches exactly.
 */
function headerMismatch_(sheet, headers) {
  var lastCol = sheet.getLastColumn();
  var actual = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];

  var limit = Math.max(actual.length, headers.length);
  for (var i = 0; i < limit; i++) {
    var expectedName = i < headers.length ? String(headers[i]) : '';
    var actualName = i < actual.length ? String(actual[i]).trim() : '';
    if (expectedName !== actualName) {
      var position = 'Column ' + (i + 1) + ' should be "' + expectedName + '"';
      if (!expectedName) {
        position = 'Column ' + (i + 1) + ' should not exist';
      }
      var found = actualName ? 'but the tab has "' + actualName + '".' : 'but the tab has no column there.';
      return 'The tab has ' + actual.length + ' columns and ' + headers.length +
        ' are expected. ' + position + ' ' + found;
    }
  }

  return '';
}

/**
 * The intake tab column order.
 *
 * THE LAYOUT, AND WHY IT IS SHAPED THIS WAY
 * -----------------------------------------
 * Three blocks, in this order:
 *
 *   1. REVIEW BLOCK. Intake-only workflow columns. A reviewer opening the tab
 *      sees these first, before any application content.
 *   2. MASTER-ALIGNED BLOCK. Every column of ANSIR_Projects_MasterList, using
 *      the master list's exact header spellings and its exact order.
 *   3. INTAKE-ONLY BLOCK. Questions the form asks that the master list has no
 *      column for. They sit at the end so they cannot break block 2 apart.
 *
 * Block 2 contains EVERY master column, including the many the form does not
 * collect, which are written empty. An empty column that lines up is what makes
 * promotion a single contiguous copy: the reviewer selects block 2 and pastes
 * it into the master list, and every value lands under the header it belongs
 * to. Omitting an uncollected column would save nothing and would silently
 * shift every column after it by one, which is the failure mode this layout
 * exists to prevent. Do not remove an empty column from block 2, and do not
 * insert anything into it that the master list does not have.
 *
 * If the master list gains, loses or renames a column, change block 2 to match
 * it and change buildApplicationRecord_ in the same edit. Those two functions
 * are the only places the column set is written down; getApplicationsSheet_
 * refuses to write to a tab whose header row disagrees with this list.
 * @private
 */
function applicationsHeaders_() {
  return [
    // ---- Block 1: review workflow. Intake only, not copied to the master list.
    'submission_timestamp',
    'review_status',
    'reviewed_by',
    'review_notes',
    'supporting_document_file_id',
    'supporting_document_url',
    'supporting_document_name',
    'application_folder_url',

    // ---- Block 2: the master list, in master order. Copy this range whole.
    'title_primary',
    'alternative_identifier_id',
    'visible',
    'project_status',
    ANSIR_CODE_HEADER,
    'title_acronym',
    'date_start_date',
    'date_end_date',
    'contributor_honoury_title',
    'contributor_name',
    'contributor_id',
    'contributor_email',
    'contributor_position_id',
    'contributor_leader',
    'contributor_is_contact',
    'contributor_role_id',
    'organisation_name',
    'organisation_id',
    'organisation_role_id',
    'raid_identifier',
    'related_raid_relation',
    'funding_identifier',
    'funding_title',
    'funding_agency_name',
    'funding_agency_location',
    'funding_agency_ror',
    'funding_identifier_type',
    'description_primary',
    'description_objectives',
    'project_keywords',
    'methods_field',
    'methods_analytical',
    'methods_computational',
    'methods_description',
    'instrumentation_type',
    'instrumentation_numbers',
    'instrumentation_method',
    'instrumentation_owner',
    'instrumentation_location',
    'instrument_provider_ror',
    'location_region',
    'location_country',
    'location_coordinates',
    'location_polygon',
    'collection_quantity',
    'collection_quantity_unit',
    'collection_quantity_notes',
    'collection_site_names',
    'collection_site_lats',
    'collection_site_longs',
    'collection_site_alt',
    'collection_site_start_time',
    'collection_site_finish_time',
    'collection_site_instrument',
    'collection_site_instrument_serial',
    'related_object_identifier',
    'related_object_schema_uri',
    'related_object_type',
    'related_object_relation',
    'related_object_category',
    'indigenous_involvement_flag',
    'description_indigenous_engagement_summary',
    'description_indigenous_data_governance',
    'description_indigenous_acknowledgement',
    'indigenous_data_sensitivity_flag',
    'data_access',
    'record_last_updated',
    'record_last_updated_by',
    'visbility',
    'project_approval',
    'project_approval_by',
    'internal_notes',

    // ---- Block 3: intake-only answers with no master list column.
    // These support the review decision. They are not published and they are
    // not copied at promotion. They sit after block 2 so that block 2 stays a
    // single unbroken range.
    'application_type',
    'application_type_other',
    'timing_constraints',
    'equipment_availability_confirmed',
    'field_team_experience',
    'training_required',
    'fdsn_network_code',
    'estimated_data_volume',
    'data_submission_confirmed',
    'embargo_duration',
    'embargo_reason',
    'restricted_reason',
    'cultural_heritage_check',
    'funding_status'
  ];
}

/**
 * Builds the intake row from the submitted form data.
 *
 * The returned object is keyed by header name and MUST carry one key for every
 * name in applicationsHeaders_(), including the master list columns the form
 * does not collect. Those are set to an empty string here rather than left out,
 * so the row that allocateAnsirCode_ assembles has a value in every position
 * and the master-aligned block stays aligned. See applicationsHeaders_() for
 * why the empty columns exist at all.
 *
 * Nothing here decides project status, visibility or approval. The intake does
 * not create projects, so it has no opinion on those fields; a reviewer sets
 * them at promotion, and the separation is deliberate. record_last_updated and
 * record_last_updated_by describe edits to the master list, not to an
 * application, so they are left empty for the same reason.
 * @private
 */
function buildApplicationRecord_(formData, ansirCode, fileInfos, applicationFolderUrl) {
  var people = buildContributorColumns_(formData);

  return {
    // ---- Block 1: review workflow.
    'submission_timestamp': new Date().toISOString(),
    'review_status': 'New',
    'reviewed_by': '',
    'review_notes': '',
    // An application may carry several supporting documents, so these three
    // columns are semicolon-delimited lists, exactly as the contributor columns
    // are, and in the same order in all three. No new column is added: the
    // intake tab's column set is copied wholesale into the master list at
    // promotion, and widening it for a second document would shift every column
    // after it. The Nth id, the Nth url and the Nth name describe one document.
    'supporting_document_file_id': fileInfoField_(fileInfos, 'id'),
    'supporting_document_url': fileInfoField_(fileInfos, 'url'),
    'supporting_document_name': fileInfoField_(fileInfos, 'name'),
    // Empty whenever filing is not configured, or when the folder could not be
    // created. The supporting_document_url list above is written either way, so
    // the reviewer always has a link to every uploaded document.
    'application_folder_url': safeText_(applicationFolderUrl),

    // ---- Block 2: the master list, in master order.
    'title_primary': safeText_(formData.title_primary),
    'alternative_identifier_id': '',
    'visible': '',
    'project_status': '',
    'alternative_identifier_ansir_code': ansirCode,
    'title_acronym': safeText_(formData.title_acronym),
    'date_start_date': safeText_(formData.date_start_date),
    'date_end_date': safeText_(formData.date_end_date),
    'contributor_honoury_title': people.titles,
    'contributor_name': people.names,
    'contributor_id': people.orcids,
    'contributor_email': people.emails,
    'contributor_position_id': people.positions,
    'contributor_leader': people.leaders,
    'contributor_is_contact': people.contacts,
    'contributor_role_id': '',
    'organisation_name': people.organisations,
    'organisation_id': people.organisationRors,
    'organisation_role_id': people.organisationRoles,
    'raid_identifier': '',
    'related_raid_relation': '',
    'funding_identifier': safeText_(formData.funding_identifier),
    'funding_title': safeText_(formData.funding_title),
    'funding_agency_name': safeText_(formData.funding_agency_name),
    'funding_agency_location': '',
    'funding_agency_ror': '',
    'funding_identifier_type': '',
    'description_primary': safeText_(formData.description_primary),
    'description_objectives': safeText_(formData.description_objectives),
    'project_keywords': safeText_(formData.project_keywords),
    'methods_field': safeText_(formData.methods_field),
    'methods_analytical': '',
    'methods_computational': '',
    'methods_description': safeText_(formData.methods_description),
    'instrumentation_type': equipmentNames_(formData.instrumentation_request).join('; '),
    'instrumentation_numbers': equipmentLines_(formData.instrumentation_request).join('; '),
    'instrumentation_method': '',
    'instrumentation_owner': '',
    'instrumentation_location': '',
    'instrument_provider_ror': '',
    'location_region': safeText_(formData.location_region),
    'location_country': safeText_(formData.location_country) || 'Australia',
    'location_coordinates': '',
    'location_polygon': formatPolygon_(formData.location_polygon),
    'collection_quantity': '',
    'collection_quantity_unit': '',
    'collection_quantity_notes': '',
    'collection_site_names': '',
    'collection_site_lats': '',
    'collection_site_longs': '',
    'collection_site_alt': '',
    'collection_site_start_time': '',
    'collection_site_finish_time': '',
    'collection_site_instrument': '',
    'collection_site_instrument_serial': '',
    'related_object_identifier': '',
    'related_object_schema_uri': '',
    'related_object_type': '',
    'related_object_relation': '',
    'related_object_category': '',
    'indigenous_involvement_flag': safeText_(formData.indigenous_involvement_flag),
    'description_indigenous_engagement_summary': safeText_(formData.description_indigenous_engagement_summary),
    'description_indigenous_data_governance': safeText_(formData.description_indigenous_data_governance),
    'description_indigenous_acknowledgement': safeText_(formData.description_indigenous_acknowledgement),
    'indigenous_data_sensitivity_flag': safeText_(formData.indigenous_data_sensitivity_flag),
    'data_access': safeText_(formData.data_access),
    'record_last_updated': '',
    'record_last_updated_by': '',
    'visbility': '',
    'project_approval': '',
    'project_approval_by': '',
    'internal_notes': buildInternalNotes_(fileInfos),

    // ---- Block 3: intake-only answers with no master list column.
    'application_type': safeText_(formData.application_type),
    'application_type_other': safeText_(formData.application_type_other),
    'timing_constraints': safeText_(formData.timing_constraints),
    'equipment_availability_confirmed': safeText_(formData.equipment_availability_confirmed) || 'No',
    'field_team_experience': safeText_(formData.field_team_experience),
    'training_required': safeText_(formData.training_required),
    'fdsn_network_code': safeText_(formData.fdsn_network_code),
    'estimated_data_volume': safeText_(formData.estimated_data_volume),
    'data_submission_confirmed': safeText_(formData.data_submission_confirmed),
    'embargo_duration': safeText_(formData.embargo_duration),
    'embargo_reason': safeText_(formData.embargo_reason),
    'restricted_reason': safeText_(formData.restricted_reason),
    'cultural_heritage_check': safeText_(formData.cultural_heritage_check),
    'funding_status': safeText_(formData.funding_status)
  };
}

/**
 * Ported from buildInternalNotes. Submission timestamp and attached PDFs only.
 * @private
 */
function buildInternalNotes_(fileInfos) {
  var files = fileInfos || [];
  var notes = [];
  notes.push('[Application submitted: ' + formatDateTime_(new Date()) + ']');
  for (var i = 0; i < files.length; i++) {
    notes.push('[Attached: ' + files[i].name + ']');
  }
  return notes.join('\n');
}

/**
 * One field of every fileInfo, joined with the semicolon convention the master
 * list uses for multi-value columns. Empty string for no documents, so the cell
 * is blank rather than carrying a stray separator.
 * @private
 */
function fileInfoField_(fileInfos, key) {
  var files = fileInfos || [];
  var out = [];
  for (var i = 0; i < files.length; i++) {
    out.push(safeText_(files[i][key]));
  }
  return out.join('; ');
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
 * The supporting document IDs on a submission, as an array.
 *
 * THREE SHAPES ARE ACCEPTED, on purpose:
 *   uploaded_file_ids as an array   - what the current form sends,
 *   uploaded_file_ids as a string   - semicolon-delimited, the project's
 *                                     multi-value convention, for any caller
 *                                     that finds a flat field easier,
 *   uploaded_file_id  as a string   - the single-document field this endpoint
 *                                     took before multiple documents existed.
 *
 * The singular field is still read because a browser holding an older cached
 * copy of the form will keep sending it, and an application must not fail
 * because someone had not reloaded the page. Both are read and merged, so a
 * caller sending both does not lose a document.
 *
 * Blanks are dropped and repeats are collapsed: the same ID twice would
 * otherwise attach the same PDF to the emails twice and count twice against the
 * caps.
 * @private
 * @return {Array} Drive file IDs, in the order given, without duplicates.
 */
function normaliseFileIds_(formData) {
  var raw = [];
  var plural = formData ? formData.uploaded_file_ids : null;

  if (plural && typeof plural.length === 'number' && typeof plural !== 'string') {
    for (var i = 0; i < plural.length; i++) {
      raw.push(plural[i]);
    }
  } else if (typeof plural === 'string') {
    raw = plural.split(';');
  }

  if (formData && formData.uploaded_file_id) {
    raw.push(formData.uploaded_file_id);
  }

  var seen = {};
  var ids = [];
  for (var j = 0; j < raw.length; j++) {
    var id = safeText_(raw[j]);
    if (!id || seen[id]) {
      continue;
    }
    seen[id] = true;
    ids.push(id);
  }
  return ids;
}

/**
 * Retrieves the previously uploaded supporting documents by their Drive file
 * IDs and returns their blobs plus metadata.
 *
 * SECURITY: the file IDs arrive from the client, and the files they name are
 * about to be emailed to an address that also arrived from the client. Without
 * a check, anybody could pass the ID of ANY file this script's owner can read
 * and have it mailed to themselves. So EVERY file's parents are verified to
 * include UPLOAD_FOLDER_ID, and anything outside that folder is refused. One
 * unchecked ID in a list is exactly as dangerous as one unchecked ID on its
 * own, so there is no fast path and no partial acceptance: if a single file
 * fails, the whole submission is refused.
 *
 * WHERE THIS RUNS MATTERS AS MUCH AS WHAT IT CHECKS. The containment check is
 * true only while a file is still in the staging folder. Filing moves it out,
 * into the per-application folder, so this function is called from
 * handleSubmit_ BEFORE any filing happens and must stay there. Moving it after
 * the move would turn the check into one that always fails, and "fixing" that
 * by widening the accepted parents would give away the whole control.
 *
 * A consequence, and a welcome one: once a document has been filed against a
 * reference, its ID is no longer accepted by a later submission, because it is
 * no longer in the staging folder. One upload belongs to one application.
 *
 * THE TWO CAPS ARE ENFORCED HERE, and here is the only place they can be
 * enforced honestly. Each upload is a separate execution with no memory of the
 * others, so no upload call can know the running total; this is the first
 * moment the whole set is visible. The sizes are the ones Drive reports for the
 * stored files, not the ones the client claimed, and the count and the total
 * are checked before any file is moved and before a reference is allocated, so
 * a breach costs nothing.
 *
 * @private
 * @param {Array} ids Drive file IDs from normaliseFileIds_.
 * @return {Object} { ok, files, message }. files is an array of
 *     { id, name, url, size, blob }, in the order the IDs were given. On
 *     refusal ok is false and message says what to tell the applicant; the
 *     caller cannot use a bare null here because "not found", "too many" and
 *     "too large in total" need different answers.
 */
function getUploadedFiles_(ids) {
  var list = ids || [];

  if (!isUploadFolderConfigured_()) {
    logLine_('CONFIGURATION ERROR: UPLOAD_FOLDER_ID has not been set, so no ' +
      'supporting document can be verified. See gas/README.md.');
    return {
      ok: false,
      files: [],
      message: 'The supporting documents could not be verified. Please contact ' + CONTACT_EMAIL + '.'
    };
  }

  if (list.length > MAX_UPLOAD_FILES) {
    logLine_('REFUSED: ' + list.length + ' supporting documents supplied, the limit is ' +
      MAX_UPLOAD_FILES + '.');
    return {
      ok: false,
      files: [],
      message: 'An application may include at most ' + MAX_UPLOAD_FILES +
        ' supporting documents. ' + list.length + ' were submitted.'
    };
  }

  var files = [];
  var total = 0;
  for (var i = 0; i < list.length; i++) {
    var fileInfo = getStagedFile_(list[i]);
    if (!fileInfo) {
      return {
        ok: false,
        files: [],
        message: 'One of the uploaded supporting documents could not be found. Please upload it again.'
      };
    }
    total += Number(fileInfo.size) || 0;
    files.push(fileInfo);
  }

  if (total > MAX_UPLOAD_TOTAL_BYTES) {
    logLine_('REFUSED: supporting documents total ' + total + ' bytes, the limit is ' +
      MAX_UPLOAD_TOTAL_BYTES + '.');
    return {
      ok: false,
      files: [],
      message: 'The supporting documents come to ' + formatBytes_(total) +
        ' in total. The limit is ' + formatBytes_(MAX_UPLOAD_TOTAL_BYTES) +
        ' across all documents in one application, because every document is ' +
        'attached to the notification emails. Please remove or reduce a document.'
    };
  }

  return { ok: true, files: files, message: '' };
}

/**
 * One staged file, verified. The containment check itself, applied to a single
 * ID; getUploadedFiles_ applies it to every ID it is given.
 * @private
 * @return {Object|null} { id, name, url, size, blob } or null.
 */
function getStagedFile_(fileId) {
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
    logLine_('REFUSED: file ' + fileId + ' is not in the configured staging folder.');
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

/**
 * The name a supporting document is stored under in Drive.
 *
 * THE APPLICANT'S OWN FILE NAME IS KEPT, and that is the point of this shape.
 * With one document per application the stored name could be entirely
 * generated, and it was. With up to five, a reviewer looking at a folder of
 * ANSIR_Application_Deep_Crustal_Survey_20260804_143000.pdf repeated five times
 * cannot tell the permit from the risk assessment without opening every one of
 * them. So the name is built from four parts, in decreasing order of how much
 * of the folder they organise:
 *
 *   ANSIR_Application_  provenance. This file was created by the intake, not
 *                       dropped into the folder by a person.
 *   <project title>_    groups the documents of one application together, and
 *                       is still meaningful in the flat staging folder where
 *                       documents from different applications sit side by side.
 *   <timestamp>_        yyyyMMdd_HHmmss, so a lexical sort is a chronological
 *                       sort, and so two applicants who upload files with the
 *                       same name cannot collide.
 *   <original name>     what the applicant called it. This is the part that
 *                       tells a reviewer which document they are looking at.
 *
 * Both variable parts are reduced to letters, digits and underscores and capped
 * in length. Drive tolerates far more than that, but a name that survives a
 * download onto any filesystem, an email attachment and a paste into a
 * spreadsheet is worth more than fidelity to the applicant's punctuation. The
 * extension is always .pdf, because the content has been proved to be a PDF.
 * @private
 */
function buildUploadFileName_(projectTitle, originalFileName) {
  // A STAGING name only. The reference number does not exist yet when a file
  // is uploaded, so the definitive name - "<reference> file_upload_<n>.pdf" -
  // is applied by moveStagedFiles_ when the file is filed into its
  // application folder. This name just has to be identifiable and orderly in
  // the staging folder in the meantime; the applicant's own filename is
  // deliberately not carried into it (they are often long, and the final
  // scheme does not use them).
  var stamp = Utilities.formatDate(new Date(), TIMEZONE, 'yyyyMMdd_HHmmss_SSS');
  return 'staged_' + stamp + '.pdf';
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
// Per-application filing
// ---------------------------------------------------------------------------
//
// THE SEQUENCING PROBLEM THIS SECTION EXISTS TO SOLVE
// ---------------------------------------------------
// The folder is named after the ANSIR reference. The reference is allocated at
// submission. The supporting document, though, is uploaded minutes earlier, by
// a separate saveUploadedFile call, when no reference exists yet and no folder
// could possibly be named. So UPLOAD_FOLDER_ID is a STAGING folder: uploads
// land there, and at submission, once the reference exists, the document is
// moved into the folder named after it and a PDF of the application is written
// alongside it.
//
// EVERY FUNCTION IN THIS SECTION FAILS QUIETLY AND CARRIES ON. By the time any
// of them runs, the application is already on the sheet and the applicant is
// waiting for a reference number. Filing is bookkeeping. It must never be the
// reason an application is lost, hidden or refused.

/** @private */
function isApplicationFolderConfigured_() {
  return !!APPLICATION_FOLDER_ID && APPLICATION_FOLDER_ID !== 'REPLACE_WITH_APPLICATION_FOLDER_ID';
}

/**
 * Creates the folder for one application, named after its ANSIR reference.
 *
 * Returns null, never throws, in all three of the ways this can not happen:
 * filing is unconfigured, the parent folder is unreachable, or the create
 * fails. The caller treats null as "no filing this time" and proceeds.
 * @private
 * @return {Folder|null}
 */
function createApplicationFolder_(ansirCode) {
  if (!isApplicationFolderConfigured_()) {
    logLine_('Folder filing is not configured: APPLICATION_FOLDER_ID is still the ' +
      'placeholder, so no folder was created for ' + ansirCode + '. The application ' +
      'is recorded and emailed as usual, and the supporting document stays in the ' +
      'staging folder. See gas/README.md to switch filing on.');
    return null;
  }
  try {
    var parent = DriveApp.getFolderById(APPLICATION_FOLDER_ID);
    var folder = parent.createFolder(ansirCode);
    logLine_('Created application folder ' + ansirCode + ' (' + folder.getId() + ').');
    return folder;
  } catch (err) {
    logError_('createApplicationFolder_', err);
    return null;
  }
}

/**
 * A folder's URL, or an empty string for a missing folder or an unreadable one.
 * @private
 */
function folderUrl_(folder) {
  if (!folder) {
    return '';
  }
  try {
    return folder.getUrl();
  } catch (err) {
    logError_('folderUrl_', err);
    return '';
  }
}

/**
 * Moves the staged supporting documents into the application's folder.
 *
 * Called only after getUploadedFiles_ has already proved every file was in the
 * staging folder. See the comment on getUploadedFiles_ for why that order is
 * not negotiable.
 *
 * EACH MOVE IS WRAPPED ON ITS OWN, so a document that cannot be moved cannot
 * stop the ones after it from being filed. If a move fails the document simply
 * stays in the staging folder. It is still attached to the emails, and its
 * entry in supporting_document_url still points at it, because a Drive URL is
 * built from the file ID and survives a move. The only loss is tidiness.
 * @private
 */
function moveStagedFiles_(fileInfos, folder, ansirCode) {
  var files = fileInfos || [];
  if (!files.length || !folder) {
    return;
  }
  for (var i = 0; i < files.length; i++) {
    var file = null;
    try {
      file = DriveApp.getFileById(files[i].id);
      file.moveTo(folder);
      logLine_('Moved supporting document ' + files[i].id + ' into ' + folder.getName() + '.');
    } catch (err) {
      logError_('moveStagedFiles_ (move, ' + files[i].id + ')', err);
      continue;
    }

    // Rename to the definitive scheme, in attachment order:
    //   "<reference> file_upload_1.pdf", "file_upload_2", ...
    // Wrapped separately: a failed rename must not undo a successful move.
    // On success the in-memory record is updated too, so the sheet row, the
    // emails and the application PDF all quote the name the file actually
    // has in Drive; on failure they keep quoting the staged name, which is
    // then still the real name. Never record a name the file does not have.
    try {
      var finalName = ansirCode + ' file_upload_' + (i + 1) + '.pdf';
      file.setName(finalName);
      files[i].name = finalName;
      if (files[i].blob && files[i].blob.setName) {
        files[i].blob.setName(finalName);
      }
      logLine_('Renamed ' + files[i].id + ' to "' + finalName + '".');
    } catch (renameErr) {
      logError_('moveStagedFiles_ (rename, ' + files[i].id + ')', renameErr);
    }
  }
}

/**
 * Writes the application PDF into the application's folder.
 * Does nothing, quietly, if either the folder or the PDF is missing.
 * @private
 */
function fileApplicationPdf_(folder, pdfBlob) {
  if (!folder || !pdfBlob) {
    return;
  }
  try {
    var file = folder.createFile(pdfBlob);
    logLine_('Filed application PDF ' + file.getName() + ' (' + file.getId() + ').');
  } catch (err) {
    logError_('fileApplicationPdf_', err);
  }
}

/**
 * Builds a PDF copy of the application.
 *
 * Named "<reference> Application.pdf", so a folder listing reads as the
 * reference twice over. Returns null rather than throwing if the conversion
 * fails: the emails then go out with whatever attachments do exist, which is
 * the supporting document, and the application is unaffected.
 * @private
 * @return {Blob|null}
 */
function buildApplicationPdf_(formData, ansirCode, fileInfos) {
  var name = ansirCode + ' Application.pdf';
  try {
    var html = applicationPdfHtml_(formData, ansirCode, fileInfos);
    var pdf = Utilities.newBlob(html, MimeType.HTML, name).getAs(MimeType.PDF);
    pdf.setName(name);
    return pdf;
  } catch (err) {
    logError_('buildApplicationPdf_', err);
    return null;
  }
}

/**
 * The HTML the PDF is rendered from: a heading block, then the application
 * transcript.
 *
 * THE CONTENT IS NOT WRITTEN HERE. It comes from applicationTranscript_, the
 * same function that builds the body of the applicant's copy and of the
 * internal notification, so the PDF and the two emails cannot disagree about
 * what was submitted. Everything in this function is presentation. If a section
 * needs to change, change applicationTranscript_ and all three change together.
 *
 * The transcript is laid out as fixed-width preformatted text on purpose. It is
 * already aligned as text, and re-parsing it into headings and paragraphs would
 * mean guessing at its structure from its punctuation, which would break the
 * moment a section was reworded.
 *
 * EVERY interpolated value goes through htmlEscape_. A project title containing
 * a less-than sign, an ampersand or a quote is ordinary research text, not an
 * attack, and it must render as itself rather than corrupt the document.
 * @private
 */
function applicationPdfHtml_(formData, ansirCode, fileInfos) {
  var css = [
    'body { font-family: Helvetica, Arial, sans-serif; color: #000000; margin: 36px; }',
    'h1 { font-size: 16pt; margin: 0 0 2px 0; }',
    'p.facility { font-size: 9pt; color: #444444; margin: 0 0 18px 0; }',
    'table.meta { border-collapse: collapse; font-size: 10pt; margin: 0 0 18px 0; }',
    'table.meta th { text-align: left; padding: 2px 18px 2px 0; vertical-align: top; }',
    'table.meta td { padding: 2px 0; vertical-align: top; }',
    'pre.transcript { font-family: Consolas, Monaco, monospace; font-size: 8.5pt; ',
    'white-space: pre-wrap; word-wrap: break-word; margin: 0; }'
  ].join('\n');

  var parts = [];
  parts.push('<html>');
  parts.push('<head>');
  parts.push('<meta charset="utf-8">');
  parts.push('<title>' + htmlEscape_(ansirCode) + ' Application</title>');
  parts.push('<style>' + css + '</style>');
  parts.push('</head>');
  parts.push('<body>');
  parts.push('<h1>ANSIR equipment loan application</h1>');
  parts.push('<p class="facility">ANSIR Research Facilities for Earth Sounding. ' +
    'An AuScope research facility funded under NCRIS.</p>');
  parts.push('<table class="meta">');
  parts.push(pdfMetaRow_('ANSIR reference', ansirCode));
  parts.push(pdfMetaRow_('Submitted', formatDateTime_(new Date())));
  parts.push(pdfMetaRow_('Project title', orNotProvided_(formData ? formData.title_primary : '')));
  // Every attached document is listed, one meta row each, so the first page of
  // the PDF says what came with the application without anyone scrolling to the
  // transcript.
  var documents = fileInfos || [];
  if (!documents.length) {
    parts.push(pdfMetaRow_('Supporting documents', 'None uploaded'));
  } else {
    for (var d = 0; d < documents.length; d++) {
      parts.push(pdfMetaRow_(
        'Supporting document ' + (d + 1) + ' of ' + documents.length,
        documents[d].name + ' (' + formatBytes_(documents[d].size) + ')'
      ));
    }
  }
  parts.push('</table>');
  parts.push('<pre class="transcript">');
  parts.push(htmlEscape_(applicationTranscript_(formData, ansirCode, fileInfos).join('\n')));
  parts.push('</pre>');
  parts.push('</body>');
  parts.push('</html>');
  return parts.join('\n');
}

/**
 * One label and value row of the PDF heading table.
 * @private
 */
function pdfMetaRow_(label, value) {
  return '<tr><th>' + htmlEscape_(label) + '</th><td>' + htmlEscape_(value) + '</td></tr>';
}

/**
 * Escapes a value for inclusion in HTML text or in a double-quoted attribute.
 *
 * The ampersand MUST be replaced first. Replacing it after the others would
 * re-escape the ampersands those replacements had just introduced, turning
 * &lt; into &amp;lt; and printing the entity rather than the character.
 *
 * This is not primarily an injection defence, although it is that too. It is
 * correctness: research titles contain ampersands, inequality signs and quotes,
 * and every one of them has to survive into the PDF as the character the
 * applicant typed.
 * @private
 */
function htmlEscape_(value) {
  var text = (value === null || value === undefined) ? '' : String(value);
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
 *   3. the same internal notification to the facility addresses matching
 *      the selected methods (FACILITY_ROUTES).
 *
 * All three carry the same attachments: the PDF copy of the application, and
 * EVERY supporting document the applicant uploaded. Any of them may be absent,
 * and the send goes ahead with whatever is present. An email with one
 * attachment is a smaller loss than no email at all.
 *
 * Attaching every document to all three messages is what MAX_UPLOAD_TOTAL_BYTES
 * exists to keep survivable: three messages, each carrying the application PDF
 * plus the whole document set, must stay under the roughly 25 MB Gmail will
 * accept. See the comment on that constant.
 *
 * Every send is individually wrapped, because a failed email must never lose an
 * application that has already been written to the sheet.
 * @private
 */
function sendNotifications_(formData, ansirCode, fileInfos, applicationPdf) {
  var sent = [];
  var files = fileInfos || [];
  var attachments = [];
  if (applicationPdf) {
    attachments.push(applicationPdf);
  }
  for (var f = 0; f < files.length; f++) {
    if (files[f] && files[f].blob) {
      attachments.push(files[f].blob);
    }
  }

  var applicantAddress = safeText_(formData.lead_email);
  try {
    sendMail_({
      to: applicantAddress,
      subject: 'ANSIR equipment loan application received - ' + ansirCode,
      body: buildApplicantEmail_(formData, ansirCode, files),
      name: MAIL_FROM_NAME,
      attachments: attachments
    });
    sent.push('applicant');
  } catch (err) {
    logError_('sendNotifications_ (applicant)', err);
  }

  var internalBody = buildInternalEmail_(formData, ansirCode, files);
  var internalSubject = 'New ANSIR equipment loan application - ' + ansirCode;

  if (ADMIN_EMAILS && ADMIN_EMAILS.length) {
    try {
      sendMail_({
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

  // Facility notifications route by the methods the applicant ticked (see
  // FACILITY_ROUTES at the top of this file). All routes are empty by design
  // until the facility addresses are confirmed - filling one in switches that
  // method's notifications on with no other change.
  var facilityRecipients = facilityRecipients_(formData);
  if (facilityRecipients.length) {
    try {
      sendMail_({
        to: facilityRecipients.join(','),
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
    logLine_('No facility addresses configured for the selected methods ' +
      '(FACILITY_ROUTES is empty by design). No facility notification was sent.');
  }

  return { sent: sent };
}

/**
 * The applicant's copy: acknowledgement, reference number, next steps, and a
 * full transcript of what was submitted.
 * @private
 */
function buildApplicantEmail_(formData, ansirCode, fileInfos) {
  var salutation = joinNonEmpty_(
    [formData.lead_title, formData.lead_given_name, formData.lead_family_name], ' '
  );

  var lines = [];
  lines.push('Dear ' + (salutation || 'Applicant') + ',');
  lines.push('');
  lines.push('Thank you for submitting an equipment loan application to ANSIR Research Facilities for Earth Sounding (ANSIR).');
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
  lines.push('ANSIR Research Facilities for Earth Sounding');
  lines.push('An AuScope research facility funded under NCRIS');
  lines.push('');

  return lines.concat(applicationTranscript_(formData, ansirCode, fileInfos)).join('\n');
}

/**
 * The internal notification sent to ADMIN_EMAILS and the routed facility addresses.
 * @private
 */
function buildInternalEmail_(formData, ansirCode, fileInfos) {
  var lines = [];
  lines.push('A new ANSIR equipment loan application has been submitted.');
  lines.push('');
  lines.push('ANSIR reference: ' + ansirCode);
  lines.push('Received: ' + formatDateTime_(new Date()));
  lines.push('Recorded in: ' + APPLICATIONS_SHEET_NAME + ' (the ANSIR project sheet)');
  lines.push('');
  lines.push('This application is NOT yet a project. It sits in the intake tab until it is');
  lines.push('reviewed and promoted. The promotion procedure is documented in docs/INTAKE.md.');
  lines.push('');

  return lines.concat(applicationTranscript_(formData, ansirCode, fileInfos)).join('\n');
}

/**
 * Everything the applicant submitted, in the order the form asks for it.
 *
 * THIS IS THE SINGLE SOURCE OF THE APPLICATION CONTENT. It is the body of the
 * applicant's copy, the body of the internal notification, and the body of the
 * filed PDF. Three readers, one text, so they cannot drift apart. It is
 * therefore written as plain text with no assumption about where it will be
 * displayed, and it must stay that way: applicationPdfHtml_ escapes it for HTML
 * rather than expecting any markup in it.
 * @private
 */
function applicationTranscript_(formData, ansirCode, fileInfos) {
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

  lines.push('SUPPORTING DOCUMENTS');
  lines.push('--------------------');
  var documents = fileInfos || [];
  if (documents.length) {
    var totalBytes = 0;
    for (var d = 0; d < documents.length; d++) {
      totalBytes += Number(documents[d].size) || 0;
      lines.push('  ' + (d + 1) + '. ' + documents[d].name +
        ' (' + formatBytes_(documents[d].size) + ')');
    }
    lines.push('');
    lines.push('Total: ' + documents.length + ' document' +
      (documents.length === 1 ? '' : 's') + ', ' + formatBytes_(totalBytes) + '.');
    lines.push('Status: received, attached to the ANSIR notification emails, and held in Drive.');
  } else {
    lines.push('No supporting documents were uploaded.');
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

/**
 * A byte count as something a person can read. Used in the transcript, in the
 * PDF heading and in the message that refuses an oversized document set, so
 * that all three quote a size the same way.
 * @private
 */
function formatBytes_(bytes) {
  var size = Number(bytes);
  if (!isFinite(size) || size <= 0) {
    return '0 KB';
  }
  if (size < 1024) {
    return size + ' bytes';
  }
  var kb = size / 1024;
  if (kb < 1024) {
    return kb.toFixed(1) + ' KB';
  }
  return (kb / 1024).toFixed(1) + ' MB';
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
