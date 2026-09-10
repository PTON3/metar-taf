// International SIGMETs are what actually cover Alaska, Hawaii, and other oceanic/
// international FIRs — the domestic G-AIRMET product only covers the continental US.
// Same CORS situation as the other aviationweather.gov routes: fetch server-side.

type Bounds = { south: number; west: number; north: number; east: number };

type LatLon = { lat: number; lon: number };

type IsigmetZone = {
    hazard: string;
    severity: string | null;
    validTime: string | null;
    issueTime: string | null;
    dueTo: string | null;
    base: string | null;
    top: string | null;
    ring: LatLon[];
};

// LINE geometries (e.g. volcanic ash trajectories) aren't closed areas — a different
// rendering primitive than the rest, so only AREA/AREAS entries are included here.
const SUPPORTED_GEOMS = new Set(["AREA", "AREAS"]);

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
        const response = await fetch("https://aviationweather.gov/api/data/isigmet?format=json", {
            next: { revalidate: 300 },
        });
        if (!response.ok) {
            return Response.json({ error: "Unable to fetch international SIGMET data." }, { status: 502 });
        }
        const data = (await response.json()) as unknown[];

        const zones: IsigmetZone[] = [];
        for (const entry of Array.isArray(data) ? data : []) {
            const feature = entry as Record<string, unknown>;
            const hazard = typeof feature.hazard === "string" ? feature.hazard : null;
            const geom = typeof feature.geom === "string" ? feature.geom : null;
            const coords = feature.coords;
            if (!hazard || !geom || !SUPPORTED_GEOMS.has(geom) || !Array.isArray(coords)) continue;

            // AREA is a flat list of points; AREAS is a list of rings (the API sometimes
            // appends a malformed trailing "ring" with null coordinates — drop those).
            const ringSets: unknown[][] = geom === "AREAS" ? (coords as unknown[][]) : [coords];

            for (const ringCoords of ringSets) {
                const ring: LatLon[] = ringCoords
                    .map((point) => {
                        const p = point as Record<string, unknown>;
                        const lat = Number(p.lat);
                        const lon = Number(p.lon);
                        return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
                    })
                    .filter((point): point is LatLon => point !== null);
                if (ring.length < 3) continue;

                if (!boundsOverlap(ringBounds(ring), bounds)) continue;

                const qualifier = typeof feature.qualifier === "string" ? feature.qualifier : null;
                const validTimeFrom = feature.validTimeFrom;
                const validTime =
                    typeof validTimeFrom === "number" ? new Date(validTimeFrom * 1000).toISOString() : null;
                const issueTime = typeof feature.receiptTime === "string" ? feature.receiptTime : null;
                // Unlike G-AIRMET's base/top (stored as hundreds of feet), isigmet
                // reports these already in feet — rescale so both share one convention.
                const base = typeof feature.base === "number" ? String(feature.base / 100) : null;
                const top = typeof feature.top === "number" ? String(feature.top / 100) : null;

                zones.push({ hazard, severity: qualifier, validTime, issueTime, dueTo: null, base, top, ring });
            }
        }

        return Response.json({ zones });
    } catch (error) {
        return Response.json(
            {
                error:
                    error instanceof Error ? error.message : "Unexpected error fetching international SIGMET data.",
            },
            { status: 500 }
        );
    }
}
