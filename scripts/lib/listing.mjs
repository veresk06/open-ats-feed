// Does the Apify store listing still describe the product we ship?
//
// `apify push` uploads source and builds an image. It does NOT write title, description,
// seoTitle or seoDescription from .actor/actor.json onto the Actor record — those are set at
// creation or by hand in Console and then never move. Ours said "10,197 verified company boards
// on Greenhouse, Ashby and Lever" for roughly thirty-five cycles while the Actor shipped six
// providers and 18,164 boards, understating the product by 44% on the surface a buyer reads
// first. A successful build looks identical either way, which is why nobody noticed.
//
// So the roster is the source of truth and the listing is checked against it every cycle.
// Length caps the API enforces and the docs do not mention: description 300, seoDescription 200.
// See docs/devops/apify-listing-metadata.md.

export const LISTING_FIELDS = ['title', 'description', 'seoTitle', 'seoDescription']

// Returns the field names that disagree with the roster. Empty means the listing is honest.
export function staleListingFields(record, { rosterText, providers }) {
  return LISTING_FIELDS.filter((field) => {
    const value = record?.[field] ?? ''
    // The two long fields carry the headline count and must agree with the roster.
    if ((field === 'description' || field === 'seoDescription') && !value.includes(rosterText)) {
      return true
    }
    // A field that names no provider is making no claim to be wrong about.
    if (!providers.some((p) => value.includes(p))) return false
    // A field that names providers must not name a set smaller than what ships. A hedge —
    // "6 ATS", "six platforms", "& 3 More" — counts as naming the full set, because a title
    // has no room for six vendor names and should not be forced to carry them.
    return !providers.every((p) => value.includes(p)) && !/\b(6|six)\b|& 3 more/i.test(value)
  })
}
