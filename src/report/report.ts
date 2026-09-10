import { execFileSync } from 'child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import * as path from 'path'
import { env } from '../env'

/* Run reports.
 *
 * Every run leaves `reports/<suite>/` behind: `index.html` (the jest-html-reporters page),
 * `summary.json` (counts, every test, failures — written by src/report/summary-reporter.js when the
 * run completes), `run.json` (written here at setup: what was under test, before anything ran) and
 * `history.json` (one line per run this directory has seen, newest last, capped — so the index can
 * show a trend and say when a suite last went red). `buildIndex` renders one `index.html` over a
 * directory of such suites; `publish` copies suites into the directory an nginx serves and rebuilds
 * the index THERE, over every suite it holds — so publishing zoetis never hides the last idexx run,
 * and the published history is merged, never replaced. Nothing here depends on jest. */

export interface RunInfo {
  suite: string
  startedAt: string
  /* checkout name -> `git describe` (tag or sha, `-dirty` when it has local changes). */
  versions: Record<string, string>
}

export interface Failure {
  name: string
  file: string
  message: string
}

export interface TestCase {
  /* jest's fullName: the describe titles and the test title, joined. */
  name: string
  /* The test's own title and its describe titles, when the reporter recorded them separately. */
  title?: string
  ancestors?: string[]
  file: string
  status: string
  durationMs: number | null
}

export interface Summary {
  startedAt: string
  finishedAt: string
  durationMs: number
  success: boolean
  total: number
  passed: number
  failed: number
  skipped: number
  todo: number
  suitesFailedToRun: number
  failures: Failure[]
  /* Absent in summaries written before the reporter recorded every test. */
  tests?: TestCase[]
}

export type Status = 'passed' | 'failed' | 'incomplete'

/* One run, as remembered in history.json. Keyed by `startedAt` (run.json's, written at setup, so
 * a run recorded as incomplete at setup and completed at teardown is one entry, upgraded). */
export interface HistoryEntry {
  startedAt: string
  status: Status
  finishedAt?: string
  durationMs?: number
  total?: number
  passed?: number
  failed?: number
  versions?: Record<string, string>
}

export interface SuiteReport {
  suite: string
  dir: string
  run?: RunInfo
  summary?: Summary
  history: HistoryEntry[]
  hasPage: boolean
}

/* The order suites are listed in; anything unknown sorts after, alphabetically. */
const SUITE_ORDER = ['fast', 'idexx', 'antech', 'zoetis', 'demo']
const HISTORY_MAX = 60
/* How many past runs the index draws per suite. */
const HISTORY_SHOWN = 20
/* Commit links: every checkout under test lives in this GitHub organisation. */
const GITHUB_ORG = 'nominal-systems'

function git (dir: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return undefined
  }
}

/* `v1.14.10-dirty (f2c93a6)`, `3013f40`, or a reason there is no version. The sha is appended only
 * when describe resolved to a tag, so a tagged checkout is still traceable to a commit. */
export function describeCheckout (dir: string): string {
  if (!existsSync(dir)) return `not present at ${dir}`
  const described = git(dir, ['describe', '--tags', '--always', '--dirty'])
  const sha = git(dir, ['rev-parse', '--short', 'HEAD'])
  if (described == null || sha == null) return 'not a git checkout'
  return described.includes(sha) ? described : `${described} (${sha})`
}

export function versionsUnderTest (): Record<string, string> {
  const versions: Record<string, string> = { 'dmi-e2e': describeCheckout(env.harnessRoot) }
  versions['dmi-api'] = env.manageApp ? describeCheckout(env.dmiApiDir) : `external, at ${env.baseUrl}`
  if (env.integration != null) versions[env.integration.name] = describeCheckout(env.integration.dir)
  return versions
}

export function suiteDir (root: string, suite: string): string {
  return path.join(root, suite)
}

function readJson<T> (file: string): T | undefined {
  if (!existsSync(file)) return undefined
  return JSON.parse(readFileSync(file, 'utf8')) as T
}

function writeJson (file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}

/* ---- history ------------------------------------------------------------------------------ */

export function statusOf (report: Pick<SuiteReport, 'summary'>): Status {
  if (report.summary == null) return 'incomplete'
  return report.summary.success ? 'passed' : 'failed'
}

function historyEntry (run: RunInfo | undefined, summary: Summary | undefined): HistoryEntry | undefined {
  const startedAt = run?.startedAt ?? summary?.startedAt
  if (startedAt == null) return undefined
  return {
    startedAt,
    status: statusOf({ summary }),
    finishedAt: summary?.finishedAt,
    durationMs: summary?.durationMs,
    total: summary?.total,
    passed: summary?.passed,
    failed: summary?.failed,
    versions: run?.versions,
  }
}

/* Union by startedAt, oldest first, capped. A completed entry beats an incomplete one for the
 * same run; otherwise the later list wins. */
export function mergeHistory (...lists: Array<HistoryEntry[] | undefined>): HistoryEntry[] {
  const byStart = new Map<string, HistoryEntry>()
  for (const list of lists) {
    for (const entry of list ?? []) {
      const existing = byStart.get(entry.startedAt)
      if (existing != null && existing.status !== 'incomplete' && entry.status === 'incomplete') continue
      byStart.set(entry.startedAt, entry)
    }
  }
  return [...byStart.values()]
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .slice(-HISTORY_MAX)
}

function readHistory (dir: string): HistoryEntry[] {
  return readJson<HistoryEntry[]>(path.join(dir, 'history.json')) ?? []
}

/* Fold the suite directory's current run into its history.json. Idempotent. */
function recordHistory (dir: string, run: RunInfo | undefined, summary: Summary | undefined): HistoryEntry[] {
  const entry = historyEntry(run, summary)
  const history = mergeHistory(readHistory(dir), entry == null ? [] : [entry])
  writeJson(path.join(dir, 'history.json'), history)
  return history
}

/* ---- the run lifecycle -------------------------------------------------------------------- */

/* Called from globalSetup, before anything is started. Records what is under test, and clears the
 * previous run's results so a run that dies before the reporter fires cannot leave a stale green
 * summary beside a fresh run.json — the index shows such a run as incomplete instead. The run also
 * enters the history now, as incomplete, so a night that died early is still a grey mark later. */
export function beginRun (): RunInfo {
  const dir = suiteDir(env.report.dir, env.suite)
  mkdirSync(dir, { recursive: true })
  for (const stale of ['summary.json', 'index.html']) rmSync(path.join(dir, stale), { force: true })
  const run: RunInfo = {
    suite: env.suite,
    startedAt: new Date().toISOString(),
    versions: versionsUnderTest(),
  }
  writeJson(path.join(dir, 'run.json'), run)
  recordHistory(dir, run, undefined)
  return run
}

function rank (suite: string): number {
  const index = SUITE_ORDER.indexOf(suite)
  return index === -1 ? SUITE_ORDER.length : index
}

/* Every suite directory under `root` that holds a run.json or a summary.json. */
export function readSuites (root: string): SuiteReport[] {
  if (!existsSync(root)) return []
  const reports: SuiteReport[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = path.join(root, entry.name)
    const run = readJson<RunInfo>(path.join(dir, 'run.json'))
    const summary = readJson<Summary>(path.join(dir, 'summary.json'))
    if (run == null && summary == null) continue
    reports.push({
      suite: entry.name,
      dir,
      run,
      summary,
      history: readHistory(dir),
      hasPage: existsSync(path.join(dir, 'index.html')),
    })
  }
  return reports.sort((a, b) => rank(a.suite) - rank(b.suite) || a.suite.localeCompare(b.suite))
}

export function buildIndex (root: string): string {
  mkdirSync(root, { recursive: true })
  const reports = readSuites(root)
  for (const report of reports) report.history = recordHistory(report.dir, report.run, report.summary)
  const file = path.join(root, 'index.html')
  writeFileSync(file, renderIndex(reports, root))
  return file
}

/* nginx's worker (typically `nobody`) reads what we publish; make sure it can. */
function makeWorldReadable (root: string): void {
  chmodSync(root, 0o755)
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name)
    if (entry.isDirectory()) makeWorldReadable(target)
    else chmodSync(target, statSync(target).mode & 0o111 ? 0o755 : 0o644)
  }
}

/* Copy the named suites from env.report.dir into env.report.publishDir (each replaced atomically,
 * via a sibling temp dir and a rename; the published history is merged into the copy first, so a
 * publish from a machine with a shorter memory never shortens the server's), then rebuild the
 * index over everything published. */
export function publish (suites: string[]): { publishDir: string, published: string[] } {
  const { publishDir } = env.report
  mkdirSync(publishDir, { recursive: true })
  const published: string[] = []
  for (const suite of suites) {
    const source = suiteDir(env.report.dir, suite)
    if (!existsSync(path.join(source, 'run.json')) && !existsSync(path.join(source, 'summary.json'))) continue
    const target = suiteDir(publishDir, suite)
    const staging = `${target}.publishing`
    rmSync(staging, { recursive: true, force: true })
    cpSync(source, staging, { recursive: true })
    writeJson(path.join(staging, 'history.json'), mergeHistory(readHistory(target), readHistory(staging)))
    rmSync(target, { recursive: true, force: true })
    renameSync(staging, target)
    published.push(suite)
  }
  buildIndex(publishDir)
  makeWorldReadable(publishDir)
  return { publishDir, published }
}

/* ---- rendering ---------------------------------------------------------------------------- */

function escapeHtml (value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function formatDuration (ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function formatTestDuration (ms: number | null): string {
  if (ms == null) return ''
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(1)} s`
}

const STATUS_LABEL: Record<Status, string> = {
  passed: 'PASSED',
  failed: 'FAILED',
  incomplete: 'DID NOT COMPLETE',
}

function timeTag (iso: string): string {
  return `<time datetime="${escapeHtml(iso)}">${escapeHtml(iso)}</time>`
}

function plural (count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/* The commit a version string points at, for a link: the sha in parentheses after a tag, or a
 * bare sha (possibly `-dirty`). A dirty checkout still links — the sha is where it started. */
function commitOf (version: string): string | undefined {
  const inParens = /\(([0-9a-f]{7,40})\)\s*$/.exec(version)
  if (inParens != null) return inParens[1]
  const bare = /^([0-9a-f]{7,40})(-dirty)?$/.exec(version)
  return bare?.[1]
}

function versionLink (name: string, version: string): string {
  const sha = commitOf(version)
  const text = escapeHtml(version)
  if (sha == null) return text
  return `<a href="https://github.com/${GITHUB_ORG}/${encodeURIComponent(name)}/commit/${sha}">${text}</a>`
}

/* The run before the current one, for "what changed" and "vs previous". */
function previousRun (report: SuiteReport): HistoryEntry | undefined {
  const current = report.run?.startedAt ?? report.summary?.startedAt
  const earlier = report.history.filter((entry) => current == null || entry.startedAt < current)
  return earlier[earlier.length - 1]
}

function versionsCell (report: SuiteReport): string {
  const { run } = report
  if (run == null) return '<td class="muted">—</td>'
  const previous = previousRun(report)?.versions
  const rows = Object.entries(run.versions)
    .map(([name, version]) => {
      const before = previous?.[name]
      const changed = before != null && before !== version
      const mark = changed
        ? ` <span class="chg" title="previous run: ${escapeHtml(before)}">changed</span>`
        : ''
      return `<div><span class="muted">${escapeHtml(name)}</span> ${versionLink(name, version)}${mark}</div>`
    })
    .join('')
  return `<td class="versions">${rows}</td>`
}

function historyCell (report: SuiteReport): string {
  const shown = report.history.slice(-HISTORY_SHOWN)
  if (shown.length === 0) return '<td class="muted">—</td>'
  const dots = shown
    .map((entry) => {
      const label = entry.status === 'incomplete'
        ? STATUS_LABEL.incomplete
        : `${STATUS_LABEL[entry.status]} · ${entry.passed ?? '?'}/${entry.total ?? '?'}` +
          (entry.durationMs == null ? '' : ` · ${formatDuration(entry.durationMs)}`)
      return `<span class="dot ${entry.status}" data-at="${escapeHtml(entry.startedAt)}" data-label="${escapeHtml(label)}"></span>`
    })
    .join('')
  const completed = report.history.filter((entry) => entry.status !== 'incomplete')
  const lastRed = [...report.history].reverse().find((entry) => entry.status === 'failed')
  const note = lastRed == null
    ? `<span class="muted">no red in ${plural(completed.length, 'recorded run')}</span>`
    : `<span class="bad">last red</span> ${timeTag(lastRed.startedAt)}`
  return `<td class="history"><div class="dots">${dots}</div><div class="note">${note}</div></td>`
}

function tookCell (report: SuiteReport): string {
  const { summary } = report
  if (summary == null) return '<td class="muted">—</td>'
  const previous = previousRun(report)?.durationMs
  let delta = ''
  if (previous != null && previous > 0) {
    const diff = summary.durationMs - previous
    if (Math.abs(diff) >= Math.max(5000, previous * 0.1)) {
      const sign = diff > 0 ? '+' : '−'
      delta = ` <span class="muted" title="previous run: ${formatDuration(previous)}">${sign}${formatDuration(Math.abs(diff))}</span>`
    }
  }
  /* Jest's own duration is the tests; the run also boots containers, migrates, builds and (in
   * full-stack mode) builds images before them — that wall time is from run.json's startedAt. */
  const started = report.run?.startedAt == null ? NaN : Date.parse(report.run.startedAt)
  const wall = Number.isNaN(started) ? NaN : Date.parse(summary.finishedAt) - started
  const wallNote = Number.isNaN(wall) || wall <= summary.durationMs
    ? ''
    : `<div class="muted wall" title="from setup to finish, including containers, migrations and image builds">${formatDuration(wall)} incl. setup</div>`
  return `<td class="took">${formatDuration(summary.durationMs)}${delta}${wallNote}</td>`
}

function suiteRow (report: SuiteReport): string {
  const status = statusOf(report)
  const { summary } = report
  const counts = summary == null
    ? '<td class="muted">no results — the run stopped before the tests reported</td>'
    : `<td class="counts"><span class="ok">${summary.passed} passed</span>` +
      (summary.failed > 0 ? ` · <span class="bad">${summary.failed} failed</span>` : '') +
      (summary.skipped > 0 ? ` · <span class="muted">${summary.skipped} skipped</span>` : '') +
      (summary.suitesFailedToRun > 0 ? ` · <span class="bad">${summary.suitesFailedToRun} file(s) failed to run</span>` : '') +
      '</td>'
  const when = summary != null
    ? `<td>${timeTag(summary.finishedAt)}</td>`
    : report.run != null
      ? `<td><span class="muted">started</span> ${timeTag(report.run.startedAt)}</td>`
      : '<td class="muted">—</td>'
  const links = [
    report.hasPage ? `<a href="${escapeHtml(report.suite)}/index.html">full report</a>` : '<span class="muted">no page</span>',
    (summary?.tests?.length ?? 0) > 0 ? `<a href="#tests-${escapeHtml(report.suite)}">tests</a>` : '',
  ].filter((link) => link !== '').join(' · ')
  return `<tr class="${status}">
  <th scope="row">${escapeHtml(report.suite)}</th>
  <td><span class="badge ${status}">${STATUS_LABEL[status]}</span></td>
  ${counts}
  ${tookCell(report)}
  ${when}
  ${historyCell(report)}
  ${versionsCell(report)}
  <td class="links">${links}</td>
</tr>`
}

function failuresBlock (report: SuiteReport): string {
  const failures = report.summary?.failures ?? []
  if (failures.length === 0) return ''
  const items = failures
    .map((failure) => `<li><strong>${escapeHtml(failure.name)}</strong> <span class="muted">${escapeHtml(failure.file)}</span>
<pre>${escapeHtml(failure.message)}</pre></li>`)
    .join('\n')
  return `<details open class="failures-block">
<summary class="bad">${escapeHtml(report.suite)}: ${plural(failures.length, 'failure')}</summary>
<ul class="failures">
${items}
</ul>
</details>`
}

const TEST_MARK: Record<string, string> = { passed: '✓', failed: '✕', pending: '○', skipped: '○', todo: '○' }

/* Every test the run executed, grouped by file and then by its describe path, with its duration —
 * what a green run actually checked, readable without opening the jest page. Collapsed unless the
 * suite is red. */
function testsBlock (report: SuiteReport): string {
  const tests = report.summary?.tests ?? []
  if (tests.length === 0) return ''
  const rows: string[] = []
  let lastFile: string | undefined
  let lastPath: string | undefined
  for (const test of tests) {
    if (test.file !== lastFile) {
      rows.push(`<tr class="file"><td colspan="3">${escapeHtml(test.file)}</td></tr>`)
      lastFile = test.file
      lastPath = undefined
    }
    const describePath = (test.ancestors ?? []).join(' › ')
    if (describePath !== '' && describePath !== lastPath) {
      rows.push(`<tr class="describe"><td></td><td colspan="2">${escapeHtml(describePath)}</td></tr>`)
      lastPath = describePath
    }
    rows.push(`<tr class="t-${escapeHtml(test.status)}"><td class="mark">${TEST_MARK[test.status] ?? '?'}</td><td>${escapeHtml(test.title ?? test.name)}</td><td class="dur">${formatTestDuration(test.durationMs)}</td></tr>`)
  }
  const status = statusOf(report)
  const slowest = [...tests].filter((test) => test.durationMs != null).sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))[0]
  const slowNote = slowest == null || slowest.durationMs == null
    ? ''
    : ` <span class="muted">· slowest: ${escapeHtml(slowest.title ?? slowest.name)} (${formatTestDuration(slowest.durationMs)})</span>`
  return `<details id="tests-${escapeHtml(report.suite)}"${status === 'failed' ? ' open' : ''} class="tests-block">
<summary>${escapeHtml(report.suite)}: ${plural(tests.length, 'test')}${slowNote}</summary>
<table class="tests">
${rows.join('\n')}
</table>
</details>`
}

function banner (reports: SuiteReport[]): string {
  if (reports.length === 0) return ''
  const failed = reports.filter((report) => statusOf(report) === 'failed')
  const incomplete = reports.filter((report) => statusOf(report) === 'incomplete')
  const tests = reports.reduce((sum, report) => sum + (report.summary?.total ?? 0), 0)
  const testsFailed = reports.reduce((sum, report) => sum + (report.summary?.failed ?? 0), 0)
  const finished = reports.map((report) => report.summary?.finishedAt).filter((iso): iso is string => iso != null).sort()
  const kind: Status = failed.length > 0 ? 'failed' : incomplete.length > 0 ? 'incomplete' : 'passed'
  const headline = kind === 'passed'
    ? `All ${plural(reports.length, 'suite')} passed`
    : kind === 'failed'
      ? `${failed.length} of ${plural(reports.length, 'suite')} failed: ${failed.map((report) => report.suite).join(', ')}`
      : `${incomplete.length} of ${plural(reports.length, 'suite')} did not complete: ${incomplete.map((report) => report.suite).join(', ')}`
  const detail = [
    tests > 0 ? `${plural(tests, 'test')}${testsFailed > 0 ? `, ${testsFailed} failed` : ', all passing'}` : '',
    finished.length > 0 ? `latest finished ${timeTag(finished[finished.length - 1])}` : '',
    finished.length > 1 ? `oldest ${timeTag(finished[0])}` : '',
  ].filter((part) => part !== '').join(' · ')
  return `<section class="banner ${kind}"><div class="headline">${headline}</div><div class="detail">${detail}</div></section>`
}

export function renderIndex (reports: SuiteReport[], root: string): string {
  const generatedAt = new Date().toISOString()
  const body = reports.length === 0
    ? `<p class="muted">No runs yet under <code>${escapeHtml(root)}</code>. Run the harness and come back.</p>`
    : `${banner(reports)}
<table class="suites">
<thead><tr><th>Suite</th><th>Result</th><th>Tests</th><th>Tests took</th><th>Finished</th><th>Last ${HISTORY_SHOWN} runs</th><th>Under test</th><th></th></tr></thead>
<tbody>
${reports.map(suiteRow).join('\n')}
</tbody>
</table>
${reports.map(failuresBlock).join('\n')}
${reports.map(testsBlock).join('\n')}`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dmi-e2e runs</title>
<style>
  :root { color-scheme: light dark; --ok: #1a7f37; --bad: #cf222e; --warn: #9a6700; --muted: #6e7781; --line: #d0d7de; --badge-fg: #fff; --ok-bg: rgba(26,127,55,.10); --bad-bg: rgba(207,34,46,.10); --warn-bg: rgba(154,103,0,.12); --code-bg: rgba(127,127,127,.12); }
  @media (prefers-color-scheme: dark) { :root { --ok: #3fb950; --bad: #f85149; --warn: #d29922; --muted: #8b949e; --line: #30363d; } }
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; margin: 2rem auto; max-width: 80rem; padding: 0 1rem; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  .sub { color: var(--muted); margin: 0 0 1.25rem; }
  .banner { border-radius: .5rem; padding: .9rem 1.1rem; margin: 0 0 1.25rem; border-left: .35rem solid var(--muted); background: var(--code-bg); }
  .banner.passed { border-color: var(--ok); background: var(--ok-bg); }
  .banner.failed { border-color: var(--bad); background: var(--bad-bg); }
  .banner.incomplete { border-color: var(--warn); background: var(--warn-bg); }
  .banner .headline { font-size: 1.15rem; font-weight: 700; }
  .banner .detail { color: var(--muted); margin-top: .15rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: .5rem .6rem; border-bottom: 1px solid var(--line); vertical-align: top; }
  thead th { color: var(--muted); font-weight: 600; font-size: .8rem; text-transform: uppercase; letter-spacing: .03em; }
  tbody th { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .badge { display: inline-block; padding: .1rem .5rem; border-radius: .3rem; font-size: .75rem; font-weight: 700; color: var(--badge-fg); white-space: nowrap; }
  .badge.passed { background: var(--ok); } .badge.failed { background: var(--bad); } .badge.incomplete { background: var(--muted); }
  .ok { color: var(--ok); } .bad { color: var(--bad); } .muted { color: var(--muted); }
  .versions { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .8rem; white-space: nowrap; }
  .versions a { color: inherit; text-decoration: none; border-bottom: 1px dotted var(--muted); }
  .versions a:hover { border-bottom-style: solid; }
  .chg { display: inline-block; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; font-size: .7rem; font-weight: 700; color: var(--warn); background: var(--warn-bg); border-radius: .3rem; padding: 0 .35rem; margin-left: .25rem; vertical-align: middle; }
  .counts, .took, .links, td > time { white-space: nowrap; }
  .took .wall { font-size: .8rem; }
  .history .dots { display: flex; gap: 2px; flex-wrap: wrap; }
  .dot { display: inline-block; width: .8rem; height: 1.1rem; border-radius: 2px; background: var(--muted); cursor: default; }
  .dot.passed { background: var(--ok); } .dot.failed { background: var(--bad); } .dot.incomplete { background: var(--muted); opacity: .5; }
  .history .note { font-size: .8rem; margin-top: .2rem; white-space: nowrap; }
  details { margin-top: 1.5rem; }
  summary { cursor: pointer; font-weight: 600; }
  .failures { list-style: none; padding: 0; }
  .failures li { margin: .75rem 0; }
  pre { background: var(--code-bg); padding: .6rem .8rem; border-radius: .3rem; overflow-x: auto; font-size: .8rem; margin: .3rem 0 0; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .tests { margin-top: .5rem; font-size: .85rem; }
  .tests td { padding: .25rem .5rem; border-bottom: 1px solid var(--line); }
  .tests tr.file td { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); padding-top: .6rem; }
  .tests tr.describe td { font-weight: 600; padding-top: .5rem; }
  .tests .mark { width: 1.2rem; text-align: center; }
  .tests tr.t-passed .mark { color: var(--ok); } .tests tr.t-failed .mark { color: var(--bad); } .tests tr.t-pending .mark, .tests tr.t-skipped .mark, .tests tr.t-todo .mark { color: var(--muted); }
  .tests tr.t-failed td { color: var(--bad); }
  .tests .dur { text-align: right; color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
  time.stale { color: var(--warn); font-weight: 700; }
  time .abs { color: var(--muted); font-size: .85em; margin-left: .45em; }
  time .abs::before { content: '· '; }
  time.stale .abs { color: inherit; }
  @media (max-width: 60rem) { .history, thead th:nth-child(6) { display: none; } }
</style>
</head>
<body>
<h1>dmi-e2e runs</h1>
<p class="sub">Latest run of each suite; the history strip is what this directory has seen. Index generated ${timeTag(generatedAt)}.</p>
${body}
<script>
  /* Relative age first, so a stale green is LOUD: the page is static and ages after it is written,
   * which is exactly when "PASSED" stops meaning anything — a run older than 36h (a nightly that
   * missed, plus slack) renders amber. The absolute time follows, in the viewer's own timezone —
   * the ISO text in the markup is what a viewer without JavaScript sees. */
  const STALE_MS = 36 * 3600 * 1000
  const local = (d) => d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  for (const t of document.querySelectorAll('time[datetime]')) {
    const d = new Date(t.getAttribute('datetime'))
    if (isNaN(d)) continue
    const s = Math.round((Date.now() - d.getTime()) / 1000)
    const rel = document.createElement('span')
    rel.textContent = s < 60 ? 'just now'
      : s < 3600 ? Math.round(s / 60) + 'm ago'
      : s < 86400 ? Math.round(s / 3600) + 'h ago'
      : Math.round(s / 86400) + 'd ago'
    const abs = document.createElement('span')
    abs.className = 'abs'
    abs.textContent = local(d)
    t.title = d.toLocaleString()
    t.replaceChildren(rel, abs)
    if (Date.now() - d.getTime() > STALE_MS) t.classList.add('stale')
  }
  /* The "tests" links point at a collapsed block: open it when arrived at by anchor. */
  const openByHash = () => { const el = location.hash && document.querySelector(location.hash); if (el && el.tagName === 'DETAILS') el.open = true }
  openByHash(); addEventListener('hashchange', openByHash)
  /* History dots: the tooltip is the run's local time plus its result. */
  for (const dot of document.querySelectorAll('.dot[data-at]')) {
    const d = new Date(dot.dataset.at)
    dot.title = (isNaN(d) ? dot.dataset.at : local(d)) + ' · ' + dot.dataset.label
  }
</script>
</body>
</html>
`
}
