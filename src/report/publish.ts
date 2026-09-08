import { env } from '../env'
import { buildIndex, publish, readSuites } from './report'

/* `npm run report:publish [suite...]` — copy the local run reports into the directory an nginx
 * serves (HARNESS_REPORT_PUBLISH_DIR) and rebuild the index there. With no arguments, every suite
 * that has a local report is published; the harness itself publishes only the suite that just ran,
 * and only under HARNESS_PUBLISH_REPORT=1. */
const requested = process.argv.slice(2)
const local = readSuites(env.report.dir).map((report) => report.suite)
const suites = requested.length > 0 ? requested : local

if (suites.length === 0) {
  console.error(`no run reports under ${env.report.dir} — run the harness first`)
  process.exit(1)
}
const missing = suites.filter((suite) => !local.includes(suite))
if (missing.length > 0) {
  console.error(`no local report for ${missing.join(', ')} (have: ${local.join(', ') || 'none'})`)
  process.exit(1)
}

buildIndex(env.report.dir)
const { publishDir, published } = publish(suites)
console.log(`published ${published.join(', ')} to ${publishDir}`)
