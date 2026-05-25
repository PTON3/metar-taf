import { normalizeRawMetar } from "@/lib/metar/normalize";

function cleanStation(input: string | null): string {
    return (input ?? "KFCM").trim().toUpperCase();
}

function isValidStation(station: string): boolean {
    return /^[A-Z0-9]{4}$/.test(station);
}

function getRawMetarFromAwcResponse(data: unknown): string | null {
    const records = Array.isArray(data)
        ? data
        : typeof data === "object" && data !== null && "data" in data && Array.isArray((data as any).data)
            ? (data as any).data
            : [data];

    const firstRecord = records[0];

    if (!firstRecord || typeof firstRecord !== "object") {
        return null;
    }

    const report = firstRecord as Record<string, unknown>;

    if (typeof report.rawOb === "string") return report.rawOb;
    if (typeof report.raw_text === "string") return report.raw_text;
    if (typeof report.raw === "string") return report.raw;

    return null;
}

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const station = cleanStation(searchParams.get("station"));

    if (!isValidStation(station)) {
        return Response.json(
            { error: "Station must be a valid 4-character ICAO ID, like KFCM." },
            { status: 400 }
        );
    }

    const url =
        `https://aviationweather.gov/api/data/metar` +
        `?ids=${encodeURIComponent(station)}&format=json`;

    try {
        const response = await fetch(url, {
            next: {
                revalidate: 120,
            },
        });

        if (response.status === 204) {
            return Response.json(
                { error: `No METAR found for ${station}.` },
                { status: 404 }
            );
        }

        if (!response.ok) {
            return Response.json(
                { error: "Unable to fetch METAR from AviationWeather.gov." },
                { status: 502 }
            );
        }

        const data = await response.json();
        const rawMetar = getRawMetarFromAwcResponse(data);

        if (!rawMetar) {
            return Response.json(
                { error: `No raw METAR found for ${station}.` },
                { status: 404 }
            );
        }

        const normalized = normalizeRawMetar(rawMetar);

        return Response.json({
            station,
            raw: rawMetar,
            normalized,
            provider: {
                name: "AviationWeather.gov",
                cachedSeconds: 120,
            },
        });
    } catch (error) {
        return Response.json(
            {
                error:
                    error instanceof Error
                        ? error.message
                        : "Unexpected error fetching live METAR.",
            },
            { status: 500 }
        );
    }
}