// app/api/taf/route.ts
import { NextRequest, NextResponse } from "next/server";
import { gunzipSync } from "zlib";
import { XMLParser } from "fast-xml-parser";

export const runtime = "nodejs";

const TAF_CACHE_URL =
    "https://aviationweather.gov/data/cache/tafs.cache.xml.gz";

const AIRPORT_API_URL =
    "https://aviationweather.gov/api/data/airport";

const KNOWN_AIRPORTS: Record<string, { lat: number; lon: number; name: string }> = {
    KFCM: {
        lat: 44.8272,
        lon: -93.4571,
        name: "Flying Cloud Airport",
    },
};

type TafRecord = {
    stationId: string;
    rawText: string;
    latitude: number;
    longitude: number;
    issueTime?: string;
    bulletinTime?: string;
    validFrom?: string;
    validTo?: string;
    forecast?: unknown;
};

function normalizeIcao(input: string): string {
    const id = input.trim().toUpperCase();

    // Allows "FCM" input to become "KFCM" for CONUS airports.
    if (id.length === 3) return `K${id}`;

    return id;
}

function asArray<T>(value: T | T[] | undefined | null): T[] {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
}

function distanceNm(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number
): number {
    const R = 3440.065; // Earth radius in nautical miles
    const toRad = (deg: number) => (deg * Math.PI) / 180;

    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);

    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) *
        Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) ** 2;

    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function getAirportPosition(icao: string) {
    if (KNOWN_AIRPORTS[icao]) {
        return KNOWN_AIRPORTS[icao];
    }

    const url = new URL(AIRPORT_API_URL);
    url.searchParams.set("ids", icao);
    url.searchParams.set("format", "json");

    const res = await fetch(url, {
        next: { revalidate: 86400 },
        headers: {
            "User-Agent": "InflightOSWeather/1.0 contact: local-dashboard",
        },
    });

    if (res.status === 204) return null;
    if (!res.ok) throw new Error(`Airport lookup failed: ${res.status}`);

    const json = await res.json();
    const data = Array.isArray(json) ? json : json.data ?? [];
    const airport = data[0];

    if (!airport) return null;

    const lat = Number(airport.lat ?? airport.latitude);
    const lon = Number(airport.lon ?? airport.longitude);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    return {
        lat,
        lon,
        name: airport.name ?? airport.site ?? icao,
    };
}

async function getCurrentTafs(): Promise<TafRecord[]> {
    const res = await fetch(TAF_CACHE_URL, {
        next: { revalidate: 600 },
        headers: {
            "User-Agent": "InflightOSWeather/1.0 contact: local-dashboard",
        },
    });

    if (!res.ok) {
        throw new Error(`TAF cache fetch failed: ${res.status}`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());

    let xml: string;
    try {
        xml = gunzipSync(buffer).toString("utf-8");
    } catch {
        // Some runtimes may auto-decompress.
        xml = buffer.toString("utf-8");
    }

    const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: "@_",
        parseTagValue: true,
    });

    const parsed = parser.parse(xml);
    const tafs = asArray(parsed?.response?.data?.TAF);

    return tafs
        .map((taf: any): TafRecord => {
            return {
                stationId: String(taf.station_id ?? "").toUpperCase(),
                rawText: String(taf.raw_text ?? ""),
                latitude: Number(taf.latitude),
                longitude: Number(taf.longitude),
                issueTime: taf.issue_time,
                bulletinTime: taf.bulletin_time,
                validFrom: taf.valid_time_from,
                validTo: taf.valid_time_to,
                forecast: taf.forecast,
            };
        })
        .filter(
            (taf) =>
                taf.stationId &&
                taf.rawText &&
                Number.isFinite(taf.latitude) &&
                Number.isFinite(taf.longitude)
        );
}

function summarizeForecastBlocks(forecast: unknown) {
    return asArray<any>(forecast).map((block) => {
        const skyConditions = asArray<any>(block.sky_condition).map((sky) => ({
            cover: sky["@_sky_cover"],
            baseFtAgl: sky["@_cloud_base_ft_agl"]
                ? Number(sky["@_cloud_base_ft_agl"])
                : null,
        }));

        return {
            change: block.change_indicator ?? "BASE",
            from: block.fcst_time_from,
            to: block.fcst_time_to,
            windDirection: block.wind_dir_degrees ?? null,
            windSpeedKt: block.wind_speed_kt ?? null,
            windGustKt: block.wind_gust_kt ?? null,
            visibilitySm: block.visibility_statute_mi ?? null,
            weather: block.wx_string ?? null,
            sky: skyConditions,
        };
    });
}

export async function GET(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url);
        const requestedStation = normalizeIcao(searchParams.get("station") ?? "KFCM");

        const airport = await getAirportPosition(requestedStation);

        if (!airport) {
            return NextResponse.json(
                { error: `Could not find airport position for ${requestedStation}` },
                { status: 404 }
            );
        }

        const tafs = await getCurrentTafs();

        const ranked = tafs
            .map((taf) => ({
                ...taf,
                distanceNm: distanceNm(
                    airport.lat,
                    airport.lon,
                    taf.latitude,
                    taf.longitude
                ),
            }))
            .sort((a, b) => a.distanceNm - b.distanceNm);

        const exactTaf = ranked.find((taf) => taf.stationId === requestedStation);
        const bestTaf = exactTaf ?? ranked[0];

        if (!bestTaf) {
            return NextResponse.json(
                { error: "No current TAFs available from AviationWeather." },
                { status: 503 }
            );
        }

        return NextResponse.json({
            requestedStation,
            requestedAirport: airport.name,
            tafStation: bestTaf.stationId,
            tafIsSameStation: bestTaf.stationId === requestedStation,
            distanceNm: Number(bestTaf.distanceNm.toFixed(1)),
            distanceSm: Number((bestTaf.distanceNm * 1.15078).toFixed(1)),
            issueTime: bestTaf.issueTime,
            bulletinTime: bestTaf.bulletinTime,
            validFrom: bestTaf.validFrom,
            validTo: bestTaf.validTo,
            rawText: bestTaf.rawText,
            forecast: summarizeForecastBlocks(bestTaf.forecast),
        });
    } catch (error) {
        console.error(error);

        return NextResponse.json(
            { error: "Failed to load nearest TAF." },
            { status: 500 }
        );
    }
}