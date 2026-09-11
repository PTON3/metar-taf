// The GFA (Graphical Forecast for Aviation) raster products — thunderstorms, weather type,
// turbulence, icing — are published per model-run cycle (roughly every 3 hours) as static GIFs
// named by that cycle's date/hour, not by "now". This mirrors the same lookup the GFA web tool
// itself makes (aviationweather.gov/api/info/gfa) to find the current cycle before building the
// image URL client-side. Proxied server-side for the same CORS reason as the other
// aviationweather.gov routes in this app.

export async function GET() {
    try {
        const response = await fetch("https://aviationweather.gov/api/info/gfa", {
            next: { revalidate: 300 },
        });
        if (!response.ok) {
            return Response.json({ error: "Unable to fetch the current GFA cycle." }, { status: 502 });
        }
        const data = await response.json();
        const datim = typeof data?.datim === "string" ? data.datim : null;
        const match = datim?.match(/^(\d{8})_(\d{2})$/);
        if (!match) {
            return Response.json({ error: "Unexpected GFA cycle format." }, { status: 502 });
        }
        return Response.json({ date: match[1], hour: match[2] });
    } catch (error) {
        return Response.json(
            { error: error instanceof Error ? error.message : "Unexpected error fetching GFA cycle." },
            { status: 500 }
        );
    }
}
