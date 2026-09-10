'use strict'

/* A jest reporter that writes `<outputDir>/summary.json` when the run completes: counts, timing,
 * every test with its status and duration, and the failed tests with the first lines of their messages. It is the data the run index
 * (src/report/report.ts) renders next to the jest-html-reporters page, so a red is legible from
 * the index without opening the full report.
 *
 * Plain CommonJS on purpose: jest loads custom reporters with a bare require, outside ts-jest's
 * transform, so a .ts reporter would not load. */
const fs = require('fs')
const path = require('path')

/* Strip ANSI colour codes: jest formats failure messages for a terminal. */
function plain (text) {
  return String(text).replace(/\u001b\[[0-9;]*m/g, '')
}

function firstLines (text, max) {
  const lines = plain(text).split('\n').map((line) => line.trimEnd()).filter((line) => line !== '')
  return lines.slice(0, max).join('\n')
}

class SummaryReporter {
  constructor (_globalConfig, options) {
    this.outputDir = (options && options.outputDir) || process.cwd()
  }

  onRunComplete (_contexts, results) {
    const failures = []
    const tests = []
    for (const file of results.testResults) {
      const relativeFile = path.relative(process.cwd(), file.testFilePath)
      for (const test of file.testResults) {
        /* Every test, not just the failed ones: the index lists what a green run actually checked. */
        tests.push({
          name: test.fullName,
          title: test.title,
          ancestors: test.ancestorTitles,
          file: relativeFile,
          status: test.status,
          durationMs: test.duration == null ? null : Math.round(test.duration),
        })
        if (test.status !== 'failed') continue
        failures.push({
          name: test.fullName,
          file: relativeFile,
          message: firstLines(test.failureMessages.join('\n'), 6),
        })
      }
      /* A suite that failed to even run (syntax error, throw at module scope) has no per-test
       * entries; surface it as a failure rather than letting it vanish from the counts. */
      if (file.testExecError != null || (file.failureMessage != null && file.testResults.length === 0)) {
        const reason = file.failureMessage || (file.testExecError && file.testExecError.message) || 'unknown'
        failures.push({
          name: `(suite failed to run) ${relativeFile}`,
          file: relativeFile,
          message: firstLines(reason, 6),
        })
      }
    }

    /* Not `results.success`: jest computes that AFTER the reporters' onRunComplete returns, so at
     * this point it still holds its initial `false` and a fully green run would be reported red.
     * This mirrors jest's own formula (TestScheduler), minus reporter errors, which are unknowable
     * from inside a reporter. */
    const success =
      results.numFailedTests === 0 &&
      results.numRuntimeErrorTestSuites === 0 &&
      !(results.snapshot && results.snapshot.failure) &&
      !results.wasInterrupted &&
      results.runExecError == null

    const finishedAt = Date.now()
    const summary = {
      startedAt: new Date(results.startTime).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      durationMs: finishedAt - results.startTime,
      success,
      total: results.numTotalTests,
      passed: results.numPassedTests,
      failed: results.numFailedTests,
      skipped: results.numPendingTests,
      todo: results.numTodoTests,
      suitesFailedToRun: results.numRuntimeErrorTestSuites,
      failures,
      tests,
    }

    fs.mkdirSync(this.outputDir, { recursive: true })
    fs.writeFileSync(path.join(this.outputDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
  }
}

module.exports = SummaryReporter
