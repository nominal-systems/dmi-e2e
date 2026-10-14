import { ApiResponse } from '../src/api-client'
import { clearFailPoints, closeMongo, failCommand, failInserts } from '../src/mongo'
import { orderPayload, seed, SeededContext } from '../src/seed'
import { closePool } from '../src/sql'

/* Regression guard (dmi-api#371): an order survives its event store throttling the order:created
 * write.
 *
 * `POST /orders` saves the order in MySQL (status ACCEPTED), inserts an `order:created` event into
 * Mongo's `events_v2`, and only then sends the order to the provider's engine. In production that
 * collection lives in Azure Cosmos DB's Mongo API, which throttles a write by failing it with code
 * 16500. Before the fix nothing retried that, the error escaped `createOrder`, the caller got a 500,
 * and the order stayed ACCEPTED in MySQL without ever being sent. Now dmi-api retries the event's
 * whole `create` (three attempts in all, waiting as long as the error asks), and an event that still
 * fails is logged with the order id and does not fail the request.
 *
 * The harness's Mongo plays the throttling store through the `failCommand` failpoint (src/mongo.ts;
 * the flag that allows it is in docker-compose.yml): the next n runs of one command on one
 * collection fail with code 16500, and nothing is written. The failpoint's hit count is how a test
 * sees how many times dmi-api tried. Mongo 4.4 cannot put a wait hint in the error message, so the
 * hint parsing, like the waits themselves, is left to dmi-api's unit tests; each retry here waits
 * the fix's no-hint fallback, which is why the throttled tests get a longer timeout. This suite runs
 * under NODE_ENV=seed, where `createOrder` returns before the engine round-trip, so "and is sent" is
 * outside it: what is proven is that the request no longer fails and that the retry really happens.
 * The idexx loop's last test (scenarios/idexx-full-stack.e2e.ts) proves the order is still sent. */

/* Never sent to a provider under NODE_ENV=seed; it only has to be present (see tenant-isolation). */
const ANY_TEST_CODE = [{ code: 'HARNESS-EVENT-STORE-THROTTLING' }]

/* dmi-api's event collection, as its Event schema names it. */
const EVENTS = 'events_v2'

/* Where dmi-api's event `seq` counter lives: the mongoose-sequence plugin's default collection, which
 * dmi-api's events module does not rename. */
const COUNTERS = 'counters'

/* What POST /orders answers an accepted order with; the control test pins it with no failpoint armed. */
const CREATED = 201

interface FeedEvent {
  type: string
  accessionId: string
  data?: { orderId?: string }
}

describe('event store throttling (dmi-api#371)', () => {
  let ctx: SeededContext

  beforeAll(async () => {
    /* Also the loud failure for a Mongo started without test commands: this throws, naming the
     * flag, before any test runs. */
    await clearFailPoints()
    ctx = await seed()
  }, 120_000)

  /* A test that fails midway must not leave inserts failing for the next one. */
  afterEach(async () => {
    await clearFailPoints()
  })

  afterAll(async () => {
    await closeMongo()
    await closePool()
  })

  async function placeOrder (): Promise<{ response: ApiResponse, requisitionId: string }> {
    const payload = orderPayload(ctx.orgA.integrationId, { testCodes: ANY_TEST_CODE })
    const response = await ctx.orgA.api.post('/orders', payload)
    return { response, requisitionId: payload.requisitionId as string }
  }

  /* The order a POST /orders created. Status and error message are compared together, so a refusal
   * goes red naming dmi-api's status and the error behind it, not a bare "expected 201". */
  function expectCreated (response: ApiResponse): { id: string } {
    expect({ status: response.status, message: response.ok ? undefined : response.body?.message })
      .toEqual({ status: CREATED, message: undefined })
    return response.body
  }

  /* The order as dmi-api now reads it back: it was recorded, and it is still ACCEPTED. */
  async function expectAccepted (orderId: string): Promise<void> {
    const response = await ctx.orgA.api.get(`/orders/${orderId}`)
    expect(response.status).toBe(200)
    expect({ id: response.body.id, status: response.body.status }).toEqual({ id: orderId, status: 'ACCEPTED' })
  }

  /* The org's event feed, narrowed to the order:created events for one order, each reduced to the
   * two fields that tie it to the order (dmi-api files the requisition id as the accession id). The
   * org is this file's own (seed() makes fresh ones), so its feed holds only the orders placed here. */
  async function orderCreatedEventsFor (orderId: string): Promise<Array<{ orderId?: string, accessionId: string }>> {
    const response = await ctx.orgA.api.get('/events', { start_seq: 0, limit: 100 })
    expect(response.status).toBe(200)
    return (response.body.data as FeedEvent[])
      .filter((event) => event.type === 'order:created' && event.data?.orderId === orderId)
      .map((event) => ({ orderId: event.data?.orderId, accessionId: event.accessionId }))
  }

  /* Exactly one order:created for the order: none means it was never recorded, two that a retry
   * wrote it twice. */
  async function expectOrderCreatedEvent (orderId: string, requisitionId: string): Promise<void> {
    expect(await orderCreatedEventsFor(orderId)).toEqual([{ orderId, accessionId: requisitionId }])
  }

  /* Proves the path is live: with no failpoint, the order is accepted and its order:created is in
   * the feed. Without it, an empty feed would satisfy the "no event" assertion below for the wrong
   * reason. */
  it('control: an accepted order has its order:created in the event feed', async () => {
    const { response, requisitionId } = await placeOrder()

    const order = expectCreated(response)
    await expectAccepted(order.id)
    await expectOrderCreatedEvent(order.id, requisitionId)
  })

  /* Two throttled attempts, then the store lets the third through: the request succeeds, and the
   * event is recorded once, by the third attempt. */
  it('an order:created insert throttled twice is retried until it is recorded', async () => {
    await failInserts(EVENTS, 2)

    const { response, requisitionId } = await placeOrder()
    const refused = await clearFailPoints()

    const order = expectCreated(response)
    await expectAccepted(order.id)
    await expectOrderCreatedEvent(order.id, requisitionId)
    expect(refused).toBe(2)
  }, 30_000)

  /* The event's insert is not its only write. Before it, mongoose-sequence's pre('save') hook takes
   * the event's `seq` with a findAndModify on `counters`, and a throttled counter write fails the
   * create just as a throttled insert does. The fix retries the whole create, hook included, so the
   * counter write is retried too; this is the only place that is proven end to end. A refused
   * attempt stops at the counter, before its insert, so the event is written once, by the third. */
  it('a throttled sequence-counter write is retried with the rest of the event', async () => {
    await failCommand(COUNTERS, 'findAndModify', 2)

    const { response, requisitionId } = await placeOrder()
    const refused = await clearFailPoints()

    const order = expectCreated(response)
    await expectAccepted(order.id)
    await expectOrderCreatedEvent(order.id, requisitionId)
    expect(refused).toBe(2)
  }, 30_000)

  /* The store keeps refusing: dmi-api stops after three attempts and gives up on the event, not on
   * the order. The event is not written anywhere else (a later order:updated carries the order), so
   * the feed has none for it. The failpoint was armed for five, so a fourth attempt would have been
   * refused too and counted. */
  it('an order:created insert that stays throttled is tried three times, and the order is still accepted', async () => {
    await failInserts(EVENTS, 5)

    const { response } = await placeOrder()
    const refused = await clearFailPoints()

    const order = expectCreated(response)
    await expectAccepted(order.id)
    expect(await orderCreatedEventsFor(order.id)).toEqual([])
    expect(refused).toBe(3)

    /* The store is healthy again once the throttling stops: the next order's event is recorded, and
     * the same feed that had nothing for the order above lists it. */
    const next = await placeOrder()
    const nextOrder = expectCreated(next.response)
    await expectOrderCreatedEvent(nextOrder.id, next.requisitionId)
  }, 30_000)
})
