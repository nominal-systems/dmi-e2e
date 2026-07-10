import { randomUUID } from 'crypto'
import * as mysql from 'mysql2/promise'
import { env } from './env'

/* Direct MySQL access for setup and assertions that HTTP cannot reach. Raw mysql2 by design: no
 * TypeORM, no dmi-api entities. Every table and column named here is part of dmi-api's
 * migration-defined schema, so a schema change breaks this loudly rather than silently — which is
 * the point. This is the one sanctioned crack in the black box. */

let pool: mysql.Pool | undefined

export function getPool (): mysql.Pool {
  if (pool == null) {
    pool = mysql.createPool({
      host: env.mysql.host,
      port: env.mysql.port,
      user: env.mysql.user,
      password: env.mysql.password,
      database: env.mysql.database,
      connectionLimit: 4,
      timezone: 'Z',
    })
  }
  return pool
}

export async function closePool (): Promise<void> {
  if (pool != null) {
    await pool.end()
    pool = undefined
  }
}

export async function query<T = any> (sql: string, params: any[] = []): Promise<T[]> {
  const [rows] = await getPool().query(sql, params)
  return rows as unknown as T[]
}

/* Reports are only ever created by the engine over MQTT (`handleExternalResults`); no HTTP route
 * creates one. The harness needs a report belonging to a known organization in order to test
 * report access control at all, so it inserts the row directly. dmi-api's `getReport` left-joins
 * patient, testResultsSet and presentedFrom, so leaving those null is fine.
 *
 * Schema (dmi-api migrations/1663613293050-InitialMigration.ts):
 *   report(id char(36) PK, orderId char(36) NOT NULL UNIQUE -> order(id),
 *          status enum('REGISTERED','PARTIAL','FINAL','CANCELLED') DEFAULT 'REGISTERED',
 *          createdAt, updatedAt, patientId char(36) NULL) */
export async function insertReport (orderId: string, status = 'REGISTERED'): Promise<string> {
  const id = randomUUID()
  await query('INSERT INTO `report` (`id`, `orderId`, `status`) VALUES (?, ?, ?)', [
    id,
    orderId,
    status,
  ])
  return id
}

/* F6 workaround. dmi-api's `POST /users` is non-functional — `BasicStrategy` is defined but
 * registered with Passport nowhere, so the endpoint 500s "Unknown authentication strategy basic"
 * (see README). Creating a user is the one step of the documented seed flow the harness cannot
 * drive over HTTP, so it inserts the row directly; everything downstream (login, org, keys,
 * provider config, practice, integration, orders) stays real HTTP.
 *
 * `password` must be an argon2id hash: dmi-api verifies it with `argon2.verify` at
 * `POST /users/auth`, and its `UserSubscriber` — which would hash a plaintext on insert — is
 * bypassed by a raw INSERT. The constant below is `argon2id('harness-password')`; the embedded
 * salt is random but verification is salt- and parameter-independent, so one constant suffices.
 * Regenerate with: node -e "const a=require('argon2');a.hash('harness-password',{type:a.argon2id}).then(console.log)". */
export const HARNESS_USER_PASSWORD = 'harness-password'
const HARNESS_USER_PASSWORD_HASH =
  '$argon2id$v=19$m=4096,t=3,p=1$L7qY2hNdZ3GO+Sq8UUwtiw$nEzYjyCkVxpn0l6bJUlP0fX965jf8owcWVbUOf+UMvc'

export async function insertUser (email: string): Promise<string> {
  const id = randomUUID()
  await query('INSERT INTO `user` (`id`, `email`, `password`) VALUES (?, ?, ?)', [
    id,
    email,
    HARNESS_USER_PASSWORD_HASH,
  ])
  return id
}

export async function countOrdersForOrganization (organizationId: string): Promise<number> {
  const rows = await query<{ count: number }>(
    'SELECT COUNT(*) AS count FROM `order` o' +
      ' JOIN `integration` i ON i.`id` = o.`integrationId`' +
      ' JOIN `provider_configuration` pc ON pc.`id` = i.`providerConfigurationId`' +
      ' WHERE pc.`organizationId` = ?',
    [organizationId],
  )
  return Number(rows[0]?.count ?? 0)
}

/* Poll until MySQL accepts a connection and the harness database exists. Container "started" is
 * not the same as "mysqld is accepting connections" — mysql:8 restarts the server once during
 * first-boot initialisation, so a single successful connect can still be followed by a refusal. */
export async function waitForMysql (timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    let connection: mysql.Connection | undefined
    try {
      connection = await mysql.createConnection({
        host: env.mysql.host,
        port: env.mysql.port,
        user: env.mysql.user,
        password: env.mysql.password,
        database: env.mysql.database,
        connectTimeout: 3000,
      })
      await connection.query('SELECT 1')
      await connection.end()
      return
    } catch (error) {
      lastError = error
      if (connection != null) await connection.end().catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }
  throw new Error(
    `MySQL at ${env.mysql.host}:${env.mysql.port} not ready within ${timeoutMs}ms: ${String(lastError)}`,
  )
}
