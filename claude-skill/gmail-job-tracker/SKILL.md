---
name: gmail-job-tracker
description: Build, refresh or update a live job-application tracker page from the user's Gmail (applications, rejections, online assessments, interviews, offers), with KPIs, filters, JD links and a refresh button. Use when asked to make a job tracker, track applications, or update the tracker.
---

# Gmail job-application tracker

The end result is a private artifact page that is a copy of `assets/tracker.html`. It has KPI cards, a pipeline bar, a weekly chart, status chips, header filters, inline editing, a JD column, paste-a-JD auto-fill, and a "↻ Update from Gmail" button. The data lives in the page's database and is refreshed daily by a scheduled task.

**Needs:** a Gmail connector, the Artifact tools (`mcp__claude-artifacts__*`), and scheduled tasks. If Gmail is missing, ask the user to connect it first.

```
First run:  scan Gmail → publish page → write rows → create daily task → wire button
Later runs: (daily task or the button) scan since lastRun → upsert rows → stamp meta/status
```

## First run

### 1. Ask two things, briefly
- How far back should the scan go? Default: Aug 1 of this recruiting season, or 180 days.
- Which Gmail address? It goes into the page's "find in Gmail" links.

### 2. Scan Gmail
Run every query below for the window and take the union of the threads.
```
("thank you for applying" OR "thanks for applying" OR "received your application" OR "application was submitted" OR "application has been received" OR subject:application) after:YYYY/MM/DD
("unfortunately" OR "not to move forward" OR "other candidates" OR "other applicants" OR "position has been filled" OR "no longer available") after:YYYY/MM/DD
(assessment OR HackerRank OR CodeSignal OR HireVue OR Codility OR "online assessment" OR interview OR "phone screen" OR "next steps") after:YYYY/MM/DD
(from:myworkday.com OR from:greenhouse-mail.io OR from:ashbyhq.com OR from:hire.lever.co OR from:smartrecruiters.com OR from:icims.com OR from:successfactors.eu OR from:avature.net OR from:workablemail.com OR from:ats.rippling.com) after:YYYY/MM/DD
```

**Skip noise:** job alerts and newsletters (Jobright, LinkedIn job alerts, Glassdoor, Indeed, Handshake digests), and course tools.

**Check the total.** If it looks low compared with what the user expects, re-scan by ATS sender domains and by `subject:application` over the full window.

### 3. Read every thread in full before classifying — never infer from the preview
Open each thread as plain text. Previews mislead: "We'd like to invite you…" can end "…to apply to other roles".

| Status | Signal |
|---|---|
| Applied | receipt confirmation |
| Invited to apply | recruiter or company invites them to apply |
| Online assessment | assessment link or invite; put the deadline in `next` |
| Next step | non-interview next step (form, availability, video intro) |
| Interview / Final round | scheduling, an invite, or a recruiter screen |
| Offer | offer |
| Rejected | "not moving forward", "other candidates" |
| Closed | role filled or cancelled; application closed for an incomplete step |

**Status rules:**
- Status only moves forward.
- Rejected and Closed override the earlier stages.
- If an assessment or deadline has already passed, say so in `notes`. Never claim an assessment is still open unless the email shows it.

### 4. Build the rows
Each row is one document in the collection `apps`. The doc id is `a001`, `a002`, … Fields:

| Field | Value |
|---|---|
| `company`, `role` | Role as written in the email, or `"(role not in email)"` |
| `jd` | Posting URL if the email has one, else `""`. Known patterns: Amazon `https://www.amazon.jobs/en/jobs/<ID>`; Workday links in the email |
| `type` | `Internship` \| `Full-time` \| `Program` |
| `track` | `PM/TPM` \| `Strategy/Ops` \| `Data/BA` \| `FDE/Solutions` \| `Design/Marketing` \| `Engineering` \| `Other` |
| `applied`, `updated` | `YYYY-MM-DD` |
| `status` | one of the statuses above |
| `next`, `notes` | short text |
| `source` | ATS or channel, e.g. `Workday`, `Greenhouse`, `LinkedIn` |
| `starred` | `false` |

**Dedupe:** use normalized company + role.

### 5. Publish the page
1. Copy `assets/tracker.html` into the working directory and fill in the placeholders:
   - `__SUBTITLE__`: e.g. "Fall 2026 recruiting · PM · Data".
   - `__GMAIL__`: their address.
   - `__TRIGGER_ID__`: leave it for now; it is filled in step 7.
2. Read the artifact guide (`mcp__claude-artifacts__guide`, topic `pages`), then call `describe_capabilities`.
3. Publish with `publish_files` and title "Job Application Tracker".
4. Declare these capabilities with `declare_capabilities`:
   - **db** with collection `apps` and doc `meta/status`. Rules: owner can read and interact; writes by the owner or admin.
   - **user**
   - **mcp**, allowing the "Claude Code Remote" server's `fire_trigger` tool. This powers the refresh button.
   - **sample**. This powers JD auto-fill.

### 6. Write the data
- Use `db_write` for each row in `apps`.
- Then write `meta/status` = `{lastRun: <ISO now>, summary: "<N> apps · first scan"}`.

### 7. Daily task and refresh button
1. Create a scheduled task: daily around 7–8am in the user's time zone, push notifications on. Its prompt must be self-contained:
   - the artifact slug;
   - the "Later runs" procedure below;
   - "never infer a status from a preview";
   - "don't duplicate rows whose source is 'Added from JD'";
   - "only message me if something changed or something is due within 7 days".
2. Put the task's trigger id into `__TRIGGER_ID__` and republish the page.

### 8. Report
Give the user the totals by status, and flag ⏰ any OA or interview due within 7 days. If an OA was missed, offer to draft a polite email asking to reopen it.

## Later runs (daily task, the ↻ button, or "update my tracker")
1. Read `meta/status.lastRun`. Scan from lastRun minus 2 days using the queries in step 2.
2. Read each new thread in full, then upsert into `apps`.
   - Match on company + role. If the email has no role, fall back to company alone.
   - Never overwrite fields the user edited by hand (`notes`, `starred`, `jd`, manual `role`) unless a newer email changes the status.
3. Stamp `meta/status` = `{lastRun, summary: "<N> apps · <k> changes"}`. The page notices this, and the button returns to idle.
