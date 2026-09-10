// aviationweather.gov (the same source already used for METAR) doesn't send CORS
// headers, so this route fetches server-side and hands the browser clean shapes.

type Bounds = { south: number; west: number; north: number; east: number };

type LatLon = { lat: number; lon: number };

type GairmetZone = {
    hazard: string;
    severity: string | null;
    validTime: string | null;
    issueTime: string | null;
    dueTo: string | null;
    base: string | null;
    top: string | null;
    ring: LatLon[];
};

// Freezing level (FZLVL) publishes as contour LINEs, not filled areas — a different
// rendering primitive than the rest, so it's left out for now.
const SUPPORTED_HAZARDS = new Set(["IFR", "ICE", "MT_OBSC", "TURB-HI", "TURB-LO", "LLWS"]);

function isFiniteNumber(value: string | null): value is string {
    return value !== null && Number.isFinite(Number(value));
}

function boundsOverlap(a: Bounds, b: Bounds): boolean {
    return a.west <= b.east && a.east >= b.west && a.south <= b.north && a.north >= b.south;
}

function ringBounds(ring: LatLon[]): Bounds {
    let west = Infinity;
    let east = -Infinity;
    let south = Infinity;
    let north = -Infinity;
    for (const point of ring) {
        west = Math.min(west, point.lon);
        east = Math.max(east, point.lon);
        south = Math.min(south, point.lat);
        north = Math.max(north, point.lat);
    }
    return { west, east, south, north };
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

    const bounds: Bounds = {
        south: Number(south),
        west: Number(west),
        north: Number(north),
        east: Number(east),
    };

    try {
        const response = await fetch("https://aviationweather.gov/api/data/gairmet?format=json", {
            next: { revalidate: 300 },
        });
        if (!response.ok) {
            return Response.json({ error: "Unable to fetch G-AIRMET data." }, { status: 502 });
        }
        const data = (await response.json()) as unknown[];

        const zones: GairmetZone[] = [];
        for (const entry of Array.isArray(data) ? data : []) {
            const feature = entry as Record<string, unknown>;
            const hazard = typeof feature.hazard === "string" ? feature.hazard : null;
            const coords = feature.coords;
            if (!hazard || !SUPPORTED_HAZARDS.has(hazard) || !Array.isArray(coords)) continue;

            const ring: LatLon[] = coords
                .map((point) => {
                    const p = point as Record<string, unknown>;
                    const lat = Number(p.lat);
                    const lon = Number(p.lon);
                    return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
                })
                .filter((point): point is LatLon => point !== null);
            if (ring.length < 3) continue;

            if (!boundsOverlap(ringBounds(ring), bounds)) continue;

            const severity = typeof feature.severity === "string" ? feature.severity : null;
            const validTime = typeof feature.validTime === "string" ? feature.validTime : null;
            const dueTo = typeof feature.due_to === "string" ? feature.due_to : null;
            const base = feature.base != null ? String(feature.base) : null;
            const top = feature.top != null ? String(feature.top) : null;
            const issueTimeRaw = feature.issueTime;
            const issueTime =
                typeof issueTimeRaw === "number"
                    ? new Date(issueTimeRaw * 1000).toISOString()
                    : null;

            zones.push({ hazard, severity, validTime, issueTime, dueTo, base, top, ring });
        }

        return Response.json({ zones });
    } catch (error) {
        return Response.json(
            { error: error instanceof Error ? error.message : "Unexpected error fetching G-AIRMET data." },
            { status: 500 }
        );
    }
}
