// Pilot reports (PIREPs) — real-time turbulence/icing/sky observations from actual
// aircraft, the natural cross-check against G-AIRMET/SIGMET forecast zones. Same CORS
// situation as the other aviationweather.gov routes: fetch server-side. Unlike those
// routes, this API accepts a bounding box directly, so no client-side bounds filtering
// is needed here.

type Bounds = { south: number; west: number; north: number; east: number };

type PirepSeverity = "SEVERE" | "MODERATE" | "LIGHT" | "NONE";

type PirepReport = {
    id: string;
    lat: number;
    lon: number;
    aircraftType: string | null;
    flightLevel: number | null;
    obsTime: string | null;
    isUrgent: boolean;
    severity: PirepSeverity;
    turbulenceIntensity: string | null;
    turbulenceType: string | null;
    icingIntensity: string | null;
    icingType: string | null;
    skyCover: string | null;
    tempC: number | null;
    windDir: number | null;
    windSpeed: number | null;
    wxString: string | null;
    rawText: string | null;
};

function isFiniteNumber(value: string | null): value is string {
    return value !== null && Number.isFinite(Number(value));
}

// Both turbulence and icing intensities use the same escalating vocabulary
// (NEG/SMTH-LGT/LGT/LGT-MOD/MOD/MOD-SEV/SEV/SEV-EXTM/EXTM for turbulence; NEG/TRC/
// TRC-LGT/LGT/LGT-MOD/MOD/MOD-SEV/SEV for icing), so one classifier covers both.
function classifyIntensity(intensity: string | null): PirepSeverity {
    if (!intensity) return "NONE";
    const value = intensity.toUpperCase();
    if (value.includes("SEV") || value.includes("EXTM")) return "SEVERE";
    if (value.includes("MOD")) return "MODERATE";
    if (value.includes("LGT") || value.includes("TRC")) return "LIGHT";
    return "NONE";
}

const SEVERITY_RANK: Record<PirepSeverity, number> = { NONE: 0, LIGHT: 1, MODERATE: 2, SEVERE: 3 };

function worseOf(a: PirepSeverity, b: PirepSeverity): PirepSeverity {
    return SEVERITY_RANK[b] > SEVERITY_RANK[a] ? b : a;
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
        const bbox = `${bounds.south},${bounds.west},${bounds.north},${bounds.east}`;
        const response = await fetch(
            `https://aviationweather.gov/api/data/pirep?format=json&age=2&bbox=${encodeURIComponent(bbox)}`,
            { next: { revalidate: 180 } }
        );
        if (!response.ok) {
            return Response.json({ error: "Unable to fetch PIREP data." }, { status: 502 });
        }
        const data = (await response.json()) as unknown[];

        const reports: PirepReport[] = [];
        for (const entry of Array.isArray(data) ? data : []) {
            const feature = entry as Record<string, unknown>;
            const lat = Number(feature.lat);
            const lon = Number(feature.lon);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

            const turbulenceIntensity =
                typeof feature.tbInt1 === "string" && feature.tbInt1 ? feature.tbInt1 : null;
            const icingIntensity = typeof feature.icgInt1 === "string" && feature.icgInt1 ? feature.icgInt1 : null;
            const severity = worseOf(classifyIntensity(turbulenceIntensity), classifyIntensity(icingIntensity));

            const clouds = feature.clouds;
            const firstCloud =
                Array.isArray(clouds) && clouds.length > 0 ? (clouds[0] as Record<string, unknown>) : null;

            const obsTimeRaw = feature.obsTime;
            const obsTime = typeof obsTimeRaw === "number" ? new Date(obsTimeRaw * 1000).toISOString() : null;

            reports.push({
                id: `${feature.receiptTime ?? ""}-${lat}-${lon}`,
                lat,
                lon,
                aircraftType: typeof feature.acType === "string" && feature.acType ? feature.acType : null,
                flightLevel: typeof feature.fltLvl === "number" ? feature.fltLvl : null,
                obsTime,
                isUrgent: feature.pirepType === "UUA",
                severity,
                turbulenceIntensity,
                turbulenceType: typeof feature.tbType1 === "string" && feature.tbType1 ? feature.tbType1 : null,
                icingIntensity,
                icingType: typeof feature.icgType1 === "string" && feature.icgType1 ? feature.icgType1 : null,
                skyCover: typeof firstCloud?.cover === "string" ? (firstCloud.cover as string) : null,
                tempC: typeof feature.temp === "number" ? feature.temp : null,
                windDir: typeof feature.wdir === "number" ? feature.wdir : null,
                windSpeed: typeof feature.wspd === "number" ? feature.wspd : null,
                wxString: typeof feature.wxString === "string" && feature.wxString ? feature.wxString : null,
                rawText: typeof feature.rawOb === "string" ? feature.rawOb : null,
            });
        }

        return Response.json({ reports });
    } catch (error) {
        return Response.json(
            { error: error instanceof Error ? error.message : "Unexpected error fetching PIREP data." },
            { status: 500 }
        );
    }
}
