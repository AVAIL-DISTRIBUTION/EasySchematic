# library/catalog — AVAIL product catalog (cards, ports pending)

One JSON file per manufacturer part number, in the EasySchematic DeviceTemplate format.
Source: avail-products-extron-biamp.xlsx (engineers' Extron and Biamp tables, reviewed by AVAIL).

- `ports` is empty for now: ports are added later, in these same files.
- Standard fields: label, shortName, manufacturer, modelNumber (part number), deviceType,
  category, referenceUrl, searchTerms, dimensions, power, PoE, thermalBtuh,
  rackForm (full / half / shelf-only), slotFamily (cards).
- `_avail` (not part of the upstream schema): status `awaiting-ports`, variant, altPartNumber,
  rackFormSource and rackUnits, slotFamilies (chassis; slot definitions come with the ports),
  cardFamilies (cards that fit more than one family), deviceTypeSource, description, notes, source.
- No prices: the repository is public, so no unitCost / MSRP / price fields (`npm run avail:check-library` fails on them).
- `index.json`: list of all files with id, label, part number, device type, category.
- ids: `avail-<vendor>-<part-number>`, stable across re-exports.
