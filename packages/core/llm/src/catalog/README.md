# Model catalogue

`model-catalog.json` is a compacted snapshot of pi's public model catalogue
(https://pi.dev/api/models). It is a reference for filling in a model's context window, output limit,
thinking and image support, and prices (`../model-catalog.ts`). Values are copied into the model
configuration once — when models are imported, or when an entry is picked in the model editor — and
from then on belong to the user: neither settings reads nor catalogue updates change them. The usage
page also uses it to estimate prices for history whose model has no configured price.

The snapshot is only the first-run and offline fallback. The desktop main process loads its cached
copy (`~/.plume/model-catalog.json`) at startup, then fetches the live catalogue every hour and on the
"Update now" action in model settings (`model-catalog-sync.ts` in `@plume/agent`). Requests revalidate with the cached
ETag. A fetched catalogue is compacted and validated as a whole, and only replaces the active one when
its revision differs and it is not older; any failure keeps the current catalogue.

Refresh the bundled snapshot from the repository root with `pnpm catalog:update`. The file records the
upstream revision (`x-pi-model-catalog-revision`) and update time; that revision also goes into price
snapshots and usage cache keys, so a new catalogue reprices estimates.

Only what we use is kept: endpoint base URL, limits, `reasoning`, image input, and text-token prices
in USD per million tokens with cache rates and context tiers. Entries without limits are skipped.
Entries whose four rates are all zero are subscription endpoints and are treated as unpriced, not free.
pi lists coding-agent chat models only, so a filled-in model is taken to support tools.

Automatic matching (imports and the editor's suggested entry): the same model at the same endpoint
(with or without a trailing `/v1`), then the family vendor's entry and OpenRouter as a reference. Full
IDs win before known suffixes such as `preview`, `high`, `thinking` and date stamps are removed;
unknown versions and paid/free variants are not collapsed. Nothing found means the general defaults
(200K window, 32K output, all capabilities on). The wire `modelId` never changes.

Regression coverage lives in `test/model-catalog.test.ts` (synthetic catalogues, independent of the
snapshot's values).
