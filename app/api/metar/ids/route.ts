// Looks up METAR data by exact station identifier instead of a bounding box — see the comment on
// fetchFlightCategoriesByIdents in app/page.tsx for why: aviationweather.gov's bbox query silently
// thins out real, currently-reporting stations in ways that don't line up with a simple record
// cap, while an exact `ids=` lookup returns precisely what's asked for. Proxied server-side for
// the same CORS reason as the other aviationweather.gov routes in this app.

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const ids = searchParams.get("ids");

    if (!ids) {
        return Response.json({ error: "ids is required." }, { status: 400 });
    }

    const url = `https://aviationweather.gov/api/data/metar?ids=${encodeURIComponent(ids)}&format=json`;

    try {
        const response = await fetch(url, {
            next: {
                revalidate: 120,
            },
        });

        if (!response.ok) {
            return Response.json(
                { error: "Unable to fetch METAR data from AviationWeather.gov." },
                { status: 502 }
            );
        }

        // Same as /api/metar/bbox: a batch of idents with zero current observations among them
        // comes back 204 No Content with an empty body.
        if (response.status === 204) {
            return Response.json({ stations: [] });
        }

        const data = await response.json();
        const records = Array.isArray(data) ? data : [];

        const stations = records
            .map((record: unknown) => {
                const report = record as Record<string, unknown>;
                const station = typeof report.icaoId === "string" ? report.icaoId : null;
                const flightCategory = typeof report.fltCat === "string" ? report.fltCat : null;
                return station && flightCategory ? { station, flightCategory } : null;
            })
            .filter(
                (entry): entry is { station: string; flightCategory: string } => entry !== null
            );

        return Response.json({ stations });
    } catch (error) {
        return Response.json(
            {
                error:
                    error instanceof Error
                        ? error.message
                        : "Unexpected error fetching METAR data.",
            },
            { status: 500 }
        );
    }
}
