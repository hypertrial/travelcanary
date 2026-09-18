export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function productionPointer(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
      && url.pathname.endsWith("/catalogs/3/publication/latest.json") ? url : null;
  } catch { return null; }
}

export function GET() {
  if (process.env.TRAVELCANARY_RUNTIME === "local") {
    return new Response(null, { status: 307, headers: { Location: "/live/catalogs/3/publication/latest.json" } });
  }
  if (process.env.VERCEL_ENV !== "production") {
    return new Response(null, { status: 307, headers: { Location: "/catalogs/3/publication/latest.json" } });
  }
  const pointer = productionPointer(process.env.TRAVELCANARY_PUBLICATION_URL);
  return pointer ? Response.redirect(pointer, 307)
    : Response.json({ error: "Public data is unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
}
