import { createRequire } from "node:module";

export const runtime = "nodejs";

const require = createRequire(import.meta.url);
const tzLookup = require("tz-lookup") as (lat: number, lon: number) => string;

type AirportInfo = {
    station: string;
    displayName: string;
    displayLocation: string;
    city: string | null;
    state: string | null;
    country: string | null;
    name: string | null;
    elevationFt: number | null;
    latitude: number | null;
    longitude: number | null;
    timeZone: string | null;
};

function cleanStation(input: string | null): string {
    return (input ?? "").trim().toUpperCase();
}

function isValidStation(station: string): boolean {
    return /^[A-Z0-9]{4}$/.test(station);
}

function getString(record: Record<string, unknown>, keys: string[]): string | null {
    for (const key of keys) {
        const value = record[key];

        if (typeof value === "string" && value.trim().length > 0) {
            return value.trim();
        }
    }

    return null;
}

function getNumber(record: Record<string, unknown>, keys: string[]): number | null {
    for (const key of keys) {
        const value = record[key];

        if (typeof value === "number" && Number.isFinite(value)) {
            return value;
        }

        if (typeof value === "string") {
            const parsed = Number(value);

            if (Number.isFinite(parsed)) {
                return parsed;
            }
        }
    }

    return null;
}

function getFirstRecord(data: unknown): Record<string, unknown> | null {
    if (Array.isArray(data)) {
        const first = data[0];

        if (first && typeof first === "object") {
            return first as Record<string, unknown>;
        }
    }

    if (data && typeof data === "object") {
        return data as Record<string, unknown>;
    }

    return null;
}

function makeDisplayName(info: {
    station: string;
    name: string | null;
    city: string | null;
    state: string | null;
    country: string | null;
}): string {
    if (info.name) {
        return `${info.station} - ${info.name}`;
    }

    if (info.city && info.state) {
        return `${info.station} - ${info.city}, ${info.state}`;
    }

    if (info.city && info.country) {
        return `${info.station} - ${info.city}, ${info.country}`;
    }

    return info.station;
}

function makeDisplayLocation(info: {
    city: string | null;
    state: string | null;
    country: string | null;
}): string {
    if (info.city && info.state) {
        return `${info.city}, ${info.state}`;
    }

    if (info.city && info.country) {
        return `${info.city}, ${info.country}`;
    }

    if (info.state && info.country) {
        return `${info.state}, ${info.country}`;
    }

    if (info.city) return info.city;
    if (info.state) return info.state;
    if (info.country) return info.country;

    return "Location unavailable";
}

function normalizeAirportInfo(
    requestedStation: string,
    record: Record<string, unknown>
): AirportInfo {
    const station =
        getString(record, ["icaoId", "icao", "id", "station"]) ?? requestedStation;

    const city = getString(record, ["city", "cityName", "municipality"]);
    const state = getString(record, ["state", "region", "province"]);
    const country = getString(record, ["country", "countryCode"]);

    const name = getString(record, [
        "name",
        "site",
        "stationName",
        "airportName",
    ]);

    const latitude = getNumber(record, ["lat", "latitude"]);
    const longitude = getNumber(record, ["lon", "longitude"]);

    const elevationFt = getNumber(record, [
        "elev",
        "elevation",
        "elevationFt",
        "elevFt",
        "elev_ft",
    ]);

    let timeZone: string | null = null;

    if (latitude !== null && longitude !== null) {
        try {
            timeZone = tzLookup(latitude, longitude);
        } catch {
            timeZone = null;
        }
    }

    return {
        station,
        displayName: makeDisplayName({
            station,
            name,
            city,
            state,
            country,
        }),
        displayLocation: makeDisplayLocation({
            city,
            state,
            country,
        }),
        city,
        state,
        country,
        name,
        elevationFt,
        latitude,
        longitude,
        timeZone,
    };
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
        `https://aviationweather.gov/api/data/stationinfo` +
        `?ids=${encodeURIComponent(station)}&format=json`;

    try {
        const response = await fetch(url, {
            next: {
                revalidate: 86_400,
            },
        });

        if (response.status === 204) {
            return Response.json(
                { error: `No airport info found for ${station}.` },
                { status: 404 }
            );
        }

        if (!response.ok) {
            return Response.json(
                { error: "Unable to fetch airport info from AviationWeather.gov." },
                { status: 502 }
            );
        }

        const data = await response.json();
        const record = getFirstRecord(data);

        if (!record) {
            return Response.json(
                { error: `No airport info found for ${station}.` },
                { status: 404 }
            );
        }

        return Response.json({
            data: normalizeAirportInfo(station, record),
        });
    } catch (error) {
        return Response.json(
            {
                error:
                    error instanceof Error
                        ? error.message
                        : "Unexpected error fetching airport info.",
            },
            { status: 500 }
        );
    }
}