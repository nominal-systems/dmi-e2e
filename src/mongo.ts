import { Document, MongoClient, MongoServerError } from 'mongodb'
import { env } from './env'

/* Direct Mongo access for failure injection: the Mongo counterpart of src/sql.ts. Raw `mongodb`
 * driver by design: no Mongoose, no dmi-api schemas. It reads and writes no documents. It arms and
 * clears the server's `failCommand` failpoint, so a scenario can make one of dmi-api's own writes
 * fail the way the production event store fails it, and then read back how many times dmi-api
 * tried. Every collection a scenario names here is dmi-api's own (`events_v2` is its event store,
 * `counters` holds the event sequence), so a rename breaks this loudly rather than silently: a
 * failpoint scoped to a collection nobody writes any more is never hit, and the scenario's hit count
 * goes red. Like sql.ts, this is a sanctioned
 * crack in the black box; dmi-api is still only ever driven over HTTP.
 *
 * Failpoints are a test-only server facility. The harness's Mongo is started with
 * `--setParameter enableTestCommands=1` (docker-compose.yml) for exactly this; a Mongo started
 * without it refuses `configureFailPoint`, and the call below then throws, naming the flag. */

/* The error code Azure Cosmos DB's Mongo API raises when it throttles a request (its HTTP 429). */
export const THROTTLED = 16500

let client: MongoClient | undefined

/* The failpoint's running hit total when failCommand last armed it (see clearFailPoints). */
let totalWhenArmed: number | undefined

/* Lazy, like sql.ts's pool: a scenario that never injects a failure never connects. The driver
 * connects on first use. */
export function getMongo (): MongoClient {
  if (client == null) {
    client = new MongoClient(env.mongoUri, { serverSelectionTimeoutMS: 10_000 })
  }
  return client
}

export async function closeMongo (): Promise<void> {
  if (client != null) {
    await client.close()
    client = undefined
  }
}

/* Every configureFailPoint reply carries `count`: the number of commands the failpoint has failed
 * since the server started. It is a running total: arming or disarming the failpoint does not reset
 * it. Returns that total. */
async function configureFailCommand (spec: Document): Promise<number> {
  let reply: Document
  try {
    reply = await getMongo().db('admin').command({ configureFailPoint: 'failCommand', ...spec })
  } catch (error) {
    /* 59 is CommandNotFound: test commands are off, so the server does not know the command. */
    if (error instanceof MongoServerError && (error.code === 59 || /no such (cmd|command)/i.test(error.message))) {
      throw new Error(
        `The Mongo at ${env.mongoUri} refused configureFailPoint (${error.message}): it was started ` +
          'without test commands. The harness starts its own with --setParameter ' +
          'enableTestCommands=1 (docker-compose.yml); with HARNESS_MANAGE_CONTAINERS=0, start yours ' +
          'with that flag too.',
      )
    }
    throw error
  }
  if (typeof reply.count !== 'number') {
    throw new Error(`configureFailPoint answered without a hit count: ${JSON.stringify(reply)}`)
  }
  return reply.count
}

/* Make the next `times` runs of `command` (the server's command name: `insert`, `findAndModify`,
 * ...) on `<database of env.mongoUri>.<collection>` fail with `errorCode`, before anything is
 * written. The same command on any other collection, and any other command, is untouched. The
 * server disarms the failpoint by itself after the last of them; clearFailPoints() disarms it
 * sooner. Mongo 4.4 ignores a custom error message, so the error dmi-api sees always reads "Failing
 * command due to 'failCommand' failpoint", with the code given here. (A code whose error must carry
 * extra information, such as 11000, DuplicateKey, makes the server fail the command with 40671
 * instead.) */
export async function failCommand (
  collection: string,
  command: string,
  times: number,
  errorCode = THROTTLED,
): Promise<void> {
  const namespace = `${getMongo().db().databaseName}.${collection}`
  totalWhenArmed = await configureFailCommand({
    mode: { times },
    data: { failCommands: [command], errorCode, namespace },
  })
}

/* Make the next `times` inserts into `collection` fail with `errorCode` (see failCommand). */
export async function failInserts (collection: string, times: number, errorCode = THROTTLED): Promise<void> {
  await failCommand(collection, 'insert', times, errorCode)
}

/* Disarm the failpoint, and return how many commands it failed since failCommand last armed it (0
 * if it was not armed from here): the difference between the running totals the two replies carry.
 * Only commands the failpoint matched and failed count, so after failCommand(c, cmd, n) this is the
 * number of `cmd` attempts on c that were refused: at most n, and attempts after the n-th went
 * through. */
export async function clearFailPoints (): Promise<number> {
  const total = await configureFailCommand({ mode: 'off' })
  const hits = totalWhenArmed == null ? 0 : total - totalWhenArmed
  totalWhenArmed = undefined
  return hits
}
