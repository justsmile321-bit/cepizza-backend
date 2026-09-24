// Delivery radius check. Uses the free US Census geocoder (no API key) to find the address,
// then measures straight-line distance from the shop.
const RADIUS = () => Number(process.env.DELIVERY_RADIUS_MILES ?? 5);
const SHOP_ADDRESS = () => process.env.SHOP_ADDRESS || '1111 Burnside Ave, East Hartford, CT 06108';

async function geocode(address) {
  const url = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=Public_AR_Current&format=json&address=' +
    encodeURIComponent(address);
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const m = (await r.json())?.result?.addressMatches?.[0];
    return m ? { lat: m.coordinates.y, lon: m.coordinates.x } : null;
  } catch { return null; }
}

function miles(a, b) {
  const rad = (d) => (d * Math.PI) / 180, R = 3958.8;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

let shopPoint = null;
async function shop() {
  if (shopPoint) return shopPoint;
  if (process.env.SHOP_LAT && process.env.SHOP_LON) shopPoint = { lat: Number(process.env.SHOP_LAT), lon: Number(process.env.SHOP_LON) };
  else shopPoint = await geocode(SHOP_ADDRESS());
  return shopPoint;
}

/** Returns { ok, miles, message }. appLat/appLon (from the iPhone's geocoder) are a fallback only. */
async function checkDelivery(address, appLat, appLon) {
  const s = await shop();
  if (!s) return { ok: false, message: 'We could not check the delivery distance right now. Please try again or call us.' };
  let point = await geocode(address);
  if (!point && Number.isFinite(appLat) && Number.isFinite(appLon)) point = { lat: appLat, lon: appLon };
  if (!point) return { ok: false, message: 'We could not find that delivery address. Please include street, town and ZIP.' };
  const d = Math.round(miles(s, point) * 10) / 10;
  if (d > RADIUS()) return { ok: false, miles: d, message: `Sorry, that address is ${d} miles away. We only deliver within ${RADIUS()} miles — please choose pickup.` };
  return { ok: true, miles: d };
}

module.exports = { checkDelivery, miles };
