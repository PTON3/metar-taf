// aviationweather.gov's own radar mosaic (the "Radar lowest" layer on their Observations map) —
// same underlying NOAA MRMS data as before, but served as a real XYZ/TMS tile pyramid instead of
// a single WMS image, and this endpoint hands back the latest N frame timestamps directly instead
// of us parsing a WMS GetCapabilities time-extent document ourselves. Proxied server-side for the
// same CORS reason as the other aviationweather.gov routes in this app.

function pad(value: number, length: number): string {
    return String(value).padStart(length, "0");
}

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const numParam = Number(searchParams.get("num"));
    const num = Number.isFinite(numParam) && numParam > 0 ? Math.min(Math.round(numParam), 20) : 6;

    try {
        const now = new Date();
        const nowStamp =
            `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1, 2)}${pad(now.getUTCDate(), 2)}` +
            `${pad(now.getUTCHours(), 2)}${pad(now.getUTCMinutes(), 2)}`;

        const response = await fetch(
            `https://aviationweather.gov/api/info/radar?type=rala&format=json&num=${num}&date=${nowStamp}`,
            { next: { revalidate: 60 } }
        );
        if (!response.ok) {
            return Response.json({ error: "Unable to fetch the current radar frame list." }, { status: 502 });
        }
        const stamps = (await response.json()) as unknown;
        if (!Array.isArray(stamps)) {
            return Response.json({ error: "Unexpected radar frame list format." }, { status: 502 });
        }

        const frames = stamps
            .filter((stamp): stamp is string => typeof stamp === "string" && /^\d{12}$/.test(stamp))
            .map((stamp) => ({ date: stamp.slice(0, 8), time: stamp.slice(8, 12) }));

        return Response.json({ frames });
    } catch (error) {
        return Response.json(
            { error: error instanceof Error ? error.message : "Unexpected error fetching radar frames." },
            { status: 500 }
        );
    }
}
