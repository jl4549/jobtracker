---
name: gmail-job-tracker
description: Build or update a job-application tracker from the user's Gmail (applications, rejections, online assessments, interviews, offers). Use when asked to track job applications, update the job tracker, or check application status from email.
---

# Gmail job-application tracker

Needs a Gmail connector (search threads + read thread). Output goes to wherever the user keeps the tracker: a Sheets/table artifact, a CSV/XLSX file, or a Google Sheet.

## 1. Decide the window
- First run: ask how far back (default 180 days). Later runs: from the last sync date minus 2 days (overlap; dedupe by message ID).
- Store `lastRun` + a one-line summary next to the tracker so the next run knows where to start.

## 2. Search Gmail (run each query, union the threads)
```
("thank you for applying" OR "received your application" OR "application was submitted" OR subject:application) after:YYYY/MM/DD
("unfortunately" OR "not to move forward" OR "other candidates" OR "position has been filled" OR "no longer available") after:YYYY/MM/DD
(assessment OR HackerRank OR CodeSignal OR HireVue OR Codility OR "online assessment" OR interview OR "phone screen") after:YYYY/MM/DD
(from:myworkday.com OR from:greenhouse-mail.io OR from:ashbyhq.com OR from:hire.lever.co OR from:smartrecruiters.com OR from:icims.com OR from:successfactors.eu OR from:avature.net) after:YYYY/MM/DD
```
If the user believes applications are missing, re-scan by ATS sender domains and by "application" in the subject over the full window.

Skip job alerts and newsletters (Jobright, LinkedIn job alerts, Glassdoor, Indeed, Handshake digests, course tools).

## 3. Read before you classify — never infer from a preview
Open each candidate thread in full (plain text). Snippets are wrong surprisingly often: "we'd like to invite you…" can end in "…to apply for other roles". Classify on the full body:

| Status | Signal |
|---|---|
| Applied | confirmation of receipt |
| Online assessment | link/invite to an assessment; capture the deadline |
| Interview | scheduling / invite / recruiter screen |
| Offer | offer letter / verbal offer |
| Rejected | "not moving forward", "other candidates" |
| Closed | role filled/cancelled, or application closed for an incomplete step |

Status only moves forward (Applied < OA < Interview < Offer); Rejected/Closed override earlier stages.

## 4. Fields per row
Company · Role · Type (intern / full-time) · Applied date · Status · Last update · Next step (+ deadline) · JD link (from the email, or the company's careers URL pattern) · Source (Gmail thread link) · Notes · Starred.

Dedupe on normalized company + role. Never overwrite a field the user edited by hand (keep their notes, stars, manual status) unless a newer email clearly changes the status; never duplicate rows the user added manually.

## 5. Report
After each run, tell the user only what changed: new applications, status changes, and any OA/interview with a deadline in the next 7 days (flag ⏰). If an OA was missed or expired, say so plainly and offer to draft a polite follow-up email.

## Scheduling
To run daily, create a scheduled task whose prompt repeats steps 1–5 against the same tracker and stamps `lastRun`.
