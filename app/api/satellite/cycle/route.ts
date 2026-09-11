// aviationweather.gov's global IR satellite mosaic (the "Infrared" layer on their Observations
// map — genuinely global, not just CONUS) is served as an XYZ/TMS tile pyramid keyed by the tile
// timestamp of the latest available scan, found the same way the GFA cycle lookup was: watching
// the tool's own network traffic. This mirrors that lookup (api/info/satellite) server-side for
// the same CORS reason as the other aviationweather.gov routes in this app.

function pad(value: number, length: number): string {
    return String(value).padStart(length, "0");
}

export async function GET() {
    try {
        const now = new Date();
        const nowStamp =
            `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1, 2)}${pad(now.getUTCDate(), 2)}` +
            `${pad(now.getUTCHours(), 2)}${pad(now.getUTCMinutes(), 2)}`;

        const response = await fetch(
            `https://aviationweather.gov/api/info/satellite?type=ir&format=tiledate&date=${nowStamp}`,
            { next: { revalidate: 120 } }
        );
        if (!response.ok) {
            return Response.json({ error: "Unable to fetch the current satellite tile time." }, { status: 502 });
        }
        const text = (await response.text()).trim();
        const match = text.match(/^(\d{8})(\d{4})$/);
        if (!match) {
            return Response.json({ error: "Unexpected satellite tile time format." }, { status: 502 });
        }
        return Response.json({ date: match[1], time: match[2] });
    } catch (error) {
        return Response.json(
            {
                error:
                    error instanceof Error ? error.message : "Unexpected error fetching satellite tile time.",
            },
            { status: 500 }
        );
    }
}
