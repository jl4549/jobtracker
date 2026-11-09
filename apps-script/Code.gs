/**
 * Job Application Tracker for Gmail
 * ---------------------------------
 * Scans your Gmail for job-application emails (confirmations, rejections,
 * online assessments, interview invites) and keeps a Google Sheet up to date.
 *
 * Runs entirely inside your own Google account. Nothing leaves your account
 * unless you add an optional ANTHROPIC_API_KEY (then only the email subject +
 * first ~2,500 characters of a matched email are sent to Claude for extraction).
 *
 * Setup: Extensions > Apps Script in a new Google Sheet, paste this file,
 * run `setup` once, approve permissions. Done. See README.md.
 */

// ============================== CONFIG ==============================
const CONFIG = {
  SHEET_NAME: 'Applications',
  FIRST_RUN_LOOKBACK_DAYS: 180,   // how far back the first sync goes
  DAILY_HOUR: 7,                  // daily sync hour (your script time zone)
  MAX_THREADS_PER_QUERY: 200,     // Gmail search page cap per run
  SEND_DIGEST: true,              // email yourself when an OA / interview / offer appears
  CLAUDE_MODEL: 'claude-haiku-5-5', // used only if ANTHROPIC_API_KEY is set
  // Senders that are job ALERTS / newsletters, not applications.
  NOISE_SENDERS: [
    'jobright.ai', 'joinrunway.io', 'jobalerts-noreply@linkedin.com', 'jobs-listings@linkedin.com',
    'messages-noreply@linkedin.com', 'instructure.com', 'gradescope.com', 'substack.com',
    'coursera', 'glassdoor.com', 'indeed.com', 'ziprecruiter.com', 'wayup.com', 'handshake@g.joinhandshake.com'
  ],
};

const HEADERS = ['Company', 'Role', 'Status', 'Applied', 'Last Update', 'Next Step', 'Source', 'Email', 'Notes', 'Key'];
const STATUSES = ['Applied', 'Online assessment', 'Interview', 'Offer', 'Rejected', 'Closed', 'Withdrawn'];
// Higher rank = further along. Terminal states (Rejected/Closed/Withdrawn) can override Applied/OA/Interview.
const STATUS_RANK = { 'Applied': 1, 'Online assessment': 2, 'Interview': 3, 'Offer': 5, 'Rejected': 4, 'Closed': 4, 'Withdrawn': 6 };

// One broad Gmail query per signal. `{AFTER}` is replaced with the last-sync date.
const QUERIES = [
  '("thank you for applying" OR "thanks for applying" OR "received your application" OR "application has been received" OR "application was submitted" OR "application was sent" OR "application sent to" OR subject:application OR subject:applying) after:{AFTER}',
  '("unfortunately" OR "not to move forward" OR "not be moving forward" OR "other candidates" OR "other applicants" OR "position has been filled" OR "no longer available" OR "decided not to proceed") after:{AFTER}',
  '(assessment OR HackerRank OR CodeSignal OR HireVue OR Codility OR "online assessment" OR "virtual job tryout" OR "next step" OR "next steps" OR interview OR "phone screen" OR "schedule a call") after:{AFTER}',
  '(from:myworkday.com OR from:greenhouse-mail.io OR from:ashbyhq.com OR from:hire.lever.co OR from:workablemail.com OR from:smartrecruiters.com OR from:icims.com OR from:successfactors.eu OR from:ats.rippling.com OR from:avature.net OR from:mail.amazon.jobs OR from:careers.microsoft.com OR from:workatastartup@ycombinator.com) after:{AFTER}',
];

// ============================== ENTRY POINTS ==============================

/** Run once: builds the sheet, installs the daily trigger, does the first sync. */
function setup() {
  const sheet = getSheet_();
  formatSheet_(sheet);
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'syncApplications')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('syncApplications').timeBased().everyDays(1).atHour(CONFIG.DAILY_HOUR).create();
  syncApplications();
}

/** Daily job (also safe to run by hand from the menu). */
function syncApplications() {
  const props = PropertiesService.getScriptProperties();
  const lastSync = props.getProperty('LAST_SYNC');
  const after = lastSync
    ? new Date(Number(lastSync) - 2 * 864e5)            // 2-day overlap; duplicates are skipped
    : new Date(Date.now() - CONFIG.FIRST_RUN_LOOKBACK_DAYS * 864e5);
  const afterStr = Utilities.formatDate(after, 'UTC', 'yyyy/MM/dd');

  const sheet = getSheet_();
  const processed = loadProcessed_();
  const rows = readRows_(sheet);
  const changes = [];

  const seenThreads = {};
  const started = Date.now();
  let outOfTime = false;
  QUERIES.forEach(q => {
    if (outOfTime) return;
    const threads = GmailApp.search(q.replace('{AFTER}', afterStr), 0, CONFIG.MAX_THREADS_PER_QUERY);
    threads.forEach(th => {
      if (outOfTime || Date.now() - started > 4.5 * 60e3) { outOfTime = true; return; } // stay under the 6-min limit
      if (seenThreads[th.getId()]) return;
      seenThreads[th.getId()] = true;
      th.getMessages().forEach(msg => {
        const id = msg.getId();
        if (processed.has(id)) return;
        processed.add(id);
        const from = msg.getFrom();
        if (isNoise(from)) return;
        const email = {
          subject: msg.getSubject() || '',
          body: (msg.getPlainBody() || '').slice(0, 6000),
          from: from,
          date: msg.getDate(),
          link: 'https://mail.google.com/mail/u/0/#all/' + th.getId(),
        };
        const info = classifyWithOptionalLLM_(email);
        if (!info) return;
        const change = upsert_(rows, info, email);
        if (change) changes.push(change);
      });
    });
  });

  writeRows_(sheet, rows);
  saveProcessed_(processed);
  if (outOfTime) {
    Logger.log('Stopped early to avoid the time limit. Run syncApplications again to continue.');
  } else {
    props.setProperty('LAST_SYNC', String(Date.now()));
  }

  if (CONFIG.SEND_DIGEST) {
    const urgent = changes.filter(c => ['Online assessment', 'Interview', 'Offer'].includes(c.status));
    if (urgent.length) sendDigest_(urgent, changes.length);
  }
  Logger.log('Sync done: %s changes', changes.length);
}

/** Adds a "Job Tracker" menu to the sheet. */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Job Tracker')
    .addItem('Update from Gmail now', 'syncApplications')
    .addItem('Re-run setup (reformat + trigger)', 'setup')
    .addToUi();
}

// ============================== CLASSIFIER (pure, testable) ==============================

function isNoise(from) {
  const f = String(from || '').toLowerCase();
  return CONFIG.NOISE_SENDERS.some(n => f.includes(n));
}

const RX = {
  rejected: /(unfortunately|regret to inform|not (to )?(be )?mov(e|ing) forward|decided (not )?to (pursue|proceed with|move forward with) other|other (candidates|applicants)|not (been )?selected|will not be (able to )?(process|proceed)|did not select you|decided to move forward with other)/i,
  closed: /(position|role|job|requisition) (has (now )?been|is now|was) (filled|closed|cancel+ed)|no longer (available|accepting)|closed out your application|change(d)? the scope of this role/i,
  assessment: /(online assessment|complete (the|an|your|our) (online )?assessment|virtual job tryout|hackerrank|codesignal|codility|hirevue|sova|heymilo|coding challenge|take-home|complete the following (test|exercise))/i,
  interview: /(invite you to (an? )?(interview|phone screen|call|conversation)|schedule (an? |your )?(interview|phone screen|call|time)|recruiter screen(ing)?|phone screen|first[- ]round|next round|interview (invitation|availability)|would love to (chat|connect|speak))/i,
  offer: /(pleased to (extend|offer)|offer letter|congratulations[^.]{0,60}offer)/i,
  applied: /(thank(s| you) for (applying|your application|submitting)|received your application|application (has been|was) (received|submitted|sent)|your application (to|for)|application sent to|you('| ha)ve (officially )?applied|successfully submitted)/i,
};

/**
 * Rule-based classification. Returns {status, company, role, nextStep} or null.
 * Order matters: rejection/closure language beats "thank you for applying".
 */
function classifyEmail(email) {
  const text = (email.subject + '\n' + email.body).replace(/\s+/g, ' ');
  let status = null;
  if (RX.offer.test(text)) status = 'Offer';
  else if (RX.rejected.test(text)) status = 'Rejected';
  else if (RX.closed.test(text)) status = 'Closed';
  else if (RX.assessment.test(text)) status = 'Online assessment';
  else if (RX.interview.test(text)) status = 'Interview';
  else if (RX.applied.test(text)) status = 'Applied';
  if (!status) return null;
  return {
    status: status,
    company: extractCompany(email),
    role: extractRole(text),
    nextStep: status === 'Online assessment' || status === 'Interview' ? extractDeadline(text) : '',
  };
}

function sentences_(text) {
  return String(text).split(/(?<=[.!?])\s+|\n+/).map(x => x.trim()).filter(Boolean);
}

function extractRole(text) {
  const pats = [
    /application (?:for|to) (?:the |our )?(?:position of )?["“]?([A-Z][^"”.\n]{2,90}?)["”]? (?:position|role|opening|job|opportunity)\b/i,
    /(?:for|to) the ["“]?([A-Z][^"”.\n]{2,90}?)["”]? (?:position|role|opening)\b/,
    /applying (?:for|to) (?:the |our )?["“]?([A-Z][^"”.\n]{2,90}?)["”]?(?: position| role| job| opportunity)?(?: at |[.!,])/,
    /interest in (?:the |our )?(?:position of )?["“]?([A-Z][^"”.\n]{2,90}?)["”]?,? (?:\d{5,} )?(?:position|role|at)\b/,
    /application for (?:the )?["“]?([A-Z][^"”.\n]{2,90}?)["”]? (?:at|with)\b/,
  ];
  const sents = sentences_(text);
  for (const p of pats) {
    for (let snt of sents) {
      let m = snt.match(p);
      while (m && /\b(thank|hi|dear|hello|interest)\b/i.test(m[1])) { snt = snt.slice(m.index + 1); m = snt.match(p); }
      if (m)
        return m[1].replace(/\s*\((ID|Job|Req)[^)]*\)\s*$/i, '').replace(/,?\s*[-–]?\s*\(?(ID:?\s*)?[A-Z]*\d{5,}\)?\s*$/, '').trim();
    }
  }
  return '';
}

const ATS_DOMAINS = /(myworkday|greenhouse-mail|greenhouse|ashbyhq|lever\.co|workablemail|workable|smartrecruiters|successfactors|icims|rippling|avature|jobvite|taleo|oraclecloud|eightfold|ycombinator|linkedin|joinhandshake|gmail|outlook|yahoo|hotmail)/i;

function extractCompany(email) {
  const sents = sentences_(email.subject + '\n' + email.body.slice(0, 1200));
  const stop = "(?:'s|’s|[!.,:;]| for | -| and |$)";
  const pats = [
    new RegExp("(?:applying|applied|application|apply) (?:to|at|with) ([A-Z][A-Za-z0-9&.' -]{1,40}?)" + stop),
    new RegExp("interest in (?:joining |working at |working with )?([A-Z][A-Za-z0-9&.' -]{1,40}?)" + stop),
    new RegExp("(?:team|careers|recruiting|opportunities) (?:at|with|within) ([A-Z][A-Za-z0-9&.' -]{1,40}?)" + stop),
    new RegExp("(?:position|role) at ([A-Z][A-Za-z0-9&.' -]{1,40}?)" + stop),
    /^([A-Z][A-Za-z0-9&.' ]{1,30}) \| /,
  ];
  for (const p of pats) for (const snt of sents) {
    const m = snt.match(p);
    if (m && !/^(the|our|this|a|an|your|us|you|it)\b/i.test(m[1]) && !/^(Hi|Dear|Hello)\b/.test(m[1])) return m[1].trim();
  }
  const from = String(email.from);
  const addr = (from.match(/<([^>]+)>/) || [null, from])[1].trim().toLowerCase();
  const local = addr.split('@')[0], dom = addr.split('@')[1] || '';
  const cap = w => w ? w.charAt(0).toUpperCase() + w.slice(1) : '';
  if (/myworkday\.com$/.test(dom) && !/^(no-?reply|donotreply|ghr|hr)$/.test(local)) return cap(local.replace(/[^a-z0-9]+.*/, ''));
  const disp = from.replace(/<.*>/, '').replace(/["']/g, '').trim();
  const cleanDisp = disp.replace(/\b(careers?|recruiting|recruitment|talent( acquisition| team)?|hiring( team)?|no-?reply|notifications?|workday|people services|hr|team|jobs|global)\b/gi, '').replace(/[|@-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (dom && !ATS_DOMAINS.test(dom)) {
    const base = dom.replace(/^(mail|email|e|careers|jobs|recruiting|recruitment|hire|us|eu|talent)\./, '').split('.')[0];
    return cap(base);
  }
  if (cleanDisp && !ATS_DOMAINS.test(cleanDisp)) return cleanDisp;
  return '';
}

function extractDeadline(text) {
  const m = text.match(/(?:by|before|due|deadline[: ]|within|in the next)\s+([A-Z][a-z]+ \d{1,2}(?:st|nd|rd|th)?,? ?\d{0,4}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d+ (?:days?|hours?|week))/i);
  return m ? 'Due ' + m[1].trim() : 'Check email for details';
}

/** Normalized key so "Product Manager Intern" at "Acme, Inc." matches later emails. */
function makeKey(company, role) {
  const norm = s => String(s || '').toLowerCase().replace(/\b(inc|llc|ltd|corp|corporation|co)\b\.?/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  return norm(company) + '|' + norm(role);
}

/** Should a new status replace the current one? Never go backwards (except to terminal states). */
function shouldUpdate(current, next) {
  if (!current) return true;
  if (current === next) return false;
  if (current === 'Offer' || current === 'Withdrawn') return false;
  return (STATUS_RANK[next] || 0) > (STATUS_RANK[current] || 0) ||
         (['Rejected', 'Closed'].includes(next) && current !== 'Rejected' && current !== 'Closed');
}

// ============================== OPTIONAL: Claude extraction ==============================

function classifyWithOptionalLLM_(email) {
  const rule = classifyEmail(email);
  if (!rule) return null;
  const key = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!key) return rule;
  try {
    const prompt = 'Extract job-application info from this email. Reply with ONLY JSON: ' +
      '{"is_job_application_email": bool, "company": str, "role": str, ' +
      '"status": one of ["Applied","Online assessment","Interview","Offer","Rejected","Closed"], "next_step": str}. ' +
      'Use "" when unknown. Read the whole body: "thank you for your interest" emails are often rejections.\n\n' +
      'FROM: ' + email.from + '\nSUBJECT: ' + email.subject + '\nBODY:\n' + email.body.slice(0, 2500);
    const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      payload: JSON.stringify({ model: CONFIG.CLAUDE_MODEL, max_tokens: 300, messages: [{ role: 'user', content: prompt }] }),
    });
    if (res.getResponseCode() !== 200) return rule;
    const txt = JSON.parse(res.getContentText()).content[0].text;
    const j = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
    if (!j.is_job_application_email) return null;
    return {
      status: STATUSES.includes(j.status) ? j.status : rule.status,
      company: j.company || rule.company,
      role: j.role || rule.role,
      nextStep: j.next_step || rule.nextStep,
    };
  } catch (e) {
    return rule;
  }
}

// ============================== SHEET I/O ==============================

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sh) sh = ss.insertSheet(CONFIG.SHEET_NAME);
  if (sh.getLastRow() === 0) sh.appendRow(HEADERS);
  return sh;
}

function formatSheet_(sh) {
  sh.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold').setBackground('#1b1b1f').setFontColor('#ffffff');
  sh.setFrozenRows(1);
  sh.hideColumns(HEADERS.indexOf('Key') + 1);
  [180, 280, 140, 100, 100, 220, 140, 70, 260].forEach((w, i) => sh.setColumnWidth(i + 1, w));
  const statusCol = HEADERS.indexOf('Status') + 1;
  const rng = sh.getRange(2, statusCol, 1000, 1);
  rng.setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(STATUSES, true).build());
  const colors = {
    'Applied': ['#f1f2f4', '#4b5563'], 'Online assessment': ['#fff4e0', '#b45309'], 'Interview': ['#e3f6ec', '#0f7b4f'],
    'Offer': ['#f1eaff', '#6d28d9'], 'Rejected': ['#fdeceb', '#b42318'], 'Closed': ['#efefef', '#7a7a80'], 'Withdrawn': ['#efefef', '#7a7a80'],
  };
  const rules = Object.keys(colors).map(s => SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo(s).setBackground(colors[s][0]).setFontColor(colors[s][1]).setRanges([rng]).build());
  sh.setConditionalFormatRules(rules);
  if (!sh.getFilter()) sh.getRange(1, 1, Math.max(sh.getLastRow(), 2), HEADERS.length).createFilter();
}

function readRows_(sh) {
  const n = sh.getLastRow() - 1;
  if (n <= 0) return [];
  return sh.getRange(2, 1, n, HEADERS.length).getValues().map(r => {
    const o = {}; HEADERS.forEach((h, i) => o[h] = r[i]); return o;
  });
}

function writeRows_(sh, rows) {
  if (!rows.length) return;
  rows.sort((a, b) => new Date(b['Last Update'] || 0) - new Date(a['Last Update'] || 0));
  const values = rows.map(o => HEADERS.map(h => o[h] === undefined ? '' : o[h]));
  sh.getRange(2, 1, values.length, HEADERS.length).setValues(values);
  sh.getRange(2, HEADERS.indexOf('Applied') + 1, values.length, 2).setNumberFormat('yyyy-mm-dd');
}

/** Insert or update a row. Returns a change record or null. */
function upsert_(rows, info, email) {
  const key = makeKey(info.company, info.role);
  // Match on full key first; fall back to company-only when the email has no role.
  let row = rows.find(r => r.Key === key) ||
            (!info.role ? rows.find(r => makeKey(r.Company, '') === makeKey(info.company, '') && !['Rejected', 'Closed', 'Offer', 'Withdrawn'].includes(r.Status)) : null);
  const dateOnly = new Date(email.date.getFullYear(), email.date.getMonth(), email.date.getDate());
  if (!row) {
    row = {
      Company: info.company || '(unknown)', Role: info.role || '(role not in email)', Status: info.status,
      Applied: info.status === 'Applied' ? dateOnly : '', 'Last Update': dateOnly, 'Next Step': info.nextStep || '',
      Source: (String(email.from).match(/@([a-z0-9.-]+)/i) || [])[1] || '', Email: email.link, Notes: '', Key: key,
    };
    rows.push(row);
    return { status: info.status, company: row.Company, role: row.Role, link: email.link, isNew: true };
  }
  if (!shouldUpdate(row.Status, info.status)) return null;
  row.Status = info.status;
  row['Last Update'] = dateOnly;
  if (info.nextStep) row['Next Step'] = info.nextStep;
  else if (['Rejected', 'Closed'].includes(info.status)) row['Next Step'] = '';
  row.Email = email.link;
  return { status: info.status, company: row.Company, role: row.Role, link: email.link, isNew: false };
}

// Processed message IDs live in a hidden sheet (Script Properties are too small for hundreds of IDs).
function loadProcessed_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName('_processed');
  if (!sh) { sh = ss.insertSheet('_processed'); sh.hideSheet(); }
  const n = sh.getLastRow();
  return new Set(n ? sh.getRange(1, 1, n, 1).getValues().map(r => String(r[0])) : []);
}
function saveProcessed_(set) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('_processed');
  const ids = Array.from(set).slice(-20000).map(id => [id]);
  sh.clear();
  if (ids.length) sh.getRange(1, 1, ids.length, 1).setValues(ids);
}

function sendDigest_(urgent, total) {
  const url = SpreadsheetApp.getActiveSpreadsheet().getUrl();
  const lines = urgent.map(c => `• ${c.status}: ${c.company} — ${c.role}\n  ${c.link}`).join('\n');
  MailApp.sendEmail(Session.getActiveUser().getEmail(),
    `Job Tracker: ${urgent.length} item(s) need action`,
    `New since last sync (${total} total changes):\n\n${lines}\n\nTracker: ${url}`);
}

// Allow `require()` in Node tests; ignored by Apps Script.
if (typeof module !== 'undefined') {
  module.exports = { classifyEmail, extractRole, extractCompany, extractDeadline, makeKey, shouldUpdate, isNoise };
}
