import type { CloudLayer, FlightCategory, NormalizedMetar } from "./types";

function cToF(celsius: number | null): number | null {
    if (celsius === null) return null;
    return Math.round((celsius * 9) / 5 + 32);
}

function parseNumber(value: string | undefined): number | null {
    if (!value) return null;

    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function parseVisibility(raw: string): {
    statuteMiles: number | null;
    raw: string | null;
} {
    const match = raw.match(/\b(P?\d+(?:\/\d+)?|\d+\s\d\/\d)SM\b/);

    if (!match) {
        return {
            statuteMiles: null,
            raw: null,
        };
    }

    const visibilityRaw = match[0];
    const value = match[1].replace("P", "");

    if (value.includes(" ")) {
        const [whole, fraction] = value.split(" ");
        const [top, bottom] = fraction.split("/").map(Number);

        return {
            statuteMiles: Number(whole) + top / bottom,
            raw: visibilityRaw,
        };
    }

    if (value.includes("/")) {
        const [top, bottom] = value.split("/").map(Number);

        return {
            statuteMiles: top / bottom,
            raw: visibilityRaw,
        };
    }

    return {
        statuteMiles: Number(value),
        raw: visibilityRaw,
    };
}

function parseWind(raw: string): NormalizedMetar["wind"] {
    const match = raw.match(/\b(VRB|\d{3})(\d{2,3})(G(\d{2,3}))?KT\b/);

    if (!match) {
        return {
            directionDeg: null,
            speedKt: null,
            gustKt: null,
            variable: false,
            raw: null,
        };
    }

    const direction = match[1];

    return {
        directionDeg: direction === "VRB" ? null : Number(direction),
        speedKt: Number(match[2]),
        gustKt: match[4] ? Number(match[4]) : null,
        variable: direction === "VRB",
        raw: match[0],
    };
}

function parseClouds(raw: string): CloudLayer[] {
    const cloudRegex = /\b(FEW|SCT|BKN|OVC|VV)(\d{3}|\/\/\/)?\b/g;
    const cloudMatches = raw.matchAll(cloudRegex);

    return Array.from(cloudMatches).map((match) => {
        const cover = match[1];
        const heightCode = match[2];

        return {
            cover,
            baseFeetAgl:
                heightCode && heightCode !== "///" ? Number(heightCode) * 100 : null,
        };
    });
}

function getCeiling(clouds: CloudLayer[]): NormalizedMetar["ceiling"] {
    const ceilingCovers = ["BKN", "OVC", "VV"];

    const ceilingLayers = clouds
        .filter(
            (layer) =>
                ceilingCovers.includes(layer.cover) && layer.baseFeetAgl !== null
        )
        .sort((a, b) => (a.baseFeetAgl ?? 0) - (b.baseFeetAgl ?? 0));

    const lowestCeiling = ceilingLayers[0];

    return {
        feetAgl: lowestCeiling?.baseFeetAgl ?? null,
        cover: lowestCeiling?.cover ?? null,
    };
}

function parseTemperatureDewpoint(raw: string): {
    temperatureC: number | null;
    dewpointC: number | null;
} {
    const match = raw.match(/\b(M?\d{2})\/(M?\d{2})\b/);

    if (!match) {
        return {
            temperatureC: null,
            dewpointC: null,
        };
    }

    const decodeTemp = (value: string): number => {
        if (value.startsWith("M")) {
            return -Number(value.slice(1));
        }

        return Number(value);
    };

    return {
        temperatureC: decodeTemp(match[1]),
        dewpointC: decodeTemp(match[2]),
    };
}

function parseAltimeter(raw: string): NormalizedMetar["altimeter"] {
    const match = raw.match(/\bA(\d{4})\b/);

    if (!match) {
        return {
            inHg: null,
            raw: null,
        };
    }

    return {
        inHg: Number(match[1]) / 100,
        raw: match[0],
    };
}

function parseObserved(raw: string): NormalizedMetar["observed"] {
    const match = raw.match(/\b(\d{2})(\d{2})(\d{2})Z\b/);

    return {
        day: parseNumber(match?.[1]),
        hourUtc: parseNumber(match?.[2]),
        minuteUtc: parseNumber(match?.[3]),
    };
}

function parseStation(raw: string): string | null {
    const match = raw.match(/^(METAR|SPECI)?\s?([A-Z0-9]{4})\b/);

    return match?.[2] ?? null;
}

function parseRemarks(raw: string): string | null {
    const parts = raw.split(" RMK ");

    return parts[1] ?? null;
}

function parseWeather(raw: string): string[] {
    const weatherCodes = [
        "TS",
        "RA",
        "SN",
        "DZ",
        "FG",
        "BR",
        "HZ",
        "FU",
        "VA",
        "DU",
        "SA",
        "SQ",
        "FC",
        "GR",
        "GS",
        "UP",
        "FZRA",
        "FZDZ",
    ];

    return weatherCodes.filter((code) =>
        new RegExp(`\\b[-+]?${code}\\b`).test(raw)
    );
}

function getFlightCategory(
    ceilingFeet: number | null,
    visibilitySm: number | null
): FlightCategory {
    if (ceilingFeet === null && visibilitySm === null) {
        return "UNKNOWN";
    }

    if (
        (ceilingFeet !== null && ceilingFeet < 500) ||
        (visibilitySm !== null && visibilitySm < 1)
    ) {
        return "LIFR";
    }

    if (
        (ceilingFeet !== null && ceilingFeet < 1000) ||
        (visibilitySm !== null && visibilitySm < 3)
    ) {
        return "IFR";
    }

    if (
        (ceilingFeet !== null && ceilingFeet <= 3000) ||
        (visibilitySm !== null && visibilitySm <= 5)
    ) {
        return "MVFR";
    }

    return "VFR";
}

export function normalizeRawMetar(rawInput: string): NormalizedMetar {
    const raw = rawInput.trim().replace(/\s+/g, " ");

    const wind = parseWind(raw);
    const visibility = parseVisibility(raw);
    const clouds = parseClouds(raw);
    const ceiling = getCeiling(clouds);
    const { temperatureC, dewpointC } = parseTemperatureDewpoint(raw);

    return {
        station: parseStation(raw),
        raw,

        observed: parseObserved(raw),

        flightCategory: getFlightCategory(
            ceiling.feetAgl,
            visibility.statuteMiles
        ),

        wind,

        visibility,

        clouds,

        ceiling,

        temperature: {
            celsius: temperatureC,
            fahrenheit: cToF(temperatureC),
        },

        dewpoint: {
            celsius: dewpointC,
            fahrenheit: cToF(dewpointC),
        },

        altimeter: parseAltimeter(raw),

        weather: parseWeather(raw),

        remarks: parseRemarks(raw),
    };
}