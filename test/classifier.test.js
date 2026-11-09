const assert = require('assert');
const C = require('./code.js');
const d = new Date('2026-11-01');
const cases = [
  // [from, subject, body, expectedStatus, expectedCompanyContains, expectedRoleContains]
  ['Tesla <noreply@tesla.com>', 'Thank you – we’ve received your Tesla application', 'Hello Alex, Thank you for submitting your application for the Internship, Product Management, Megapack Services (Winter/Spring 2027), 287443 position. We will be reviewing your qualifications shortly.', 'Applied', 'Tesla', 'Internship, Product Management'],
  ['no-reply@us.greenhouse-mail.io', 'Information about your application to Appian', 'Hi Alex, Thank you for your interest in the Product Manager Intern role at Appian! The hiring team has reviewed your resume and unfortunately your application wasn\'t selected for the next round.', 'Rejected', 'Appian', 'Product Manager Intern'],
  ['Microsoft <careers@email.careers.microsoft.com>', 'Thank you for your interest in Microsoft', 'Hi Alex, Thank you for your interest in the position of Product Manager II, 200046809 at Microsoft. After careful consideration, we’ve decided not to move forward with your candidacy at this time.', 'Rejected', 'Microsoft', 'Product Manager II'],
  ['noreply@mail.amazon.jobs', 'Action Required for your Amazon MBA Application — Complete Assessment', 'Hi Alex, Thank you for your interest in Amazon! The next step of the application process is the online assessment. Please complete this online assessment in the next week.', 'Online assessment', 'Amazon', ''],
  ['MasterCard People Services <mastercard@myworkday.com>', 'An update on your application for Associate Product Specialist, Product Management at Mastercard', 'Thank you for applying to the Associate Product Specialist, Product Management position and considering Mastercard. We wanted to inform you that this role has now been filled.', 'Closed', 'Mastercard', 'Associate Product Specialist'],
  ['careers.us@alphasights.com', 'Your AlphaSights Application', 'Thank you for applying to AlphaSights. You should have received an invitation to complete our HeyMilo and SOVA exercises. We did not receive all completed exercises in the given time frame. Therefore, we assume you are no longer interested and have closed out your application.', 'Closed', 'AlphaSights', ''],
  ['Nina R <recruiter@mercedes-benz.com>', 'Recruiter Screen - AI Program Manager Intern', 'Hello, We are excited to invite you to an initial recruiter screening for the Internship position. Please confirm receipt of this interview calendar notice.', 'Interview', '', ''],
  ['DoorDash <no-reply@doordash.com>', 'Thank you for applying to DoorDash', 'Hi Alex, Thank you for applying to DoorDash\'s Associate, New Verticals - Fulfillment Strategy & Operations position! We\'ve received your application.', 'Applied', 'DoorDash', ''],
  ['Jobright Job Alert <noreply@jobright.ai>', 'Amazon just posted a 87% match role', 'Apply now', null, '', ''],
  ['SAP Careers <system@successfactors.eu>', 'Your Application for SAP iXp Intern - Product Management 458160', 'Dear Alex, Thank you for applying for a new career opportunity within SAP. After carefully reviewing your application, we regret to inform you that we have chosen to pursue other applicants.', 'Rejected', 'SAP', ''],
];
let pass=0, fail=0;
for (const [from, subject, body, st, co, role] of cases) {
  const noise = C.isNoise(from);
  const r = noise ? null : C.classifyEmail({from, subject, body, date: d});
  const got = r ? r.status : null;
  const ok = got === st && (!co || (r && r.company.toLowerCase().includes(co.toLowerCase()))) && (!role || (r && r.role.includes(role)));
  console.log(ok ? '✓' : '✗', String(got).padEnd(18), '|', r ? (r.company + ' | ' + r.role + (r.nextStep ? ' | ' + r.nextStep : '')) : '(skipped)', ok ? '' : `  <-- expected ${st} / ${co} / ${role}`);
  ok ? pass++ : fail++;
}
// status ordering
assert.strictEqual(C.shouldUpdate('Applied','Rejected'), true);
assert.strictEqual(C.shouldUpdate('Interview','Applied'), false);
assert.strictEqual(C.shouldUpdate('Online assessment','Interview'), true);
assert.strictEqual(C.shouldUpdate('Rejected','Applied'), false);
assert.strictEqual(C.shouldUpdate('Offer','Rejected'), false);
assert.strictEqual(C.makeKey('Acme, Inc.','PM Intern'), C.makeKey('acme','PM  intern'));
console.log(`\n${pass}/${pass+fail} classification cases passed; status-order asserts OK`);
