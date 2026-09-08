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
 * `summary.json` (counts and failures, written by src/report/summary-reporter.js when the run
 * completes) and `run.json` (written here at setup: what was under test, before anything ran).
 * `buildIndex` renders one `index.html` over a directory of such suites; `publish` copies suites
 * into the directory an nginx serves and rebuilds the index THERE, over every suite it holds — so
 * publishing zoetis never hides the last idexx run. Nothing here depends on jest. */

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
}

export interface SuiteReport {
  suite: string
  dir: string
  run?: RunInfo
  summary?: Summary
  hasPage: boolean
}

/* The order suites are listed in; anything unknown sorts after, alphabetically. */
const SUITE_ORDER = ['fast', 'idexx', 'antech', 'zoetis', 'demo']

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

/* Called from globalSetup, before anything is started. Records what is under test, and clears the
 * previous run's results so a run that dies before the reporter fires cannot leave a stale green
 * summary beside a fresh run.json — the index shows such a run as incomplete instead. */
export function beginRun (): RunInfo {
  const dir = suiteDir(env.report.dir, env.suite)
  mkdirSync(dir, { recursive: true })
  for (const stale of ['summary.json', 'index.html']) rmSync(path.join(dir, stale), { force: true })
  const run: RunInfo = {
    suite: env.suite,
    startedAt: new Date().toISOString(),
    versions: versionsUnderTest(),
  }
  writeFileSync(path.join(dir, 'run.json'), JSON.stringify(run, null, 2) + '\n')
  return run
}

function readJson<T> (file: string): T | undefined {
  if (!existsSync(file)) return undefined
  return JSON.parse(readFileSync(file, 'utf8')) as T
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
    reports.push({ suite: entry.name, dir, run, summary, hasPage: existsSync(path.join(dir, 'index.html')) })
  }
  return reports.sort((a, b) => rank(a.suite) - rank(b.suite) || a.suite.localeCompare(b.suite))
}

export function buildIndex (root: string): string {
  mkdirSync(root, { recursive: true })
  const file = path.join(root, 'index.html')
  writeFileSync(file, renderIndex(readSuites(root), root))
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
 * via a sibling temp dir and a rename), then rebuild the index over everything published. */
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

type Status = 'passed' | 'failed' | 'incomplete'

function statusOf (report: SuiteReport): Status {
  if (report.summary == null) return 'incomplete'
  return report.summary.success ? 'passed' : 'failed'
}

const STATUS_LABEL: Record<Status, string> = {
  passed: 'PASSED',
  failed: 'FAILED',
  incomplete: 'DID NOT COMPLETE',
}

function timeCell (iso: string | undefined): string {
  if (iso == null) return '<td class="muted">—</td>'
  return `<td><time datetime="${escapeHtml(iso)}">${escapeHtml(iso)}</time></td>`
}

function versionsCell (run: RunInfo | undefined): string {
  if (run == null) return '<td class="muted">—</td>'
  const rows = Object.entries(run.versions)
    .map(([name, version]) => `<div><span class="muted">${escapeHtml(name)}</span> ${escapeHtml(version)}</div>`)
    .join('')
  return `<td class="versions">${rows}</td>`
}

function suiteRow (report: SuiteReport): string {
  const status = statusOf(report)
  const { summary } = report
  const counts = summary == null
    ? '<td class="muted" colspan="2">no results — the run stopped before the tests reported</td>'
    : `<td class="counts"><span class="ok">${summary.passed} passed</span>` +
      (summary.failed > 0 ? ` · <span class="bad">${summary.failed} failed</span>` : '') +
      (summary.skipped > 0 ? ` · <span class="muted">${summary.skipped} skipped</span>` : '') +
      (summary.suitesFailedToRun > 0 ? ` · <span class="bad">${summary.suitesFailedToRun} file(s) failed to run</span>` : '') +
      `</td><td>${formatDuration(summary.durationMs)}</td>`
  const link = report.hasPage
    ? `<a href="${escapeHtml(report.suite)}/index.html">full report</a>`
    : '<span class="muted">no page</span>'
  return `<tr class="${status}">
  <th scope="row">${escapeHtml(report.suite)}</th>
  <td><span class="badge ${status}">${STATUS_LABEL[status]}</span></td>
  ${counts}
  ${timeCell(summary?.finishedAt ?? report.run?.startedAt)}
  ${versionsCell(report.run)}
  <td>${link}</td>
</tr>`
}

function failuresBlock (report: SuiteReport): string {
  const failures = report.summary?.failures ?? []
  if (failures.length === 0) return ''
  const items = failures
    .map((failure) => `<li><strong>${escapeHtml(failure.name)}</strong> <span class="muted">${escapeHtml(failure.file)}</span>
<pre>${escapeHtml(failure.message)}</pre></li>`)
    .join('\n')
  return `<details open>
<summary>${escapeHtml(report.suite)}: ${failures.length} failure${failures.length === 1 ? '' : 's'}</summary>
<ul class="failures">
${items}
</ul>
</details>`
}

export function renderIndex (reports: SuiteReport[], root: string): string {
  const generatedAt = new Date().toISOString()
  const body = reports.length === 0
    ? `<p class="muted">No runs yet under <code>${escapeHtml(root)}</code>. Run the harness and come back.</p>`
    : `<table>
<thead><tr><th>Suite</th><th>Result</th><th>Tests</th><th>Took</th><th>Finished</th><th>Under test</th><th></th></tr></thead>
<tbody>
${reports.map(suiteRow).join('\n')}
</tbody>
</table>
${reports.map(failuresBlock).join('\n')}`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dmi-e2e runs</title>
<style>
  :root { color-scheme: light dark; --ok: #1a7f37; --bad: #cf222e; --muted: #6e7781; --line: #d0d7de; --badge-fg: #fff; }
  @media (prefers-color-scheme: dark) { :root { --ok: #3fb950; --bad: #f85149; --muted: #8b949e; --line: #30363d; } }
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; margin: 2rem auto; max-width: 72rem; padding: 0 1rem; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  .sub { color: var(--muted); margin: 0 0 1.5rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: .5rem .6rem; border-bottom: 1px solid var(--line); vertical-align: top; }
  thead th { color: var(--muted); font-weight: 600; font-size: .8rem; text-transform: uppercase; letter-spacing: .03em; }
  tbody th { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .badge { display: inline-block; padding: .1rem .5rem; border-radius: .3rem; font-size: .75rem; font-weight: 700; color: var(--badge-fg); }
  .badge.passed { background: var(--ok); } .badge.failed { background: var(--bad); } .badge.incomplete { background: var(--muted); }
  .ok { color: var(--ok); } .bad { color: var(--bad); } .muted { color: var(--muted); }
  .versions { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .8rem; white-space: nowrap; }
  .counts { white-space: nowrap; }
  details { margin-top: 1.5rem; }
  summary { cursor: pointer; font-weight: 600; color: var(--bad); }
  .failures { list-style: none; padding: 0; }
  .failures li { margin: .75rem 0; }
  pre { background: rgba(127,127,127,.12); padding: .6rem .8rem; border-radius: .3rem; overflow-x: auto; font-size: .8rem; margin: .3rem 0 0; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
</style>
</head>
<body>
<h1>dmi-e2e runs</h1>
<p class="sub">Latest run of each suite. Index generated <time datetime="${generatedAt}">${generatedAt}</time>.</p>
${body}
<script>
  for (const t of document.querySelectorAll('time[datetime]')) {
    const d = new Date(t.getAttribute('datetime'))
    if (!isNaN(d)) t.textContent = d.toLocaleString()
  }
</script>
</body>
</html>
`
}
