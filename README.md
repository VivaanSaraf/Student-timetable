# Bellhop

## Online deployment

The public site is https://bellhop1.netlify.app. Netlify builds only the public
assets into `dist/` and proxies `/api/` to the free Docker web service at
https://bellhop-bh03.onrender.com. The free Render instance may take about a
minute to wake after inactivity. Render's `DATABASE_URL` points to the persistent
Netlify Postgres database; the database password is kept in private environment
variables. The Docker image includes Poppler for PDF imports.

Render configuration: Docker runtime, free compute, health path `/health`,
`DATABASE_URL` (private) and
`BELLHOP_ALLOWED_ORIGINS=https://bellhop1.netlify.app`. Do not use a local
database file for the hosted service: free Render disks do not preserve data.

`migrate_to_postgres.py` accepts the database URL on stdin to copy local accounts
and classes without copying sessions or replacing an existing account with a
different password. Keep database URLs and data files out of Git.

## Run locally

Create a Python virtual environment, install `requirements.txt`, then run
`python server.py` from this folder and open `http://localhost:8123/index.html`.
PDF imports need Poppler (`pdftotext`); screenshot imports also need Tesseract
with English language data. The hosted Docker image installs both.

The server keeps accounts and timetables in `data/bellhop.sqlite3`. Browsers on
this computer share that database when they use this server. Keep the `data`
folder if you move the site to a new computer; it contains the saved accounts
and schedules. The data folder is excluded from Git.

If you created an account before the server was added, open the site at the same
address you originally used (`localhost` or `127.0.0.1`) **in that original
browser** and log in once. Bellhop will transfer that account and its timetable
to the database. Then log in normally from another browser. If the original
browser data was cleared, the old account and timetable cannot be recovered
from the static site.

This development server listens on this computer only. Access from another
device requires hosting the site and database on a server with HTTPS.

## Add repeating classes

Classes in the Weekly view repeat every week. In the 10-day cycle view, they
repeat each cycle. Choose a day and time, then open **Repeat on more days** to
save the same subject, room and time on other days at once.

A pop-up shows any existing class that overlaps the chosen time. Change the
time or day before saving. Classes can start exactly when the previous one ends.
If one day in a group clashes, none of that group is saved. PDF imports also
check for clashes and continue to skip exact duplicates.

**Home** keeps your session signed in; choose **Your Timetable** to return.
**Log out** ends the session.

## Import a 10-day timetable from a PDF or screenshot

Log in, choose **Import**, and upload a PDF, PNG or JPG (up to 5 MB).
Screenshots are read with OCR on the Bellhop server and are not saved. Include
the day labels and class times, and crop unrelated content. Small or blurry
text may be misread, so check the preview carefully. Edit or remove
any row and add missing ones before importing. Set the date that was **Day 1**
on the calendar; the cycle advances on weekdays and repeats after Day 10.
School holidays are not known automatically, so update the Day 1 date after a
break if your school pauses the cycle. Weekly classes remain saved and appear
on their actual weekdays. Importing the same classes again skips duplicates.

The calendar fills the screen without a sidebar. **Week** shows Monday–Friday,
labelling each column with its weekday, date and month. **10-day cycle** labels each column Day 1–10,
with the matching date, month and weekday. Classes appear at their actual times.
Use **Today** or the arrows to move between weeks or cycles; **Calendar settings**
also lets you jump to a date and update Day 1. Imported classes follow the Day 1
anchor, skipping weekends, even when Day 1 is midweek. With a Monday Day 1,
Days 1–5 form the first school week and Days 6–10 the second.

**Create** opens the repeating-class form. Click an empty time to prefill a new
class, or an existing class to see its date, time, room and recurrence. Search
filters subjects and rooms in the displayed calendar. **Next up** follows the
current date regardless of which week you are browsing. **Clear all classes**
in Calendar settings removes all weekly and cycle classes after confirmation.

On phones, both schedule types show one dated day at a time. Use the day arrows
or swipe horizontally to move between school days. Both views skip weekends;
Today returns to the current day (or the next school day on a weekend).

The importer reads selectable text in a PDF and recognizes common layouts with
Day 1–10 headings and time ranges. Scanned PDFs need OCR first. The uploaded
file is read for the preview and is not saved to disk.
