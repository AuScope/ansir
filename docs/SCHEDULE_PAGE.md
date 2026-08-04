# Schedule page

How `schedule/index.html` turns the committed JSON into the public instrument
availability page, and how that page is embedded in the ANSIR website.

- Data: [`SCHEDULE_DATA.md`](SCHEDULE_DATA.md) covers the ANSIR project sheet
  layout contract and the build step that produces the JSON.
- Page: this document.

The page holds **no fleet data of its own**. Every number, name and date on
screen comes from one of three committed JSON files:

| File | What it supplies | Required? |
| --- | --- | --- |
| `data/schedule.json` | the seismic fleet: every category, instrument, allocation, experiment and rapid response entry | yes - without it the error panel shows |
| `data/data.json` | the research project register: which projects use magnetotellurics, what they have committed, and their dates | no - the MT accordion and the MT timeline rows are omitted |
| `data/instrument-register.json` | the MT fleet: how many of each model AuScope holds, from the published PIDINST records | no - the MT accordion is omitted |

---

## Contents

1. [What the page answers, in order](#what-the-page-answers-in-order)
2. [How it is put together](#how-it-is-put-together)
3. [How the headline figures are derived](#how-the-headline-figures-are-derived)
4. [Magnetotellurics](#magnetotellurics)
5. [The timeline](#the-timeline)
6. [Defensive rendering](#defensive-rendering)
7. [Iframe embedding](#iframe-embedding)
8. [What the page assumes about the JSON](#what-the-page-assumes-about-the-json)
9. [Verifying a change](#verifying-a-change)

---

## What the page answers, in order

The section order is the order a prospective applicant asks the questions.

| Section | The question it answers |
| --- | --- |
| Header currency strip | How old is this? Where does it come from? |
| Availability at a glance | How much is free right now? |
| Availability by instrument type | How many of *the thing I need* are free? Four accordions: three built from the project sheet, plus Magnetotellurics. |
| Deployment timeline | When does it come free, and what is it competing with? |
| Rapid response deployments | Can ANSIR move fast after an earthquake? |
| Footer | Eligibility, the application terms, the ANSIR address, and how current these figures are. |

Availability leads, because what is available is what an applicant needs before
anything else. There is deliberately no explanatory prose above the tiles and no
lede paragraph under the h1: the page opens h1 -> currency strip -> figures. The
footer carries the line that matters, that a reader should confirm figures with
ANSIR before relying on them for an application.

---

## How it is put together

One file, `schedule/index.html`. Vanilla HTML, CSS and JavaScript, no build
step, no dependencies, nothing loaded from a CDN. The CSS custom properties use
the same names and values as `../index.html` and `../stats/index.html`, plus a
short block of chart tokens local to this page.

```
fetch schedule.json   fetch data.json   fetch instrument-register.json
  |  required           |  optional       |  optional
  |                     |  null on any failure of either
  +---------------------+-----------------+
                        |
  +-- summarise()                -> the headline column sums
  +-- commitmentsByExperiment()  -> allocations rolled up per experiment
  +-- supportedByCode()          -> register lookup, keyed on ANSIR code
  +-- selectMtProjects()         -> current and upcoming MT projects
  +-- mtFleet()                  -> MT models joined to those projects
  |
  +-- buildProvenanceHeader()
  +-- buildHeadline()   buildCategories()   buildMtCategory()   buildMtSection()
  +-- prepareTimeline() -> buildTimelineNames() / drawTimeline() / buildTimelineTable()
  +-- buildExperiments()  buildRapidResponse()
```

All three fetches are issued together, not one after another, so the two
optional files cost no extra round trip. Only the first is required:
`schedule.json` failing shows the error panel; either of the others failing
resolves to `null` and the page renders every seismic figure exactly as it would
have anyway.

### Category display labels

The sheet's category headings are written for its own maintainer. `RECORDERS` is
rendered as **Seismic Recorders**, through a one-entry map keyed on the sheet's
verbatim string:

```js
var CATEGORY_LABELS = { 'RECORDERS': 'Seismic Recorders' };
```

A category with no entry in the map keeps the sheet's own wording, so a heading
renamed or added in the sheet still renders. This is a display label only: the
verbatim string stays the key, and neither `data/schedule.json` nor
`scripts/fetch-schedule.js` is involved. The label exists because a bare
"Recorders" sitting beside a "Magnetotellurics" group would read as though it
covered MT recorders too, which it does not.

### Safe rendering

Everything is built with `createElement` and `textContent`. No data value is
ever assigned to `innerHTML`, so a stray angle bracket typed into the
spreadsheet cannot become markup. The one place raw text becomes a link is
`appendLinkified()`, which splits the notes on a URL or email pattern and builds
real `<a>` nodes around the matches.

There are **no template literals anywhere in the file**, in line with the house
rule for pages in this repository.

### Chart colours

Two categorical series carry the timeline: `--series-deployed` (`#6f42c1`, the
indigo the projects page uses for "In Progress") and `--series-reserved`
(`#b87b00`). The pair is checked with the `dataviz` palette validator against
the white chart surface:

```
Lightness band       PASS   both inside L 0.43-0.77
Chroma floor         PASS   both >= 0.1
CVD separation       PASS   dE 30.8 (protan), 20.0 (tritan)
Normal-vision floor  PASS   dE 32.9
Contrast vs surface  PASS   both >= 3:1
```

If you restyle the timeline, re-run the validator rather than eyeballing the
result.

Colour is never the only channel: the legend is always present, each row is
named in the gutter beside its bar, every bar carries an `aria-label`, and the
whole chart has a data-table twin under "Show data table".

---

## How the headline figures are derived

The headline tiles are **column sums**, with one exception:

| Tile | Computed as |
| --- | --- |
| instruments available | sum of `available` over every instrument |
| On loan | sum of `onLoan` |
| Reserved | sum of `count` over allocations with `status: "reserved"`, so it reconciles with the Reserved rows visible in the instrument tables. Expressions of interest are **not** included: an EOI is not an approved project. |
| In testing | sum of `testing` |
| Under repair | sum of `repair` |
| of N in the fleet | `totals.fleetInstruments` from the file, not a sum |

The status columns are maintained independently of one another in the sheet, so
they are not expected to sum to the fleet total, and the page does not present
them as though they should.

**The page never reconciles one figure against another.** Every number is
rendered exactly as recorded. Doing arithmetic to make the display agree would
put the page's own inference in front of the recorded value, and would keep it
from the only people who can act on it.

`schedule.json` carries a `warnings` array written by
`scripts/fetch-schedule.js`. That array is a maintainer channel: the sync job
prints it to stderr, and the page does not render it. Keep it that way. The data
is in the file if a future view ever needs it.

---

## Magnetotellurics

MT is presented as the fourth accordion under "Availability by instrument type",
answering the question "how many of each MT model are free?" from
`instrument-register.json` (the fleet) joined to `data.json` (the commitments).

The project sheet carries no MT rows, so the MT accordion touches it not at all,
and **no MT number reaches the headline tiles**, which stay seismic column sums
and nothing else.

**Selection rule** (`selectMtProjects`), applied to `data.json`'s `data[]`:

| Test | Rule |
| --- | --- |
| Method | `methods[]` contains `Magnetotelluric`, compared lowercased and trimmed |
| Currency | `status` is `Planning` or `In Progress` |
| Order | `startDate` ascending, projects with no start date last, register order breaking ties |

Status decides currency; dates do not.

### The availability accordion

Same card anatomy as a seismic instrument card, deliberately: big available
figure, meter, status counts line, committed-to table with the same pills, same
CSS classes. A reader should not have to learn a second card.

**Arithmetic, per model:**

| Figure | Rule |
| --- | --- |
| Registered | `count` from `instrument-register.json`. Ownership only: the register says how many exist, never how many are field-ready. |
| On loan now | Sum of committed units from selected projects that are `In Progress` **and** whose `endDate` is missing or `>= today`. |
| Testing, Repair | **Literal zero.** Neither is tracked for MT in either register. Stated rather than omitted, so the card reads like a seismic one; the accordion's one muted line says so in words. |
| Available | `registered - onLoanNow`, clamped at 0. |

`endDate` is compared as an ISO string, so no `Date` object is constructed and
no timezone can shift a boundary.

**Why the end date and not the status alone.** A project keeps its `In Progress`
status in the register until someone edits it, so the on-loan arithmetic also
tests the end date: a project past its end date is not counted against
availability, while its row still appears in the model's committed-to table with
its real dates. That split is the design: **the table is display, the arithmetic
is the headline.** Every selected project referencing a model gets a row
whatever its dates say.

**If the clamp fires** - committed units exceeding registered units - the card
shows `0` rather than a negative number and appends a muted flag, "figures
exceed the registered fleet - check the project register". A negative would be
read as a fleet figure rather than as something to check in the source.

**Joining a project's instrument line to a register model.** The project
register writes the model into a longer descriptive name ("LEMI-120 Magnetic
Coils", "Earth Data PR6-24 Loggers"), so the model key is looked for anywhere
inside the instrument key. Both are normalised by `instrumentKey()`: lowercased,
whitespace collapsed, and the separator between a letter run and a digit run
removed, so `LEMI-120`, `LEMI 120` and `lemi120` are one key. The first model
that matches wins, so a name is never counted against two models.

**Matching is exact, and never guessed.** There is no remapping table. An
instrument name that does not match a registered model stays unmatched and is
named in **one muted line at the bottom of the accordion**, not given a card:
"Recorded in projects but not in the instrument register: ...". Accessories such
as electrodes, fluxgates, solar panels, laptops and batteries land there as a
matter of course. Names are listed rather than dropped, because a reader
comparing the two sources should be able to see the full picture, and because
any correction belongs in the project sheet rather than in page code.

### Status mapping (accordion tables and timeline)

The register's vocabulary maps onto the pills the page already defines:

| Register status | Pill | Card border |
| --- | --- | --- |
| `Planning` | Reserved | `--series-reserved` |
| `In Progress` | Deployed | `--series-deployed` |
| anything else | Complete | `--series-available` |

The same mapping runs the pills in the accordion's committed-to tables. The
third row is not reachable under the current selection rule, which admits only
`Planning` and `In Progress`; it is kept as the honest fallback for a status
nobody has thought of yet, stating what is recorded rather than dressing it up
as a live deployment.

**Timeline rows.** Selected MT projects are appended to the deployment timeline,
because the window a reader is checking is one window. A project that borrows
seismic gear as well as MT gear already has a bar under its project sheet name,
so a row is skipped when its `ansirCode` matches one already on the timeline.
The MT card still renders in that case; only the duplicate bar is suppressed.

**If the project sheet later gains MT availability rows**, they render as an
ordinary category accordion under "Availability by instrument type"
automatically, with no code change: the parser and the page are both blind to
category names. The page would then carry three MT views - sheet availability,
register availability and project commitments - so reconcile the presentation at
that point. Expect the sheet and the instrument register to count different
things (field-ready versus owned). Whichever view survives, check first that it
covers the same projects: the project register knows about MT work the sheet may
not.

---

## The timeline

A range bar per experiment, plus one per current MT project, drawn as
hand-rolled SVG. No chart library.

**Layout.** The experiment names sit in an HTML gutter that never scrolls; the
plot is a sibling `overflow-x: auto` box holding the SVG. Both use the same 34px
row pitch (`--row-height` in CSS, `ROW_H` in JS - change them together). Wide
plots scroll inside that box, never the page body.

**Domain.** The axis starts at the earliest out date, but no earlier than 18
months before today (`MONTHS_BACK`), so a long-running deployment cannot stretch
the axis across empty years and push current work off the right of the screen.
`MONTHS_FORWARD` (36 months) is the same clamp on the right, keeping a
far-future end date from squashing every other bar into a sliver. It sits well
past the latest seismic due date.

A bar that starts before the window is drawn **with a square left end** instead
of a rounded one, which reads as "continues beyond here"; a bar running past the
right-hand horizon is drawn with a square right end in the same way. Nothing is
hidden: the true dates appear in the row tooltip, in the `aria-label` and in the
data table, and the caption counts how many rows are affected at each end. The
domain ends one month past the latest due date so the longest bar does not touch
the edge.

**Month precision.** Most dates in the sheet are `MM-YYYY`. A bar therefore runs
from the start of its out month to the *end* of its due month, so "out 06-2026,
due 09-2026" spans four whole months rather than three. Day-precision dates
position within the month; year-precision dates span January to December.

**Today.** A 2px rule with a small chip label, drawn last so it sits above the
bars. When the plot has to scroll, it opens scrolled to today rather than to the
far left.

**Dates never go through `new Date(string)`.** `new Date('2026-07-21')` is UTC
midnight and renders as 20 July for any viewer behind UTC. `formatIso()` splits
the ISO string and formats from its parts instead.

---

## Defensive rendering

Each case below is designed behaviour, and each is exercised by the data as it
stands.

| Case | What the page does |
| --- | --- |
| `warnings` non-empty | Nothing on screen. Kept in the JSON and in the sync job's stderr for the maintainer. |
| `data.json` fails to load | MT accordion omitted entirely, MT timeline rows absent, every seismic figure unchanged, no console error. |
| `instrument-register.json` fails to load | Magnetotellurics accordion absent, three accordions instead of four, everything else unchanged including the MT timeline rows, no console error. |
| MT project with `instruments: []` | Card renders, "No instrument loans recorded against this project." Contributes nothing to the accordion. |
| MT `ansirCode` already on the timeline | One bar, not two. The MT card still renders. |
| MT model with no commitments | Card renders at full availability, "No project commitments recorded against this model." |
| MT instrument name matching no model | One muted line at the foot of the accordion. No card, no silent drop, no guessed remapping. |
| MT commitment exceeding the registered fleet | Available shows `0`, plus the muted "figures exceed the registered fleet" flag. Never a negative number. |
| MT project `In Progress` past its end date | Not counted as on loan; its committed-to row still renders with its real dates. |
| `ansirCode: null` | "No ANSIR reference recorded"; no register lookup attempted. |
| Both dates null | Row kept, no bar, "Dates to be confirmed" in the plot and the gutter. |
| `allocations: []` | "No experiment allocations recorded against this instrument type." An instrument type carrying only an expression of interest gets the allocation table instead, holding just the EOI row. |
| `available: 0` | Card greys, meter empty, the zero is still the headline figure. |
| `startDate: null` | "Not recorded". |
| `count: null` with `tentative` | Renders "TBC" and an "EOI" pill. |
| `unnamedInterest > 0` | A final "Expression of interest" row in the instrument's allocation table, carrying an "EOI" pill and "TBC" units. Never added into Reserved. |
| `note` on an instrument | Clean name as the card title, annotation in small print beneath it. |
| Fetch of `schedule.json` fails | Error panel with a hardcoded link to the ANSIR project sheet, the ANSIR contact address, and a retry button. Never a blank page. |

The fallback source URL in the error panel is hardcoded as
`FALLBACK_SOURCE_URL`, because `sourceUrl` lives inside the file that has just
failed to load.

Tentative allocations are emitted by the parser from a `*` in an allocation
cell, and the page renders them distinctly, so an EOI typed into the sheet
displays correctly with no code change.

---

## Iframe embedding

The page is served from GitHub Pages at
`https://auscope.github.io/ansir/schedule/` and embedded in the ANSIR website
page at `https://www.auscope.org.au/ansir-schedule`.

Same convention as `../index.html`, `../stats/index.html` and
`../apply/index.html`:

- `SQUARESPACE_PARENT_URL = 'https://www.auscope.org.au/ansir-schedule'`
- `PARENT_ORIGIN` derived through `new URL().origin`
- a `ResizeObserver` on both `documentElement` and `body`
- `{type: 'ansir-resize', height}` posted to the parent
- a 10-second post-load poll to catch late-rendering content
- an extra post on every accordion and data-table toggle, since those are the
  main things that change the page height after load

### The embed block

The code block on the parent page holds exactly this:

```html
<iframe id="ansir-schedule"
        src="https://auscope.github.io/ansir/schedule/"
        style="width:100%;border:0;overflow:hidden"
        height="2000"
        title="ANSIR instrument availability and schedule"></iframe>
<script>
  window.addEventListener('message', function (event) {
    if (event.origin !== 'https://auscope.github.io') return;
    if (!event.data || event.data.type !== 'ansir-resize') return;
    document.getElementById('ansir-schedule').style.height = event.data.height + 'px';
  });
</script>
```

The origin check is the important line. If the repository is ever served from a
custom domain, both the `src` and the `event.origin` comparison must be updated
to that domain in the same edit.

The `height="2000"` attribute is only the pre-resize placeholder, so the block
does not collapse to nothing before the first message arrives. The iframe id
`ansir-schedule` is what the listener looks for; keep the two in step.

Nothing else on the parent page needs to change when the data changes: the fleet
figures update themselves every time the scheduled Action commits a change to
`data/schedule.json`.

### Height measurement

`sendHeightToParent()` measures **`document.body`**, not
`document.documentElement`:

```js
var height = Math.max(
    body.scrollHeight,
    body.offsetHeight,
    Math.ceil(body.getBoundingClientRect().height)
);
```

Taking the maximum across `documentElement` as well cannot report a *smaller*
number: once the parent has sized the iframe to the tall page,
`documentElement.scrollHeight` is pinned to that iframe height. On this page
collapsing a category is a primary interaction, so the iframe has to be able to
shrink as well as grow. The body box is content-driven in both directions, and
collapsing and reopening categories reports a smaller then a larger height
accordingly.

### Embedding checks

1. `https://auscope.github.io/ansir/schedule/` and
   `https://auscope.github.io/ansir/data/schedule.json` both return 200 over
   HTTPS.
2. The schedule fetch step is wired into `.github/workflows/sync-sheets.yml`
   (see [SCHEDULE_DATA.md](SCHEDULE_DATA.md)). Without it the JSON is only as
   fresh as the last manual run.
3. The as-at date in the header reads correctly. It is typed by hand into the
   spreadsheet's tab name and does not update itself when a number changes, so a
   stale tab name makes current data look old.

---

## What the page assumes about the JSON

The page reads the JSON, never the spreadsheet, so a layout change in the sheet
does not reach the browser. What happens instead:

- The scheduled Action fails, names the offending cell, and writes nothing.
- `data/schedule.json` keeps its last known good contents.
- **The page carries on serving the last good data.**

Fix the sheet, or update `scripts/fetch-schedule.js`, following
[SCHEDULE_DATA.md](SCHEDULE_DATA.md). The page needs no change for any of it.

The page only needs editing if the **JSON shape** changes: a renamed or new
top-level key, or a new field on an instrument or experiment. In that case
update the output-format table in `SCHEDULE_DATA.md` and this document in the
same commit.

What the page relies on:

- `data/data.json` is an object with a `data` array of projects, each with
  `ansirCode`, `title`, `acronym`, `status`, `startDate`, `endDate`, `methods[]`,
  `instruments[{name, count}]` and `location{region, country}`. Anything else,
  including a missing file, is treated as "no register" and the MT section is
  omitted. It is never allowed to break the seismic page.
- `data/instrument-register.json` is an object with a `models` array, each entry
  carrying `model`, `title` and `count`. Anything else, including a missing
  file, is treated as "no instrument register" and the Magnetotellurics
  accordion is omitted. The page reads nothing else from that file: not the DOI
  lists, not the platforms, not `dataQuality`. It is never allowed to break the
  rest of the page.
- `categories[].instruments[]` exists and is non-empty, or the error panel shows.
- An allocation's `experiment` string matches an entry in `experiments[]` by
  name. That is how an allocation row gets its out and due dates. A name that
  does not match still renders, with "Not recorded" for both dates.
- `supportedExperiments[].ansirCode` matches `experiments[].ansirCode`. That is
  how "About this project" gets its description, applicants and funding. An
  experiment with no match simply has no About panel.

---

## Verifying a change

Serve the repository root and load the page. Opening the file directly will not
work, because `fetch` on a `file://` URL is blocked.

```
python3 -m http.server 8777
open http://localhost:8777/schedule/index.html
```

Then check:

1. **No console errors**, at desktop width and at 400px.
2. **The body never scrolls sideways.** `document.documentElement.scrollWidth`
   must equal `window.innerWidth`. Wide content scrolls in its own box.
3. **The seismic numbers match the file.** Re-derive them in the console rather
   than trusting the render:

   ```js
   fetch('../data/schedule.json').then(function (r) { return r.json(); }).then(function (d) {
     var t = 0;
     d.categories.forEach(function (c) {
       c.instruments.forEach(function (i) { t += i.available; });
     });
     console.log('available', t, 'fleet', d.totals.fleetInstruments);
   });
   ```

4. **The MT availability figures match the cards.** Recompute them
   independently: join the two files, apply the on-loan-now rule, and diff the
   result against the cards and the accordion header.

   ```js
   Promise.all([
     fetch('../data/instrument-register.json').then(function (r) { return r.json(); }),
     fetch('../data/data.json').then(function (r) { return r.json(); })
   ]).then(function (res) {
     var reg = res[0], proj = res[1];
     var d = new Date(), mm = d.getMonth() + 1, dd = d.getDate();
     var t = d.getFullYear() + '-' + (mm < 10 ? '0' : '') + mm + '-' + (dd < 10 ? '0' : '') + dd;
     function k(s) {
       return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim()
         .replace(/([a-z])[\s-]+(?=\d)/g, '$1').replace(/(\d)[\s-]+(?=[a-z])/g, '$1');
     }
     var loan = {};
     proj.data.filter(function (p) {
       return (p.methods || []).some(function (m) {
         return String(m).trim().toLowerCase() === 'magnetotelluric';
       }) && (p.status === 'Planning' || p.status === 'In Progress');
     }).forEach(function (p) {
       if (p.status !== 'In Progress' || (p.endDate && p.endDate < t)) return;
       (p.instruments || []).forEach(function (l) {
         reg.models.some(function (m) {
           if (k(l.name).indexOf(k(m.model)) === -1) return false;
           loan[m.model] = (loan[m.model] || 0) + l.count;
           return true;
         });
       });
     });
     reg.models.forEach(function (m) {
       console.log(m.model, Math.max(0, m.count - (loan[m.model] || 0)), 'of', m.count);
     });
   });
   ```

   The same filter, mapped to `p.ansirCode` instead, gives the list of selected
   MT projects to compare against the `.exp-code` text in `#mt-projects`.
5. **Both optional-file paths.** Serve a copy of the repository with
   `data/data.json` removed: the MT section must be absent, the timeline must
   drop back to its seismic rows, and the console must be clean. Then serve one
   with `data/instrument-register.json` removed: three accordions instead of
   four, the MT timeline rows still present, the console still clean. A 404 on
   either optional file is never visible to the reader.
6. **The resize message fires.** `postMessage` is targeted at
   `https://www.auscope.org.au`, so a localhost parent never receives it. Test
   with a same-origin probe page that shadows `window.postMessage` before the
   iframe loads, then collapse a category and confirm the reported height goes
   down as well as up.
7. **Keyboard.** Tab to a timeline bar: the focus halo appears and the tooltip
   opens. Tab to the plot container: it scrolls with the arrow keys.
8. **The error path.** Rename `data/schedule.json` temporarily and hard-reload
   (a normal reload serves the cached copy, which is itself the intended
   behaviour). You should get the error panel with a working source link, not a
   blank page.
