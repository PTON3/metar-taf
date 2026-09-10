// Domestic (CONUS) SIGMETs — convective, icing, turbulence — a different product
// than the CONUS-only G-AIRMET graphical forecast. Same CORS situation as the other
// aviationweather.gov routes: fetch server-side.

type Bounds = { south: number; west: number; north: number; east: number };

type LatLon = { lat: number; lon: number };

type SigmetZone = {
    hazard: string;
    severity: string | null;
    validTime: string | null;
    issueTime: string | null;
    dueTo: string | null;
    base: string | null;
    top: string | null;
    ring: LatLon[];
};

// This feed sometimes carries AIRMET-type entries too — those are the domain of the
// G-AIRMET overlay, so only genuine SIGMETs are kept here to avoid double-counting.
const HAZARD_LABEL: Record<string, string> = { CONVECTIVE: "TS" };

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
        const response = await fetch("https://aviationweather.gov/api/data/airsigmet?format=json", {
            next: { revalidate: 300 },
        });
        if (!response.ok) {
            return Response.json({ error: "Unable to fetch domestic SIGMET data." }, { status: 502 });
        }
        const data = (await response.json()) as unknown[];

        const zones: SigmetZone[] = [];
        for (const entry of Array.isArray(data) ? data : []) {
            const feature = entry as Record<string, unknown>;
            if (feature.airSigmetType !== "SIGMET") continue;

            const rawHazard = typeof feature.hazard === "string" ? feature.hazard : null;
            const coords = feature.coords;
            if (!rawHazard || !Array.isArray(coords)) continue;

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

            const hazard = HAZARD_LABEL[rawHazard] ?? rawHazard;
            const severity = typeof feature.severity === "string" ? feature.severity : null;
            const validTimeFrom = feature.validTimeFrom;
            const validTime =
                typeof validTimeFrom === "number" ? new Date(validTimeFrom * 1000).toISOString() : null;
            const issueTime = typeof feature.receiptTime === "string" ? feature.receiptTime : null;
            // altitudeHi1/altitudeLow1 are already in feet — rescale to hundreds of
            // feet so this shares the same convention as G-AIRMET's base/top.
            const altitudeHi1 = feature.altitudeHi1;
            const altitudeLow1 = feature.altitudeLow1;
            const top = typeof altitudeHi1 === "number" ? String(altitudeHi1 / 100) : null;
            const base = typeof altitudeLow1 === "number" ? String(altitudeLow1 / 100) : null;

            zones.push({ hazard, severity, validTime, issueTime, dueTo: null, base, top, ring });
        }

        return Response.json({ zones });
    } catch (error) {
        return Response.json(
            { error: error instanceof Error ? error.message : "Unexpected error fetching SIGMET data." },
            { status: 500 }
        );
    }
}
