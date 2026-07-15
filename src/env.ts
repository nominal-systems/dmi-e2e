import { existsSync } from 'fs'
import * as path from 'path'

/* Harness configuration, resolved once from process.env against defaults that match
 * docker-compose.yml. This repo has no dependency on dmi-api's source: it locates a dmi-api
 * checkout on disk purely to bootstrap it (build, migrate, run), never to import from it. */

function str (name: string, fallback: string): string {
  const value = process.env[name]
  return value == null || value === '' ? fallback : value
}

function int (name: string, fallback: number): number {
  const value = process.env[name]
  if (value == null || value === '') return fallback
  const parsed = Number(value)
  if (Number.isNaN(parsed)) throw new Error(`${name} must be a number, got '${value}'`)
  return parsed
}

function flag (name: string, fallback: boolean): boolean {
  const value = process.env[name]
  if (value == null || value === '') return fallback
  return value === '1' || value.toLowerCase() === 'true'
}

export interface MysqlEnv {
  host: string
  port: number
  user: string
  password: string
  database: string
}

export interface HarnessEnv {
  /* Root of this repo (dmi-e2e). */
  harnessRoot: string
  /* Root of a dmi-api checkout. Only used for process orchestration. */
  dmiApiDir: string
  composeFile: string
  /* Host that published container ports are reachable on. A single knob (default 127.0.0.1) so the
   * suite can run against a remote docker host unchanged; the per-service *_HOST vars default to it. */
  host: string
  appPort: number
  baseUrl: string
  admin: { username: string, password: string }
  /* aes-256-ctr keys dmi-api's provider-configuration encryption; must be exactly 32 bytes. */
  secretKey: string
  jwtSecretKey: string
  mysql: MysqlEnv
  mongoUri: string
  activemq: { hostname: string, port: number }
  /* HARNESS_FULL_STACK=1 selects the full-system suite: dmi-api under a normal NODE_ENV against the
   * real demo provider stack (redis + demo-provider-api + demo integration), instead of the default
   * fast suite (NODE_ENV=seed, dmi-api alone). */
  fullStack: boolean
  demoProvider: {
    /* Host-facing base URL (published port), used by the harness to mint an API key. Includes the
     * demo-provider-api's `/demo` global prefix. */
    baseUrl: string
    /* Compose-network base URL the integration container uses to reach the vendor. Stored verbatim
     * in the dmi-api provider configuration, so it must resolve inside the compose network. */
    internalUrl: string
  }
  /* Orchestration. Set HARNESS_BASE_URL to point at a dmi-api you started yourself, in which case
   * the harness neither builds nor spawns one, and never touches DMI_API_DIR. */
  manageContainers: boolean
  manageApp: boolean
  build: boolean
  keepUp: boolean
  timeouts: { depsReadyMs: number, appReadyMs: number, requestMs: number, migrationsMs: number }
}

const harnessRoot = path.resolve(__dirname, '..')
const host = str('HARNESS_HOST', '127.0.0.1')
const appPort = int('HARNESS_APP_PORT', 3010)
const demoProviderPort = int('HARNESS_DEMO_PROVIDER_PORT', 3011)
const explicitBaseUrl = process.env.HARNESS_BASE_URL

export const env: HarnessEnv = {
  harnessRoot,
  dmiApiDir: path.resolve(str('DMI_API_DIR', path.join(harnessRoot, '..', 'dmi-api'))),
  composeFile: path.join(harnessRoot, 'docker-compose.yml'),
  host,
  appPort,
  baseUrl: str('HARNESS_BASE_URL', `http://${host}:${appPort}`),
  admin: {
    username: str('HARNESS_ADMIN_USERNAME', 'admin'),
    password: str('HARNESS_ADMIN_PASSWORD', 'admin'),
  },
  secretKey: str('HARNESS_SECRET_KEY', 'harness_secret_key_exactly_32_by'),
  jwtSecretKey: str('HARNESS_JWT_SECRET_KEY', 'harness-jwt-secret'),
  mysql: {
    host: str('HARNESS_MYSQL_HOST', host),
    port: int('HARNESS_MYSQL_PORT', 3307),
    user: str('HARNESS_MYSQL_USER', 'root'),
    password: str('HARNESS_MYSQL_PASSWORD', 'harness'),
    database: str('HARNESS_MYSQL_DATABASE', 'dmi_harness'),
  },
  mongoUri: str(
    'HARNESS_MONGO_URI',
    `mongodb://${host}:${int('HARNESS_MONGO_PORT', 27018)}/dmi_harness`,
  ),
  activemq: {
    hostname: str('HARNESS_ACTIVEMQ_HOST', host),
    port: int('HARNESS_ACTIVEMQ_PORT', 1884),
  },
  fullStack: flag('HARNESS_FULL_STACK', false),
  demoProvider: {
    baseUrl: str('HARNESS_DEMO_PROVIDER_URL', `http://${host}:${demoProviderPort}/demo`),
    internalUrl: str('HARNESS_DEMO_PROVIDER_INTERNAL_URL', 'http://dmi-demo-provider-api:3000/demo'),
  },
  manageContainers: flag('HARNESS_MANAGE_CONTAINERS', true),
  manageApp: flag('HARNESS_MANAGE_APP', explicitBaseUrl == null),
  build: flag('HARNESS_BUILD', true),
  keepUp: flag('HARNESS_KEEP_UP', false),
  timeouts: {
    depsReadyMs: int('HARNESS_DEPS_READY_MS', 180_000),
    appReadyMs: int('HARNESS_APP_READY_MS', 180_000),
    requestMs: int('HARNESS_REQUEST_MS', 30_000),
    /* Cold-start migrations are slow: dmi-api ships large data migrations (breed/ref tables,
     * hundreds of thousands of rows) that TypeORM logs line by line. Generous by default. */
    migrationsMs: int('HARNESS_MIGRATIONS_MS', 900_000),
  },
}

if (Buffer.byteLength(env.secretKey, 'utf8') !== 32) {
  throw new Error(
    `HARNESS_SECRET_KEY must be exactly 32 bytes (aes-256-ctr), got ${Buffer.byteLength(env.secretKey, 'utf8')}`,
  )
}

/* Called only on the paths that actually need a checkout, so `HARNESS_BASE_URL=... npm test`
 * against an already-running dmi-api works with no checkout present at all. */
export function requireDmiApiDir (): string {
  if (!existsSync(path.join(env.dmiApiDir, 'package.json'))) {
    throw new Error(
      `No dmi-api checkout at ${env.dmiApiDir}. Set DMI_API_DIR, or set HARNESS_BASE_URL to ` +
        'point at a dmi-api you are running yourself.',
    )
  }
  if (!existsSync(path.join(env.dmiApiDir, 'node_modules'))) {
    throw new Error(
      `${env.dmiApiDir} has no node_modules. Run 'npm install' there first — it needs a ` +
        'GHP_TOKEN with read:packages, because dmi-api resolves @nominal-systems/* from GitHub ' +
        'Packages. See the README.',
    )
  }
  return env.dmiApiDir
}

/* Environment handed to dmi-api's `migration:run` and to the app process. dotenv (via dmi-api's
 * loadEnv) never overwrites keys already present in the environment, so these win over any .env the
 * checkout happens to have.
 *
 * Fast mode (default): NODE_ENV=seed is load-bearing — dmi-api's orders.service short-circuits
 * before the MQTT round-trip to the engine, which is not part of that suite.
 *
 * Full-stack mode (HARNESS_FULL_STACK=1): a normal NODE_ENV so createOrder actually RPCs the engine
 * over MQTT, and a modest ENGINE_RESPONSE_TIMEOUT so an unanswered engine fails in ~10s rather than
 * hanging for dmi-api's 90s default. 'development' (not 'production') keeps fastify cookies non-
 * secure over the harness's plain HTTP; only `=== 'seed'` changes order behaviour, so any non-seed
 * value is "normal" here. */
export function appEnv (): NodeJS.ProcessEnv {
  const { fullStack } = env
  return {
    ...process.env,
    NODE_ENV: fullStack ? 'development' : 'seed',
    PORT: String(env.appPort),
    BASE_URL: '',
    JWT_SECRET_KEY: env.jwtSecretKey,
    SECRET_KEY: env.secretKey,
    ADMIN_AUTH_STRATEGY: 'jwt',
    ADMIN_USERNAME: env.admin.username,
    ADMIN_PASSWORD: env.admin.password,
    DATABASE_TYPE: 'mysql',
    DATABASE_HOST: env.mysql.host,
    DATABASE_PORT: String(env.mysql.port),
    DATABASE_USERNAME: env.mysql.user,
    DATABASE_PASSWORD: env.mysql.password,
    DATABASE_DATABASE: env.mysql.database,
    DATABASE_SYNCHRONIZE: 'false',
    DATABASE_RUN_MIGRATIONS: 'false',
    DATABASE_LOGGING: 'false',
    MONGO_URI: env.mongoUri,
    ACTIVEMQ_PROTOCOL: 'mqtt',
    ACTIVEMQ_HOSTNAME: env.activemq.hostname,
    ACTIVEMQ_PORT: String(env.activemq.port),
    ACTIVEMQ_USERNAME: '',
    ACTIVEMQ_PASSWORD: '',
    STATSIG_ENABLED: 'false',
    /* Fast mode: the engine is absent; fail fast. Full-stack: a real engine RPC round-trips, so
     * allow ~10s (still well under the 90s default) before giving up on it. */
    ENGINE_RESPONSE_TIMEOUT: fullStack ? '10000' : '2000',
  }
}
