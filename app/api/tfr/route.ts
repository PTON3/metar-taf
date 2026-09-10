// FAA's public TFR site (tfr.faa.gov) doesn't send CORS headers, so this route fetches
// server-side and hands the browser clean, bounds-filtered GeoJSON-ish shapes instead.

type Bounds = { south: number; west: number; north: number; east: number };

type LatLon = { lat: number; lon: number };

type TfrShape = {
    notamKey: string;
    type: string;
    title: string;
    rings: LatLon[][];
};

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
        const listResponse = await fetch("https://tfr.faa.gov/tfrapi/getTfrList", {
            next: { revalidate: 300 },
        });
        if (!listResponse.ok) {
            return Response.json({ error: "Unable to fetch the active TFR list." }, { status: 502 });
        }
        const activeList = (await listResponse.json()) as { notam_id?: string }[];
        const notamIds = Array.isArray(activeList)
            ? activeList.map((entry) => entry.notam_id).filter((id): id is string => Boolean(id))
            : [];

        if (notamIds.length === 0) {
            return Response.json({ tfrs: [] });
        }

        const cqlFilter = notamIds
            .map((id) => `NOTAM_KEY LIKE '${id.replace(/'/g, "''")}%'`)
            .join(" OR ");

        const wfsUrl =
            "https://tfr.faa.gov/geoserver/TFR/ows" +
            "?service=WFS&version=1.1.0&request=GetFeature&typeName=TFR:V_TFR_LOC" +
            "&outputFormat=application/json&srsname=EPSG:4326" +
            `&CQL_FILTER=${encodeURIComponent(cqlFilter)}`;

        const shapeResponse = await fetch(wfsUrl, { next: { revalidate: 300 } });
        if (!shapeResponse.ok) {
            return Response.json({ error: "Unable to fetch TFR shapes." }, { status: 502 });
        }
        const shapeData = await shapeResponse.json();
        const features = Array.isArray(shapeData?.features) ? shapeData.features : [];

        const tfrs: TfrShape[] = [];
        for (const feature of features) {
            const geometryType = feature?.geometry?.type;
            const coordinates = feature?.geometry?.coordinates;
            const notamKey = feature?.properties?.NOTAM_KEY;
            const type = feature?.properties?.LEGAL;
            const title = feature?.properties?.TITLE;
            if (!coordinates || !notamKey || !type) continue;

            const ringSets: number[][][] = geometryType === "MultiPolygon" ? coordinates.flat() : coordinates;
            const rings: LatLon[][] = ringSets.map((ring) =>
                ring.map(([lon, lat]: [number, number]) => ({ lat, lon }))
            );

            const intersects = rings.some((ring) => boundsOverlap(ringBounds(ring), bounds));
            if (!intersects) continue;

            tfrs.push({ notamKey, type, title: title ?? "", rings });
        }

        return Response.json({ tfrs });
    } catch (error) {
        return Response.json(
            { error: error instanceof Error ? error.message : "Unexpected error fetching TFR data." },
            { status: 500 }
        );
    }
}
