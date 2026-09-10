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

        const data = await response.json();
        const records = Array.isArray(data) ? data : [];

        const stations = records
            .map((record: unknown) => {
                const report = record as Record<string, unknown>;
                const station = typeof report.icaoId === "string" ? report.icaoId : null;
                const flightCategory = typeof report.fltCat === "string" ? report.fltCat : null;
                return station && flightCategory ? { station, flightCategory } : null;
            })
            .filter((entry): entry is { station: string; flightCategory: string } => entry !== null);

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
