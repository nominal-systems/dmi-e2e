import { env } from './env'

/* A thin, immutable HTTP client for the three auth schemes dmi-api exposes: HTTP Basic (admin,
 * for /users), Bearer/JWT (for /organizations), and X-API-Key (the data plane). It speaks only
 * HTTP — no dmi-api source, no supertest, no in-process app instance. */

export type Json = any

export interface ApiResponse<T = Json> {
  status: number
  ok: boolean
  body: T
  text: string
  headers: Record<string, string>
}

export type Query = Record<string, string | number | boolean | undefined>

export class ApiClient {
  private constructor (
    private readonly baseUrl: string,
    private readonly authHeaders: Record<string, string>,
  ) {}

  static create (baseUrl: string = env.baseUrl): ApiClient {
    return new ApiClient(baseUrl.replace(/\/+$/, ''), {})
  }

  /* Each of these returns a new client, so a single seeded context can hand out `orgA.api` /
   * `orgB.api` views without any risk of one test mutating another's credentials. */
  anonymous (): ApiClient {
    return new ApiClient(this.baseUrl, {})
  }

  withBasicAuth (username: string, password: string): ApiClient {
    const encoded = Buffer.from(`${username}:${password}`, 'utf8').toString('base64')
    return new ApiClient(this.baseUrl, { authorization: `Basic ${encoded}` })
  }

  withBearer (token: string): ApiClient {
    return new ApiClient(this.baseUrl, { authorization: `Bearer ${token}` })
  }

  withApiKey (apiKey: string): ApiClient {
    return new ApiClient(this.baseUrl, { 'x-api-key': apiKey })
  }

  async get<T = Json> (path: string, query?: Query): Promise<ApiResponse<T>> {
    return await this.request<T>('GET', path, { query })
  }

  async post<T = Json> (path: string, body?: Json, query?: Query): Promise<ApiResponse<T>> {
    return await this.request<T>('POST', path, { body, query })
  }

  async put<T = Json> (path: string, body?: Json): Promise<ApiResponse<T>> {
    return await this.request<T>('PUT', path, { body })
  }

  async delete<T = Json> (path: string): Promise<ApiResponse<T>> {
    return await this.request<T>('DELETE', path, {})
  }

  private async request<T> (
    method: string,
    path: string,
    { body, query }: { body?: Json, query?: Query },
  ): Promise<ApiResponse<T>> {
    const url = new URL(`${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }

    const headers: Record<string, string> = { accept: 'application/json', ...this.authHeaders }
    if (body !== undefined) headers['content-type'] = 'application/json'

    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(env.timeouts.requestMs),
    })

    const text = await response.text()
    let parsed: T = undefined as unknown as T
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text) as T
      } catch {
        /* Non-JSON body (a PDF, an HTML error page). Callers get it via `text`. */
      }
    }

    const responseHeaders: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value
    })

    return { status: response.status, ok: response.ok, body: parsed, text, headers: responseHeaders }
  }
}

/* Seeding must fail loudly and legibly: a silent 400 three steps up produces a baffling failure
 * in the scenario rather than at the point of the mistake. */
export function expectOk<T> (response: ApiResponse<T>, what: string): T {
  if (!response.ok) {
    throw new Error(`${what} failed: HTTP ${response.status} — ${response.text.slice(0, 500)}`)
  }
  return response.body
}
