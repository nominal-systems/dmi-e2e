import { ApiClient, expectOk } from './api-client'

/* Canonical dmi ref codes (species, sexes, breeds) are opaque UUIDs. A scenario that wants to
 * exercise dmi-api's ref mapping — the transformation from a canonical code to the provider's own
 * vocabulary on the way to the engine — has to place its order with one of those codes, and a UUID
 * hard-coded in a test rots silently. So the code is looked up BY NAME over `GET /refs/<kind>`, with
 * the org's own API key: the same route an integrator would use to discover it.
 *
 * Two things the caller still owns, because they are provider-specific: which fields the provider
 * maps at all (check its provider_ref rows, not just its reference endpoints), and picking a ref
 * whose provider code is spelled differently from its dmi name — otherwise the assertion that the
 * provider's vocabulary arrived at the mock cannot fail. See CLAUDE.md, "Ref-mapped fields need
 * value assertions". */

export interface RefItem { code: string, name: string }

/* The `GET /refs/<kind>` collections dmi-api exposes. */
export type RefKind = 'species' | 'sexes' | 'breeds'

/* Resolve a canonical dmi ref code by its human-readable name. Throws loudly rather than returning
 * undefined: if the seed data ever stops carrying this ref, the scenario must fail at setup with a
 * message that says so, not place an order with `undefined` and fail somewhere confusing. */
export function refCodeByName (items: RefItem[], name: string, kind: RefKind): string {
  const matches = items.filter((item) => item.name === name)
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one dmi ref named '${name}' in /refs/${kind}, found ${matches.length}. ` +
        'dmi-api\'s ref seed data has changed; pick another ref whose provider code differs from its dmi name.',
    )
  }
  return matches[0].code
}

/* Fetch the collection as the org and resolve one ref by name. */
export async function lookupRefCode (api: ApiClient, kind: RefKind, name: string): Promise<string> {
  const { items } = expectOk<{ items: RefItem[] }>(await api.get(`/refs/${kind}`), `list dmi ${kind} refs`)
  return refCodeByName(items, name, kind)
}
