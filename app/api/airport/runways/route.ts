type AirportRunway = {
    id: string;
    airportIdent: string;
    name: string;
    lengthFt: number | null;
    widthFt: number | null;
    surface: string | null;
    status: string | null;
    lighted: boolean | null;
    endA: {
        ident: string | null;
        headingDeg: number | null;
        latitude: number | null;
        longitude: number | null;
    };
    endB: {
        ident: string | null;
        headingDeg: number | null;
        latitude: number | null;
        longitude: number | null;
    };
};

type ArcGisFeature = {
    attributes: Record<string, unknown>;
};

type ArcGisResponse = {
    features?: ArcGisFeature[];
    error?: {
        message?: string;
    };
};

const FAA_RUNWAYS_QUERY_URL =
    "https://services.arcgis.com/xOi1kZaI0eWDREZv/arcgis/rest/services/Runways_View/FeatureServer/0/query";

function cleanStation(input: string | null): string {
    return (input ?? "").trim().toUpperCase();
}

function isValidStation(station: string): boolean {
    return /^[A-Z0-9]{3,4}$/.test(station);
}

function getFaaIdent(station: string): string {
    if (station.length === 4 && station.startsWith("K")) {
        return station.slice(1);
    }

    return station;
}

function getString(
    attributes: Record<string, unknown>,
    possibleKeys: string[]
): string | null {
    for (const key of possibleKeys) {
        const value = attributes[key];

        if (typeof value === "string" && value.trim()) {
            return value.trim();
        }

        if (typeof value === "number" && Number.isFinite(value)) {
            return String(value);
        }
    }

    return null;
}

function getNumber(
    attributes: Record<string, unknown>,
    possibleKeys: string[]
): number | null {
    for (const key of possibleKeys) {
        const value = attributes[key];

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

function normalizeHeading(heading: number): number {
    let normalized = heading % 360;

    if (normalized < 0) {
        normalized += 360;
    }

    return Math.round(normalized);
}

function calculateBearingDeg(
    fromLatDeg: number,
    fromLonDeg: number,
    toLatDeg: number,
    toLonDeg: number
): number {
    const fromLat = (fromLatDeg * Math.PI) / 180;
    const toLat = (toLatDeg * Math.PI) / 180;
    const deltaLon = ((toLonDeg - fromLonDeg) * Math.PI) / 180;

    const y = Math.sin(deltaLon) * Math.cos(toLat);
    const x =
        Math.cos(fromLat) * Math.sin(toLat) -
        Math.sin(fromLat) * Math.cos(toLat) * Math.cos(deltaLon);

    const bearing = (Math.atan2(y, x) * 180) / Math.PI;

    return normalizeHeading(bearing);
}

function splitRunwayEnds(runwayId: string | null): {
    endAIdent: string | null;
    endBIdent: string | null;
    displayName: string;
} {
    if (!runwayId) {
        return {
            endAIdent: null,
            endBIdent: null,
            displayName: "Unknown runway",
        };
    }

    const cleaned = runwayId.trim();

    const parts = cleaned
        .split(/[\/\-]/)
        .map((part) => part.trim())
        .filter(Boolean);

    if (parts.length >= 2) {
        return {
            endAIdent: parts[0],
            endBIdent: parts[1],
            displayName: `${parts[0]} / ${parts[1]}`,
        };
    }

    return {
        endAIdent: cleaned,
        endBIdent: null,
        displayName: cleaned,
    };
}

function isRunwayLighted(value: string | null): boolean | null {
    if (!value) return null;

    const normalized = value.toUpperCase();

    if (normalized.includes("NSTD") || normalized.includes("NONE")) {
        return false;
    }

    if (normalized.includes("LIRL") || normalized.includes("MIRL") || normalized.includes("HIRL")) {
        return true;
    }

    return null;
}

function normalizeRunway(feature: ArcGisFeature, index: number): AirportRunway {
    const attributes = feature.attributes;

    const objectId =
        getString(attributes, ["OBJECTID"]) ??
        getString(attributes, ["FID"]) ??
        String(index);

    const airportIdent =
        getString(attributes, ["ARPT_ID"]) ??
        getString(attributes, ["LOC_ID"]) ??
        "UNKNOWN";

    const runwayId = getString(attributes, ["RWY_ID"]);
    const { endAIdent, endBIdent, displayName } = splitRunwayEnds(runwayId);

    const lat1 = getNumber(attributes, ["LAT1_DECIMAL"]);
    const lon1 = getNumber(attributes, ["LONG1_DECIMAL"]);
    const lat2 = getNumber(attributes, ["LAT2_DECIMAL"]);
    const lon2 = getNumber(attributes, ["LONG2_DECIMAL"]);

    const endAHeading =
        lat1 !== null && lon1 !== null && lat2 !== null && lon2 !== null
            ? calculateBearingDeg(lat1, lon1, lat2, lon2)
            : null;

    const endBHeading =
        lat1 !== null && lon1 !== null && lat2 !== null && lon2 !== null
            ? calculateBearingDeg(lat2, lon2, lat1, lon1)
            : null;

    const lightCode = getString(attributes, ["RWY_LGT_CODE"]);

    return {
        id: `${airportIdent}-${runwayId ?? objectId}`,
        airportIdent,
        name: displayName,
        lengthFt:
            getNumber(attributes, ["RWY_LEN"]) !== null
                ? Math.round(getNumber(attributes, ["RWY_LEN"]) ?? 0)
                : null,
        widthFt:
            getNumber(attributes, ["RWY_WIDTH"]) !== null
                ? Math.round(getNumber(attributes, ["RWY_WIDTH"]) ?? 0)
                : null,
        surface: getString(attributes, ["SURFACE_TYPE_CODE"]),
        status: getString(attributes, ["COND"]),
        lighted: isRunwayLighted(lightCode),
        endA: {
            ident: endAIdent,
            headingDeg: endAHeading,
            latitude: lat1,
            longitude: lon1,
        },
        endB: {
            ident: endBIdent,
            headingDeg: endBHeading,
            latitude: lat2,
            longitude: lon2,
        },
    };
}

async function queryRunwaysByFaaIdent(faaIdent: string): Promise<ArcGisResponse> {
    const params = new URLSearchParams({
        f: "json",
        where: `ARPT_ID = '${faaIdent.replaceAll("'", "''")}'`,
        outFields: "*",
        returnGeometry: "false",
        orderByFields: "RWY_ID ASC",
    });

    const response = await fetch(`${FAA_RUNWAYS_QUERY_URL}?${params.toString()}`, {
        next: {
            revalidate: 86_400,
        },
    });

    if (!response.ok) {
        throw new Error("Unable to fetch FAA runway data.");
    }

    return response.json();
}

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const station = cleanStation(searchParams.get("station"));

    if (!isValidStation(station)) {
        return Response.json(
            {
                error:
                    "Station must be a valid FAA or ICAO identifier, like FCM or KFCM.",
            },
            { status: 400 }
        );
    }

    const faaIdent = getFaaIdent(station);

    try {
        const data = await queryRunwaysByFaaIdent(faaIdent);

        if (data.error?.message) {
            return Response.json(
                { error: data.error.message },
                { status: 502 }
            );
        }

        const features = data.features ?? [];

        const runways = features.map((feature, index) =>
            normalizeRunway(feature, index)
        );

        return Response.json({
            station,
            faaIdent,
            data: runways,
            source: {
                name: "FAA/BTS NTAD Runways",
                url: "https://services.arcgis.com/xOi1kZaI0eWDREZv/arcgis/rest/services/Runways_View/FeatureServer/0",
                note:
                    "Runway data is derived from FAA NASR data through the USDOT/BTS NTAD Runways layer. Headings are calculated from runway endpoint coordinates and should be used for situational awareness only.",
            },
        });
    } catch (error) {
        return Response.json(
            {
                error:
                    error instanceof Error
                        ? error.message
                        : "Unexpected error fetching FAA runway data.",
            },
            { status: 500 }
        );
    }
}