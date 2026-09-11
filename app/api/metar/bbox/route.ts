function isFiniteNumber(value: string | null): value is string {
    return value !== null && Number.isFinite(Number(value));
}

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const south = searchParams.get("south");
    const west = searchParams.get("west");
    const north = searchParams.get("north");
    const east = searchParams.get("east");

    if (!isFiniteNumber(south) || !isFiniteNumber(west) || !isFiniteNumber(north) || !isFiniteNumber(east)) {
        return Response.json(
            { error: "south, west, north, and east numeric bounds are required." },
            { status: 400 }
        );
    }

    const url =
        `https://aviationweather.gov/api/data/metar` +
        `?bbox=${south},${west},${north},${east}&format=json`;

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

        // A bbox with zero matching stations (e.g. open ocean) comes back 204 No Content with an
        // empty body — .json() on that throws "Unexpected end of JSON input", so this has to be
        // checked before parsing rather than relying on try/catch to paper over it.
        if (response.status === 204) {
            return Response.json({ stations: [] });
        }

        const data = await response.json();
        const records = Array.isArray(data) ? data : [];

        // aviationweather.gov's bbox METAR query silently truncates at exactly 400 records for a
        // large-enough box (confirmed empirically — repeated identical queries against a dense
        // tile consistently return exactly 400 and are consistently missing real, currently-
        // reporting stations), with no explicit "truncated" flag in the response the way the FAA's
        // ArcGIS airport/airspace services provide one. Surfacing that as our own exceededLimit
        // flag lets callers reuse the same fetchAdaptive recursive-tiling fix already used for
        // those services, splitting the bbox further instead of silently dropping stations.
        const METAR_BBOX_TRUNCATION_CAP = 400;
        const exceededLimit = records.length >= METAR_BBOX_TRUNCATION_CAP;

        // lat/lon/name come straight from the METAR record itself — every station this returns
        // is, by definition, one with a current observation, so building markers directly from
        // this response (rather than cross-referencing a separate airport database and hoping
        // the identifiers line up) guarantees every one of them has a real flight category.
        const stations = records
            .map((record: unknown) => {
                const report = record as Record<string, unknown>;
                const station = typeof report.icaoId === "string" ? report.icaoId : null;
                const flightCategory = typeof report.fltCat === "string" ? report.fltCat : null;
                const lat = typeof report.lat === "number" ? report.lat : null;
                const lon = typeof report.lon === "number" ? report.lon : null;
                const name = typeof report.name === "string" ? report.name : null;
                return station && flightCategory && lat !== null && lon !== null
                    ? { station, flightCategory, lat, lon, name }
                    : null;
            })
            .filter(
                (entry): entry is { station: string; flightCategory: string; lat: number; lon: number; name: string | null } =>
                    entry !== null
            );

        return Response.json({ stations, exceededLimit });
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
