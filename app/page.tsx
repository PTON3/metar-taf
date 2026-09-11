"use client";

import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type PointerEvent,
    type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { FlightCategory, NormalizedMetar } from "@/lib/metar/types";
import {
    OPERATIONAL_MINIMUMS,
    NIGHT_STACKING_RAMP_ELIGIBILITY,
} from "@/lib/minimums/weatherMinimums";
import * as SunCalc from "suncalc";
import * as Geomagnetism from "geomagnetism";
import Image from "next/image";
import FeedbackWidget from "./FeedbackWidget";

const RADAR_MAX_RADIUS_NM = 250;
// Where the map opens on load, as a fraction of the pan-out-to-max-zoom-in range.
const RADAR_DEFAULT_ZOOM_PERCENT = 0.6;
// Below this zoom *percent* (the same 0-100 metric the on-screen zoom readout shows, not a raw
// zoom level — raw levels map to a different visible scale depending on latitude and container
// size, which the percent already normalizes for) only the top airport tier (majors) stays
// visible, so panning across the country doesn't flood the map with every small grass strip in
// the FAA dataset. Full local detail loading (airspace shapes + every airport, not just majors)
// uses this same threshold, since that's also when the airport tiers below start needing it.
const LOCAL_DETAIL_MIN_ZOOM_PERCENT = 30;
// Between LOCAL_DETAIL_MIN_ZOOM_PERCENT and this, a second airport tier — majors plus anything
// with a real ICAO identifier (airport.icao, a reliable proxy for "significant enough to have
// one" already returned by the airports query, no extra fetch needed) — wins the decluttering
// grid instead of majors alone, so the view fills in with more substantial fields before jumping
// to literally everything. At or above this, every airport shows, undecimated.
const AIRPORT_ALL_MIN_ZOOM_PERCENT = 45;
// Fetches cover the viewport expanded by this much — generous on purpose, so the data for
// wherever you pan next is already loaded *before* you get there rather than popping in after
// you arrive (still bounded by the RADAR_MAX_RADIUS_NM-based cap below, which is what actually
// keeps each request under the ArcGIS query-size limit).
const LOCAL_DETAIL_PADDING_FACTOR = 3;
const LOCAL_DETAIL_DEBOUNCE_MS = 250;
const NM_TO_METERS = 1852;
const EARTH_CIRCUMFERENCE_METERS = 40075016.686;
const MAP_TILE_SIZE = 256;
const RADAR_BASEMAP_TILE_URL =
    "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}";
const RADAR_BOUNDARY_TILE_URL =
    "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}";
const RADAR_BASEMAP_MAX_ZOOM = 16;
const RADAR_WHEEL_ZOOM_SENSITIVITY = 0.012;
// Fraction of the zoom range (pan-out floor to 1 nm ceiling) moved per +/- button click.
const RADAR_ZOOM_STEP_PERCENT = 0.1;
// Wheel zoom is non-passive (it has to preventDefault), which forces the browser to dispatch
// every event to the main thread instead of handling it on the compositor the way it does for
// native page scrolling — so under load, events can arrive coalesced into fewer, chunkier jumps
// no matter how continuous the input hardware is. Applying each wheel delta to a target and
// gliding view.zoom toward that target once per animation frame (instead of snapping straight to
// it) decouples what's rendered from how choppy the raw input turned out to be. Fraction of the
// remaining gap to close each frame — higher feels snappier/more direct, lower feels smoother.
const RADAR_WHEEL_ZOOM_EASE = 0.35;

// aviationweather.gov's own radar mosaic — the "Radar lowest" layer on their Observations map.
// Same underlying NOAA MRMS data as the old opengeo.ncep.noaa.gov WMS source this replaces
// (confirmed: the tile layer's own attribution reads "MRMS") — what's different is delivery: a
// real XYZ/TMS tile pyramid instead of one WMS image stretched across every zoom level, so it
// stays crisp when zoomed in instead of getting blurry, the same upgrade already made for
// satellite. It also animates uniformly everywhere (found the same 6-frame animated tile set
// covering both Alaska and CONUS in the same session), so unlike before there's no separate
// "outside CONUS gets a single static frame" fallback path to maintain.
const RADAR_TILE_URL_TEMPLATE =
    "https://aviationweather.gov/data/tilecache/rad_rala/{date}/{time}/{z}/rad_{x}_{y}.png";
// Tiles only exist natively up to this zoom — past it the highest-zoom tiles are scaled up
// rather than fetched at a zoom that 404s.
const RADAR_MAX_NATIVE_ZOOM = 7;
// The layer publishes new frames roughly every 10 minutes; matches RADAR_ANIMATION_FRAME_COUNT
// below so the animation loop always has exactly this many frames to play through.
const RADAR_ANIMATION_FRAME_COUNT = 6;
const RADAR_ANIMATION_FRAME_MS = 500;
const RADAR_ANIMATION_LAST_FRAME_HOLD_MS = 3000;
// Refetch at least this often so a screen left open on the radar tab still
// picks up newly published scans, even with no pan/zoom/station change.
const RADAR_RESYNC_INTERVAL_MS = 60_000;

// aviationweather.gov's own global IR mosaic — the "Infrared" layer on their Observations map
// (genuinely global, a composite of every operational GEO satellite, not just GOES/CONUS like the
// old IEM source this replaces). Found by enabling that layer live and inspecting the resulting
// Leaflet tile layer: a plain grayscale IR XYZ/TMS tile pyramid, not a single stretched image, so
// it's drawn the same tiled way as the basemap below rather than as one ImageOverlay-style rect.
const SATELLITE_TILE_URL_TEMPLATE =
    "https://aviationweather.gov/data/tilecache/sat_ir/{date}/{time}/{z}/sat_{x}_{y}.png";
// Tiles only exist natively up to this zoom — same idea as RADAR_BASEMAP_MAX_ZOOM, but far lower,
// so past it the highest-zoom tiles are just scaled up rather than fetched at a zoom that 404s.
const SATELLITE_MAX_NATIVE_ZOOM = 6;
// New scans land every 10-15 minutes; no point resyncing faster than that.
const SATELLITE_RESYNC_INTERVAL_MS = 10 * 60_000;
// Plain grayscale IR (dark = warm surface/low cloud, white = cold high cloud tops) — no color
// enhancement, unlike the old IEM source this replaces.
const SATELLITE_LEGEND_GRADIENT = "linear-gradient(to top, #050505, #808080, #ffffff)";

// Exact colors read off aviationweather.gov's own "Radar (dBZ)" legend popover DOM — the tiles
// arrive already styled in this palette (no client-side recoloring, same as satellite/GFA).
const RADAR_LEGEND_GRADIENT =
    "linear-gradient(to top, #888, #46a, #59c, #4d7, #1b1, #191, #161, #fd0, #f90, red, #900, #fff, #f6f, #a0f)";

const RADAR_SCALE_NICE_VALUES_NM = [
    1, 2, 5, 10, 20, 25, 50, 75, 100, 150, 200, 300, 400, 500, 750, 1000, 1500, 2000, 3000, 5000,
];
const RADAR_SCALE_MIN_NM = RADAR_SCALE_NICE_VALUES_NM[0];
const RADAR_SCALE_MAX_TARGET_PX = 340;
const RADAR_SCALE_STEP_COUNT = 4;

type RadarWmsBounds = {
    west: number;
    south: number;
    east: number;
    north: number;
};

// Panning/zooming out is deliberately decoupled from the data-fetch radius above
// (RADAR_MAX_RADIUS_NM): aviation data (radar, hazards, PIREPs, airports) only ever
// covers a 250nm circle around the loaded station, but the basemap itself is free to
// pan anywhere — nearly the full globe, clamped just shy of the poles where Web
// Mercator breaks down. Panning far from the station simply shows bare basemap.
// Used only to size the zoomed-all-the-way-out "whole world fits" view — a normal,
// finite (non-wrapping) box is correct for that one computation.
const GLOBAL_PAN_BOUNDS: RadarWmsBounds = { west: -179.9, south: -85, east: 179.9, north: 85 };

// The actual pan clamp, by contrast, leaves longitude unbounded so the map can be
// dragged past +/-180 without hitting a wall — combined with the basemap tile loop's
// existing mod-wrap on tile-x (and wrapLonNear for everything else drawn on top), this
// is what makes crossing the antimeridian (e.g. through Alaska's Aleutian chain) a
// seamless continuation instead of a hard edge. Latitude still clamps just shy of the
// poles, where Mercator itself breaks down.
const PAN_CLAMP_BOUNDS: RadarWmsBounds = { west: -Infinity, south: -85, east: Infinity, north: 85 };

// A broad North America box (CONUS, Alaska's mainland, Hawaii, Puerto Rico/Caribbean) used to
// fetch the lightweight vector layers (TFRs, hazards, PIREPs, majors) and the radar mosaic up
// front, so panning anywhere in the country actually shows data instead of bare basemap.
// Satellite is a genuinely global tile source, so it isn't bounded to this box at all.
const AMERICAS_BOUNDS: RadarWmsBounds = { west: -170, south: 15, east: -50, north: 75 };

function buildRadarTileUrl(z: number, x: number, y: number, frame: { date: string; time: string }): string {
    return RADAR_TILE_URL_TEMPLATE.replace("{date}", frame.date)
        .replace("{time}", frame.time)
        .replace("{z}", String(z))
        .replace("{x}", String(x))
        .replace("{y}", String(y));
}

function buildSatelliteTileUrl(z: number, x: number, y: number, cycle: { date: string; time: string }): string {
    return SATELLITE_TILE_URL_TEMPLATE.replace("{date}", cycle.date)
        .replace("{time}", cycle.time)
        .replace("{z}", String(z))
        .replace("{x}", String(x))
        .replace("{y}", String(y));
}

// aviationweather.gov's own GFA (Graphical Forecast for Aviation) tool — the same one pilots use
// for thunderstorm/turbulence/icing/weather-type outlooks — renders each product as a single
// pre-colored GIF per forecast cycle (~every 3 hours). Bounds found by inspecting the tool's own
// network traffic and its exposed `window.gfa.layers.weather.layer.getBounds()`, which reported
// these exact numbers identically across every product tested — one mosaic spanning the Pacific
// to the mid-Atlantic, well past just CONUS (it covers Alaska, Hawaii, and the Caribbean too). No
// client-side recoloring needed — unlike the NWS reflectivity radar above, these arrive already
// styled, so they're drawn as-is, the same as the satellite overlay.
const GFA_MOSAIC_BOUNDS: RadarWmsBounds = {
    west: -215.69104,
    south: -0.196746,
    east: -39.508957,
    north: 76.97271,
};
// New model cycles land roughly every 3 hours; no point resyncing faster than that.
const GFA_RESYNC_INTERVAL_MS = 20 * 60_000;
// TFRs/G-AIRMETs/SIGMETs/PIREPs used to be fetched once on load and never again — a real
// staleness gap (new TFRs, amended G-AIRMETs/SIGMETs, and fresh PIREPs could all silently go
// unseen for the rest of the session). Refetched on this interval instead, same as every other
// live layer.
const HAZARDS_REFRESH_INTERVAL_MS = 5 * 60_000;

type GfaOverlayId = "thunderstorms" | "weatherType" | "turbulence" | "icing";

type GfaOverlayConfig = {
    id: GfaOverlayId;
    label: string;
    // The file-name product suffix aviationweather.gov uses for this layer — confirmed by
    // watching the GFA tool's own image requests while switching between its menu items.
    fileProduct: string;
};

const GFA_OVERLAYS: readonly GfaOverlayConfig[] = [
    { id: "thunderstorms", label: "Thunderstorms", fileProduct: "sfc_tstm" },
    { id: "weatherType", label: "Weather Type", fileProduct: "sfc_wx" },
    { id: "turbulence", label: "Turbulence", fileProduct: "maxa_gtg" },
    { id: "icing", label: "Icing", fileProduct: "max_icsevsld" },
];

function buildGfaProductUrl(fileProduct: string, cycle: { date: string; hour: string }): string {
    return `https://aviationweather.gov/data/products/gfam/${cycle.date}/${cycle.hour}/${cycle.date}_${cycle.hour}_F00_gfaak_${fileProduct}_m.gif`;
}

// Legend colors pulled directly from the GFA tool's own legend popover (read via its live DOM —
// e.g. window.gfa's Turbulence legend renders a ~45-stop gradient table with exact hex values per
// cell), not approximated, so these match the source exactly rather than just resembling it.
// Thunderstorm coverage: ISOL / SCT / NUM (isolated/scattered/numerous — standard aviation
// coverage terms), a flat 3-stop scale, not a smooth gradient.
const GFA_THUNDERSTORM_LEGEND_GRADIENT = "linear-gradient(to top, #f99, #f33, #900)";
// GTG turbulence (Eddy Dissipation Rate x100) — sampled down from the tool's full gradient table.
const GFA_TURBULENCE_LEGEND_GRADIENT =
    "linear-gradient(to top, #f4ffff, #cff, #cf6, #cf0, #fc0, #f90, #f60, #f40000, #900, #3d0000)";
// Icing severity with SLD (supercooled large droplets, the red cap) — Trace/Light/Mod/Heavy/SLD.
const GFA_ICING_LEGEND_GRADIENT =
    "linear-gradient(to top, #cff, #9cf, #69f, #33f, rgba(255,0,0,0.5))";
// Weather Type categories — the "Likely" (more saturated) tier of each precip type, plus severe
// thunderstorms. It's categorical, not an intensity scale, so these render as swatches, not a bar.
const GFA_WEATHER_TYPE_SWATCHES: readonly { label: string; color: string }[] = [
    { label: "Rain", color: "#065d2c" },
    { label: "Snow", color: "#081d58" },
    { label: "Mix", color: "#490092" },
    { label: "Ice", color: "#e40072" },
    { label: "T-Storm", color: "#99000d" },
];

// ---- FAA aeronautical data (Aeronautical Information Services open data) ----
// Both are official public FAA feature services, no API key required.
const AIRSPACE_QUERY_URL =
    "https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/Class_Airspace/FeatureServer/0/query";
const AIRPORTS_QUERY_URL =
    "https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/US_Airport/FeatureServer/0/query";

type AirspacePolygon = {
    airspaceClass: string;
    name: string;
    rings: { lat: number; lon: number }[][];
};

type AirportPoint = {
    ident: string;
    name: string;
    icao: string | null;
    lat: number;
    lon: number;
    flightCategory?: FlightCategory;
    // FAA FAR91 flag — empirically this is exactly the ~30 largest US hub airports (ATL, LAX,
    // ORD, JFK, DFW, ...), not just "has an instrument approach" (IAPEXISTS, which is true for
    // ~3000 airports — way too many to read as "major"). Used to declutter zoomed-out views:
    // major airports always render, everything else only once zoomed in close enough to matter.
    isMajor: boolean;
};

const AIRSPACE_GOLD = "rgba(230, 199, 111, 0.5)";
const AIRSPACE_CLASS_STYLES: Record<string, { color: string; width: number; dash: number[] }> = {
    B: { color: AIRSPACE_GOLD, width: 2, dash: [] },
    C: { color: AIRSPACE_GOLD, width: 2, dash: [] },
    D: { color: AIRSPACE_GOLD, width: 1.5, dash: [6, 4] },
};

// Below this per-vertex turn angle, a vertex is treated as part of a curved radius
// (rounded off); at or above it, the vertex is a real corner and stays sharp.
const AIRSPACE_CORNER_ANGLE_DEG = 25;

function computeTurnAngleDeg(
    prev: { x: number; y: number },
    current: { x: number; y: number },
    next: { x: number; y: number }
): number {
    const v1x = current.x - prev.x;
    const v1y = current.y - prev.y;
    const v2x = next.x - current.x;
    const v2y = next.y - current.y;
    const mag1 = Math.hypot(v1x, v1y);
    const mag2 = Math.hypot(v2x, v2y);
    if (mag1 === 0 || mag2 === 0) return 0;
    const cos = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (mag1 * mag2)));
    return (Math.acos(cos) * 180) / Math.PI;
}

// Standard ray-casting point-in-polygon test, used for hover/click hit-testing
// against TFR and G-AIRMET zones (both drawn as simple closed rings).
function pointInRing(x: number, y: number, ring: { x: number; y: number }[]): boolean {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i].x;
        const yi = ring[i].y;
        const xj = ring[j].x;
        const yj = ring[j].y;
        const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
        if (intersects) inside = !inside;
    }
    return inside;
}

// More saturated than a straight Tailwind-400 pastel — those read as washed-out and blend into
// a busy dark map (radar colors, terrain) instead of popping at a glance.
const FLIGHT_CATEGORY_MARKER_COLORS: Record<FlightCategory, string> = {
    VFR: "#16d16f",
    MVFR: "#2563eb",
    IFR: "#ef4444",
    LIFR: "#d946ef",
    UNKNOWN: "#71717a",
};

// ArcGIS caps any single query at 1000 features and silently drops the rest — exposed here as
// exceededLimit (from the response's own exceededTransferLimit flag) so callers that need the
// *complete* picture (see fetchAdaptive below) can detect a truncated tile and split it, rather
// than quietly rendering whatever fraction of a dense area happened to come back first.
async function fetchAirspacePolygonsPage(
    bounds: GeoBounds,
    signal?: AbortSignal
): Promise<{ polygons: AirspacePolygon[]; exceededLimit: boolean }> {
    const params = new URLSearchParams({
        geometry: `${bounds.west},${bounds.south},${bounds.east},${bounds.north}`,
        geometryType: "esriGeometryEnvelope",
        inSR: "4326",
        spatialRel: "esriSpatialRelIntersects",
        where: "CLASS IN ('B','C','D')",
        outFields: "CLASS,NAME",
        returnGeometry: "true",
        maxAllowableOffset: "0.0001",
        geometryPrecision: "4",
        f: "geojson",
    });

    const response = await fetch(`${AIRSPACE_QUERY_URL}?${params.toString()}`, { signal });
    if (!response.ok) throw new Error("Airspace request failed.");
    const data = await response.json();
    const features = Array.isArray(data?.features) ? data.features : [];

    const polygons: AirspacePolygon[] = [];
    for (const feature of features) {
        const geometryType = feature?.geometry?.type;
        const coordinates = feature?.geometry?.coordinates;
        const airspaceClass = feature?.properties?.CLASS;
        if (!coordinates || !airspaceClass) continue;

        const ringSets: number[][][] =
            geometryType === "MultiPolygon" ? coordinates.flat() : coordinates;
        const rings = ringSets.map((ring) =>
            ring.map((point) => ({ lat: point[1], lon: point[0] }))
        );

        polygons.push({ airspaceClass, name: feature?.properties?.NAME ?? "", rings });
    }
    return { polygons, exceededLimit: data?.exceededTransferLimit === true };
}

async function fetchAirspacePolygons(bounds: GeoBounds, signal?: AbortSignal): Promise<AirspacePolygon[]> {
    const { polygons } = await fetchAirspacePolygonsPage(bounds, signal);
    return polygons;
}

type TfrPolygon = {
    notamKey: string;
    type: string;
    title: string;
    rings: { lat: number; lon: number }[][];
};

const TFR_STYLE = {
    fill: "rgba(239, 68, 68, 0.16)",
    stroke: "rgba(239, 68, 68, 0.9)",
    width: 2,
};

async function fetchTfrPolygons(bounds: GeoBounds): Promise<TfrPolygon[]> {
    const params = new URLSearchParams({
        south: String(bounds.south),
        west: String(bounds.west),
        north: String(bounds.north),
        east: String(bounds.east),
    });

    const response = await fetch(`/api/tfr?${params.toString()}`);
    if (!response.ok) throw new Error("TFR request failed.");
    const data = await response.json();
    return Array.isArray(data?.tfrs) ? data.tfrs : [];
}

type GairmetZone = {
    hazard: string;
    severity: string | null;
    validTime: string | null;
    issueTime: string | null;
    dueTo: string | null;
    base: string | null;
    top: string | null;
    ring: { lat: number; lon: number }[];
};

// Colors matched to aviationweather.gov's own G-AIRMET map (sampled from its live
// rendering — IFR magenta, icing purple, mountain obscuration maroon, turbulence
// orange/red-orange, LLWS blue). TS/VA/MTW/TC (below) are international-SIGMET-only
// hazards with no G-AIRMET equivalent, styled to fit the same palette.
const GAIRMET_HAZARD_STYLES: Record<string, { fill: string; stroke: string }> = {
    IFR: { fill: "rgba(255, 0, 255, 0.22)", stroke: "rgba(255, 51, 255, 0.95)" },
    ICE: { fill: "rgba(0, 0, 255, 0.2)", stroke: "rgba(70, 70, 255, 0.95)" },
    MT_OBSC: { fill: "rgba(153, 0, 153, 0.24)", stroke: "rgba(193, 40, 193, 0.95)" },
    "TURB-HI": { fill: "rgba(255, 102, 0, 0.2)", stroke: "rgba(255, 132, 40, 0.95)" },
    "TURB-LO": { fill: "rgba(204, 51, 0, 0.2)", stroke: "rgba(224, 81, 30, 0.95)" },
    TURB: { fill: "rgba(255, 102, 0, 0.2)", stroke: "rgba(255, 132, 40, 0.95)" },
    LLWS: { fill: "rgba(153, 51, 51, 0.26)", stroke: "rgba(193, 81, 81, 0.95)" },
    TS: { fill: "rgba(220, 20, 20, 0.22)", stroke: "rgba(255, 60, 60, 0.95)" },
    VA: { fill: "rgba(120, 113, 108, 0.28)", stroke: "rgba(168, 158, 150, 0.95)" },
    MTW: { fill: "rgba(45, 212, 191, 0.2)", stroke: "rgba(94, 234, 212, 0.95)" },
    TC: { fill: "rgba(190, 18, 60, 0.24)", stroke: "rgba(244, 63, 94, 0.95)" },
};

const GAIRMET_HAZARD_LABELS: Record<string, string> = {
    IFR: "IFR (Ceiling/Visibility)",
    ICE: "Icing",
    MT_OBSC: "Mountain Obscuration",
    "TURB-HI": "Turbulence (High)",
    "TURB-LO": "Turbulence (Low)",
    TURB: "Turbulence",
    LLWS: "Low-Level Wind Shear",
    TS: "Thunderstorms",
    VA: "Volcanic Ash",
    MTW: "Mountain Wave",
    TC: "Tropical Cyclone",
};

// Minimal legend keys — short labels, one row per hazard the layer can show.
const GAIRMET_LEGEND_ENTRIES: readonly [string, string][] = [
    ["IFR", "IFR"],
    ["ICE", "Icing"],
    ["MT_OBSC", "Mtn Obsc"],
    ["TURB-HI", "Turb Hi"],
    ["TURB-LO", "Turb Lo"],
    ["LLWS", "LLWS"],
];

const SIGMET_LEGEND_ENTRIES: readonly [string, string][] = [
    ["TS", "T-Storms"],
    ["TURB", "Turb"],
    ["ICE", "Icing"],
    ["VA", "Volc Ash"],
    ["MTW", "Mtn Wave"],
    ["TC", "Trop Cyc"],
];

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

const PIREP_SEVERITY_COLORS: Record<PirepSeverity, string> = {
    SEVERE: "#ff3b30",
    MODERATE: "#fb923c",
    LIGHT: "#4ade80",
    NONE: "#a1a1aa",
};

const PIREP_LEGEND_ENTRIES: readonly [PirepSeverity, string][] = [
    ["SEVERE", "Severe"],
    ["MODERATE", "Moderate"],
    ["LIGHT", "Light"],
    ["NONE", "None"],
];

// A simple top-down airplane silhouette (Material-style "flight" glyph) in a 24x24
// box, pointing north — reused for every PIREP marker so they all read at a glance
// as pilot reports, same size regardless of severity (only the fill color changes).
// Built lazily (not at module scope) because Path2D doesn't exist during Next.js's
// server-side render pass of this client component.
const AIRPLANE_ICON_PATH_D =
    "M12 2 L14 9 L21 13 L21 15 L14 13 L14 18 L17 20 L17 21.5 L12 20.5 L7 21.5 L7 20 L10 18 L10 13 L3 15 L3 13 L10 9 Z";
let airplaneIconPathCache: Path2D | null = null;

function getAirplaneIconPath(): Path2D {
    if (!airplaneIconPathCache) {
        airplaneIconPathCache = new Path2D(AIRPLANE_ICON_PATH_D);
    }
    return airplaneIconPathCache;
}

function drawAirplaneMarker(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    size: number,
    color: string,
    isUrgent: boolean
) {
    const path = getAirplaneIconPath();
    ctx.save();
    ctx.translate(x, y);
    const scale = size / 24;
    ctx.scale(scale, scale);
    ctx.translate(-12, -12);
    ctx.fillStyle = color;
    ctx.fill(path);
    ctx.lineWidth = (isUrgent ? 2.2 : 1.4) / scale;
    ctx.strokeStyle = isUrgent ? "#ffffff" : "#18181b";
    ctx.stroke(path);
    ctx.restore();
}

async function fetchGairmetZones(bounds: GeoBounds): Promise<GairmetZone[]> {
    const params = new URLSearchParams({
        south: String(bounds.south),
        west: String(bounds.west),
        north: String(bounds.north),
        east: String(bounds.east),
    });

    const response = await fetch(`/api/gairmet?${params.toString()}`);
    if (!response.ok) throw new Error("G-AIRMET request failed.");
    const data = await response.json();
    return Array.isArray(data?.zones) ? data.zones : [];
}

// International SIGMETs — cover Alaska, Hawaii, and other regions outside the
// CONUS-only G-AIRMET product. Same shape, so it draws through the same code path.
async function fetchIsigmetZones(bounds: GeoBounds): Promise<GairmetZone[]> {
    const params = new URLSearchParams({
        south: String(bounds.south),
        west: String(bounds.west),
        north: String(bounds.north),
        east: String(bounds.east),
    });

    const response = await fetch(`/api/isigmet?${params.toString()}`);
    if (!response.ok) throw new Error("International SIGMET request failed.");
    const data = await response.json();
    return Array.isArray(data?.zones) ? data.zones : [];
}

// Domestic (CONUS) SIGMETs — convective, icing, turbulence.
async function fetchAirsigmetZones(bounds: GeoBounds): Promise<GairmetZone[]> {
    const params = new URLSearchParams({
        south: String(bounds.south),
        west: String(bounds.west),
        north: String(bounds.north),
        east: String(bounds.east),
    });

    const response = await fetch(`/api/airsigmet?${params.toString()}`);
    if (!response.ok) throw new Error("Domestic SIGMET request failed.");
    const data = await response.json();
    return Array.isArray(data?.zones) ? data.zones : [];
}

async function fetchPirepReports(bounds: GeoBounds): Promise<PirepReport[]> {
    const params = new URLSearchParams({
        south: String(bounds.south),
        west: String(bounds.west),
        north: String(bounds.north),
        east: String(bounds.east),
    });

    const response = await fetch(`/api/pirep?${params.toString()}`);
    if (!response.ok) throw new Error("PIREP request failed.");
    const data = await response.json();
    return Array.isArray(data?.reports) ? data.reports : [];
}

async function fetchAirportsPage(
    bounds: GeoBounds,
    majorOnly = false,
    signal?: AbortSignal
): Promise<{ airports: AirportPoint[]; exceededLimit: boolean }> {
    const baseWhere = "PRIVATEUSE=0 AND OPERSTATUS='OPERATIONAL' AND MIL_CODE='CIVIL'";
    const params = new URLSearchParams({
        geometry: `${bounds.west},${bounds.south},${bounds.east},${bounds.north}`,
        geometryType: "esriGeometryEnvelope",
        inSR: "4326",
        spatialRel: "esriSpatialRelIntersects",
        where: majorOnly ? `${baseWhere} AND FAR91=1` : baseWhere,
        outFields: "IDENT,NAME,ICAO_ID,FAR91",
        returnGeometry: "true",
        geometryPrecision: "5",
        f: "geojson",
    });

    const response = await fetch(`${AIRPORTS_QUERY_URL}?${params.toString()}`, { signal });
    if (!response.ok) throw new Error("Airports request failed.");
    const data = await response.json();
    const features = Array.isArray(data?.features) ? data.features : [];

    const airports: AirportPoint[] = [];
    for (const feature of features) {
        const coordinates = feature?.geometry?.coordinates;
        if (!Array.isArray(coordinates) || coordinates.length < 2) continue;
        const rawIdent: string = feature?.properties?.IDENT ?? "";
        const icao: string | null = feature?.properties?.ICAO_ID ?? null;
        airports.push({
            // Normalized to the same K-prefixed 4-letter form everywhere (matching the METAR
            // station identifier and aviationweather.gov's own convention), instead of the FAA
            // data's mix of a bare 3-letter domestic code (e.g. "MIC") for some airports and a
            // full ICAO code for others — that inconsistency read as arbitrary on the map, and
            // it's also what let the same physical airport get keyed two different ways (its FAA
            // ident vs. its METAR station id) in earlier orphan-station handling and show up twice.
            ident: normalizeAirportIdent(rawIdent, icao),
            name: feature?.properties?.NAME ?? "",
            icao,
            lon: coordinates[0],
            lat: coordinates[1],
            isMajor: majorOnly || feature?.properties?.FAR91 === 1,
        });
    }
    return { airports, exceededLimit: data?.exceededTransferLimit === true };
}

function normalizeAirportIdent(rawIdent: string, icao: string | null): string {
    if (icao) return icao;
    if (rawIdent.length === 3) return `K${rawIdent}`;
    return rawIdent;
}

async function fetchAirports(
    bounds: GeoBounds,
    majorOnly = false,
    signal?: AbortSignal
): Promise<AirportPoint[]> {
    const { airports } = await fetchAirportsPage(bounds, majorOnly, signal);
    return airports;
}

const VALID_FLIGHT_CATEGORIES: readonly FlightCategory[] = ["VFR", "MVFR", "IFR", "LIFR", "UNKNOWN"];

// airport.ident is already normalized to this exact form at fetch time (see
// normalizeAirportIdent), so this just guards the empty-string edge case.
function resolveMetarStationKey(airport: AirportPoint): string | null {
    return airport.ident.length === 4 ? airport.ident : null;
}

// A bbox-shaped query against aviationweather.gov's METAR endpoint turned out to silently drop
// real, currently-reporting stations in ways that had nothing to do with the documented 400-record
// cap (confirmed by hand: KMIC and KSTP, both a few miles from KMSP with their own live METARs,
// were missing from *every* bbox query wide enough to also contain KMSP, capped or not — some
// undocumented spatial thinning, not just truncation). Querying explicitly by identifier instead
// sidesteps that entirely: `ids=` is an exact-match lookup with no area-based thinning, so it
// returns precisely the stations asked for and nothing else. Since the FAA airport fetch already
// gives a complete, deduplicated identifier list (fetchAdaptive already fixed its own ArcGIS
// truncation), the METAR step becomes "look up exactly these idents" rather than "guess at what's
// in this box" — and an airport with no result here has no METAR, full stop; there is nothing left
// to estimate.
const METAR_IDS_BATCH_SIZE = 300;
const METAR_IDS_FETCH_CONCURRENCY = 4;

async function fetchFlightCategoriesByIdents(
    idents: readonly string[],
    signal?: AbortSignal
): Promise<Map<string, FlightCategory>> {
    const uniqueIdents = Array.from(new Set(idents));
    const batches: string[][] = [];
    for (let i = 0; i < uniqueIdents.length; i += METAR_IDS_BATCH_SIZE) {
        batches.push(uniqueIdents.slice(i, i + METAR_IDS_BATCH_SIZE));
    }

    const categories = new Map<string, FlightCategory>();
    await runWithConcurrency(
        batches.map((batch) => async () => {
            if (signal?.aborted) return;
            const response = await fetch(`/api/metar/ids?ids=${batch.join(",")}`, { signal });
            if (!response.ok) return;
            const data = await response.json();
            const stations = Array.isArray(data?.stations) ? data.stations : [];
            for (const entry of stations) {
                const station = entry?.station;
                const flightCategory = entry?.flightCategory;
                if (
                    typeof station === "string" &&
                    VALID_FLIGHT_CATEGORIES.includes(flightCategory as FlightCategory)
                ) {
                    categories.set(station, flightCategory as FlightCategory);
                }
            }
        }),
        METAR_IDS_FETCH_CONCURRENCY
    );
    return categories;
}

// Looks up a real flightCategory (if any) for every airport by its own identifier and attaches
// it — no fallback, no estimate. An airport this doesn't find a category for simply has none,
// which is the honest, correct state for a field with no ASOS/AWOS of its own: it stays gray.
async function attachFlightCategories(
    airports: readonly AirportPoint[],
    signal?: AbortSignal
): Promise<AirportPoint[]> {
    const idents = airports.map((airport) => resolveMetarStationKey(airport)).filter((key): key is string => key !== null);
    const categories = await fetchFlightCategoriesByIdents(idents, signal);
    if (categories.size === 0) return airports as AirportPoint[];
    return airports.map((airport) => {
        const key = resolveMetarStationKey(airport);
        const flightCategory = key ? categories.get(key) : undefined;
        return flightCategory ? { ...airport, flightCategory } : airport;
    });
}

// ---- Minimal Web Mercator slippy-map math (replaces the Leaflet dependency) ----

type MapView = { lat: number; lon: number; zoom: number };
type GeoBounds = { west: number; south: number; east: number; north: number };

function lonToWorldFrac(lon: number): number {
    return (lon + 180) / 360;
}

function latToWorldFrac(lat: number): number {
    const sinLat = Math.sin((lat * Math.PI) / 180);
    return 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI);
}

function worldFracToLon(frac: number): number {
    return frac * 360 - 180;
}

function worldFracToLat(frac: number): number {
    const n = Math.PI - 2 * Math.PI * frac;
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

function projectToWorldPixel(lat: number, lon: number, zoom: number): { x: number; y: number } {
    const scale = MAP_TILE_SIZE * Math.pow(2, zoom);
    return { x: lonToWorldFrac(lon) * scale, y: latToWorldFrac(lat) * scale };
}

// With continuous (unclamped) panning, view.lon can drift past +/-180 as the map wraps
// around the world — a real longitude like -170 and its wrapped twin +190 are the same
// physical point, but projectToWorldPixel treats them as a full world-width apart. This
// picks whichever +/-360 multiple of a feature's longitude lands closest to the current
// view, so every marker/polygon/image bound projects to the copy of the world actually
// on screen instead of potentially a world away.
function wrapLonNear(lon: number, refLon: number): number {
    return lon + 360 * Math.round((refLon - lon) / 360);
}

function unprojectFromWorldPixel(x: number, y: number, zoom: number): { lat: number; lon: number } {
    const scale = MAP_TILE_SIZE * Math.pow(2, zoom);
    return { lat: worldFracToLat(y / scale), lon: worldFracToLon(x / scale) };
}

// Screen-space pixel size of the decluttering grid used by computeVisibleAirports below.
const AIRPORT_DECLUTTER_CELL_PX = 56;

// At low zoom a hard isMajor filter is either too sparse (the FAA's FAR91 "major hub" flag is
// only ~30 airports nationwide — a near-empty map) or, with a looser definition, too dense
// (thousands of IAP-having fields crowd the view). Grid decimation sits between the two: bucket
// every candidate into a screen-space grid and keep only the single best one per cell, so the
// view always reads as "a reasonable, evenly-spread set of airports" regardless of how dense the
// underlying data actually is. Which airport wins a cell escalates through three tiers as you
// zoom in (see LOCAL_DETAIL_MIN_ZOOM_PERCENT / AIRPORT_ALL_MIN_ZOOM_PERCENT for the thresholds):
// majors only, then majors + anything with a real ICAO code (airport.icao — already returned by
// the airports query, a reliable "this one's substantial" proxy with no extra fetch needed), then
// finally every airport undecimated. A category (a resolved METAR flight color) always wins a
// cell first regardless of tier — a colored dot is more useful than an uncolored one of higher
// rank — with the tier's rank only breaking ties between two candidates that are otherwise equal.
// Shared by drawing and hit-testing so a click always lands on whatever's actually visible.
type AirportDetailTier = "major" | "semiMajor" | "all";

function computeVisibleAirports(
    airports: readonly AirportPoint[],
    view: MapView,
    tileZoom: number,
    centerWorldPx: { x: number; y: number },
    scaleFactor: number,
    cssWidth: number,
    cssHeight: number,
    selectedIdent: string | null,
    tier: AirportDetailTier
): AirportPoint[] {
    if (tier === "all") return airports as AirportPoint[];

    const cellSize = AIRPORT_DECLUTTER_CELL_PX;
    const bestByCell = new Map<string, { airport: AirportPoint; score: number }>();
    let selected: AirportPoint | null = null;
    for (const airport of airports) {
        if (airport.ident === selectedIdent) {
            selected = airport;
            continue;
        }
        const world = projectToWorldPixel(airport.lat, wrapLonNear(airport.lon, view.lon), tileZoom);
        const x = cssWidth / 2 + (world.x - centerWorldPx.x) * scaleFactor;
        const y = cssHeight / 2 + (world.y - centerWorldPx.y) * scaleFactor;
        if (x < -cellSize || x > cssWidth + cellSize || y < -cellSize || y > cssHeight + cellSize) continue;
        const rank =
            tier === "semiMajor" ? airport.isMajor || airport.icao !== null : airport.isMajor;
        const score = (airport.flightCategory ? 2 : 0) + (rank ? 1 : 0);
        // The cell key is built from world-space position (scaled by the current zoom), not
        // screen-space x/y — an airport's own lat/lon never moves, so its cell only changes when
        // the zoom does. Keying off screen position instead made every airport's cell shift as
        // the view panned, so the "winner" of each cell — and thus which dots were visible —
        // changed continuously, reading as airports strobing in and out while panning.
        const key = `${Math.floor((world.x * scaleFactor) / cellSize)},${Math.floor((world.y * scaleFactor) / cellSize)}`;
        const existing = bestByCell.get(key);
        if (!existing || score > existing.score) {
            bestByCell.set(key, { airport, score });
        }
    }
    const result = Array.from(bestByCell.values(), (entry) => entry.airport);
    if (selected) result.push(selected);
    return result;
}

function computeAirportDetailTier(zoomPercent: number): AirportDetailTier {
    if (zoomPercent >= AIRPORT_ALL_MIN_ZOOM_PERCENT) return "all";
    if (zoomPercent >= LOCAL_DETAIL_MIN_ZOOM_PERCENT) return "semiMajor";
    return "major";
}

function boundsForDiameterMeters(center: { lat: number; lon: number }, diameterMeters: number): GeoBounds {
    const latDeltaDeg = (diameterMeters / 2 / 6378137) * (180 / Math.PI);
    const lonDeltaDeg = latDeltaDeg / Math.max(0.01, Math.cos((center.lat * Math.PI) / 180));
    return {
        west: center.lon - lonDeltaDeg,
        east: center.lon + lonDeltaDeg,
        south: center.lat - latDeltaDeg,
        north: center.lat + latDeltaDeg,
    };
}

// The lat/lon box currently on screen. Returns null for a viewport straddling the antimeridian
// (west > east) — a rare edge case for a US-focused layer that isn't worth handling correctly;
// callers just skip the reactive fetch for that one frame.
function computeViewportBounds(view: MapView, cssWidth: number, cssHeight: number): GeoBounds | null {
    const centerWorldPx = projectToWorldPixel(view.lat, view.lon, view.zoom);
    const topLeft = unprojectFromWorldPixel(
        centerWorldPx.x - cssWidth / 2,
        centerWorldPx.y - cssHeight / 2,
        view.zoom
    );
    const bottomRight = unprojectFromWorldPixel(
        centerWorldPx.x + cssWidth / 2,
        centerWorldPx.y + cssHeight / 2,
        view.zoom
    );
    if (topLeft.lon > bottomRight.lon) return null;
    return { west: topLeft.lon, east: bottomRight.lon, north: topLeft.lat, south: bottomRight.lat };
}

function boundsContains(outer: GeoBounds, inner: GeoBounds): boolean {
    return (
        outer.west <= inner.west &&
        outer.east >= inner.east &&
        outer.south <= inner.south &&
        outer.north >= inner.north
    );
}

function padBounds(bounds: GeoBounds, factor: number): GeoBounds {
    const lonPad = ((bounds.east - bounds.west) * (factor - 1)) / 2;
    const latPad = ((bounds.north - bounds.south) * (factor - 1)) / 2;
    return {
        west: bounds.west - lonPad,
        east: bounds.east + lonPad,
        south: bounds.south - latPad,
        north: bounds.north + latPad,
    };
}

function intersectBounds(a: GeoBounds, b: GeoBounds): GeoBounds {
    return {
        west: Math.max(a.west, b.west),
        east: Math.min(a.east, b.east),
        south: Math.max(a.south, b.south),
        north: Math.min(a.north, b.north),
    };
}

// Tiles a bounding box into a grid of smaller boxes, each small enough to stay under the ArcGIS
// service's 1000-record cap even in the densest tile — AMERICAS_BOUNDS as a whole has ~5,200
// airports and ~1,500 Class B/C/D shapes nationwide (confirmed live), so a 4x4 grid keeps even an
// unevenly-dense tile (the Northeast corridor, say) comfortably under the cap.
function tileBounds(bounds: GeoBounds, cols: number, rows: number): GeoBounds[] {
    const lonStep = (bounds.east - bounds.west) / cols;
    const latStep = (bounds.north - bounds.south) / rows;
    const tiles: GeoBounds[] = [];
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            tiles.push({
                west: bounds.west + col * lonStep,
                east: bounds.west + (col + 1) * lonStep,
                south: bounds.south + row * latStep,
                north: bounds.south + (row + 1) * latStep,
            });
        }
    }
    return tiles;
}

// Runs async tasks with bounded concurrency instead of firing them all at once — a full-country
// tiled fetch is a couple dozen requests, and the ArcGIS services behind fetchAirports/
// fetchAirspacePolygons share a request-unit quota across every user of this app (a burst has
// hit a 429 "quota exceeded" in testing), so this spreads the load out instead of bursting it.
async function runWithConcurrency<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
    const results: T[] = new Array(tasks.length);
    let nextIndex = 0;
    async function worker() {
        for (;;) {
            const index = nextIndex++;
            if (index >= tasks.length) return;
            results[index] = await tasks[index]();
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
    return results;
}

const NATIONWIDE_TILE_COLS = 4;
const NATIONWIDE_TILE_ROWS = 4;
const NATIONWIDE_FETCH_CONCURRENCY = 4;
// Keeps flight categories current (weather changes) and picks up any airport/airspace data a
// tile happened to miss. Airport/airspace boundaries themselves are effectively static, so this
// interval is really about the METAR-derived colors, not the underlying geometry.
const NATIONWIDE_REFRESH_INTERVAL_MS = 7 * 60_000;

// Even a single 30deg x 15deg tile (1/16th of AMERICAS_BOUNDS) can badly exceed ArcGIS's
// 1000-feature-per-request cap in a dense region — one such tile over the central US actually
// holds 2,556 airports (returnCountOnly-verified) and 2,690 airspace polygons, so the plain tiled
// fetch below was silently getting only the first ~1000 of each and dropping the rest before
// flight categories were ever attempted, which is why a majority of airports still had no color
// even after tiling. This recurses: on a truncated response (the ArcGIS response's own
// exceededTransferLimit flag), split the tile into 4 quadrants and re-fetch each, so only the
// pockets that are actually dense enough to need it get subdivided further. Capped at
// NATIONWIDE_ADAPTIVE_MAX_DEPTH so a pathological case can't runaway into an unbounded number of
// requests.
const NATIONWIDE_ADAPTIVE_MAX_DEPTH = 3;

// A transient failure (network blip, the ArcGIS service's own request-unit quota — see the
// runWithConcurrency comment) on just one quadrant used to sink the *entire* top-level tile: the
// old single `.catch(() => [])` at each call site wrapped the whole recursive fetchAdaptive call,
// so one bad sub-request discarded every sibling quadrant's already-successful results too. One
// retry plus catching failures at the leaf itself keeps a lone bad quadrant's blast radius to just
// that quadrant.
async function fetchPageWithRetry<T>(
    bounds: GeoBounds,
    fetchPage: (bounds: GeoBounds) => Promise<{ items: T[]; exceededLimit: boolean }>
): Promise<{ items: T[]; exceededLimit: boolean }> {
    try {
        return await fetchPage(bounds);
    } catch {
        try {
            return await fetchPage(bounds);
        } catch {
            return { items: [], exceededLimit: false };
        }
    }
}

async function fetchAdaptive<T>(
    bounds: GeoBounds,
    fetchPage: (bounds: GeoBounds) => Promise<{ items: T[]; exceededLimit: boolean }>,
    depth = 0
): Promise<T[]> {
    const { items, exceededLimit } = await fetchPageWithRetry(bounds, fetchPage);
    if (!exceededLimit || depth >= NATIONWIDE_ADAPTIVE_MAX_DEPTH) return items;

    const midLon = (bounds.west + bounds.east) / 2;
    const midLat = (bounds.south + bounds.north) / 2;
    const quadrants: GeoBounds[] = [
        { west: bounds.west, east: midLon, south: bounds.south, north: midLat },
        { west: midLon, east: bounds.east, south: bounds.south, north: midLat },
        { west: bounds.west, east: midLon, south: midLat, north: bounds.north },
        { west: midLon, east: bounds.east, south: midLat, north: bounds.north },
    ];
    const results = await Promise.all(
        quadrants.map((quadrant) => fetchAdaptive(quadrant, fetchPage, depth + 1))
    );
    return results.flat();
}

// Full airport + airspace + flight-category detail for the whole AMERICAS_BOUNDS area, not just
// near the selected station — tiled because a single request that size errors out on the ArcGIS
// side for airports/airspace (reported as a CORS failure). fetchAdaptive above further subdivides
// any tile whose airports or airspace alone still exceed the ArcGIS cap. Runs once on load and
// again on NATIONWIDE_REFRESH_INTERVAL_MS so the whole country is populated up front instead of
// only filling in reactively as panned to. Each top-level tile fetches airports/airspace together
// so onZoneDone can report one tick per tile — that's what drives the "loading zone N" progress
// text on first load — with flight categories attached afterward in one pass across the complete,
// deduplicated airport list (see attachFlightCategories).
async function loadNationwideAirportsAndAirspace(
    signal: AbortSignal,
    onZoneDone?: (zoneIndex: number, zoneCount: number) => void
): Promise<{ airports: AirportPoint[]; polygons: AirspacePolygon[] }> {
    const tiles = tileBounds(AMERICAS_BOUNDS, NATIONWIDE_TILE_COLS, NATIONWIDE_TILE_ROWS);
    const tileResults = await runWithConcurrency(
        tiles.map((tile, index) => async () => {
            const [airports, polygons] = await Promise.all([
                fetchAdaptive(tile, (b) =>
                    fetchAirportsPage(b, false, signal).then((r) => ({
                        items: r.airports,
                        exceededLimit: r.exceededLimit,
                    }))
                ).catch(() => [] as AirportPoint[]),
                fetchAdaptive(tile, (b) =>
                    fetchAirspacePolygonsPage(b, signal).then((r) => ({
                        items: r.polygons,
                        exceededLimit: r.exceededLimit,
                    }))
                ).catch(() => [] as AirspacePolygon[]),
            ]);
            onZoneDone?.(index, tiles.length);
            return { airports, polygons };
        }),
        NATIONWIDE_FETCH_CONCURRENCY
    );

    const airportMap = new Map<string, AirportPoint>();
    const polygonMap = new Map<string, AirspacePolygon>();
    for (const result of tileResults) {
        for (const airport of result.airports) airportMap.set(airport.ident, airport);
        for (const polygon of result.polygons) {
            const key = `${polygon.airspaceClass}|${polygon.name}|${polygon.rings[0]?.[0]?.lat}|${polygon.rings[0]?.[0]?.lon}`;
            polygonMap.set(key, polygon);
        }
    }

    const airports = await attachFlightCategories(Array.from(airportMap.values()), signal);

    return {
        airports,
        polygons: Array.from(polygonMap.values()),
    };
}

function computeBoundsZoom(
    bounds: GeoBounds,
    containerWidthPx: number,
    containerHeightPx: number,
    fit: "contain" | "cover" = "contain"
): number {
    const lonSpan = lonToWorldFrac(bounds.east) - lonToWorldFrac(bounds.west);
    const latSpan = Math.abs(latToWorldFrac(bounds.south) - latToWorldFrac(bounds.north));
    const zoomForWidth = Math.log2(containerWidthPx / (lonSpan * MAP_TILE_SIZE));
    const zoomForHeight = Math.log2(containerHeightPx / (latSpan * MAP_TILE_SIZE));
    return fit === "cover"
        ? Math.max(zoomForWidth, zoomForHeight)
        : Math.min(zoomForWidth, zoomForHeight);
}

// Keeps the viewport from ever panning past the given geographic bounds — once the
// bounds are smaller than the viewport on an axis (e.g. at the 150nm zoomed-out
// floor), that axis locks to the bounds' center instead of allowing any pan.
function clampViewToMaxBounds(
    view: MapView,
    maxBounds: GeoBounds,
    viewportWidthPx: number,
    viewportHeightPx: number
): MapView {
    const scale = MAP_TILE_SIZE * Math.pow(2, view.zoom);
    const boundsMinX = lonToWorldFrac(maxBounds.west) * scale;
    const boundsMaxX = lonToWorldFrac(maxBounds.east) * scale;
    const boundsMinY = latToWorldFrac(maxBounds.north) * scale;
    const boundsMaxY = latToWorldFrac(maxBounds.south) * scale;

    const centerPx = projectToWorldPixel(view.lat, view.lon, view.zoom);
    const halfWidth = viewportWidthPx / 2;
    const halfHeight = viewportHeightPx / 2;

    const clampedX =
        boundsMaxX - boundsMinX <= viewportWidthPx
            ? (boundsMinX + boundsMaxX) / 2
            : Math.min(Math.max(centerPx.x, boundsMinX + halfWidth), boundsMaxX - halfWidth);
    const clampedY =
        boundsMaxY - boundsMinY <= viewportHeightPx
            ? (boundsMinY + boundsMaxY) / 2
            : Math.min(Math.max(centerPx.y, boundsMinY + halfHeight), boundsMaxY - halfHeight);

    const clampedLatLon = unprojectFromWorldPixel(clampedX, clampedY, view.zoom);
    return { lat: clampedLatLon.lat, lon: clampedLatLon.lon, zoom: view.zoom };
}

function computeScaleForView(view: MapView, targetPx: number): { nm: number; px: number } {
    const metersPerPixel =
        (EARTH_CIRCUMFERENCE_METERS * Math.abs(Math.cos((view.lat * Math.PI) / 180))) /
        (MAP_TILE_SIZE * Math.pow(2, view.zoom));
    const maxNm = (metersPerPixel * targetPx) / NM_TO_METERS;

    let chosen = RADAR_SCALE_NICE_VALUES_NM[0];
    for (const value of RADAR_SCALE_NICE_VALUES_NM) {
        if (value <= maxNm) chosen = value;
        else break;
    }

    const px = (chosen * NM_TO_METERS) / metersPerPixel;
    return { nm: chosen, px };
}

// The scale bar's smallest nice value is RADAR_SCALE_MIN_NM (1 nm) — zooming in past the point
// where that value would represent less than one target-width's worth of real distance makes
// the bar balloon past its intended width to keep showing "1 nm" at a real scale under 1 nm. This
// finds the zoom level where the bar exactly reads RADAR_SCALE_MIN_NM, so callers can clamp there.
function computeMaxZoomForMinScale(lat: number, targetPx: number): number {
    const metersPerPixelAtZoom0 =
        EARTH_CIRCUMFERENCE_METERS * Math.max(Math.abs(Math.cos((lat * Math.PI) / 180)), 0.01);
    const ratio = (metersPerPixelAtZoom0 * targetPx) / (MAP_TILE_SIZE * NM_TO_METERS * RADAR_SCALE_MIN_NM);
    return Math.log2(Math.max(ratio, 1));
}

function computeScaleTargetPx(containerWidthPx: number): number {
    return Math.max(90, Math.min(RADAR_SCALE_MAX_TARGET_PX, containerWidthPx * 0.38));
}

function computeEffectiveMaxZoom(rangeMax: number, lat: number, containerWidthPx: number): number {
    return Math.min(rangeMax, computeMaxZoomForMinScale(lat, computeScaleTargetPx(containerWidthPx)));
}

// Matches the on-screen zoom readout's own math — see displayZoomPercent — so a threshold
// expressed as "N% zoom" means the same thing everywhere it's checked.
function computeZoomPercent(zoom: number, min: number, effectiveMax: number): number {
    return effectiveMax > min ? ((zoom - min) / (effectiveMax - min)) * 100 : 0;
}

function computePinchMetrics(
    points: readonly { x: number; y: number }[]
): { distance: number; mid: { x: number; y: number } } {
    const [a, b] = points;
    return {
        distance: Math.hypot(b.x - a.x, b.y - a.y),
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    };
}

const EARTH_RADIUS_NM = 3440.065;

// Built once (parsing the WMM coefficient tables isn't free) and reused for every lookup —
// declination drifts slowly enough (secular variation) that a per-session model is plenty fresh.
const MAGNETIC_MODEL = Geomagnetism.model();

// True bearing/great-circle distance between two points — already curvature-correct at any range
// via spherical trig (haversine distance, initial great-circle bearing) rather than flat-plane
// approximation, which would drift increasingly wrong as distance grows.
function computeBearingDistance(
    from: { lat: number; lon: number },
    to: { lat: number; lon: number }
): { bearingDeg: number; distanceNm: number } {
    const lat1 = (from.lat * Math.PI) / 180;
    const lat2 = (to.lat * Math.PI) / 180;
    const dLat = lat2 - lat1;
    const dLon = ((to.lon - from.lon) * Math.PI) / 180;

    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    const bearingDeg = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;

    const a =
        Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const distanceNm = EARTH_RADIUS_NM * c;

    return { bearingDeg, distanceNm };
}

// Converts a true bearing to magnetic using the WMM declination at the reference point (the
// convention pilots use: local variation at the station, not some blend along the course) —
// "variation east, magnetic least": magnetic = true - declination (east-positive).
function trueToMagneticBearing(trueBearingDeg: number, at: { lat: number; lon: number }): number {
    const declination = MAGNETIC_MODEL.point([at.lat, at.lon]).decl;
    return ((trueBearingDeg - declination) % 360 + 360) % 360;
}

type ApiResponse = {
    raw?: string;
    normalized?: NormalizedMetar;
    error?: string;
};

type StationInfo = {
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

type AirportDiagramInfo = {
    station: string;
    faaIdent: string;
    faaSearchUrl: string;
    faaSearchResultsUrl: string;
    faaAirportDiagramPageUrl: string;
    diagramPdfUrl: string | null;
    chartName: string | null;
    pdfName: string | null;
    cycle: string | null;
    note: string;
};

type AirportDiagramResponse =
    | AirportDiagramInfo
    | {
        error: string;
    };

type StationInfoResponse = {
    data?: StationInfo;
    error?: string;
};

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

type AirportRunwaysResponse = {
    data?: AirportRunway[];
    error?: string;
};

type RunwayEnd = {
    runwayId: string;
    pairName: string;
    ident: string;
    headingDeg: number;
};

type RunwayWindComponent = {
    headwindKt: number;
    crosswindKt: number;
    crosswindFrom: "left" | "right" | "centerline";
};

type AirportMapFeature = {
    id: string;
    label: string;
    latitude: number;
    longitude: number;
};

type AirportMapFeatureLayout = {
    feature: AirportMapFeature;
    point: SvgPoint;
};

type AirportMapLayout = {
    runwayLayout: RunwayLayout[];
    featureLayout: AirportMapFeatureLayout[];
};

type SvgPoint = {
    x: number;
    y: number;
};

type RunwayLayout = {
    runway: AirportRunway;
    start: SvgPoint;
    end: SvgPoint;
};

type CalculatedRunwayEnd = RunwayEnd & {
    component: RunwayWindComponent;
    gustComponent: RunwayWindComponent | null;
};

type RemarkBubble = {
    code: string;
    meaning: string;
};

type WindDisplayMode = "animated" | "direction" | "hidden";

type DecoderTab = "lookup" | "raw";
type DashboardTab = "weather" | "taf" | "radar" | "airport";

type TafSkyCondition = {
    cover?: string | null;
    baseFtAgl?: number | null;
};

type TafForecastBlock = {
    change?: string | null;
    probability?: number | null;
    from?: string | null;
    to?: string | null;
    windDirection?: string | number | null;
    windSpeedKt?: string | number | null;
    windGustKt?: string | number | null;
    visibilitySm?: string | number | null;
    weather?: string | null;
    sky?: TafSkyCondition[];
};

type TafResponse = {
    requestedStation: string;
    requestedAirport?: string;
    tafStation: string;
    tafIsSameStation: boolean;
    distanceNm?: number;
    distanceSm?: number;
    issueTime?: string;
    validFrom?: string;
    validTo?: string;
    rawText: string;
    forecast?: TafForecastBlock[];
};


const KFCM_INFLIGHT_FEATURE: AirportMapFeature = {
    id: "inflight-aviation",
    label: "Inflight",
    latitude: 44.829983,
    longitude: -93.451894,
};

const FLIGHT_CATEGORY_STYLES: Record<FlightCategory, string> = {
    VFR: "border-emerald-400/50 bg-emerald-400/15 text-emerald-200",
    MVFR: "border-sky-400/50 bg-sky-400/15 text-sky-200",
    IFR: "border-red-400/50 bg-red-400/15 text-red-200",
    LIFR: "border-fuchsia-400/50 bg-fuchsia-400/15 text-fuchsia-200",
    UNKNOWN: "border-zinc-500/50 bg-zinc-500/15 text-zinc-200",
};

type TafIconKey =
    | "clearDay"
    | "clearNight"
    | "fewDay"
    | "fewNight"
    | "sctDay"
    | "sctNight"
    | "bknDay"
    | "bknNight"
    | "ovcDay"
    | "ovcNight"
    | "rain"
    | "thunderstorm"
    | "fog"
    | "snow"
    | "freezing";

const TAF_ICON_SRC: Record<TafIconKey, string> = {
    clearDay: "/icons/taf/sun.png",
    clearNight: "/icons/taf/moon.png",

    fewDay: "/icons/taf/few_day.png",
    fewNight: "/icons/taf/few_night.png",

    sctDay: "/icons/taf/sct_day.png",
    sctNight: "/icons/taf/sct_night.png",

    bknDay: "/icons/taf/bkn_day.png",
    bknNight: "/icons/taf/bkn_night.png",

    ovcDay: "/icons/taf/clouds_day.png",
    ovcNight: "/icons/taf/clouds_night.png",

    rain: "/icons/taf/rain.png",
    thunderstorm: "/icons/taf/thunderstorm.png",
    fog: "/icons/taf/fog.png",
    snow: "/icons/taf/snow.png",
    freezing: "/icons/taf/snow.png",
};

const TAF_MARKER_ICON_SRC = {
    sunrise: "/icons/sunrise.png",
    sunset: "/icons/sunset.png",
};

// Refresh intervals in milliseconds. Change the leading integer for minutes.
const LIVE_WEATHER_REFRESH_MS = 1 * 60 * 1000;
const TAF_REFRESH_MS = 5 * 60 * 1000;

const TAF_FULLSCREEN_BASE_HEIGHT = 490;
const TAF_FULLSCREEN_MIN_SCALE = 0.45;
const TAF_FULLSCREEN_CARD_WIDTH = 155;
const TAF_FULLSCREEN_CARD_GAP = 12;

type TafTimelineMarker = {
    type: "sunrise" | "sunset" | "currencyStart" | "currencyEnd";
    label: string;
    time: Date;
};

type NightCurrencyWindow = {
    start: Date;
    end: Date;
};

type TafHourSlot = {
    startsAt: Date;
    block: TafForecastBlock;
    iconKey: TafIconKey;
    weatherLabel: string;
    flightCategory: FlightCategory;
    visibility: string;
    ceiling: string;
    wind: string;
    gusts: string;
    change: string;
    precipChance: { percent: number; label: string } | null;
    changeNote: string | null;
    markers: TafTimelineMarker[];
    isNightCurrency: boolean;
};

type InflightLabelSide = "left" | "right" | "middle";

export default function Home() {
    const [activeTab, setActiveTab] = useState<DecoderTab>("lookup");
    const [station, setStation] = useState("KFCM");
    const [isFullscreenOpen, setIsFullscreenOpen] = useState(false);
    const [isRadarFullscreen, setIsRadarFullscreen] = useState(false);
    const [rawInput, setRawInput] = useState("");
    const [searchMode, setSearchMode] = useState<"decode" | "quiz">("decode");
    const [quizMode, setQuizMode] = useState(false);

    const [metar, setMetar] = useState<NormalizedMetar | null>(null);
    const [rawMetar, setRawMetar] = useState<string | null>(null);
    const [stationInfo, setStationInfo] = useState<StationInfo | null>(null);
    const [airportDiagram, setAirportDiagram] = useState<AirportDiagramInfo | null>(null);
    const [runways, setRunways] = useState<AirportRunway[]>([]);
    const [error, setError] = useState("");
    const [lastMetarFetchAttempt, setLastMetarFetchAttempt] = useState<Date | null>(null);

    const [loading, setLoading] = useState(true);
    // Separate from `loading` (which also flips true for the silent 2-minute background
    // refresh — see the refreshTimer effect below): this one only ever gets set for a lookup the
    // user actually asked for (the initial page load, Go, Enter, Decode, Start Quiz, or a manual
    // refresh), and it's what gates the full-page loading overlay below. A silent background
    // refresh should never interrupt someone reading the page.
    const [pageLoading, setPageLoading] = useState(true);
    const latestStationRef = useRef(station);
    const latestActiveTabRef = useRef(activeTab);

    useEffect(() => {
        latestStationRef.current = station;
    }, [station]);

    useEffect(() => {
        latestActiveTabRef.current = activeTab;
    }, [activeTab]);

    async function loadLiveMetar(cleanStation: string, options?: { silent?: boolean }) {
        setLastMetarFetchAttempt(new Date());

        try {
            const response = await fetch(
                `/api/metar/live?station=${encodeURIComponent(cleanStation)}`
            );
            const data: ApiResponse = await response.json();

            if (!response.ok || data.error) {
                throw new Error(data.error ?? "Unable to fetch live METAR.");
            }

            const normalized = data.normalized ?? null;

            setMetar(normalized);
            setRawMetar(data.raw ?? null);

            await fetchStationInfo(normalized?.station ?? cleanStation);
            await fetchAirportDiagram(normalized?.station ?? cleanStation);
            await fetchAirportRunways(normalized?.station ?? cleanStation);

        } catch (err) {
            setError(err instanceof Error ? err.message : "Unexpected error.");
        } finally {
            setLoading(false);
            if (!options?.silent) setPageLoading(false);
        }
    }

    function fetchLiveMetar(stationToFetch = station, options?: { silent?: boolean }) {
        const cleanStation = stationToFetch.trim().toUpperCase();

        setLoading(true);
        if (!options?.silent) setPageLoading(true);
        setError("");
        setStation(cleanStation);
        latestStationRef.current = cleanStation;

        void loadLiveMetar(cleanStation, options);
    }

    function startQuiz() {
        setQuizMode(true);
        fetchLiveMetar();
    }

    function runSearch() {
        if (searchMode === "quiz") {
            startQuiz();
        } else {
            setQuizMode(false);
            fetchLiveMetar();
        }
    }

    async function decodeRawMetar() {
        setLoading(true);
        setPageLoading(true);
        setError("");
        setQuizMode(false);

        try {
            const response = await fetch("/api/metar/parse", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    raw: rawInput,
                }),
            });

            const data: ApiResponse = await response.json();

            if (!response.ok || data.error) {
                throw new Error(data.error ?? "Unable to decode raw METAR.");
            }

            const normalized = data.normalized ?? null;

            setMetar(normalized);
            setRawMetar(data.raw ?? rawInput);

            await fetchStationInfo(normalized?.station);
            await fetchAirportDiagram(normalized?.station);
            await fetchAirportRunways(normalized?.station);

        } catch (err) {
            setError(err instanceof Error ? err.message : "Unexpected error.");
        } finally {
            setLoading(false);
            setPageLoading(false);
        }
    }

    async function fetchStationInfo(stationToLookup: string | null | undefined) {
        if (!stationToLookup) {
            setStationInfo(null);
            return;
        }

        try {
            const response = await fetch(
                `/api/airport/info?station=${encodeURIComponent(stationToLookup)}`
            );

            const data: StationInfoResponse = await response.json();

            if (!response.ok || data.error || !data.data) {
                setStationInfo(null);
                return;
            }

            setStationInfo(data.data);
        } catch {
            setStationInfo(null);
        }
    }

    async function fetchAirportDiagram(stationToLookup: string | null | undefined) {
        if (!stationToLookup) {
            setAirportDiagram(null);
            return;
        }

        try {
            const response = await fetch(
                `/api/airport/diagram?station=${encodeURIComponent(stationToLookup)}`
            );

            const data: AirportDiagramResponse = await response.json();

            if (!response.ok || "error" in data) {
                setAirportDiagram(null);
                return;
            }

            setAirportDiagram(data);
        } catch {
            setAirportDiagram(null);
        }
    }

    async function fetchAirportRunways(stationToLookup: string | null | undefined) {
        if (!stationToLookup) {
            setRunways([]);
            return;
        }

        try {
            const response = await fetch(
                `/api/airport/runways?station=${encodeURIComponent(stationToLookup)}`
            );

            const data: AirportRunwaysResponse = await response.json();

            if (!response.ok || data.error || !data.data) {
                setRunways([]);
                return;
            }

            setRunways(data.data);
        } catch {
            setRunways([]);
        }
    }

    useEffect(() => {
        const initialLoadTimer = window.setTimeout(() => {
            void loadLiveMetar("KFCM");
        }, 0);

        const refreshTimer = window.setInterval(() => {
            if (latestActiveTabRef.current === "lookup") {
                void fetchLiveMetar(latestStationRef.current, { silent: true });
            }
        }, LIVE_WEATHER_REFRESH_MS);

        return () => {
            window.clearTimeout(initialLoadTimer);
            window.clearInterval(refreshTimer);
        };

        // Run once on page load, then refresh the current live ICAO lookup every 2 minutes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <main className="min-h-screen bg-[#050505] text-zinc-100">
            <div className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_top_left,_rgba(214,179,90,0.16),_transparent_35%),radial-gradient(circle_at_top_right,_rgba(255,255,255,0.08),_transparent_30%)]" />

            <div className="mx-auto w-full max-w-[2400px] px-3 py-6 sm:px-4 md:w-[95vw] md:py-8 lg:px-8">
                <header className="relative mb-8 overflow-hidden rounded-3xl border border-zinc-900 bg-gradient-to-b from-zinc-950 to-black px-5 py-5 sm:px-7 sm:py-6">
                    <svg
                        className="pointer-events-none absolute -right-16 -top-16 h-[220px] w-[220px] text-[#d6b35a] opacity-[0.08] sm:h-[260px] sm:w-[260px]"
                        viewBox="0 0 400 400"
                        fill="none"
                        aria-hidden="true"
                    >
                        <circle cx="200" cy="200" r="188" stroke="currentColor" strokeWidth="1" />
                        <circle cx="200" cy="200" r="138" stroke="currentColor" strokeWidth="1" />
                        <circle cx="200" cy="200" r="3" fill="currentColor" />
                        {Array.from({ length: 12 }).map((_, i) => {
                            const angle = (i * 30 * Math.PI) / 180;
                            const inner = i % 3 === 0 ? 168 : 178;
                            const x1 = Number((200 + Math.sin(angle) * inner).toFixed(2));
                            const y1 = Number((200 - Math.cos(angle) * inner).toFixed(2));
                            const x2 = Number((200 + Math.sin(angle) * 188).toFixed(2));
                            const y2 = Number((200 - Math.cos(angle) * 188).toFixed(2));
                            return (
                                <line
                                    key={i}
                                    x1={x1}
                                    y1={y1}
                                    x2={x2}
                                    y2={y2}
                                    stroke="currentColor"
                                    strokeWidth={i % 3 === 0 ? 2 : 1}
                                />
                            );
                        })}
                    </svg>

                    <div className="relative flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                        <div className="flex items-center gap-3">
                            <Image
                                src="/inflight-logo.svg"
                                alt="Inflight Aviation"
                                width={40}
                                height={40}
                                className="h-10 w-10 shrink-0 object-contain"
                            />

                            <div>
                                <p className="text-[10px] font-semibold uppercase tracking-[0.25em] text-[#e6c76f]">
                                    Inflight Aviation
                                </p>
                                <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
                                    Weather
                                </h1>
                            </div>
                        </div>

                        <div className="w-full lg:w-[360px] lg:flex-none">
                            {activeTab === "lookup" ? (
                                <>
                                    <div className="flex items-center gap-1.5 rounded-full border border-zinc-700 bg-black/60 py-1.5 pl-5 pr-1.5 transition focus-within:border-[#d6b35a]">
                                        <input
                                            value={station}
                                            onChange={(event) =>
                                                setStation(event.target.value.toUpperCase())
                                            }
                                            onKeyDown={(event) => {
                                                if (event.key === "Enter") runSearch();
                                            }}
                                            className="min-w-0 flex-1 bg-transparent text-sm font-semibold text-white outline-none placeholder:font-normal placeholder:text-zinc-600"
                                            placeholder="Enter ICAO code — KFCM"
                                        />

                                        <button
                                            onClick={runSearch}
                                            disabled={loading}
                                            className="shrink-0 rounded-full bg-[#d6b35a] px-5 py-2 text-xs font-black uppercase tracking-[0.08em] text-black transition hover:bg-[#e6c76f] disabled:cursor-not-allowed disabled:opacity-50"
                                        >
                                            {loading ? "…" : "Go"}
                                        </button>
                                    </div>

                                    <div className="mt-2 flex items-center gap-3">
                                        <div className="relative flex items-center rounded-full border border-zinc-700 bg-black/40 p-0.5 text-[10px] font-black uppercase tracking-[0.08em]">
                                            <span
                                                aria-hidden="true"
                                                className={`absolute inset-y-0.5 left-0.5 w-16 rounded-full bg-[#d6b35a] transition-transform duration-200 ease-out ${searchMode === "quiz" ? "translate-x-16" : "translate-x-0"
                                                    }`}
                                            />

                                            <button
                                                onClick={() => setSearchMode("decode")}
                                                className={`relative z-10 w-16 rounded-full px-2 py-1.5 uppercase transition-colors ${searchMode === "decode" ? "text-black" : "text-zinc-400"
                                                    }`}
                                            >
                                                Decode
                                            </button>

                                            <button
                                                onClick={() => setSearchMode("quiz")}
                                                title="Pull the current METAR for this station and quiz yourself before decoding it"
                                                className={`relative z-10 w-16 rounded-full px-2 py-1.5 uppercase transition-colors ${searchMode === "quiz" ? "text-black" : "text-zinc-400"
                                                    }`}
                                            >
                                                Quiz
                                            </button>
                                        </div>

                                        <button
                                            onClick={() => setActiveTab("raw")}
                                            className="text-xs font-semibold text-zinc-500 transition hover:text-[#e6c76f]"
                                        >
                                            Paste raw METAR →
                                        </button>
                                    </div>
                                </>
                            ) : (
                                <>
                                    <textarea
                                        value={rawInput}
                                        onChange={(event) => setRawInput(event.target.value)}
                                        className="min-h-24 w-full rounded-2xl border border-zinc-700 bg-black/60 px-4 py-3 font-mono text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-[#d6b35a]"
                                        placeholder="KFCM 011753Z AUTO 35012KT 10SM FEW050 SCT250 22/15 A2992 RMK AO2"
                                    />

                                    <div className="mt-3 flex items-center justify-between gap-3">
                                        <button
                                            onClick={() => setActiveTab("lookup")}
                                            className="text-xs font-semibold text-zinc-500 transition hover:text-[#e6c76f]"
                                        >
                                            ← Back to airport lookup
                                        </button>

                                        <button
                                            onClick={decodeRawMetar}
                                            disabled={loading}
                                            className="shrink-0 rounded-full bg-[#d6b35a] px-5 py-2 text-xs font-black uppercase tracking-[0.08em] text-black transition hover:bg-[#e6c76f] disabled:cursor-not-allowed disabled:opacity-50"
                                        >
                                            {loading ? "Decoding…" : "Decode"}
                                        </button>
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                </header>

                <div className="relative">
                    {error && (
                        <div className="mt-6 rounded-2xl border border-red-500/40 bg-red-950/30 p-4 text-red-200">
                            {error}
                        </div>
                    )}

                    {metar ? (
                        quizMode ? (
                            <QuizPanel
                                key={rawMetar ?? metar.raw}
                                metar={metar}
                                rawText={rawMetar ?? metar.raw}
                                timeZone={stationInfo?.timeZone}
                                onContinue={() => setQuizMode(false)}
                            />
                        ) : (
                            <MetarDashboard
                                metar={metar}
                                rawMetar={rawMetar ?? metar.raw}
                                station={station}
                                stationInfo={stationInfo}
                                airportDiagram={airportDiagram}
                                runways={runways}
                                isFullscreenOpen={isFullscreenOpen}
                                setIsFullscreenOpen={setIsFullscreenOpen}
                                isRadarFullscreen={isRadarFullscreen}
                                setIsRadarFullscreen={setIsRadarFullscreen}
                                lastMetarFetchAttempt={lastMetarFetchAttempt}
                                onRefetchMetar={() => fetchLiveMetar()}
                            />
                        )
                        ) : (
                        <EmptyState />
                    )}

                    <footer className="mt-10 border-t border-zinc-900 pt-5 text-center">
                        <p className="text-[11px] leading-5 text-zinc-500">
                            Created by Preston Vaughn for Inflight Aviation. METAR and TAF data provided by
                            AviationWeather.gov. Airport information provided by FAA.gov.
                        </p>
                    </footer>

                    {/* Covers everything below the header (still-mounted content from the
                        previous station included) until the new station's METAR/TAF/airport data
                        has fully loaded, matching the radar bubble's own loading gate — no tab,
                        button, or link under here is reachable until it lifts. Gated on
                        pageLoading rather than loading so the silent 2-minute background refresh
                        never triggers this. */}
                    {pageLoading && (
                        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-4 rounded-3xl bg-[#050505]/95 px-8 text-center backdrop-blur-sm">
                            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#d6b35a]">
                                Loading
                            </p>
                            <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-700 border-t-[#e6c76f]" />
                            <p className="text-sm font-medium text-zinc-300">
                                {station || "Fetching weather data…"}
                            </p>
                        </div>
                    )}
                </div>

            </div>

            <FeedbackWidget currentStation={station} hidden={isFullscreenOpen || isRadarFullscreen} />
        </main>
    );
}

function MetarDashboard({
    metar,
    rawMetar,
    station,
    stationInfo,
    airportDiagram,
    runways,
    isFullscreenOpen,
    setIsFullscreenOpen,
    isRadarFullscreen,
    setIsRadarFullscreen,
    lastMetarFetchAttempt,
    onRefetchMetar,
}: {
    metar: NormalizedMetar;
    rawMetar: string;
    station: string;
    stationInfo: StationInfo | null;
    airportDiagram: AirportDiagramInfo | null;
    runways: AirportRunway[];
    isFullscreenOpen: boolean;
    setIsFullscreenOpen: (value: boolean) => void;
    isRadarFullscreen: boolean;
    setIsRadarFullscreen: (value: boolean) => void;
    lastMetarFetchAttempt: Date | null;
    onRefetchMetar: () => void;
}) {
    const [now, setNow] = useState(() => new Date());
    const [activeDashboardTab, setActiveDashboardTab] =
        useState<DashboardTab>("weather");

    const fullscreenRef = useRef<HTMLDivElement | null>(null);

    const categoryStyle = FLIGHT_CATEGORY_STYLES[metar.flightCategory];

    const tafStation = metar.station ?? station;
    const [taf, setTaf] = useState<TafResponse | null>(null);
    const [tafLoading, setTafLoading] = useState(true);
    const [tafError, setTafError] = useState<string | null>(null);
    const [lastTafFetchAttempt, setLastTafFetchAttempt] = useState<Date | null>(null);
    const [tafRefreshNonce, setTafRefreshNonce] = useState(0);
    const latestTafRef = useRef<TafResponse | null>(null);

    useEffect(() => {
        const timer = window.setInterval(() => {
            setNow(new Date());
        }, 1_000);

        return () => window.clearInterval(timer);
    }, []);

    useEffect(() => {
        latestTafRef.current = taf;
    }, [taf]);

    useEffect(() => {
        let isActive = true;
        let controller: AbortController | null = null;

        async function loadTaf(showLoading = true) {
            controller?.abort();
            const requestController = new AbortController();
            controller = requestController;
            setLastTafFetchAttempt(new Date());

            try {
                if (showLoading || !latestTafRef.current) {
                    setTafLoading(true);
                }

                const response = await fetch(
                    `/api/taf?station=${encodeURIComponent(tafStation)}`,
                    {
                        cache: "no-store",
                        signal: requestController.signal,
                    }
                );

                if (!response.ok) {
                    throw new Error("Unable to load TAF data.");
                }

                const data = await response.json();

                if (!isActive || requestController.signal.aborted) return;

                setTaf(data);
                setTafError(null);
            } catch (err) {
                if (err instanceof DOMException && err.name === "AbortError") {
                    return;
                }

                if (!latestTafRef.current) {
                    setTafError(
                        err instanceof Error
                            ? err.message
                            : "Something went wrong loading the TAF."
                    );
                }
            } finally {
                if (isActive && !requestController.signal.aborted) {
                    setTafLoading(false);
                }
            }
        }

        const initialLoadTimer = window.setTimeout(() => {
            latestTafRef.current = null;
            setTaf(null);
            setTafError(null);
            void loadTaf(true);
        }, 0);

        const refreshTimer = window.setInterval(() => {
            void loadTaf(false);
        }, TAF_REFRESH_MS);

        return () => {
            isActive = false;
            window.clearTimeout(initialLoadTimer);
            window.clearInterval(refreshTimer);
            controller?.abort();
        };
    }, [tafStation, tafRefreshNonce]);

    function refetchTaf() {
        setTafRefreshNonce((current) => current + 1);
    }

    useEffect(() => {
        if (!isFullscreenOpen) return;

        const frame = window.requestAnimationFrame(() => {
            void fullscreenRef.current?.requestFullscreen?.().catch(() => {
                // Browser fullscreen can fail if blocked, but fixed overlay still works.
            });
        });

        function handleFullscreenChange() {
            if (!document.fullscreenElement) {
                setIsFullscreenOpen(false);
            }
        }

        document.addEventListener("fullscreenchange", handleFullscreenChange);

        return () => {
            window.cancelAnimationFrame(frame);
            document.removeEventListener("fullscreenchange", handleFullscreenChange);
        };
    }, [isFullscreenOpen]);

    async function closeFullscreenDashboard() {
        if (document.fullscreenElement) {
            await document.exitFullscreen().catch(() => { });
        }

        setIsFullscreenOpen(false);
    }

    const fullscreenStationInfoBlock = (
        <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[#d6b35a]">
                Fullscreen Weather
            </p>

            <div className="mt-1 min-w-0">
                <h2 className="truncate text-3xl font-black leading-tight text-white md:text-4xl">
                    {stationInfo?.displayName ??
                        metar.station ??
                        "Unknown Station"}
                </h2>

                {stationInfo && (
                    <p className="mt-1 truncate text-sm text-zinc-400">
                        {stationInfo.displayLocation}
                        {stationInfo.elevationFt !== null
                            ? ` | Elev. ${stationInfo.elevationFt.toLocaleString()} ft`
                            : ""}
                        {stationInfo.timeZone
                            ? ` | ${stationInfo.timeZone}`
                            : ""}
                    </p>
                )}
            </div>
        </div>
    );

    const fullscreenFlightCategoryBadge = (
        <div className={`rounded-2xl border px-7 py-3 text-center ${categoryStyle}`}>
            <p className="text-3xl font-black leading-none">
                {metar.flightCategory}
            </p>

            <p className="mt-2 text-sm font-semibold">
                {getFlightCategoryDescription(metar)}
            </p>
        </div>
    );

    const fullscreenClockExitBlock = (
        <div className="flex shrink-0 items-center gap-3">
            <LiveAirportClock now={now} timeZone={stationInfo?.timeZone} />

            <button
                type="button"
                onClick={closeFullscreenDashboard}
                className="rounded-full border border-zinc-700 bg-black/70 px-4 py-2 text-[11px] font-black uppercase tracking-[0.16em] text-zinc-200 transition hover:border-[#d6b35a]/50 hover:text-[#e6c76f]"
            >
                Exit
            </button>
        </div>
    );

    return (
        <>
            <section className="mt-8 overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-950/90 shadow-2xl">
                <div className="border-b border-zinc-800 bg-gradient-to-r from-black via-zinc-950 to-[#171307] p-6">
                    <div className="flex flex-col gap-4">
                        <div>
                            <div className="flex items-center justify-between gap-3">
                                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#d6b35a]">
                                    Decoded Airport Weather
                                </p>

                                <button
                                    type="button"
                                    onClick={() => setIsFullscreenOpen(true)}
                                    aria-label="Open fullscreen weather dashboard"
                                    title="Fullscreen"
                                    className="hidden h-9 w-9 items-center justify-center rounded-full border border-zinc-700 bg-black/70 text-zinc-300 transition hover:border-[#d6b35a]/50 hover:bg-[#d6b35a]/10 hover:text-[#e6c76f] min-[700px]:inline-flex"
                                >
                                    <svg
                                        viewBox="0 0 24 24"
                                        className="h-4 w-4"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2.2"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                    >
                                        <path d="M8 3H3v5" />
                                        <path d="M3 3l6.5 6.5" />
                                        <path d="M16 3h5v5" />
                                        <path d="M21 3l-6.5 6.5" />
                                        <path d="M8 21H3v-5" />
                                        <path d="M3 21l6.5-6.5" />
                                        <path d="M16 21h5v-5" />
                                        <path d="M21 21l-6.5-6.5" />
                                    </svg>
                                </button>
                            </div>

                            <div className="mt-3 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                                <div>
                                    <h2 className="text-3xl font-bold text-white md:text-4xl">
                                        {stationInfo?.displayName ??
                                            metar.station ??
                                            "Unknown Station"}
                                    </h2>

                                    {stationInfo && (
                                        <p className="mt-2 text-sm text-zinc-400">
                                            {stationInfo.displayLocation}
                                            {stationInfo.elevationFt !== null
                                                ? ` | Elev. ${stationInfo.elevationFt.toLocaleString()} ft`
                                                : ""}
                                            {stationInfo.timeZone
                                                ? ` | ${stationInfo.timeZone}`
                                                : ""}
                                        </p>
                                    )}
                                </div>

                                <div className="flex flex-wrap items-center gap-3">
                                    <LiveAirportClock
                                        now={now}
                                        timeZone={stationInfo?.timeZone}
                                    />
                                </div>
                            </div>
                        </div>

                        <div
                            className={`rounded-2xl border px-5 py-3 text-center ${categoryStyle}`}
                        >
                            <p className="flex items-center justify-center gap-1.5 text-xs font-semibold uppercase tracking-[0.2em]">
                                Flight Category
                                <InfoTooltip text="Combines ceiling and visibility into one rating: VFR (good), MVFR (marginal), IFR (low), or LIFR (very low)." />
                            </p>
                            <p className="mt-1 text-3xl font-black">
                                {metar.flightCategory}
                            </p>
                            <p className="mt-1 text-sm">
                                {getFlightCategoryDescription(metar)}
                            </p>
                        </div>

                        <div className="mt-2 flex rounded-2xl border border-zinc-800 bg-black p-1">
                            <DashboardTabButton
                                active={activeDashboardTab === "weather"}
                                onClick={() => setActiveDashboardTab("weather")}
                            >
                                METAR
                            </DashboardTabButton>

                            <DashboardTabButton
                                active={activeDashboardTab === "taf"}
                                onClick={() => setActiveDashboardTab("taf")}
                            >
                                TAF
                            </DashboardTabButton>

                            <DashboardTabButton
                                active={activeDashboardTab === "radar"}
                                onClick={() => setActiveDashboardTab("radar")}
                            >
                                Radar<span className="ml-1 text-[10px] font-semibold opacity-60">BETA</span>
                            </DashboardTabButton>

                            <DashboardTabButton
                                active={activeDashboardTab === "airport"}
                                onClick={() => setActiveDashboardTab("airport")}
                            >
                                Airport Info
                            </DashboardTabButton>
                        </div>
                    </div>
                </div>

                <div className="p-6">
                    {activeDashboardTab === "weather" && (
                        <WeatherDashboardTab
                            metar={metar}
                            rawMetar={rawMetar}
                            runways={runways}
                            now={now}
                            stationInfo={stationInfo}
                            taf={taf}
                            lastMetarFetchAttempt={lastMetarFetchAttempt}
                            onRefetchMetar={onRefetchMetar}
                        />
                    )}

                    {activeDashboardTab === "taf" && (
                        <TafDashboardTab
                            station={tafStation}
                            timeZone={stationInfo?.timeZone}
                            latitude={stationInfo?.latitude}
                            longitude={stationInfo?.longitude}
                            now={now}
                            taf={taf}
                            loading={tafLoading}
                            error={tafError}
                            lastTafFetchAttempt={lastTafFetchAttempt}
                            onRefetchTaf={refetchTaf}
                        />
                    )}

                    {activeDashboardTab === "radar" && (
                        <RadarDashboardTab
                            stationInfo={stationInfo}
                            runways={runways}
                            isRadarFullscreen={isRadarFullscreen}
                            setIsRadarFullscreen={setIsRadarFullscreen}
                        />
                    )}

                    {activeDashboardTab === "airport" && (
                        <AirportInfoDashboardTab
                            stationInfo={stationInfo}
                            airportDiagram={airportDiagram}
                            runways={runways}
                        />
                    )}
                </div>
            </section>

            {isFullscreenOpen && (
                <div
                    ref={fullscreenRef}
                    className="fixed inset-0 z-50 overflow-hidden bg-[#050505] text-zinc-100"
                >
                    <div className="absolute inset-0 overflow-hidden">
                        <div className="flex h-full min-h-0 w-full flex-col gap-3 px-3 py-3 sm:px-5 sm:py-4">
                            <div className="flex-none rounded-3xl border border-zinc-800 bg-gradient-to-r from-black via-zinc-950 to-[#171307] p-4 shadow-2xl">
                                <div
                                    style={{
                                        gridTemplateColumns: "minmax(0, 560px) minmax(0, 1fr) auto",
                                    }}
                                    className="hidden h-[120px] items-center gap-6 min-[1250px]:grid"
                                >
                                    {fullscreenStationInfoBlock}

                                    <div
                                        style={{ width: "calc(100% - 48px)" }}
                                        className="h-[78px] min-w-0 justify-self-start"
                                    >
                                        {fullscreenFlightCategoryBadge}
                                    </div>

                                    {fullscreenClockExitBlock}
                                </div>

                                <div className="flex flex-col gap-3 min-[1250px]:hidden">
                                    <div className="flex items-start justify-between gap-3">
                                        {fullscreenStationInfoBlock}
                                        {fullscreenClockExitBlock}
                                    </div>

                                    {fullscreenFlightCategoryBadge}
                                </div>
                            </div>

                            <div className="min-h-0 flex-1 overflow-hidden">
                                <RunwayWindWidget
                                    metar={metar}
                                    runways={runways}
                                    now={now}
                                    stationInfo={stationInfo}
                                    taf={taf}
                                    fullscreen
                                />
                            </div>

                            <div className="relative h-[clamp(260px,32dvh,380px)] flex-none overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-950/90 p-2 shadow-2xl sm:p-3">
                                <div className="flex h-full w-full flex-col justify-end">
                                    <TafDashboardTab
                                        station={tafStation}
                                        timeZone={stationInfo?.timeZone}
                                        latitude={stationInfo?.latitude}
                                        longitude={stationInfo?.longitude}
                                        hourlyOnly
                                        fullscreen
                                        now={now}
                                        taf={taf}
                                        loading={tafLoading}
                                        error={tafError}
                                    />
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}

function WeatherDashboardTab({
    metar,
    rawMetar,
    runways,
    now,
    stationInfo,
    taf,
    lastMetarFetchAttempt,
    onRefetchMetar,
}: {
    metar: NormalizedMetar;
    rawMetar: string;
    runways: AirportRunway[];
    now: Date;
    stationInfo: StationInfo | null;
    taf: TafResponse | null;
    lastMetarFetchAttempt: Date | null;
    onRefetchMetar: () => void;
}) {
    return (
        <>
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.2em] text-[#d6b35a]">
                    Visual Decoder
                    <InfoTooltip text="Click a runway number to view wind from that runway's perspective. Click and drag the compass ring to rotate it manually. RESET snaps back to north-up, and the ping icon orients to the inflight view. The gold outline marks the runway with the best headwind." />
                </p>

                {now && (
                    <div className="flex flex-col items-end">
                        <ObservationTimeBubble
                            metar={metar}
                            now={now}
                            stationInfo={stationInfo ?? null}
                        />
                        <LastFetchFinePrint
                            label="METAR"
                            lastAttempt={lastMetarFetchAttempt}
                            onResync={onRefetchMetar}
                        />
                    </div>
                )}
            </div>

            <RunwayWindWidget
                metar={metar}
                runways={runways}
                now={now}
                stationInfo={stationInfo}
                taf={taf}
            />

            <p className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.2em] text-[#d6b35a]">
                METAR
                <InfoTooltip text="A routine surface weather observation taken directly at the airport, issued hourly or whenever conditions change significantly." />
            </p>

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                <WeatherCard
                    label="Wind"
                    value={formatWind(metar)}
                    detail={formatWindDetail(metar)}
                    accent="gold"
                    info="Direction the wind is blowing from (degrees true) and its sustained speed in knots. Gusts are shown when reported."
                />

                <WeatherCard
                    label="Visibility"
                    value={formatVisibility(metar)}
                    detail={getVisibilityDescription(metar)}
                    accent="silver"
                    info="How far you can see horizontally, in statute miles. Lower numbers mean hazier or thicker weather."
                />

                <WeatherCard
                    label="Ceiling"
                    value={formatCeiling(metar)}
                    detail={getCeilingDescription(metar)}
                    accent="silver"
                    info="Height of the lowest broken or overcast cloud layer, in feet above the ground. Usually the main limiter for visual flying."
                />

                <WeatherCard
                    label="Clouds"
                    value={formatClouds(metar)}
                    detail={getCloudDescription(metar)}
                    accent="gold"
                    info="Sky cover by layer — few, scattered, broken, or overcast — listed from lowest to highest."
                />

                <WeatherCard
                    label="Temp / Dewpoint"
                    value={formatTemperature(metar)}
                    detail={getSpreadDescription(metar)}
                    accent="silver"
                    info="Air temperature and dew point in degrees Celsius. The smaller the gap between them, the higher the chance of fog or low clouds."
                />

                <WeatherCard
                    label="Altimeter"
                    value={formatAltimeter(metar)}
                    detail="Pressure setting"
                    accent="gold"
                    info="The local barometric pressure setting, in inches of mercury. Dial this into your altimeter so it reads true altitude."
                />
            </div>

            <RemarksSection remarks={metar.remarks} />

            <div className="mt-6 rounded-2xl border border-[#d6b35a]/20 bg-[#d6b35a]/10 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#e6c76f]">
                    Raw METAR
                </p>
                <p className="mt-3 break-words font-mono text-sm leading-6 text-zinc-200">
                    {rawMetar}
                </p>
            </div>
        </>
    );
}

function formatTafTime(value?: string | null) {
    if (!value) return "Not reported";

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) return value;

    return new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short",
    }).format(date);
}

function TafHourlyForecast({
    taf,
    timeZone,
    latitude,
    longitude,
    fullscreen = false,
}: {
    taf: TafResponse;
    timeZone?: string | null;
    latitude?: number | null;
    longitude?: number | null;
    fullscreen?: boolean;
}) {
    const slots = buildTafHourlySlots(
        taf,
        timeZone,
        latitude,
        longitude
    ).slice(0, 24);

    const tafFullscreenContentWidth =
        slots.length * TAF_FULLSCREEN_CARD_WIDTH +
        Math.max(0, slots.length - 1) * TAF_FULLSCREEN_CARD_GAP;

    const scrollRef = useRef<HTMLDivElement | null>(null);
    const rowRef = useRef<HTMLDivElement | null>(null);
    const [isDragging, setIsDragging] = useState(false);
    const [startX, setStartX] = useState(0);
    const [scrollLeft, setScrollLeft] = useState(0);

    const [tafScale, setTafScale] = useState(1);
    const [naturalRowHeight, setNaturalRowHeight] = useState(TAF_FULLSCREEN_BASE_HEIGHT);

    useEffect(() => {
        if (!fullscreen) {
            return;
        }

        const slider = scrollRef.current;
        const row = rowRef.current;
        if (!slider || !row) return;

        let latestRowHeight = row.offsetHeight || TAF_FULLSCREEN_BASE_HEIGHT;

        const updateScale = () => {
            const availableHeight = slider.clientHeight;
            const nextScale = Math.min(
                1,
                Math.max(
                    TAF_FULLSCREEN_MIN_SCALE,
                    availableHeight / latestRowHeight
                )
            );

            setTafScale(Number(nextScale.toFixed(3)));
        };

        const handleRowResize = () => {
            latestRowHeight = row.offsetHeight || latestRowHeight;
            setNaturalRowHeight(latestRowHeight);
            updateScale();
        };

        const frame = window.requestAnimationFrame(handleRowResize);
        const sliderObserver = new ResizeObserver(updateScale);
        const rowObserver = new ResizeObserver(handleRowResize);

        sliderObserver.observe(slider);
        rowObserver.observe(row);
        window.addEventListener("resize", updateScale);

        return () => {
            window.cancelAnimationFrame(frame);
            sliderObserver.disconnect();
            rowObserver.disconnect();
            window.removeEventListener("resize", updateScale);
        };
    }, [fullscreen]);

    if (slots.length === 0) {
        return null;
    }

    function handleMouseDown(event: React.MouseEvent<HTMLDivElement>) {
        const slider = scrollRef.current;
        if (!slider) return;

        setIsDragging(true);
        setStartX(event.pageX - slider.offsetLeft);
        setScrollLeft(slider.scrollLeft);
    }

    function handleMouseMove(event: React.MouseEvent<HTMLDivElement>) {
        if (!isDragging) return;

        const slider = scrollRef.current;
        if (!slider) return;

        event.preventDefault();

        const x = event.pageX - slider.offsetLeft;
        const walk = x - startX;

        slider.scrollLeft = scrollLeft - walk;
    }

    function stopDragging() {
        setIsDragging(false);
    }

    function handleWheel(event: React.WheelEvent<HTMLDivElement>) {
        const slider = scrollRef.current;
        if (!slider || event.ctrlKey) return;

        const absX = Math.abs(event.deltaX);
        const absY = Math.abs(event.deltaY);

        const HORIZONTAL_THRESHOLD = 12;
        const HORIZONTAL_DOMINANCE = 1.35;
        const SCROLL_SENSITIVITY = 0.65;

        const isIntentionalHorizontalScroll =
            absX > HORIZONTAL_THRESHOLD && absX > absY * HORIZONTAL_DOMINANCE;

        // If the user is mostly scrolling vertically, let the page scroll past the TAF.
        if (!isIntentionalHorizontalScroll) {
            return;
        }

        event.preventDefault();

        slider.scrollLeft += event.deltaX * SCROLL_SENSITIVITY;
    }

    function isCurrentTafHour(date: Date) {
        const now = new Date();
        const currentHour = roundDownToUtcHour(now);
        const nextHour = new Date(currentHour.getTime() + 60 * 60 * 1000);

        return date >= currentHour && date < nextHour;
    }

    return (
        <div
            ref={scrollRef}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={stopDragging}
            onMouseLeave={stopDragging}
            onWheel={handleWheel}
            style={{ touchAction: "pan-x" }}
            className={`scrollbar-hide mt-0 ${fullscreen ? "flex h-full min-h-0 items-end" : ""} overflow-x-auto overflow-y-hidden pb-0 select-none ${isDragging ? "cursor-grabbing" : "cursor-grab"}`}
        >
            <div
                style={
                    fullscreen
                        ? {
                            width: `${tafFullscreenContentWidth * tafScale}px`,
                            height: `${naturalRowHeight * tafScale}px`,
                            position: "relative",
                            flex: "0 0 auto",
                        }
                        : undefined
                }
                className={fullscreen ? "" : "flex min-w-max gap-3"}
            >
                <div
                    ref={rowRef}
                    style={
                        fullscreen
                            ? {
                                position: "absolute",
                                bottom: 0,
                                left: 0,
                                transform: `scale(${tafScale})`,
                                transformOrigin: "bottom left",
                            }
                            : undefined
                    }
                    className="flex min-w-max gap-3"
                >
                {slots.map((slot, index) => {
                    const { dayLabel, hourLabel } = formatTafHourLabel(
                        slot.startsAt,
                        timeZone
                    );

                    const displayHourLabel =
                        index === 0 && isCurrentTafHour(slot.startsAt)
                            ? "Now"
                            : hourLabel;

                    return (
                        <div
                            key={slot.startsAt.toISOString()}
                            className="flex w-[155px] shrink-0 flex-col"
                        >
                            <article
                                className={`flex h-full flex-col overflow-hidden rounded-2xl ${fullscreen ? "border-2" : "border"} border-zinc-800 bg-gradient-to-b from-black/70 to-zinc-950 p-4 pb-2 shadow-lg`}
                            >
                                <div className="flex flex-none items-start justify-between gap-2">
                                    <div>
                                        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
                                            {dayLabel}
                                        </p>
                                        <p className="mt-1 text-lg font-black text-white">
                                            {displayHourLabel}
                                        </p>
                                    </div>

                                    <span
                                        className={`rounded-full border px-2 py-1 text-[10px] font-black ${FLIGHT_CATEGORY_STYLES[slot.flightCategory]}`}
                                    >
                                        {slot.flightCategory}
                                    </span>
                                </div>

                                <div className="mt-0 flex h-32 items-center justify-center">
                                    <Image
                                        src={TAF_ICON_SRC[slot.iconKey]}
                                        alt={slot.weatherLabel}
                                        width={128}
                                        height={128}
                                        draggable={false}
                                        onDragStart={(event) => event.preventDefault()}
                                        className="pointer-events-none h-32 w-32 max-w-none select-none object-contain drop-shadow-2xl"
                                    />
                                </div>

                                <p className="min-h-[40px] text-center text-sm font-semibold leading-5 text-white">
                                    {slot.weatherLabel}
                                </p>

                                <div className="mt-3 min-h-[30px]">
                                    <p
                                        className={`flex items-center justify-center gap-1.5 rounded-full border border-dashed px-2 py-1 text-center text-[10px] font-bold uppercase tracking-[0.12em] ${
                                            slot.precipChance && slot.precipChance.percent > 0
                                                ? "border-sky-400/50 text-sky-300"
                                                : "border-zinc-500/60 text-zinc-400"
                                        }`}
                                    >
                                        <RaindropIcon />
                                        {slot.precipChance ? slot.precipChance.percent : 0}% chance
                                    </p>
                                </div>

                                <div className="mt-2 space-y-2 rounded-xl border border-zinc-800 bg-black/35 p-3 text-xs">
                                    <TafHourRow label="Vis" value={slot.visibility} />
                                    <TafHourRow label="Ceil" value={slot.ceiling} />
                                    <TafHourRow label="Wind" value={slot.wind} />
                                    <TafHourRow label="Gust" value={slot.gusts} />
                                </div>

                                {slot.changeNote && (
                                    <p className="mt-2 text-center text-[10px] uppercase tracking-[0.1em] text-zinc-600">
                                        {slot.changeNote}
                                    </p>
                                )}
                            </article>

                            <div
                                className={
                                    fullscreen
                                        ? "pointer-events-none mt-1 h-[40px] flex-none space-y-1 overflow-visible"
                                        : "pointer-events-none mt-1 h-[40px] flex-none space-y-1 overflow-hidden"
                                }
                            >
                                {slot.markers.map((marker) => {
                                    const isSunMarker =
                                        marker.type === "sunrise" || marker.type === "sunset";

                                    if (isSunMarker) {
                                        return (
                                            <div
                                                key={`${marker.type}-${marker.time.toISOString()}`}
                                                className="flex w-full items-center justify-center gap-2 text-xs font-black text-[#f2d675]"
                                            >
                                                <Image
                                                    src={
                                                        marker.type === "sunrise"
                                                            ? TAF_MARKER_ICON_SRC.sunrise
                                                            : TAF_MARKER_ICON_SRC.sunset
                                                    }
                                                    alt={marker.label}
                                                    width={40}
                                                    height={40}
                                                    draggable={false}
                                                    onDragStart={(event) => event.preventDefault()}
                                                    className="pointer-events-none h-10 w-10 select-none object-contain drop-shadow-lg"
                                                />

                                                <span className="-ml-1">
                                                    {formatTafMarkerTime(marker.time, timeZone)}
                                                </span>
                                            </div>
                                        );
                                    }

                                    return (
                                        <div
                                            key={`${marker.type}-${marker.time.toISOString()}`}
                                            className="flex w-full items-center justify-between rounded-full border border-[#d6b35a]/40 bg-[#d6b35a]/10 px-4 py-1 text-[10px] font-bold uppercase tracking-[0.1em] text-[#e6c76f]"
                                        >
                                            <span>{marker.label}</span>
                                            <span>{formatTafMarkerTime(marker.time, timeZone)}</span>
                                        </div>
                                    );
                                })}

                                {slot.isNightCurrency && !hasNightCurrencyEdgeMarker(slot.markers) && (
                                    <div className="w-full rounded-full border border-[#d6b35a]/30 bg-[#d6b35a]/10 px-2 py-1 text-center text-[10px] font-black uppercase tracking-[0.12em] text-[#e6c76f]">
                                        Night Currency
                                    </div>
                                )}
                            </div>
                        </div>
                    );
                })}
                </div>
            </div>
        </div>
    );
}

function hasNightCurrencyEdgeMarker(markers: TafTimelineMarker[]) {
    return markers.some(
        (marker) =>
            marker.type === "currencyStart" ||
            marker.type === "currencyEnd"
    );
}

function TafHourRow({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex items-center justify-between gap-3">
            <span className="text-zinc-500">{label}</span>
            <span className="text-right font-semibold text-zinc-200">{value}</span>
        </div>
    );
}

function buildSunCurrencyData(
    slots: TafHourSlot[],
    latitude: number,
    longitude: number
): {
    markers: TafTimelineMarker[];
    windows: NightCurrencyWindow[];
} {
    if (slots.length === 0) {
        return {
            markers: [],
            windows: [],
        };
    }

    const timelineStart = slots[0].startsAt;
    const timelineEnd = new Date(
        slots[slots.length - 1].startsAt.getTime() + 60 * 60 * 1000
    );

    const markers: TafTimelineMarker[] = [];
    const windows: NightCurrencyWindow[] = [];

    const firstDay = new Date(
        Date.UTC(
            timelineStart.getUTCFullYear(),
            timelineStart.getUTCMonth(),
            timelineStart.getUTCDate() - 1,
            12
        )
    );

    for (let dayOffset = 0; dayOffset < 5; dayOffset += 1) {
        const day = new Date(firstDay.getTime() + dayOffset * 24 * 60 * 60 * 1000);
        const nextDay = new Date(day.getTime() + 24 * 60 * 60 * 1000);

        const todayTimes = SunCalc.getTimes(day, latitude, longitude);
        const tomorrowTimes = SunCalc.getTimes(nextDay, latitude, longitude);

        const sunrise = todayTimes.sunrise;
        const sunset = todayTimes.sunset;
        const tomorrowSunrise = tomorrowTimes.sunrise;

        if (isValidDate(sunrise)) {
            markers.push({
                type: "sunrise",
                label: "Sun Up",
                time: sunrise,
            });
        }

        if (isValidDate(sunset)) {
            markers.push({
                type: "sunset",
                label: "Sun Down",
                time: sunset,
            });
        }

        if (isValidDate(sunset) && isValidDate(tomorrowSunrise)) {
            const currencyStart = new Date(sunset.getTime() + 60 * 60 * 1000);
            const currencyEnd = new Date(
                tomorrowSunrise.getTime() - 60 * 60 * 1000
            );

            windows.push({
                start: currencyStart,
                end: currencyEnd,
            });

            markers.push({
                type: "currencyStart",
                label: "Begin Night",
                time: currencyStart,
            });

            markers.push({
                type: "currencyEnd",
                label: "End Night",
                time: currencyEnd,
            });
        }
    }

    const uniqueMarkers = markers
        .filter((marker) => marker.time >= timelineStart && marker.time < timelineEnd)
        .filter(
            (marker, index, array) =>
                array.findIndex(
                    (other) =>
                        other.type === marker.type &&
                        other.time.getTime() === marker.time.getTime()
                ) === index
        )
        .sort((a, b) => a.time.getTime() - b.time.getTime());

    const visibleWindows = windows.filter(
        (window) => window.start < timelineEnd && window.end > timelineStart
    );

    return {
        markers: uniqueMarkers,
        windows: visibleWindows,
    };
}

function isValidDate(value: Date | null | undefined): value is Date {
    return value instanceof Date && !Number.isNaN(value.getTime());
}

function formatTafMarkerTime(date: Date, timeZone?: string | null) {
    try {
        return new Intl.DateTimeFormat("en-US", {
            timeZone: timeZone ?? undefined,
            hour: "numeric",
            minute: "2-digit",
            hour12: false,
        }).format(date);
    } catch {
        return new Intl.DateTimeFormat("en-US", {
            hour: "numeric",
            minute: "2-digit",
            hour12: false,
        }).format(date);
    }
}

function buildTafHourlySlots(
    taf: TafResponse,
    timeZone?: string | null,
    latitude?: number | null,
    longitude?: number | null
): TafHourSlot[] {

    const forecastBlocks = taf.forecast ?? [];

    if (forecastBlocks.length === 0) {
        return [];
    }

    const startDate = parseTafDate(
        taf.validFrom ?? forecastBlocks[0]?.from ?? null
    );

    const endDate = parseTafDate(
        taf.validTo ?? forecastBlocks[forecastBlocks.length - 1]?.to ?? null
    );

    if (!startDate || !endDate) {
        return [];
    }

    const now = new Date();

    if (now >= endDate) {
        return [];
    }

    const currentHour = roundDownToUtcHour(now);
    const tafStartHour = roundDownToUtcHour(startDate);

    const firstHour = currentHour > tafStartHour ? currentHour : tafStartHour;

    const slots: TafHourSlot[] = [];

    let cursor = new Date(firstHour);
    let guard = 0;

    while (cursor < endDate && guard < 36) {
        const activeBlock =
            getActiveTafBlock(forecastBlocks, cursor) ?? forecastBlocks[0];

        const isDay = isTafDayIconForHour(cursor, timeZone, latitude, longitude);
        const iconInfo = getTafIconInfo(activeBlock, isDay);
        const changeInfo = getTafChangeInfo(activeBlock);

        slots.push({
            startsAt: new Date(cursor),
            block: activeBlock,
            iconKey: iconInfo.iconKey,
            weatherLabel: iconInfo.label,
            flightCategory: getTafFlightCategory(activeBlock),
            visibility: formatTafVisibility(activeBlock.visibilitySm),
            ceiling: formatTafCeiling(activeBlock.sky),
            wind: formatTafWindShort(activeBlock),
            gusts: activeBlock.windGustKt ? `${activeBlock.windGustKt} kt` : "—",
            change: activeBlock.change ?? "BASE",
            precipChance: changeInfo.precipChance,
            changeNote: changeInfo.changeNote,
            markers: [],
            isNightCurrency: false,
        });

        cursor = new Date(cursor.getTime() + 60 * 60 * 1000);
        guard += 1;
    }

    const sunData =
        typeof latitude === "number" && typeof longitude === "number"
            ? buildSunCurrencyData(slots, latitude, longitude)
            : null;

    if (!sunData) {
        return slots;
    }

    return slots.map((slot) => {
        const slotEnd = new Date(slot.startsAt.getTime() + 60 * 60 * 1000);

        return {
            ...slot,
            markers: sunData.markers.filter(
                (marker) => marker.time >= slot.startsAt && marker.time < slotEnd
            ),
            isNightCurrency: sunData.windows.some(
                (window) => slot.startsAt < window.end && slotEnd > window.start
            ),
        };
    });
}

function getActiveTafBlock(
    blocks: TafForecastBlock[],
    hour: Date
): TafForecastBlock | null {
    const matchingBlocks = blocks.filter((block) => {
        const from = parseTafDate(block.from ?? null);
        const to = parseTafDate(block.to ?? null);

        if (!from || !to) return false;

        return from <= hour && hour < to;
    });

    if (matchingBlocks.length === 0) {
        return null;
    }

    return matchingBlocks.sort(
        (a, b) => getTafChangePriority(b.change) - getTafChangePriority(a.change)
    )[0];
}

function getTafChangeInfo(block: TafForecastBlock): {
    precipChance: { percent: number; label: string } | null;
    changeNote: string | null;
} {
    const code = (block.change ?? "BASE").toUpperCase();

    if (code.includes("PROB")) {
        const percentMatch = code.match(/PROB(\d+)/);
        const percent = block.probability ?? (percentMatch ? Number(percentMatch[1]) : null);
        const precipLabel = getPrecipChanceLabel(block.weather);

        if (percent && precipLabel) {
            return { precipChance: { percent, label: precipLabel }, changeNote: null };
        }
    }

    if (code.includes("TEMPO")) {
        return { precipChance: null, changeNote: "TEMPO" };
    }

    if (code.includes("BECMG")) {
        return { precipChance: null, changeNote: "BECMG" };
    }

    if (code.startsWith("FM")) {
        return { precipChance: null, changeNote: "FM" };
    }

    return { precipChance: null, changeNote: null };
}

function getPrecipChanceLabel(weather?: string | null): string | null {
    const w = (weather ?? "").toUpperCase();

    if (!w) return null;

    if (w.includes("TS")) return w.includes("RA") ? "Thunderstorms / rain" : "Thunderstorms";
    if (w.includes("FZRA") || w.includes("FZDZ")) return "Freezing rain";
    if (w.includes("PL") || w.includes("IC")) return "Freezing precip";
    if (w.includes("SN") || w.includes("SG") || w.includes("BLSN")) return "Snow";
    if (w.includes("SHRA") || w.includes("VCSH")) return "Rain showers";
    if (w.includes("RA") || w.includes("DZ")) return "Rain";
    if (w.includes("GR") || w.includes("GS")) return "Hail";

    return null;
}

function getTafChangePriority(change?: string | null) {
    const code = (change ?? "BASE").toUpperCase();

    if (code.includes("TEMPO")) return 5;
    if (code.includes("PROB")) return 4;
    if (code.includes("BECMG")) return 3;
    if (code.includes("FM")) return 2;

    return 1;
}

function getTafIconInfo(
    block: TafForecastBlock,
    isDay: boolean
): {
    iconKey: TafIconKey;
    label: string;
} {
    const weather = (block.weather ?? "").toUpperCase();
    const skyCovers = (block.sky ?? [])
        .map((layer) => layer.cover?.toUpperCase())
        .filter(Boolean);

    if (weather.includes("TS") || weather.includes("VCTS")) {
        return {
            iconKey: "thunderstorm",
            label: weather.includes("RA") ? "Thunderstorms / rain" : "Thunderstorms",
        };
    }

    if (
        weather.includes("FZRA") ||
        weather.includes("FZDZ") ||
        weather.includes("PL") ||
        weather.includes("IC")
    ) {
        return {
            iconKey: "freezing",
            label: "Freezing precip",
        };
    }

    if (
        weather.includes("SN") ||
        weather.includes("SG") ||
        weather.includes("BLSN") ||
        weather.includes("SHSN")
    ) {
        return {
            iconKey: "snow",
            label: "Snow",
        };
    }

    if (
        weather.includes("RA") ||
        weather.includes("DZ") ||
        weather.includes("SHRA") ||
        weather.includes("VCSH")
    ) {
        return {
            iconKey: "rain",
            label: weather.includes("SH") ? "Rain showers" : "Rain",
        };
    }

    if (
        weather.includes("FG") ||
        weather.includes("BR") ||
        weather.includes("HZ") ||
        weather.includes("FU") ||
        weather.includes("DU") ||
        weather.includes("SA")
    ) {
        return {
            iconKey: "fog",
            label: weather.includes("BR") ? "Mist" : "Fog / haze",
        };
    }

    if (skyCovers.includes("OVC")) {
        return {
            iconKey: isDay ? "ovcDay" : "ovcNight",
            label: "Overcast",
        };
    }

    if (skyCovers.includes("BKN")) {
        return {
            iconKey: isDay ? "bknDay" : "bknNight",
            label: "Broken clouds",
        };
    }

    if (skyCovers.includes("SCT")) {
        return {
            iconKey: isDay ? "sctDay" : "sctNight",
            label: "Scattered clouds",
        };
    }

    if (skyCovers.includes("FEW")) {
        return {
            iconKey: isDay ? "fewDay" : "fewNight",
            label: "Few clouds",
        };
    }

    return {
        iconKey: isDay ? "clearDay" : "clearNight",
        label: "Clear",
    };
}

function getTafFlightCategory(block: TafForecastBlock): FlightCategory {
    const visibilitySm = parseTafVisibilitySm(block.visibilitySm);
    const ceilingFt = getTafCeilingFt(block.sky);

    if (
        (visibilitySm !== null && visibilitySm < 1) ||
        (ceilingFt !== null && ceilingFt < 500)
    ) {
        return "LIFR";
    }

    if (
        (visibilitySm !== null && visibilitySm < 3) ||
        (ceilingFt !== null && ceilingFt < 1000)
    ) {
        return "IFR";
    }

    if (
        (visibilitySm !== null && visibilitySm <= 5) ||
        (ceilingFt !== null && ceilingFt <= 3000)
    ) {
        return "MVFR";
    }

    return "VFR";
}

function getTafCeilingFt(sky?: TafSkyCondition[]) {
    const ceilingLayers = (sky ?? [])
        .filter((layer) => {
            const cover = layer.cover?.toUpperCase();

            return cover === "BKN" || cover === "OVC" || cover === "VV";
        })
        .map((layer) => layer.baseFtAgl)
        .filter((base): base is number => typeof base === "number");

    if (ceilingLayers.length === 0) {
        return null;
    }

    return Math.min(...ceilingLayers);
}

function formatTafCeiling(sky?: TafSkyCondition[]) {
    const ceiling = getTafCeilingFt(sky);

    if (ceiling === null) return "—";

    return `${ceiling.toLocaleString()} ft`;
}

function parseTafVisibilitySm(value?: string | number | null) {
    if (value === null || value === undefined || value === "") {
        return null;
    }

    if (typeof value === "number") {
        return value;
    }

    const clean = value
        .toUpperCase()
        .replace("SM", "")
        .replace("P", "")
        .replace("+", "")
        .trim();

    const mixedFraction = clean.match(/^(\d+)\s+(\d+)\/(\d+)$/);

    if (mixedFraction) {
        const whole = Number(mixedFraction[1]);
        const numerator = Number(mixedFraction[2]);
        const denominator = Number(mixedFraction[3]);

        return whole + numerator / denominator;
    }

    const fraction = clean.match(/^(\d+)\/(\d+)$/);

    if (fraction) {
        const numerator = Number(fraction[1]);
        const denominator = Number(fraction[2]);

        return numerator / denominator;
    }

    const numberValue = Number(clean);

    return Number.isFinite(numberValue) ? numberValue : null;
}

function formatTafVisibility(value?: string | number | null) {
    const visibility = parseTafVisibilitySm(value);

    if (visibility === null) return "—";

    if (visibility >= 6) return "6+ SM";

    return `${visibility} SM`;
}

function formatTafWindShort(block: TafForecastBlock) {
    if (!block.windSpeedKt) {
        return "—";
    }

    const direction =
        block.windDirection === "VRB"
            ? "VRB"
            : block.windDirection !== null && block.windDirection !== undefined
                ? `${String(block.windDirection).padStart(3, "0")}°`
                : "VRB";

    return `${direction} ${block.windSpeedKt} kt`;
}

function parseTafDate(value: string | null) {
    if (!value) return null;

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) return null;

    return date;
}

function roundDownToUtcHour(date: Date) {
    const rounded = new Date(date);

    rounded.setUTCMinutes(0, 0, 0);

    return rounded;
}

function isTafDayIconForHour(
    hourStart: Date,
    timeZone?: string | null,
    latitude?: number | null,
    longitude?: number | null
) {
    const hourEnd = new Date(hourStart.getTime() + 60 * 60 * 1000);

    if (typeof latitude === "number" && typeof longitude === "number") {
        const times = getSunTimesForLocalDay(
            hourStart,
            timeZone,
            latitude,
            longitude
        );

        if (isValidDate(times.sunrise) && isValidDate(times.sunset)) {
            const sunrise = times.sunrise;
            const sunset = times.sunset;

            // Hour containing sunrise uses day icon.
            if (hourStart <= sunrise && sunrise < hourEnd) {
                return true;
            }

            // Hour containing sunset uses night icon.
            if (hourStart <= sunset && sunset < hourEnd) {
                return false;
            }

            // Otherwise, normal daylight window.
            return hourStart >= sunrise && hourStart < sunset;
        }
    }

    const hour = getHourInTimeZone(hourStart, timeZone);
    return hour >= 6 && hour < 19;
}

function getSunTimesForLocalDay(
    date: Date,
    timeZone: string | null | undefined,
    latitude: number,
    longitude: number
) {
    const localParts = getLocalDateParts(date, timeZone);

    // Use noon UTC for the airport's local calendar date.
    // This prevents evening local times from rolling into the next UTC day.
    const localDayAnchor = new Date(
        Date.UTC(
            localParts.year,
            localParts.month - 1,
            localParts.day,
            12,
            0,
            0
        )
    );

    return SunCalc.getTimes(localDayAnchor, latitude, longitude);
}

function getLocalDateParts(date: Date, timeZone?: string | null) {
    try {
        const parts = new Intl.DateTimeFormat("en-US", {
            timeZone: timeZone ?? undefined,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
        }).formatToParts(date);

        const year = Number(parts.find((part) => part.type === "year")?.value);
        const month = Number(parts.find((part) => part.type === "month")?.value);
        const day = Number(parts.find((part) => part.type === "day")?.value);

        return { year, month, day };
    } catch {
        return {
            year: date.getFullYear(),
            month: date.getMonth() + 1,
            day: date.getDate(),
        };
    }
}

function getHourInTimeZone(date: Date, timeZone?: string | null) {
    try {
        const parts = new Intl.DateTimeFormat("en-US", {
            timeZone: timeZone ?? undefined,
            hour: "2-digit",
            hourCycle: "h23",
        }).formatToParts(date);

        const hourPart = parts.find((part) => part.type === "hour");

        return Number(hourPart?.value ?? date.getHours());
    } catch {
        return date.getHours();
    }
}

function formatTafHourLabel(date: Date, timeZone?: string | null) {
    try {
        return {
            dayLabel: new Intl.DateTimeFormat("en-US", {
                timeZone: timeZone ?? undefined,
                weekday: "short",
            }).format(date),
            hourLabel: new Intl.DateTimeFormat("en-US", {
                timeZone: timeZone ?? undefined,
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
            }).format(date),
        };
    } catch {
        return {
            dayLabel: new Intl.DateTimeFormat("en-US", {
                weekday: "short",
            }).format(date),
            hourLabel: new Intl.DateTimeFormat("en-US", {
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
            }).format(date),
        };
    }
}

function TafDashboardTab({
    station = "KFCM",
    timeZone,
    latitude,
    longitude,
    hourlyOnly = false,
    fullscreen = false,
    now,
    taf,
    loading,
    error,
    lastTafFetchAttempt = null,
    onRefetchTaf,
}: {
    station?: string;
    timeZone?: string | null;
    latitude?: number | null;
    longitude?: number | null;
    hourlyOnly?: boolean;
    fullscreen?: boolean;
    now: Date;
    taf: TafResponse | null;
    loading: boolean;
    error: string | null;
    lastTafFetchAttempt?: Date | null;
    onRefetchTaf?: () => void;
}) {
    if (loading) {
        return (
            <div className="rounded-2xl border border-zinc-800 bg-black/55 p-8 text-center">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#d6b35a]">
                    TAF
                </p>
                <h3 className="mt-2 text-2xl font-bold text-white">
                    Loading Forecast
                </h3>
                <p className="mx-auto mt-3 max-w-2xl text-sm leading-6 text-zinc-400">
                    Finding the closest available TAF station for {station}.
                </p>
            </div>
        );
    }

    if (error || !taf) {
        return (
            <div className="rounded-2xl border border-red-900/60 bg-red-950/20 p-8 text-center">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-red-300">
                    TAF
                </p>
                <h3 className="mt-2 text-2xl font-bold text-white">
                    TAF Unavailable
                </h3>
                <p className="mx-auto mt-3 max-w-2xl text-sm leading-6 text-red-200">
                    {error ?? "No TAF data was returned."}
                </p>
            </div>
        );
    }

    if (hourlyOnly) {
        if (fullscreen) {
            return (
                <>
                    <div className="pointer-events-none absolute right-2 top-2 z-10">
                        <TafIssuedBubble
                            issueTime={taf.issueTime}
                            timeZone={timeZone}
                            now={now}
                            solid
                        />
                    </div>

                    <TafHourlyForecast
                        taf={taf}
                        timeZone={timeZone}
                        latitude={latitude}
                        longitude={longitude}
                        fullscreen={fullscreen}
                    />
                </>
            );
        }

        return (
            <TafHourlyForecast
                taf={taf}
                timeZone={timeZone}
                latitude={latitude}
                longitude={longitude}
                fullscreen={fullscreen}
            />
        );
    }

    return (
        <>
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                    <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.2em] text-[#d6b35a]">
                        TAF
                        <InfoTooltip text="Terminal Aerodrome Forecast — a scheduled forecast of expected airport weather over the next 24-30 hours, updated a few times a day." />
                    </p>

                    <h3 className="mt-2 text-2xl font-bold text-white">
                        {taf.tafStation} Forecast
                    </h3>

                    <p className="mt-1 text-sm text-zinc-400">
                        Requested airport: {taf.requestedStation}
                        {taf.requestedAirport
                            ? ` — ${taf.requestedAirport}`
                            : ""}
                    </p>
                </div>

                <div className="flex flex-col items-end">
                    <TafIssuedBubble issueTime={taf.issueTime} timeZone={timeZone} now={now} />
                    {onRefetchTaf && (
                        <LastFetchFinePrint
                            label="TAF"
                            lastAttempt={lastTafFetchAttempt}
                            onResync={onRefetchTaf}
                        />
                    )}
                </div>
            </div>

            <div className="space-y-4 rounded-2xl border border-zinc-800 bg-black/55 p-6">
                <TafHourlyForecast
                    taf={taf}
                    timeZone={timeZone}
                    latitude={latitude}
                    longitude={longitude}
                />

                <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-4">
                    <div className="mb-2 flex items-center justify-between gap-3">
                        <h4 className="text-sm font-semibold uppercase tracking-[0.16em] text-zinc-300">
                            Raw TAF
                        </h4>

                        <p className="text-xs text-zinc-500">
                            Issued {formatTafTime(taf.issueTime)}
                        </p>
                    </div>

                    <pre className="whitespace-pre-wrap break-words font-mono text-sm leading-6 text-zinc-100">
                        {taf.rawText}
                    </pre>
                </div>

                <p className="text-xs leading-5 text-zinc-500">
                    TAFs are terminal forecasts for the reporting airport. When the
                    requested airport does not publish a TAF, this dashboard shows
                    the closest available TAF station.
                </p>
            </div>
        </>
    );
}

function RadarDashboardTab({
    stationInfo,
    runways,
    isRadarFullscreen,
    setIsRadarFullscreen,
}: {
    stationInfo: StationInfo | null;
    runways: AirportRunway[];
    isRadarFullscreen: boolean;
    setIsRadarFullscreen: (value: boolean) => void;
}) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const viewRef = useRef<MapView>({ lat: 0, lon: 0, zoom: 4 });
    const zoomRangeRef = useRef<{ min: number; max: number }>({ min: 2, max: RADAR_BASEMAP_MAX_ZOOM });
    const maxBoundsRef = useRef<GeoBounds | null>(null);
    const stationMarkerPositionRef = useRef<{ lat: number; lon: number } | null>(null);
    const airportSearchContainerRef = useRef<HTMLDivElement | null>(null);
    const tileCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
    const boundaryTileCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
    const radarTileCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
    const radarFramesRef = useRef<{ date: string; time: string }[]>([]);
    const satelliteTileCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
    const satelliteCycleRef = useRef<{ date: string; time: string } | null>(null);
    const gfaImagesRef = useRef<Partial<Record<GfaOverlayId, HTMLImageElement>>>({});
    const airspacePolygonsRef = useRef<AirspacePolygon[]>([]);
    const tfrPolygonsRef = useRef<TfrPolygon[]>([]);
    const gairmetZonesRef = useRef<GairmetZone[]>([]);
    const sigmetZonesRef = useRef<GairmetZone[]>([]);
    const pirepsRef = useRef<PirepReport[]>([]);
    const airportsRef = useRef<AirportPoint[]>([]);
    const localDetailCoverageBoundsRef = useRef<GeoBounds | null>(null);
    const localDetailDebounceRef = useRef<number | null>(null);
    const localDetailAbortRef = useRef<AbortController | null>(null);
    const lastLocalDetailCheckRef = useRef(0);
    const nationwideAbortRef = useRef<AbortController | null>(null);
    const drawFrameRef = useRef<() => void>(() => {});
    const rafScheduledRef = useRef(false);
    const activePointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
    const lastPointerPosRef = useRef<{ x: number; y: number } | null>(null);
    const pinchLastRef = useRef<{ distance: number; mid: { x: number; y: number } } | null>(null);
    const wheelZoomTargetRef = useRef<number | null>(null);
    const wheelZoomAnchorRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
    const wheelZoomAnimRef = useRef<number | null>(null);
    const pointerDownScreenPosRef = useRef<{ x: number; y: number } | null>(null);
    const hoveredAirportIdentRef = useRef<string | null>(null);
    const selectedAirportIdentRef = useRef<string | null>(null);
    const zoneInfoPinnedRef = useRef(false);

    const [radarFrameTimes, setRadarFrameTimes] = useState<Date[]>([]);
    const [currentFrameIndex, setCurrentFrameIndex] = useState(0);
    const [radarFrameGeneration, setRadarFrameGeneration] = useState(0);
    const [radarError, setRadarError] = useState<string | null>(null);
    const [radarVisible, setRadarVisible] = useState(true);
    const [satelliteVisible, setSatelliteVisible] = useState(false);
    // Mutually exclusive with radar/satellite (and with each other) — only one raster image
    // overlay is ever drawn at a time, same rule that already governs radar vs. satellite.
    const [activeGfaOverlay, setActiveGfaOverlay] = useState<GfaOverlayId | null>(null);
    const [airspaceVisible, setAirspaceVisible] = useState(true);
    const [tfrVisible, setTfrVisible] = useState(true);
    const [gairmetVisible, setGairmetVisible] = useState(true);
    const [sigmetVisible, setSigmetVisible] = useState(true);
    const [pirepVisible, setPirepVisible] = useState(true);
    const [boundaryVisible, setBoundaryVisible] = useState(false);
    const [selectedAirport, setSelectedAirport] = useState<AirportPoint | null>(null);
    const [zoneInfo, setZoneInfo] = useState<{
        x: number;
        y: number;
        pinned: boolean;
        tfrs: TfrPolygon[];
        gairmets: GairmetZone[];
        pireps: PirepReport[];
    } | null>(null);
    const [stationMarkerPosition, setStationMarkerPosition] = useState<{ lat: number; lon: number } | null>(
        null
    );
    const [airportSearchOpen, setAirportSearchOpen] = useState(false);
    const [airportSearchQuery, setAirportSearchQuery] = useState("");
    const [airportSearchError, setAirportSearchError] = useState<string | null>(null);
    const [displayZoomPercent, setDisplayZoomPercent] = useState<number | null>(null);
    const [displayScale, setDisplayScale] = useState<{ nm: number; px: number } | null>(null);
    const [mobileControlsOpen, setMobileControlsOpen] = useState(false);
    const [mobileLegendOpen, setMobileLegendOpen] = useState(false);
    // Gates the radar bubble behind a loading screen until every first-load fetch (radar imagery,
    // satellite, hazards/local data, and every nationwide zone) has finished — see the loading
    // block inside the main data-loading effect. Only the very first load for a station is gated
    // this way; the periodic background refreshes that follow update silently.
    const [radarLoadProgress, setRadarLoadProgress] = useState<{
        ready: boolean;
        completed: number;
        total: number;
        label: string;
    }>({ ready: false, completed: 0, total: 1, label: "Loading radar…" });
    const radarBubbleRef = useRef<HTMLDivElement | null>(null);

    const latitude = stationInfo?.latitude ?? null;
    const longitude = stationInfo?.longitude ?? null;

    // Precipitation, satellite, and the four GFA forecast overlays are all views of the same
    // "live weather" slot — toggling one on swaps every other one off, rather than layering
    // multiple translucent rasters at once.
    function togglePrecipitation() {
        setRadarVisible((current) => {
            const next = !current;
            if (next) {
                setSatelliteVisible(false);
                setActiveGfaOverlay(null);
            }
            return next;
        });
    }

    function toggleGfaOverlay(id: GfaOverlayId) {
        setActiveGfaOverlay((current) => {
            const next = current === id ? null : id;
            if (next) {
                setRadarVisible(false);
                setSatelliteVisible(false);
            }
            return next;
        });
    }

    function toggleSatellite() {
        setSatelliteVisible((current) => {
            const next = !current;
            if (next) {
                setRadarVisible(false);
                setActiveGfaOverlay(null);
            }
            return next;
        });
    }

    const scheduleDraw = useCallback(() => {
        if (rafScheduledRef.current) return;
        rafScheduledRef.current = true;
        requestAnimationFrame(() => {
            rafScheduledRef.current = false;
            drawFrameRef.current();
        });
    }, []);

    const applyZoomAtScreenPoint = useCallback(
        (screenX: number, screenY: number, targetZoom: number) => {
            const canvas = canvasRef.current;
            if (!canvas) return;
            const view = viewRef.current;
            const cssWidth = canvas.clientWidth;
            const cssHeight = canvas.clientHeight;

            const { min, max } = zoomRangeRef.current;
            const effectiveMax = computeEffectiveMaxZoom(max, view.lat, cssWidth);
            const clampedZoom = Math.max(min, Math.min(effectiveMax, targetZoom));

            const oldTileZoom = Math.round(view.zoom);
            const oldScaleFactor = Math.pow(2, view.zoom - oldTileZoom);
            const oldCenterWorldPx = projectToWorldPixel(view.lat, view.lon, oldTileZoom);
            const pointWorldPxOld = {
                x: oldCenterWorldPx.x + (screenX - cssWidth / 2) / oldScaleFactor,
                y: oldCenterWorldPx.y + (screenY - cssHeight / 2) / oldScaleFactor,
            };
            const pointLatLon = unprojectFromWorldPixel(pointWorldPxOld.x, pointWorldPxOld.y, oldTileZoom);

            const newTileZoom = Math.round(clampedZoom);
            const newScaleFactor = Math.pow(2, clampedZoom - newTileZoom);
            const pointWorldPxNew = projectToWorldPixel(pointLatLon.lat, pointLatLon.lon, newTileZoom);
            const newCenterWorldPx = {
                x: pointWorldPxNew.x - (screenX - cssWidth / 2) / newScaleFactor,
                y: pointWorldPxNew.y - (screenY - cssHeight / 2) / newScaleFactor,
            };
            const newCenterLatLon = unprojectFromWorldPixel(
                newCenterWorldPx.x,
                newCenterWorldPx.y,
                newTileZoom
            );

            const candidate = { lat: newCenterLatLon.lat, lon: newCenterLatLon.lon, zoom: clampedZoom };
            const maxBounds = maxBoundsRef.current;
            viewRef.current = maxBounds
                ? clampViewToMaxBounds(candidate, maxBounds, cssWidth, cssHeight)
                : candidate;
        },
        []
    );

    const panByScreenDelta = useCallback((dx: number, dy: number) => {
        const view = viewRef.current;
        const tileZoom = Math.round(view.zoom);
        const scaleFactor = Math.pow(2, view.zoom - tileZoom);
        const centerWorldPx = projectToWorldPixel(view.lat, view.lon, tileZoom);
        const newWorldPx = {
            x: centerWorldPx.x - dx / scaleFactor,
            y: centerWorldPx.y - dy / scaleFactor,
        };
        const newLatLon = unprojectFromWorldPixel(newWorldPx.x, newWorldPx.y, tileZoom);
        const candidate = { lat: newLatLon.lat, lon: newLatLon.lon, zoom: view.zoom };
        const canvas = canvasRef.current;
        const maxBounds = maxBoundsRef.current;
        viewRef.current =
            maxBounds && canvas
                ? clampViewToMaxBounds(candidate, maxBounds, canvas.clientWidth, canvas.clientHeight)
                : candidate;
    }, []);

    const handleZoomButtonClick = useCallback(
        (direction: 1 | -1) => {
            const canvas = canvasRef.current;
            if (!canvas) return;
            const view = viewRef.current;
            const { min, max } = zoomRangeRef.current;
            const effectiveMax = computeEffectiveMaxZoom(max, view.lat, canvas.clientWidth);
            const step = RADAR_ZOOM_STEP_PERCENT * (effectiveMax - min);
            applyZoomAtScreenPoint(canvas.clientWidth / 2, canvas.clientHeight / 2, view.zoom + direction * step);
            scheduleDraw();
        },
        [applyZoomAtScreenPoint, scheduleDraw]
    );

    const handleZoomPercentClick = useCallback(() => {
        if (latitude === null || longitude === null) return;
        const canvas = canvasRef.current;
        const { min, max } = zoomRangeRef.current;
        const effectiveMax = canvas ? computeEffectiveMaxZoom(max, latitude, canvas.clientWidth) : max;
        viewRef.current = {
            lat: latitude,
            lon: longitude,
            zoom: min + RADAR_DEFAULT_ZOOM_PERCENT * (effectiveMax - min),
        };
        scheduleDraw();
    }, [latitude, longitude, scheduleDraw]);

    function handleAirportSearchSubmit() {
        const query = airportSearchQuery.trim().toUpperCase();
        if (!query) return;

        const mainStationKey = stationInfo?.station?.toUpperCase();
        if (mainStationKey && (query === mainStationKey || `K${query}` === mainStationKey)) {
            setAirportSearchError("That's the current airport.");
            return;
        }

        const match = airportsRef.current.find(
            (airport) =>
                airport.ident.toUpperCase() === query || airport.icao?.toUpperCase() === query
        );

        if (!match) {
            setAirportSearchError(`Out of range (${RADAR_MAX_RADIUS_NM} nm).`);
            return;
        }

        selectedAirportIdentRef.current = match.ident;
        setSelectedAirport(match);
        scheduleDraw();
        setAirportSearchOpen(false);
        setAirportSearchQuery("");
        setAirportSearchError(null);
    }

    // Airspace shapes and full (not just major) airport detail load reactively as the user pans
    // and zooms, instead of being limited to a fixed radius around the selected station — each
    // fetch is still capped to a safe request size (the ArcGIS services these hit error out past
    // roughly RADAR_MAX_RADIUS_NM), it's just re-centered on wherever the view currently is.
    function maybeFetchLocalDetail() {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const view = viewRef.current;

        const cssWidth = canvas.clientWidth;
        const cssHeight = canvas.clientHeight;
        if (cssWidth === 0 || cssHeight === 0) return;

        const { min, max } = zoomRangeRef.current;
        // Station latitude, not view.lat — see the matching comment in drawFrame.
        const effectiveMax = computeEffectiveMaxZoom(max, latitude ?? view.lat, cssWidth);
        if (computeZoomPercent(view.zoom, min, effectiveMax) < LOCAL_DETAIL_MIN_ZOOM_PERCENT) return;

        const viewportBounds = computeViewportBounds(view, cssWidth, cssHeight);
        if (!viewportBounds) return;

        const covered = localDetailCoverageBoundsRef.current;
        if (covered && boundsContains(covered, viewportBounds)) return;

        // Only arm the timer if one isn't already pending — resetting it on every check would
        // let a long, continuous pan defer the fetch forever instead of ever settling.
        if (localDetailDebounceRef.current !== null) return;

        localDetailDebounceRef.current = window.setTimeout(() => {
            localDetailDebounceRef.current = null;

            const latestCanvas = canvasRef.current;
            const latestView = viewRef.current;
            if (!latestCanvas) return;
            const { min: latestMin, max: latestMax } = zoomRangeRef.current;
            const latestEffectiveMax = computeEffectiveMaxZoom(
                latestMax,
                latitude ?? latestView.lat,
                latestCanvas.clientWidth
            );
            if (
                computeZoomPercent(latestView.zoom, latestMin, latestEffectiveMax) <
                LOCAL_DETAIL_MIN_ZOOM_PERCENT
            ) {
                return;
            }
            const freshViewport = computeViewportBounds(
                latestView,
                latestCanvas.clientWidth,
                latestCanvas.clientHeight
            );
            if (!freshViewport) return;

            const requestBounds = intersectBounds(
                padBounds(freshViewport, LOCAL_DETAIL_PADDING_FACTOR),
                boundsForDiameterMeters(
                    { lat: latestView.lat, lon: latestView.lon },
                    RADAR_MAX_RADIUS_NM * NM_TO_METERS * 2
                )
            );

            localDetailAbortRef.current?.abort();
            const controller = new AbortController();
            localDetailAbortRef.current = controller;

            Promise.all([
                fetchAirspacePolygons(requestBounds, controller.signal).catch(() => null),
                fetchAirports(requestBounds, false, controller.signal).catch(() => null),
            ]).then(async ([polygons, airports]) => {
                if (controller.signal.aborted) return;

                if (polygons) {
                    const polygonKey = (polygon: AirspacePolygon) =>
                        `${polygon.airspaceClass}|${polygon.name}|${polygon.rings[0]?.[0]?.lat}|${polygon.rings[0]?.[0]?.lon}`;
                    const existingKeys = new Set(airspacePolygonsRef.current.map(polygonKey));
                    const merged = airspacePolygonsRef.current.slice();
                    for (const polygon of polygons) {
                        const key = polygonKey(polygon);
                        if (!existingKeys.has(key)) {
                            existingKeys.add(key);
                            merged.push(polygon);
                        }
                    }
                    airspacePolygonsRef.current = merged;
                }

                if (airports) {
                    const withCategories = await attachFlightCategories(airports, controller.signal).catch(
                        () => airports
                    );
                    if (controller.signal.aborted) return;

                    const mergedAirports = new Map<string, AirportPoint>();
                    for (const airport of airportsRef.current) mergedAirports.set(airport.ident, airport);
                    for (const airport of withCategories) {
                        if (resolveMetarStationKey(airport) === stationInfo?.station) continue;
                        mergedAirports.set(airport.ident, airport);
                    }
                    airportsRef.current = Array.from(mergedAirports.values());
                }

                localDetailCoverageBoundsRef.current = requestBounds;
                scheduleDraw();
            });
        }, LOCAL_DETAIL_DEBOUNCE_MS);
    }

    function hitTestAirport(localX: number, localY: number): AirportPoint | null {
        const canvas = canvasRef.current;
        if (!canvas) return null;
        const cssWidth = canvas.clientWidth;
        const cssHeight = canvas.clientHeight;
        const view = viewRef.current;
        const tileZoom = Math.max(0, Math.min(RADAR_BASEMAP_MAX_ZOOM, Math.round(view.zoom)));
        const scaleFactor = Math.pow(2, view.zoom - tileZoom);
        const centerWorldPx = projectToWorldPixel(view.lat, view.lon, tileZoom);

        const { min: hitTestMin, max: hitTestMax } = zoomRangeRef.current;
        const hitTestEffectiveMax = computeEffectiveMaxZoom(hitTestMax, latitude ?? view.lat, cssWidth);
        const hitTestTier = computeAirportDetailTier(
            computeZoomPercent(view.zoom, hitTestMin, hitTestEffectiveMax)
        );
        const candidates = computeVisibleAirports(
            airportsRef.current,
            view,
            tileZoom,
            centerWorldPx,
            scaleFactor,
            cssWidth,
            cssHeight,
            selectedAirportIdentRef.current,
            hitTestTier
        );
        let closest: AirportPoint | null = null;
        let closestDistance = 14;
        for (const airport of candidates) {
            const world = projectToWorldPixel(airport.lat, wrapLonNear(airport.lon, view.lon), tileZoom);
            const x = cssWidth / 2 + (world.x - centerWorldPx.x) * scaleFactor;
            const y = cssHeight / 2 + (world.y - centerWorldPx.y) * scaleFactor;
            const distance = Math.hypot(x - localX, y - localY);
            if (distance < closestDistance) {
                closestDistance = distance;
                closest = airport;
            }
        }
        return closest;
    }

    function hitTestOverlayZones(
        localX: number,
        localY: number
    ): { tfrs: TfrPolygon[]; gairmets: GairmetZone[]; pireps: PirepReport[] } {
        const canvas = canvasRef.current;
        if (!canvas) return { tfrs: [], gairmets: [], pireps: [] };
        const cssWidth = canvas.clientWidth;
        const cssHeight = canvas.clientHeight;
        const view = viewRef.current;
        const tileZoom = Math.max(0, Math.min(RADAR_BASEMAP_MAX_ZOOM, Math.round(view.zoom)));
        const scaleFactor = Math.pow(2, view.zoom - tileZoom);
        const centerWorldPx = projectToWorldPixel(view.lat, view.lon, tileZoom);

        // Ring points are shifted by one offset computed from the ring's own first point
        // (not wrapped individually) so a ring near the antimeridian doesn't tear into a
        // garbage shape when its vertices straddle the +/-360 rounding boundary.
        const toScreen = (point: { lat: number; lon: number }, lonOffset: number) => {
            const world = projectToWorldPixel(point.lat, point.lon + lonOffset, tileZoom);
            return {
                x: cssWidth / 2 + (world.x - centerWorldPx.x) * scaleFactor,
                y: cssHeight / 2 + (world.y - centerWorldPx.y) * scaleFactor,
            };
        };
        const ringOffset = (ring: { lat: number; lon: number }[]) =>
            wrapLonNear(ring[0].lon, view.lon) - ring[0].lon;

        const tfrs: TfrPolygon[] = [];
        if (tfrVisible) {
            for (const tfr of tfrPolygonsRef.current) {
                const hit = tfr.rings.some(
                    (ring) =>
                        ring.length >= 3 &&
                        pointInRing(localX, localY, ring.map((p) => toScreen(p, ringOffset(ring))))
                );
                if (hit) tfrs.push(tfr);
            }
        }

        const gairmets: GairmetZone[] = [];
        if (gairmetVisible) {
            for (const zone of gairmetZonesRef.current) {
                const offset = ringOffset(zone.ring);
                if (
                    zone.ring.length >= 3 &&
                    pointInRing(localX, localY, zone.ring.map((p) => toScreen(p, offset)))
                ) {
                    gairmets.push(zone);
                }
            }
        }
        if (sigmetVisible) {
            for (const zone of sigmetZonesRef.current) {
                const offset = ringOffset(zone.ring);
                if (
                    zone.ring.length >= 3 &&
                    pointInRing(localX, localY, zone.ring.map((p) => toScreen(p, offset)))
                ) {
                    gairmets.push(zone);
                }
            }
        }

        const pireps: PirepReport[] = [];
        if (pirepVisible) {
            for (const report of pirepsRef.current) {
                const point = toScreen(report, wrapLonNear(report.lon, view.lon) - report.lon);
                if (Math.hypot(point.x - localX, point.y - localY) < 10) {
                    pireps.push(report);
                }
            }
        }

        return { tfrs, gairmets, pireps };
    }

    function handlePointerDown(event: PointerEvent<HTMLCanvasElement>) {
        const canvas = canvasRef.current;
        if (!canvas) return;
        try {
            canvas.setPointerCapture(event.pointerId);
        } catch {
            // Ignore — some synthetic/edge-case pointer ids can't be captured.
        }
        activePointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        pointerDownScreenPosRef.current = { x: event.clientX, y: event.clientY };

        if (activePointersRef.current.size === 1) {
            lastPointerPosRef.current = { x: event.clientX, y: event.clientY };
            pinchLastRef.current = null;
        } else if (activePointersRef.current.size === 2) {
            pinchLastRef.current = computePinchMetrics(
                Array.from(activePointersRef.current.values())
            );
            lastPointerPosRef.current = null;
        }
    }

    function handlePointerMove(event: PointerEvent<HTMLCanvasElement>) {
        if (!activePointersRef.current.has(event.pointerId)) {
            const canvas = canvasRef.current;
            if (canvas) {
                const rect = canvas.getBoundingClientRect();
                const localX = event.clientX - rect.left;
                const localY = event.clientY - rect.top;
                const hit = hitTestAirport(localX, localY);
                const nextIdent = hit?.ident ?? null;
                if (hoveredAirportIdentRef.current !== nextIdent) {
                    hoveredAirportIdentRef.current = nextIdent;
                    scheduleDraw();
                }

                let overlayHit = false;
                if (!zoneInfoPinnedRef.current) {
                    const { tfrs, gairmets, pireps } = hitTestOverlayZones(localX, localY);
                    if (tfrs.length > 0 || gairmets.length > 0 || pireps.length > 0) {
                        overlayHit = true;
                        setZoneInfo({ x: localX, y: localY, pinned: false, tfrs, gairmets, pireps });
                    } else {
                        setZoneInfo((current) => (current && !current.pinned ? null : current));
                    }
                }

                canvas.style.cursor = hit || overlayHit ? "pointer" : "grab";
            }
            return;
        }

        activePointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        const points = Array.from(activePointersRef.current.values());

        if (points.length === 1) {
            const last = lastPointerPosRef.current;
            lastPointerPosRef.current = points[0];
            if (!last) return;
            panByScreenDelta(points[0].x - last.x, points[0].y - last.y);
            scheduleDraw();
        } else if (points.length >= 2) {
            const metrics = computePinchMetrics(points.slice(0, 2));
            const last = pinchLastRef.current;
            pinchLastRef.current = metrics;
            if (!last) return;

            const canvas = canvasRef.current;
            if (!canvas) return;
            const rect = canvas.getBoundingClientRect();
            const localX = metrics.mid.x - rect.left;
            const localY = metrics.mid.y - rect.top;

            panByScreenDelta(metrics.mid.x - last.mid.x, metrics.mid.y - last.mid.y);
            const zoomDelta = Math.log2(metrics.distance / Math.max(1, last.distance));
            applyZoomAtScreenPoint(localX, localY, viewRef.current.zoom + zoomDelta);
            scheduleDraw();
        }
    }

    function handlePointerUp(event: PointerEvent<HTMLCanvasElement>) {
        const wasSinglePointer = activePointersRef.current.size === 1;
        const downPos = pointerDownScreenPosRef.current;

        activePointersRef.current.delete(event.pointerId);
        const canvas = canvasRef.current;
        if (canvas?.hasPointerCapture(event.pointerId)) {
            canvas.releasePointerCapture(event.pointerId);
        }

        if (wasSinglePointer && downPos && canvas) {
            const movedDistance = Math.hypot(event.clientX - downPos.x, event.clientY - downPos.y);
            if (movedDistance < 6) {
                const rect = canvas.getBoundingClientRect();
                const localX = event.clientX - rect.left;
                const localY = event.clientY - rect.top;
                const hit = hitTestAirport(localX, localY);
                if (hit) {
                    const nextIdent = selectedAirportIdentRef.current === hit.ident ? null : hit.ident;
                    selectedAirportIdentRef.current = nextIdent;
                    setSelectedAirport(nextIdent ? hit : null);
                    scheduleDraw();
                }

                // Checked regardless of the airport hit above — a PIREP (or TFR/hazard
                // zone) can sit right on top of an airport marker, and both should stay
                // reachable rather than the airport silently winning every click there.
                const { tfrs, gairmets, pireps } = hitTestOverlayZones(localX, localY);
                if (tfrs.length > 0 || gairmets.length > 0 || pireps.length > 0) {
                    zoneInfoPinnedRef.current = true;
                    setZoneInfo({ x: localX, y: localY, pinned: true, tfrs, gairmets, pireps });
                } else if (zoneInfoPinnedRef.current) {
                    zoneInfoPinnedRef.current = false;
                    setZoneInfo(null);
                }
            }
        }

        if (activePointersRef.current.size === 1) {
            lastPointerPosRef.current = Array.from(activePointersRef.current.values())[0] ?? null;
            pinchLastRef.current = null;
        } else if (activePointersRef.current.size === 0) {
            lastPointerPosRef.current = null;
            pinchLastRef.current = null;
        }
        pointerDownScreenPosRef.current = null;
    }

    function handlePointerLeave() {
        if (hoveredAirportIdentRef.current !== null) {
            hoveredAirportIdentRef.current = null;
            scheduleDraw();
        }
        if (!zoneInfoPinnedRef.current) {
            setZoneInfo(null);
        }
    }

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        function stepWheelZoom() {
            wheelZoomAnimRef.current = null;
            const target = wheelZoomTargetRef.current;
            if (target === null) return;
            const anchor = wheelZoomAnchorRef.current;
            const current = viewRef.current.zoom;
            const diff = target - current;
            if (Math.abs(diff) < 0.001) {
                applyZoomAtScreenPoint(anchor.x, anchor.y, target);
                wheelZoomTargetRef.current = null;
            } else {
                applyZoomAtScreenPoint(anchor.x, anchor.y, current + diff * RADAR_WHEEL_ZOOM_EASE);
                wheelZoomAnimRef.current = requestAnimationFrame(stepWheelZoom);
            }
            scheduleDraw();
        }

        function onWheelNative(event: WheelEvent) {
            // React's synthetic onWheel is attached passively and can't preventDefault
            // (it would just log a console warning), so this listener is wired natively.
            event.preventDefault();
            const rect = canvas!.getBoundingClientRect();
            wheelZoomAnchorRef.current = { x: event.clientX - rect.left, y: event.clientY - rect.top };
            // Every wheel event nudges a target zoom (uncapped in how often it can move — always
            // continuous, never snapped to a fixed step). A separate animation loop glides the
            // actual view toward that target once per frame, so rendering stays smooth even if the
            // browser ends up delivering wheel events in irregular or coalesced bursts.
            const view = viewRef.current;
            const { min, max } = zoomRangeRef.current;
            const effectiveMax = computeEffectiveMaxZoom(max, view.lat, canvas!.clientWidth);
            const base = wheelZoomTargetRef.current ?? view.zoom;
            const zoomDelta = -event.deltaY * RADAR_WHEEL_ZOOM_SENSITIVITY;
            wheelZoomTargetRef.current = Math.max(min, Math.min(effectiveMax, base + zoomDelta));
            if (wheelZoomAnimRef.current === null) {
                wheelZoomAnimRef.current = requestAnimationFrame(stepWheelZoom);
            }
        }

        canvas.addEventListener("wheel", onWheelNative, { passive: false });
        return () => {
            canvas.removeEventListener("wheel", onWheelNative);
            if (wheelZoomAnimRef.current !== null) cancelAnimationFrame(wheelZoomAnimRef.current);
            wheelZoomAnimRef.current = null;
            wheelZoomTargetRef.current = null;
        };
    }, [applyZoomAtScreenPoint, scheduleDraw]);

    useEffect(() => {
        if (!airportSearchOpen) return;

        function handlePointerDownOutside(event: globalThis.PointerEvent) {
            if (!airportSearchContainerRef.current?.contains(event.target as Node)) {
                setAirportSearchOpen(false);
                setAirportSearchQuery("");
                setAirportSearchError(null);
            }
        }

        document.addEventListener("pointerdown", handlePointerDownOutside);
        return () => document.removeEventListener("pointerdown", handlePointerDownOutside);
    }, [airportSearchOpen]);

    const drawFrame = () => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const dpr = window.devicePixelRatio || 1;
        const cssWidth = canvas.clientWidth;
        const cssHeight = canvas.clientHeight;
        if (cssWidth === 0 || cssHeight === 0) return;

        const pixelWidth = Math.round(cssWidth * dpr);
        const pixelHeight = Math.round(cssHeight * dpr);
        if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
            canvas.width = pixelWidth;
            canvas.height = pixelHeight;
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = "#18181b";
        ctx.fillRect(0, 0, cssWidth, cssHeight);

        const view = viewRef.current;
        const { min: zoomRangeMin, max: zoomRangeMax } = zoomRangeRef.current;
        const effectiveMaxZoom = computeEffectiveMaxZoom(zoomRangeMax, view.lat, cssWidth);
        const zoomPercent = computeZoomPercent(view.zoom, zoomRangeMin, effectiveMaxZoom);
        // The airport/airspace LOD threshold uses the station's fixed latitude, not the current
        // view's — effectiveMaxZoom depends on latitude (Mercator distortion), so keying it to
        // view.lat meant panning north/south at an unchanged zoom level could nudge the percent
        // across the threshold on its own, making minor airports flicker in and out mid-pan.
        const lodEffectiveMaxZoom = computeEffectiveMaxZoom(zoomRangeMax, latitude ?? view.lat, cssWidth);
        const lodZoomPercent = computeZoomPercent(view.zoom, zoomRangeMin, lodEffectiveMaxZoom);
        const airportTier = computeAirportDetailTier(lodZoomPercent);
        // Airspace shapes come in at the same threshold as the airport tier escalating past
        // majors-only — semiMajor or all, not just all.
        const showMinorAirports = airportTier !== "major";

        const nowMs = performance.now();
        if (nowMs - lastLocalDetailCheckRef.current > 200) {
            lastLocalDetailCheckRef.current = nowMs;
            maybeFetchLocalDetail();
        }

        const tileZoom = Math.max(0, Math.min(RADAR_BASEMAP_MAX_ZOOM, Math.round(view.zoom)));
        const scaleFactor = Math.pow(2, view.zoom - tileZoom);
        const centerWorldPx = projectToWorldPixel(view.lat, view.lon, tileZoom);

        const halfWidthWorld = cssWidth / 2 / scaleFactor;
        const halfHeightWorld = cssHeight / 2 / scaleFactor;
        const minTileX = Math.floor((centerWorldPx.x - halfWidthWorld) / MAP_TILE_SIZE) - 1;
        const maxTileX = Math.floor((centerWorldPx.x + halfWidthWorld) / MAP_TILE_SIZE) + 1;
        const minTileY = Math.floor((centerWorldPx.y - halfHeightWorld) / MAP_TILE_SIZE) - 1;
        const maxTileY = Math.floor((centerWorldPx.y + halfHeightWorld) / MAP_TILE_SIZE) + 1;
        const tileCountAtZoom = Math.pow(2, tileZoom);

        for (let tx = minTileX; tx <= maxTileX; tx++) {
            for (let ty = minTileY; ty <= maxTileY; ty++) {
                if (ty < 0 || ty >= tileCountAtZoom) continue;
                const wrappedX = ((tx % tileCountAtZoom) + tileCountAtZoom) % tileCountAtZoom;
                const key = `${tileZoom}/${wrappedX}/${ty}`;
                let img = tileCacheRef.current.get(key);
                if (!img) {
                    img = new window.Image();
                    img.src = RADAR_BASEMAP_TILE_URL.replace("{z}", String(tileZoom))
                        .replace("{y}", String(ty))
                        .replace("{x}", String(wrappedX));
                    img.onload = () => scheduleDraw();
                    tileCacheRef.current.set(key, img);
                }
                if (img.complete && img.naturalWidth > 0) {
                    const screenX = cssWidth / 2 + (tx * MAP_TILE_SIZE - centerWorldPx.x) * scaleFactor;
                    const screenY = cssHeight / 2 + (ty * MAP_TILE_SIZE - centerWorldPx.y) * scaleFactor;
                    const size = MAP_TILE_SIZE * scaleFactor;
                    ctx.drawImage(img, screenX, screenY, size, size);
                }
            }
        }

        // Radar is a real tile pyramid too (see RADAR_TILE_URL_TEMPLATE) — same tiled draw
        // pattern as the basemap and satellite, just addressed by animation frame as well as
        // zoom/x/y so every frame's tiles can be cached and drawn instantly once fetched once.
        const radarFrame = radarVisible ? radarFramesRef.current[currentFrameIndex] : undefined;
        if (radarFrame) {
            const radTileZoom = Math.min(tileZoom, RADAR_MAX_NATIVE_ZOOM);
            const radScaleFactor = Math.pow(2, view.zoom - radTileZoom);
            const radCenterWorldPx = projectToWorldPixel(view.lat, view.lon, radTileZoom);
            const radHalfWidthWorld = cssWidth / 2 / radScaleFactor;
            const radHalfHeightWorld = cssHeight / 2 / radScaleFactor;
            const radMinTileX = Math.floor((radCenterWorldPx.x - radHalfWidthWorld) / MAP_TILE_SIZE) - 1;
            const radMaxTileX = Math.floor((radCenterWorldPx.x + radHalfWidthWorld) / MAP_TILE_SIZE) + 1;
            const radMinTileY = Math.floor((radCenterWorldPx.y - radHalfHeightWorld) / MAP_TILE_SIZE) - 1;
            const radMaxTileY = Math.floor((radCenterWorldPx.y + radHalfHeightWorld) / MAP_TILE_SIZE) + 1;
            const radTileCount = Math.pow(2, radTileZoom);

            for (let tx = radMinTileX; tx <= radMaxTileX; tx++) {
                for (let ty = radMinTileY; ty <= radMaxTileY; ty++) {
                    if (ty < 0 || ty >= radTileCount) continue;
                    const wrappedX = ((tx % radTileCount) + radTileCount) % radTileCount;
                    // TMS Y-flip for the request only — on-screen position still uses the
                    // un-flipped ty, same reasoning as the satellite tile loop above.
                    const tmsY = radTileCount - 1 - ty;
                    const key = `${radarFrame.date}${radarFrame.time}/${radTileZoom}/${wrappedX}/${tmsY}`;
                    let img = radarTileCacheRef.current.get(key);
                    if (!img) {
                        img = new window.Image();
                        img.src = buildRadarTileUrl(radTileZoom, wrappedX, tmsY, radarFrame);
                        img.onload = () => scheduleDraw();
                        radarTileCacheRef.current.set(key, img);
                    }
                    if (img.complete && img.naturalWidth > 0) {
                        const screenX = cssWidth / 2 + (tx * MAP_TILE_SIZE - radCenterWorldPx.x) * radScaleFactor;
                        const screenY = cssHeight / 2 + (ty * MAP_TILE_SIZE - radCenterWorldPx.y) * radScaleFactor;
                        const size = MAP_TILE_SIZE * radScaleFactor;
                        ctx.drawImage(img, screenX, screenY, size, size);
                    }
                }
            }
        }

        // Satellite is a real tile pyramid (see SATELLITE_TILE_URL_TEMPLATE), not one stretched
        // image, so it's drawn the same tiled way as the basemap above — just capped at its own,
        // much lower, native zoom (tiles beyond that don't exist and just get scaled up).
        if (satelliteVisible && satelliteCycleRef.current) {
            const cycle = satelliteCycleRef.current;
            const satTileZoom = Math.min(tileZoom, SATELLITE_MAX_NATIVE_ZOOM);
            const satScaleFactor = Math.pow(2, view.zoom - satTileZoom);
            const satCenterWorldPx = projectToWorldPixel(view.lat, view.lon, satTileZoom);
            const satHalfWidthWorld = cssWidth / 2 / satScaleFactor;
            const satHalfHeightWorld = cssHeight / 2 / satScaleFactor;
            const satMinTileX = Math.floor((satCenterWorldPx.x - satHalfWidthWorld) / MAP_TILE_SIZE) - 1;
            const satMaxTileX = Math.floor((satCenterWorldPx.x + satHalfWidthWorld) / MAP_TILE_SIZE) + 1;
            const satMinTileY = Math.floor((satCenterWorldPx.y - satHalfHeightWorld) / MAP_TILE_SIZE) - 1;
            const satMaxTileY = Math.floor((satCenterWorldPx.y + satHalfHeightWorld) / MAP_TILE_SIZE) + 1;
            const satTileCount = Math.pow(2, satTileZoom);

            for (let tx = satMinTileX; tx <= satMaxTileX; tx++) {
                for (let ty = satMinTileY; ty <= satMaxTileY; ty++) {
                    if (ty < 0 || ty >= satTileCount) continue;
                    const wrappedX = ((tx % satTileCount) + satTileCount) % satTileCount;
                    // The source serves TMS tiles (Y=0 at the south), the world-pixel math above
                    // is standard XYZ (Y=0 at the north) — flip only for the request, not the
                    // on-screen position, which still uses the un-flipped ty.
                    const tmsY = satTileCount - 1 - ty;
                    const key = `${cycle.date}${cycle.time}/${satTileZoom}/${wrappedX}/${tmsY}`;
                    let img = satelliteTileCacheRef.current.get(key);
                    if (!img) {
                        img = new window.Image();
                        img.src = buildSatelliteTileUrl(satTileZoom, wrappedX, tmsY, cycle);
                        img.onload = () => scheduleDraw();
                        satelliteTileCacheRef.current.set(key, img);
                    }
                    if (img.complete && img.naturalWidth > 0) {
                        const screenX = cssWidth / 2 + (tx * MAP_TILE_SIZE - satCenterWorldPx.x) * satScaleFactor;
                        const screenY = cssHeight / 2 + (ty * MAP_TILE_SIZE - satCenterWorldPx.y) * satScaleFactor;
                        const size = MAP_TILE_SIZE * satScaleFactor;
                        ctx.drawImage(img, screenX, screenY, size, size);
                    }
                }
            }
        }

        const gfaImg = activeGfaOverlay ? gfaImagesRef.current[activeGfaOverlay] ?? null : null;
        if (gfaImg && gfaImg.complete && gfaImg.naturalWidth > 0) {
            const gfaLonOffset = wrapLonNear(GFA_MOSAIC_BOUNDS.west, view.lon) - GFA_MOSAIC_BOUNDS.west;
            const topLeftWorld = projectToWorldPixel(
                GFA_MOSAIC_BOUNDS.north,
                GFA_MOSAIC_BOUNDS.west + gfaLonOffset,
                tileZoom
            );
            const bottomRightWorld = projectToWorldPixel(
                GFA_MOSAIC_BOUNDS.south,
                GFA_MOSAIC_BOUNDS.east + gfaLonOffset,
                tileZoom
            );
            const x0 = cssWidth / 2 + (topLeftWorld.x - centerWorldPx.x) * scaleFactor;
            const y0 = cssHeight / 2 + (topLeftWorld.y - centerWorldPx.y) * scaleFactor;
            const x1 = cssWidth / 2 + (bottomRightWorld.x - centerWorldPx.x) * scaleFactor;
            const y1 = cssHeight / 2 + (bottomRightWorld.y - centerWorldPx.y) * scaleFactor;
            ctx.drawImage(gfaImg, x0, y0, x1 - x0, y1 - y0);
        }

        if (boundaryVisible) {
            for (let tx = minTileX; tx <= maxTileX; tx++) {
                for (let ty = minTileY; ty <= maxTileY; ty++) {
                    if (ty < 0 || ty >= tileCountAtZoom) continue;
                    const wrappedX = ((tx % tileCountAtZoom) + tileCountAtZoom) % tileCountAtZoom;
                    const key = `${tileZoom}/${wrappedX}/${ty}`;
                    let img = boundaryTileCacheRef.current.get(key);
                    if (!img) {
                        img = new window.Image();
                        img.src = RADAR_BOUNDARY_TILE_URL.replace("{z}", String(tileZoom))
                            .replace("{y}", String(ty))
                            .replace("{x}", String(wrappedX));
                        img.onload = () => scheduleDraw();
                        boundaryTileCacheRef.current.set(key, img);
                    }
                    if (img.complete && img.naturalWidth > 0) {
                        const screenX = cssWidth / 2 + (tx * MAP_TILE_SIZE - centerWorldPx.x) * scaleFactor;
                        const screenY = cssHeight / 2 + (ty * MAP_TILE_SIZE - centerWorldPx.y) * scaleFactor;
                        const size = MAP_TILE_SIZE * scaleFactor;
                        ctx.drawImage(img, screenX, screenY, size, size);
                    }
                }
            }
        }

        const drawHazardZones = (zones: GairmetZone[]) => {
            for (const zone of zones) {
                const style = GAIRMET_HAZARD_STYLES[zone.hazard];
                if (!style || zone.ring.length < 3) continue;

                // Wrapped once for the whole ring (not per-vertex) — wrapping each point
                // independently can pick different +/-360 multiples for vertices that sit
                // right at the rounding boundary, tearing the shape into a seam that
                // stretches across the map.
                const lonOffset = wrapLonNear(zone.ring[0].lon, view.lon) - zone.ring[0].lon;
                const points = zone.ring.map((point) => {
                    const world = projectToWorldPixel(point.lat, point.lon + lonOffset, tileZoom);
                    return {
                        x: cssWidth / 2 + (world.x - centerWorldPx.x) * scaleFactor,
                        y: cssHeight / 2 + (world.y - centerWorldPx.y) * scaleFactor,
                    };
                });

                ctx.beginPath();
                ctx.moveTo(points[0].x, points[0].y);
                for (let i = 1; i < points.length; i++) {
                    ctx.lineTo(points[i].x, points[i].y);
                }
                ctx.closePath();
                ctx.fillStyle = style.fill;
                ctx.fill();
                ctx.lineWidth = 1.5;
                ctx.strokeStyle = style.stroke;
                ctx.stroke();
            }
        };

        if (gairmetVisible) drawHazardZones(gairmetZonesRef.current);
        if (sigmetVisible) drawHazardZones(sigmetZonesRef.current);

        // Below LOCAL_DETAIL_MIN_ZOOM_PERCENT, skip drawing airspace shapes even if some are
        // already loaded (from exploring a zoomed-in area earlier in the session) — a wide
        // zoomed-out view showing every Class B/C/D ring visited so far would just be clutter.
        if (airspaceVisible && showMinorAirports) {
            for (const polygon of airspacePolygonsRef.current) {
                const style = AIRSPACE_CLASS_STYLES[polygon.airspaceClass];
                if (!style) continue;

                for (const ring of polygon.rings) {
                    if (ring.length < 3) continue;
                    const lonOffset = wrapLonNear(ring[0].lon, view.lon) - ring[0].lon;
                    const points = ring.map((point) => {
                        const world = projectToWorldPixel(point.lat, point.lon + lonOffset, tileZoom);
                        return {
                            x: cssWidth / 2 + (world.x - centerWorldPx.x) * scaleFactor,
                            y: cssHeight / 2 + (world.y - centerWorldPx.y) * scaleFactor,
                        };
                    });

                    // Round off gentle bends (simplified circular radii) into smooth curves,
                    // but keep real corners sharp — decided per vertex by its turn angle.
                    const n = points.length;
                    ctx.beginPath();
                    ctx.moveTo(points[0].x, points[0].y);
                    for (let i = 0; i < n; i++) {
                        const prev = points[(i - 1 + n) % n];
                        const current = points[i];
                        const next = points[(i + 1) % n];
                        const turnAngle = computeTurnAngleDeg(prev, current, next);
                        if (turnAngle >= AIRSPACE_CORNER_ANGLE_DEG) {
                            ctx.lineTo(current.x, current.y);
                        } else {
                            ctx.quadraticCurveTo(
                                current.x,
                                current.y,
                                (current.x + next.x) / 2,
                                (current.y + next.y) / 2
                            );
                        }
                    }
                    ctx.closePath();
                    ctx.setLineDash(style.dash);
                    ctx.lineWidth = style.width;
                    ctx.strokeStyle = style.color;
                    ctx.stroke();
                    ctx.setLineDash([]);
                }
            }
        }

        if (tfrVisible) {
            for (const tfr of tfrPolygonsRef.current) {
                for (const ring of tfr.rings) {
                    if (ring.length < 3) continue;
                    const lonOffset = wrapLonNear(ring[0].lon, view.lon) - ring[0].lon;
                    const points = ring.map((point) => {
                        const world = projectToWorldPixel(point.lat, point.lon + lonOffset, tileZoom);
                        return {
                            x: cssWidth / 2 + (world.x - centerWorldPx.x) * scaleFactor,
                            y: cssHeight / 2 + (world.y - centerWorldPx.y) * scaleFactor,
                        };
                    });

                    ctx.beginPath();
                    ctx.moveTo(points[0].x, points[0].y);
                    for (let i = 1; i < points.length; i++) {
                        ctx.lineTo(points[i].x, points[i].y);
                    }
                    ctx.closePath();
                    ctx.fillStyle = TFR_STYLE.fill;
                    ctx.fill();
                    ctx.lineWidth = TFR_STYLE.width;
                    ctx.strokeStyle = TFR_STYLE.stroke;
                    ctx.stroke();
                }
            }
        }

        if (airspaceVisible) {
            const selectedIdent = selectedAirportIdentRef.current;
            let selectedAirport: AirportPoint | null = null;
            const visibleAirports = computeVisibleAirports(
                airportsRef.current,
                view,
                tileZoom,
                centerWorldPx,
                scaleFactor,
                cssWidth,
                cssHeight,
                selectedIdent,
                airportTier
            );

            for (const airport of visibleAirports) {
                const world = projectToWorldPixel(airport.lat, wrapLonNear(airport.lon, view.lon), tileZoom);
                const x = cssWidth / 2 + (world.x - centerWorldPx.x) * scaleFactor;
                const y = cssHeight / 2 + (world.y - centerWorldPx.y) * scaleFactor;
                const isSelected = airport.ident === selectedIdent;
                if (isSelected) selectedAirport = airport;

                // Airports with a real flight category get the big, easy-to-read dot; an N/A
                // (no METAR of its own) airport is only ever a minor supporting detail, so it
                // stays small regardless of major/minor status.
                const hasCategory = airport.flightCategory !== undefined;
                const radius = isSelected ? 7.5 : hasCategory ? (airport.isMajor ? 6.5 : 5) : 3.5;
                ctx.beginPath();
                ctx.arc(x, y, radius, 0, Math.PI * 2);
                ctx.fillStyle = isSelected
                    ? "#d6b35a"
                    : FLIGHT_CATEGORY_MARKER_COLORS[airport.flightCategory ?? "UNKNOWN"];
                ctx.fill();
                // Flat filled circle with a thin dark edge for definition, closer to
                // aviationweather.gov's own METAR station styling — the white ring gave every
                // dot a "halo" that read as busier/heavier than their plain colored-dot look.
                // The selected airport keeps its own distinct white ring as a highlight.
                ctx.lineWidth = isSelected ? 2.5 : 1;
                ctx.strokeStyle = isSelected ? "#ffffff" : "rgba(0, 0, 0, 0.55)";
                ctx.stroke();

                const showLabel = hoveredAirportIdentRef.current === airport.ident || isSelected;
                if (showLabel) {
                    ctx.font = "700 11px system-ui, sans-serif";
                    ctx.textBaseline = "middle";
                    ctx.lineWidth = 3;
                    ctx.strokeStyle = "rgba(0, 0, 0, 0.85)";
                    ctx.strokeText(airport.ident, x + radius + 4, y);
                    ctx.fillStyle = "#f4f4f5";
                    ctx.fillText(airport.ident, x + radius + 4, y);
                }
            }

            const stationMarkerPosition = stationMarkerPositionRef.current;
            if (selectedAirport && stationMarkerPosition) {
                const originWorld = projectToWorldPixel(
                    stationMarkerPosition.lat,
                    wrapLonNear(stationMarkerPosition.lon, view.lon),
                    tileZoom
                );
                const originX = cssWidth / 2 + (originWorld.x - centerWorldPx.x) * scaleFactor;
                const originY = cssHeight / 2 + (originWorld.y - centerWorldPx.y) * scaleFactor;
                const destWorld = projectToWorldPixel(
                    selectedAirport.lat,
                    wrapLonNear(selectedAirport.lon, view.lon),
                    tileZoom
                );
                const destX = cssWidth / 2 + (destWorld.x - centerWorldPx.x) * scaleFactor;
                const destY = cssHeight / 2 + (destWorld.y - centerWorldPx.y) * scaleFactor;

                ctx.beginPath();
                ctx.moveTo(originX, originY);
                ctx.lineTo(destX, destY);
                ctx.setLineDash([2, 4]);
                ctx.lineWidth = 1.5;
                ctx.strokeStyle = "rgba(230, 199, 111, 0.85)";
                ctx.stroke();
                ctx.setLineDash([]);
            }
        }

        if (pirepVisible) {
            for (const report of pirepsRef.current) {
                const world = projectToWorldPixel(report.lat, wrapLonNear(report.lon, view.lon), tileZoom);
                const x = cssWidth / 2 + (world.x - centerWorldPx.x) * scaleFactor;
                const y = cssHeight / 2 + (world.y - centerWorldPx.y) * scaleFactor;
                drawAirplaneMarker(ctx, x, y, 14, PIREP_SEVERITY_COLORS[report.severity], report.isUrgent);
            }
        }

        for (const runway of runways) {
            const { endA, endB } = runway;
            if (
                endA.latitude === null ||
                endA.longitude === null ||
                endB.latitude === null ||
                endB.longitude === null
            ) {
                continue;
            }
            const aWorld = projectToWorldPixel(endA.latitude, wrapLonNear(endA.longitude, view.lon), tileZoom);
            const bWorld = projectToWorldPixel(endB.latitude, wrapLonNear(endB.longitude, view.lon), tileZoom);
            const ax = cssWidth / 2 + (aWorld.x - centerWorldPx.x) * scaleFactor;
            const ay = cssHeight / 2 + (aWorld.y - centerWorldPx.y) * scaleFactor;
            const bx = cssWidth / 2 + (bWorld.x - centerWorldPx.x) * scaleFactor;
            const by = cssHeight / 2 + (bWorld.y - centerWorldPx.y) * scaleFactor;
            ctx.beginPath();
            ctx.moveTo(ax, ay);
            ctx.lineTo(bx, by);
            ctx.lineCap = "round";
            ctx.lineWidth = 3;
            ctx.strokeStyle = "#f4f4f5";
            ctx.stroke();
        }

        if (stationMarkerPositionRef.current) {
            const { lat: markerLat, lon: markerLon } = stationMarkerPositionRef.current;
            const markerWorld = projectToWorldPixel(markerLat, wrapLonNear(markerLon, view.lon), tileZoom);
            const mx = cssWidth / 2 + (markerWorld.x - centerWorldPx.x) * scaleFactor;
            const my = cssHeight / 2 + (markerWorld.y - centerWorldPx.y) * scaleFactor;

            ctx.beginPath();
            ctx.arc(mx, my, 12, 0, Math.PI * 2);
            ctx.fillStyle = "rgba(214, 179, 90, 0.2)";
            ctx.fill();

            ctx.beginPath();
            ctx.arc(mx, my, 7, 0, Math.PI * 2);
            ctx.fillStyle = "#d6b35a";
            ctx.fill();
            ctx.lineWidth = 2.5;
            ctx.strokeStyle = "#ffffff";
            ctx.stroke();

            if (stationInfo?.station) {
                ctx.font = "700 12px system-ui, sans-serif";
                ctx.textBaseline = "middle";
                ctx.lineWidth = 3;
                ctx.strokeStyle = "rgba(0, 0, 0, 0.85)";
                ctx.strokeText(stationInfo.station, mx + 13, my);
                ctx.fillStyle = "#f4f4f5";
                ctx.fillText(stationInfo.station, mx + 13, my);
            }
        }

        setDisplayZoomPercent((prev) => {
            const next = effectiveMaxZoom > zoomRangeMin ? Math.round(zoomPercent) : null;
            return prev === next ? prev : next;
        });
        setDisplayScale((prev) => {
            const next = computeScaleForView(view, computeScaleTargetPx(cssWidth));
            return prev && prev.nm === next.nm && prev.px === next.px ? prev : next;
        });
    };

    useEffect(() => {
        drawFrameRef.current = drawFrame;
    });

    useEffect(() => {
        if (latitude === null || longitude === null || !containerRef.current) {
            return;
        }

        let cancelled = false;
        const center = { lat: latitude, lon: longitude };
        const tileCache = tileCacheRef.current;
        const boundaryTileCache = boundaryTileCacheRef.current;

        setRadarFrameTimes([]);
        setCurrentFrameIndex(0);
        setRadarFrameGeneration(0);
        setRadarError(null);
        tileCache.clear();
        boundaryTileCache.clear();
        radarTileCacheRef.current.clear();
        radarFramesRef.current = [];
        satelliteTileCacheRef.current.clear();
        satelliteCycleRef.current = null;
        gfaImagesRef.current = {};
        // Deliberately NOT clearing airportsRef, airspacePolygonsRef, tfrPolygonsRef,
        // gairmetZonesRef, sigmetZonesRef, or pirepsRef here. All of that data is fetched
        // nationwide (AMERICAS_BOUNDS) and has nothing to do with which station is currently
        // selected, so wiping it on every station switch was throwing away a fully-loaded
        // nationwide dataset and forcing a full reload from zero — which is exactly why airports
        // clear across the country (e.g. everything around KMSP) would visibly disappear for the
        // ~20-30s it took to reload after looking up a different, distant airport. Their own
        // loaders (loadHazards, loadNationwideAirportsAndAirspace, and the local-area fetch below)
        // now merge onto whatever's already there instead of assuming an empty starting point.
        stationMarkerPositionRef.current = center;
        setStationMarkerPosition(center);
        hoveredAirportIdentRef.current = null;
        selectedAirportIdentRef.current = null;
        setSelectedAirport(null);
        zoneInfoPinnedRef.current = false;
        setZoneInfo(null);
        setAirportSearchOpen(false);
        setAirportSearchQuery("");
        setAirportSearchError(null);

        function recomputeZoomRange() {
            const container = containerRef.current;
            if (!container) return;
            const width = container.clientWidth;
            const height = container.clientHeight;
            if (width === 0 || height === 0) return;
            const minZoom = computeBoundsZoom(GLOBAL_PAN_BOUNDS, width, height, "cover");
            zoomRangeRef.current = { min: minZoom, max: RADAR_BASEMAP_MAX_ZOOM };
            const clampedZoomView = {
                ...viewRef.current,
                zoom: Math.max(viewRef.current.zoom, minZoom),
            };
            viewRef.current = clampViewToMaxBounds(clampedZoomView, PAN_CLAMP_BOUNDS, width, height);
            scheduleDraw();
        }

        const container = containerRef.current;
        const width = container.clientWidth;
        const height = container.clientHeight;
        // Airspace/airport ArcGIS queries error out (reported as a CORS failure) past roughly
        // this size, so their initial fetch — and every later viewport-driven refetch as the
        // user pans — stays capped at this radius. Radar/satellite are tile pyramids now, with
        // no equivalent request-size limit, so they aren't bounded by this at all.
        const maxZoomOutBounds = boundsForDiameterMeters(center, RADAR_MAX_RADIUS_NM * NM_TO_METERS * 2);
        const minZoom =
            width > 0 && height > 0 ? computeBoundsZoom(GLOBAL_PAN_BOUNDS, width, height, "cover") : 2;
        const defaultMaxZoom =
            width > 0 ? computeEffectiveMaxZoom(RADAR_BASEMAP_MAX_ZOOM, center.lat, width) : RADAR_BASEMAP_MAX_ZOOM;
        const defaultZoom = minZoom + RADAR_DEFAULT_ZOOM_PERCENT * (defaultMaxZoom - minZoom);

        maxBoundsRef.current = PAN_CLAMP_BOUNDS;
        viewRef.current = {
            lat: center.lat,
            lon: center.lon,
            zoom: Math.min(Math.max(defaultZoom, minZoom), RADAR_BASEMAP_MAX_ZOOM),
        };
        zoomRangeRef.current = { min: minZoom, max: RADAR_BASEMAP_MAX_ZOOM };
        scheduleDraw();

        const resizeObserver = new ResizeObserver(() => recomputeZoomRange());
        resizeObserver.observe(container);

        // The loading screen is only shown for the very first load of a station — steps: radar,
        // satellite, forecast overlays, hazards, local area, and one per nationwide zone (each
        // zone now includes its own slice of flight categories, tiled the same way as airports —
        // see loadNationwideAirportsAndAirspace). Background refreshes (resync intervals, the
        // periodic nationwide reload) update silently and never touch this state.
        let radarLoadStepsCompleted = 0;
        const radarLoadTotalSteps = 1 + 1 + 1 + 1 + 1 + NATIONWIDE_TILE_COLS * NATIONWIDE_TILE_ROWS;
        setRadarLoadProgress({
            ready: false,
            completed: 0,
            total: radarLoadTotalSteps,
            label: "Loading radar imagery…",
        });
        function reportRadarLoadStep(label: string) {
            radarLoadStepsCompleted += 1;
            setRadarLoadProgress({
                ready: radarLoadStepsCompleted >= radarLoadTotalSteps,
                completed: radarLoadStepsCompleted,
                total: radarLoadTotalSteps,
                label,
            });
        }

        // Every resync fetches the *current* latest N frame timestamps from aviationweather.gov
        // fresh — never a cached list — so a screen left open always advances to newly published
        // scans instead of looping the same frames forever. Frames are identified by their own
        // date/time stamp, so a stale vs. current frame can never be confused with each other;
        // any tile cache entries for stamps no longer in the current list are pruned below so the
        // cache doesn't grow unbounded over a long session.
        const loadRadarFrames = async () => {
            try {
                const response = await fetch(`/api/radar/frames?num=${RADAR_ANIMATION_FRAME_COUNT}`);
                if (!response.ok) throw new Error("Radar frame list request failed.");
                const data = await response.json();
                const frames = Array.isArray(data?.frames) ? data.frames : [];
                if (frames.length === 0) throw new Error("No radar frames available.");
                if (cancelled) return;

                radarFramesRef.current = frames;
                const liveKeys = new Set(frames.map((f: { date: string; time: string }) => `${f.date}${f.time}`));
                for (const key of radarTileCacheRef.current.keys()) {
                    if (!liveKeys.has(key.split("/")[0])) radarTileCacheRef.current.delete(key);
                }

                setRadarFrameTimes(
                    frames.map((f: { date: string; time: string }) =>
                        new Date(
                            Date.UTC(
                                Number(f.date.slice(0, 4)),
                                Number(f.date.slice(4, 6)) - 1,
                                Number(f.date.slice(6, 8)),
                                Number(f.time.slice(0, 2)),
                                Number(f.time.slice(2, 4))
                            )
                        )
                    )
                );
                setCurrentFrameIndex(frames.length - 1);
                setRadarFrameGeneration((generation) => generation + 1);
                setRadarError(null);
                scheduleDraw();
            } catch {
                if (!cancelled) {
                    setRadarError("Live radar imagery is unavailable right now.");
                }
            }
        };

        loadRadarFrames().then(() => reportRadarLoadStep("Loading radar imagery"));
        const radarResyncId = window.setInterval(loadRadarFrames, RADAR_RESYNC_INTERVAL_MS);

        // Genuinely global, so no coverage gate needed — just find the latest tile cycle. The
        // tiles themselves lazy-load in the draw loop the same way basemap tiles do; this only
        // needs to know which cycle folder to request them from, and clears the tile cache (the
        // old cycle's tiles are stale — same file names, different pixels) whenever it changes.
        const loadSatelliteCycle = async (): Promise<void> => {
            try {
                const response = await fetch("/api/satellite/cycle");
                if (!response.ok || cancelled) return;
                const cycle = await response.json();
                if (!cycle?.date || !cycle?.time) return;
                const current = satelliteCycleRef.current;
                if (current?.date !== cycle.date || current?.time !== cycle.time) {
                    satelliteTileCacheRef.current.clear();
                    satelliteCycleRef.current = { date: cycle.date, time: cycle.time };
                    scheduleDraw();
                }
            } catch {
                // Supplementary — a failed refresh just leaves the previous cycle's tiles in place.
            }
        };

        loadSatelliteCycle().then(() => reportRadarLoadStep("Loading satellite imagery"));
        const satelliteResyncId = window.setInterval(loadSatelliteCycle, SATELLITE_RESYNC_INTERVAL_MS);

        // Thunderstorms/Weather Type/Turbulence/Icing — all four are the same GFA_MOSAIC_BOUNDS
        // image, just a different product suffix, and all publish on the same model cycle. One
        // cycle lookup, then one image fetch per product, all sharing the same resync interval.
        const loadGfaOverlays = async (): Promise<void> => {
            try {
                const cycleResponse = await fetch("/api/gfa/cycle");
                if (!cycleResponse.ok) return;
                const cycle = await cycleResponse.json();
                if (cancelled || !cycle?.date || !cycle?.hour) return;

                await Promise.all(
                    GFA_OVERLAYS.map(
                        (overlay) =>
                            new Promise<void>((resolve) => {
                                const img = new window.Image();
                                img.onload = () => {
                                    if (!cancelled) {
                                        gfaImagesRef.current[overlay.id] = img;
                                        scheduleDraw();
                                    }
                                    resolve();
                                };
                                img.onerror = () => resolve();
                                img.src = buildGfaProductUrl(overlay.fileProduct, cycle);
                            })
                    )
                );
            } catch {
                // Supplementary — a failed load just leaves these overlays unavailable to toggle.
            }
        };

        loadGfaOverlays().then(() => reportRadarLoadStep("Loading forecast overlays"));
        const gfaResyncId = window.setInterval(loadGfaOverlays, GFA_RESYNC_INTERVAL_MS);

        // TFRs, G-AIRMETs, SIGMETs, and PIREPs, refetched on their own interval — see
        // HAZARDS_REFRESH_INTERVAL_MS above for why this exists as a separate, repeating fetch
        // rather than the one-shot it used to be.
        const loadHazards = async () => {
            try {
                const [tfrs, gairmetZones, isigmetZones, airsigmetZones, pireps] = await Promise.all([
                    fetchTfrPolygons(AMERICAS_BOUNDS).catch(() => [] as TfrPolygon[]),
                    fetchGairmetZones(AMERICAS_BOUNDS).catch(() => [] as GairmetZone[]),
                    fetchIsigmetZones(AMERICAS_BOUNDS).catch(() => [] as GairmetZone[]),
                    fetchAirsigmetZones(AMERICAS_BOUNDS).catch(() => [] as GairmetZone[]),
                    fetchPirepReports(AMERICAS_BOUNDS).catch(() => [] as PirepReport[]),
                ]);
                if (cancelled) return;
                tfrPolygonsRef.current = tfrs;
                gairmetZonesRef.current = gairmetZones;
                sigmetZonesRef.current = [...isigmetZones, ...airsigmetZones];
                pirepsRef.current = pireps;
                scheduleDraw();
            } catch {
                // Supplementary — a failed refresh just leaves the previous data in place.
            }
        };

        loadHazards().then(() => reportRadarLoadStep("Loading hazards"));
        const hazardsResyncId = window.setInterval(loadHazards, HAZARDS_REFRESH_INTERVAL_MS);

        (async () => {
            try {
                const [polygons, localAirports, majorAirports] = await Promise.all([
                    // Kept at the local radius, not AMERICAS_BOUNDS — a nationwide query
                    // for these polygon shapes (far more vertices than a point layer)
                    // errors out on the ArcGIS side, which the browser reports as a CORS
                    // failure. Class B/C/D airspace is also most relevant near the
                    // station anyway, so this isn't a real loss of "all the data".
                    fetchAirspacePolygons(maxZoomOutBounds).catch(() => [] as AirspacePolygon[]),
                    fetchAirports(maxZoomOutBounds).catch(() => [] as AirportPoint[]),
                    // Nationwide, but filtered to airports with a published instrument
                    // approach — keeps the result well under the ArcGIS service's 1000-
                    // record cap and is what makes "major airports everywhere" possible
                    // without flooding the map (or the shared API quota) with every
                    // grass strip in the country. Failure here just means minor-only
                    // coverage outside the local radius, not a broken map.
                    fetchAirports(AMERICAS_BOUNDS, true).catch(() => [] as AirportPoint[]),
                ]);
                if (cancelled) return;
                // Merged onto whatever nationwide airspace is already loaded (from a previous
                // station's session — see the top-of-effect comment on why that's no longer
                // cleared on a station switch) rather than replacing it outright, so switching to
                // a new station never makes airspace polygons elsewhere in the country vanish.
                if (polygons.length > 0) {
                    const polygonKey = (polygon: AirspacePolygon) =>
                        `${polygon.airspaceClass}|${polygon.name}|${polygon.rings[0]?.[0]?.lat}|${polygon.rings[0]?.[0]?.lon}`;
                    const existingKeys = new Set(airspacePolygonsRef.current.map(polygonKey));
                    const merged = airspacePolygonsRef.current.slice();
                    for (const polygon of polygons) {
                        const key = polygonKey(polygon);
                        if (!existingKeys.has(key)) {
                            existingKeys.add(key);
                            merged.push(polygon);
                        }
                    }
                    airspacePolygonsRef.current = merged;
                }

                const mainStationEntry = localAirports.find(
                    (airport) => resolveMetarStationKey(airport) === stationInfo?.station
                );
                if (mainStationEntry) {
                    const correctedPosition = { lat: mainStationEntry.lat, lon: mainStationEntry.lon };
                    stationMarkerPositionRef.current = correctedPosition;
                    setStationMarkerPosition(correctedPosition);
                }

                // Local (full detail, within the station's data radius) and nationwide
                // majors overlap near the station — merge by ident, preferring the local
                // copy since it's the fresher/more complete of the two.
                const merged = new Map<string, AirportPoint>();
                for (const airport of majorAirports) merged.set(airport.ident, airport);
                for (const airport of localAirports) merged.set(airport.ident, airport);

                const uncategorized = Array.from(merged.values()).filter(
                    (airport) => resolveMetarStationKey(airport) !== stationInfo?.station
                );
                if (cancelled) return;
                const categorizedLocal = await attachFlightCategories(uncategorized);
                if (cancelled) return;
                // Merged onto whatever's already loaded (see the top-of-effect comment) instead of
                // replacing it, so switching stations only adds this area's detail rather than
                // discarding every other airport in the country until the nationwide tiled loader
                // catches back up.
                const finalAirports = new Map<string, AirportPoint>();
                for (const airport of airportsRef.current) finalAirports.set(airport.ident, airport);
                for (const airport of categorizedLocal) finalAirports.set(airport.ident, airport);
                airportsRef.current = Array.from(finalAirports.values());
                // The station's own local fetch already covers this radius — seed coverage with
                // it so the reactive fetcher doesn't immediately redo the same request on the
                // first frame.
                localDetailCoverageBoundsRef.current = maxZoomOutBounds;
                scheduleDraw();
            } catch {
                // Airspace/airport data is supplementary — fail silently and keep the radar working.
            } finally {
                reportRadarLoadStep("Loading local area");
            }
        })();

        // Runs alongside (not after) the fetch above — full nationwide airport + airspace detail,
        // tiled to stay under the ArcGIS per-request cap, so the rest of the country is populated
        // within a few seconds of load rather than only filling in reactively as panned to. Repeats
        // periodically to keep flight-category colors current.
        const nationwideController = new AbortController();
        nationwideAbortRef.current = nationwideController;

        const loadNationwideDetail = async (isInitial: boolean) => {
            try {
                const { airports: tiledAirports, polygons: tiledPolygons } = await loadNationwideAirportsAndAirspace(
                    nationwideController.signal,
                    isInitial
                        ? (zoneIndex, zoneCount) =>
                              reportRadarLoadStep(`Loading zone ${zoneIndex + 1} of ${zoneCount}`)
                        : undefined
                );
                if (cancelled || nationwideController.signal.aborted) return;

                // tiledAirports already carries its own resolved flightCategory (or none) — just
                // merge it in, keeping whichever entry is newer for a given identifier.
                const mergedAirports = new Map<string, AirportPoint>();
                for (const airport of airportsRef.current) mergedAirports.set(airport.ident, airport);
                for (const airport of tiledAirports) {
                    if (resolveMetarStationKey(airport) === stationInfo?.station) continue;
                    mergedAirports.set(airport.ident, airport);
                }
                airportsRef.current = Array.from(mergedAirports.values());

                const polygonKey = (polygon: AirspacePolygon) =>
                    `${polygon.airspaceClass}|${polygon.name}|${polygon.rings[0]?.[0]?.lat}|${polygon.rings[0]?.[0]?.lon}`;
                const existingPolygonKeys = new Set(airspacePolygonsRef.current.map(polygonKey));
                const mergedPolygons = airspacePolygonsRef.current.slice();
                for (const polygon of tiledPolygons) {
                    const key = polygonKey(polygon);
                    if (!existingPolygonKeys.has(key)) {
                        existingPolygonKeys.add(key);
                        mergedPolygons.push(polygon);
                    }
                }
                airspacePolygonsRef.current = mergedPolygons;

                // The whole country is loaded now — the viewport-reactive fetcher (kept around as
                // a fallback for anything a tile happened to truncate) has nothing left to add
                // anywhere inside this box.
                localDetailCoverageBoundsRef.current = AMERICAS_BOUNDS;
                scheduleDraw();
            } catch {
                // Supplementary — a failed refresh just leaves the previous data in place. On the
                // initial load, force the gate open anyway rather than leaving the loading screen
                // stuck if some step's progress ticks never fired.
                if (isInitial) setRadarLoadProgress((prev) => ({ ...prev, ready: true }));
            }
        };

        loadNationwideDetail(true);
        const nationwideRefreshId = window.setInterval(
            () => loadNationwideDetail(false),
            NATIONWIDE_REFRESH_INTERVAL_MS
        );

        return () => {
            cancelled = true;
            resizeObserver.disconnect();
            window.clearInterval(radarResyncId);
            window.clearInterval(satelliteResyncId);
            window.clearInterval(gfaResyncId);
            window.clearInterval(hazardsResyncId);
            window.clearInterval(nationwideRefreshId);
            nationwideAbortRef.current?.abort();
            nationwideAbortRef.current = null;
            radarTileCacheRef.current.clear();
            radarFramesRef.current = [];
            satelliteTileCacheRef.current.clear();
            satelliteCycleRef.current = null;
            gfaImagesRef.current = {};
            tileCache.clear();
            boundaryTileCache.clear();
            localDetailCoverageBoundsRef.current = null;
            if (localDetailDebounceRef.current !== null) {
                window.clearTimeout(localDetailDebounceRef.current);
                localDetailDebounceRef.current = null;
            }
            localDetailAbortRef.current?.abort();
            localDetailAbortRef.current = null;
        };
    }, [latitude, longitude, scheduleDraw, stationInfo?.station]);

    useEffect(() => {
        scheduleDraw();
        // currentFrameIndex is included so the redraw is scheduled from *this* effect —
        // which runs after the drawFrameRef reassignment effect above — rather than from
        // inside the animation timer's setTimeout, where requestAnimationFrame could fire
        // before React re-renders and the canvas would paint one frame behind the dot.
    }, [
        radarVisible,
        satelliteVisible,
        airspaceVisible,
        tfrVisible,
        gairmetVisible,
        sigmetVisible,
        pirepVisible,
        boundaryVisible,
        currentFrameIndex,
        scheduleDraw,
    ]);

    useEffect(() => {
        if (radarFrameTimes.length < 2) return;
        let cancelled = false;
        let timeoutId: number;

        const tick = (index: number) => {
            const isLastFrame = index === radarFrameTimes.length - 1;
            const delay = isLastFrame ? RADAR_ANIMATION_LAST_FRAME_HOLD_MS : RADAR_ANIMATION_FRAME_MS;
            timeoutId = window.setTimeout(() => {
                if (cancelled) return;
                const next = (index + 1) % radarFrameTimes.length;
                setCurrentFrameIndex(next);
                tick(next);
            }, delay);
        };

        tick(radarFrameTimes.length - 1);
        return () => {
            cancelled = true;
            window.clearTimeout(timeoutId);
        };
        // Keyed on radarFrameGeneration (not currentFrameIndex) so every resync — even
        // when the frame count is unchanged — restarts the loop cleanly from the newest frame.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [radarFrameGeneration, scheduleDraw]);

    useEffect(() => {
        if (!isRadarFullscreen) return;

        const frame = window.requestAnimationFrame(() => {
            void radarBubbleRef.current?.requestFullscreen?.().catch(() => {
                // Browser fullscreen can fail if blocked, but the expanded layout still applies.
            });
        });

        function handleFullscreenChange() {
            if (!document.fullscreenElement) {
                setIsRadarFullscreen(false);
            }
        }

        document.addEventListener("fullscreenchange", handleFullscreenChange);

        return () => {
            window.cancelAnimationFrame(frame);
            document.removeEventListener("fullscreenchange", handleFullscreenChange);
        };
    }, [isRadarFullscreen]);

    async function toggleRadarFullscreen() {
        if (isRadarFullscreen) {
            if (document.fullscreenElement) {
                await document.exitFullscreen().catch(() => {});
            }
            setIsRadarFullscreen(false);
            return;
        }
        setIsRadarFullscreen(true);
    }

    if (latitude === null || longitude === null) {
        return (
            <div className="rounded-2xl border border-zinc-800 bg-black/55 p-6">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#d6b35a]">
                    Radar
                </p>
                <p className="mt-3 text-sm text-zinc-400">
                    Radar is unavailable without station coordinates.
                </p>
            </div>
        );
    }

    const latestRadarTime = radarFrameTimes[radarFrameTimes.length - 1] ?? null;

    const legendCards = (
        <>
            {gairmetVisible && (
                <div className="rounded-lg border border-zinc-700 bg-black/70 px-1.5 py-1.5 backdrop-blur-sm">
                    <p className="mb-0.5 text-center text-[8px] font-semibold uppercase tracking-wide text-zinc-400">
                        G-AIRMET
                    </p>
                    <div className="space-y-0.5">
                        {GAIRMET_LEGEND_ENTRIES.map(([key, label]) => (
                            <div key={key} className="flex items-center gap-1">
                                <span
                                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                                    style={{ background: GAIRMET_HAZARD_STYLES[key].stroke }}
                                />
                                <span className="whitespace-nowrap text-[9px] text-zinc-300">
                                    {label}
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            )}
            {sigmetVisible && (
                <div className="rounded-lg border border-zinc-700 bg-black/70 px-1.5 py-1.5 backdrop-blur-sm">
                    <p className="mb-0.5 text-center text-[8px] font-semibold uppercase tracking-wide text-zinc-400">
                        SIGMET
                    </p>
                    <div className="space-y-0.5">
                        {SIGMET_LEGEND_ENTRIES.map(([key, label]) => (
                            <div key={key} className="flex items-center gap-1">
                                <span
                                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                                    style={{ background: GAIRMET_HAZARD_STYLES[key].stroke }}
                                />
                                <span className="whitespace-nowrap text-[9px] text-zinc-300">
                                    {label}
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            )}
            {pirepVisible && (
                <div className="rounded-lg border border-zinc-700 bg-black/70 px-1.5 py-1.5 backdrop-blur-sm">
                    <p className="mb-0.5 text-center text-[8px] font-semibold uppercase tracking-wide text-zinc-400">
                        PIREPs
                    </p>
                    <div className="space-y-0.5">
                        {PIREP_LEGEND_ENTRIES.map(([key, label]) => (
                            <div key={key} className="flex items-center gap-1">
                                <span
                                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                                    style={{ background: PIREP_SEVERITY_COLORS[key] }}
                                />
                                <span className="whitespace-nowrap text-[9px] text-zinc-300">
                                    {label}
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            )}
            {radarVisible && (
                <div className="rounded-lg border border-zinc-700 bg-black/70 px-1.5 py-1.5 backdrop-blur-sm">
                    <p className="text-center text-[8px] font-semibold uppercase tracking-wide text-zinc-400">
                        Precip
                    </p>
                    <p className="text-center text-[8px] font-semibold uppercase tracking-wide text-zinc-400">
                        Heavy
                    </p>
                    <div
                        className="mx-auto mt-1 h-20 w-2 rounded-full"
                        style={{ background: RADAR_LEGEND_GRADIENT }}
                    />
                    <p className="mt-1 text-center text-[8px] font-semibold uppercase tracking-wide text-zinc-400">
                        Light
                    </p>
                </div>
            )}
            {satelliteVisible && (
                <div className="rounded-lg border border-zinc-700 bg-black/70 px-1.5 py-1.5 backdrop-blur-sm">
                    <p className="text-center text-[8px] font-semibold uppercase tracking-wide text-zinc-400">
                        Satellite
                    </p>
                    <p className="text-center text-[8px] font-semibold uppercase tracking-wide text-zinc-400">
                        Cold
                    </p>
                    <div
                        className="mx-auto mt-1 h-20 w-2 rounded-full"
                        style={{ background: SATELLITE_LEGEND_GRADIENT }}
                    />
                    <p className="mt-1 text-center text-[8px] font-semibold uppercase tracking-wide text-zinc-400">
                        Warm
                    </p>
                </div>
            )}
            {activeGfaOverlay === "thunderstorms" && (
                <div className="rounded-lg border border-zinc-700 bg-black/70 px-1.5 py-1.5 backdrop-blur-sm">
                    <p className="text-center text-[8px] font-semibold uppercase tracking-wide text-zinc-400">
                        T-Storm
                    </p>
                    <p className="text-center text-[8px] font-semibold uppercase tracking-wide text-zinc-400">
                        Numerous
                    </p>
                    <div
                        className="mx-auto mt-1 h-20 w-2 rounded-full"
                        style={{ background: GFA_THUNDERSTORM_LEGEND_GRADIENT }}
                    />
                    <p className="mt-1 text-center text-[8px] font-semibold uppercase tracking-wide text-zinc-400">
                        Isolated
                    </p>
                </div>
            )}
            {activeGfaOverlay === "weatherType" && (
                <div className="rounded-lg border border-zinc-700 bg-black/70 px-1.5 py-1.5 backdrop-blur-sm">
                    <p className="mb-0.5 text-center text-[8px] font-semibold uppercase tracking-wide text-zinc-400">
                        Weather
                    </p>
                    <div className="space-y-0.5">
                        {GFA_WEATHER_TYPE_SWATCHES.map(({ label, color }) => (
                            <div key={label} className="flex items-center gap-1">
                                <span
                                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                                    style={{ background: color }}
                                />
                                <span className="whitespace-nowrap text-[9px] text-zinc-300">{label}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}
            {activeGfaOverlay === "turbulence" && (
                <div className="rounded-lg border border-zinc-700 bg-black/70 px-1.5 py-1.5 backdrop-blur-sm">
                    <p className="text-center text-[8px] font-semibold uppercase tracking-wide text-zinc-400">
                        Turb
                    </p>
                    <p className="text-center text-[8px] font-semibold uppercase tracking-wide text-zinc-400">
                        Extreme
                    </p>
                    <div
                        className="mx-auto mt-1 h-20 w-2 rounded-full"
                        style={{ background: GFA_TURBULENCE_LEGEND_GRADIENT }}
                    />
                    <p className="mt-1 text-center text-[8px] font-semibold uppercase tracking-wide text-zinc-400">
                        Light
                    </p>
                </div>
            )}
            {activeGfaOverlay === "icing" && (
                <div className="rounded-lg border border-zinc-700 bg-black/70 px-1.5 py-1.5 backdrop-blur-sm">
                    <p className="text-center text-[8px] font-semibold uppercase tracking-wide text-zinc-400">
                        Icing
                    </p>
                    <p className="text-center text-[8px] font-semibold uppercase tracking-wide text-zinc-400">
                        SLD
                    </p>
                    <div
                        className="mx-auto mt-1 h-20 w-2 rounded-full"
                        style={{ background: GFA_ICING_LEGEND_GRADIENT }}
                    />
                    <p className="mt-1 text-center text-[8px] font-semibold uppercase tracking-wide text-zinc-400">
                        Trace
                    </p>
                </div>
            )}
        </>
    );

    return (
        <div
            ref={radarBubbleRef}
            className={
                isRadarFullscreen
                    ? "fixed inset-0 z-50 flex h-screen w-screen flex-col overflow-y-auto bg-[#050505] p-4 text-zinc-100 sm:p-6"
                    : "rounded-2xl border border-zinc-800 bg-black/55 p-6"
            }
        >
            <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#d6b35a]">
                        Radar
                        <span className="ml-1.5 text-[9px] font-semibold tracking-normal text-zinc-500">
                            BETA
                        </span>
                    </p>
                    {isRadarFullscreen && stationInfo && (
                        <p className="mt-1 truncate text-xl font-bold text-white sm:text-2xl">
                            {stationInfo.displayName}
                        </p>
                    )}
                </div>
                {radarVisible && (
                    <div className="flex flex-col items-end gap-1.5">
                        <p className="whitespace-nowrap text-[11px] text-zinc-500">
                            {radarError
                                ? radarError
                                : latestRadarTime
                                    ? `Radar: ${formatFinePrintTime(latestRadarTime)}`
                                    : "Loading radar…"}
                        </p>
                        {radarFrameTimes.length > 1 && (
                            <div className={`flex items-center ${isRadarFullscreen ? "gap-2" : "gap-1.5"}`}>
                                {radarFrameTimes.map((_, index) => (
                                    <span
                                        key={index}
                                        className={`rounded-full transition ${
                                            isRadarFullscreen ? "h-2.5 w-2.5" : "h-2 w-2"
                                        } ${index === currentFrameIndex ? "bg-[#e6c76f]" : "bg-zinc-700"}`}
                                    />
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </div>

            <div
                ref={containerRef}
                className={
                    isRadarFullscreen
                        ? "relative mt-5 min-h-0 w-full flex-1 overflow-hidden rounded-2xl border border-zinc-700"
                        : "relative mt-5 h-[600px] w-full overflow-hidden rounded-2xl border border-zinc-700 sm:h-[720px]"
                }
            >
                <canvas
                    ref={canvasRef}
                    className="absolute inset-0 h-full w-full cursor-grab"
                    style={{ touchAction: "none" }}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    onPointerCancel={handlePointerUp}
                    onPointerLeave={handlePointerLeave}
                />

                {/* Covers the canvas/controls (which mount and start loading underneath
                    immediately) until every first-load fetch reports done, so the bubble only
                    ever appears once it's fully populated instead of drawing in piecemeal. */}
                {!radarLoadProgress.ready && (
                    <div className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-4 bg-[#0a0a0a] px-8 text-center">
                        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#d6b35a]">
                            Radar
                        </p>
                        <div className="w-full max-w-xs">
                            <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                                <div
                                    className="h-full rounded-full bg-[#e6c76f] transition-[width] duration-300 ease-out"
                                    style={{
                                        width: `${Math.min(
                                            100,
                                            (radarLoadProgress.completed / radarLoadProgress.total) * 100
                                        )}%`,
                                    }}
                                />
                            </div>
                        </div>
                        <p className="text-sm font-medium text-zinc-300">{radarLoadProgress.label}</p>
                        <p className="text-[11px] tabular-nums text-zinc-600">
                            {radarLoadProgress.completed} / {radarLoadProgress.total}
                        </p>
                    </div>
                )}

                {selectedAirport ? (() => {
                    const origin = stationMarkerPosition ?? { lat: latitude, lon: longitude };
                    const { bearingDeg, distanceNm } = computeBearingDistance(
                        origin,
                        { lat: selectedAirport.lat, lon: selectedAirport.lon }
                    );
                    const magneticBearingDeg = trueToMagneticBearing(bearingDeg, origin);
                    const category = selectedAirport.flightCategory ?? "UNKNOWN";
                    const categoryLabel = category === "UNKNOWN" ? "N/A" : category;
                    return (
                        <div className="absolute left-2 top-2 z-10 w-[168px] rounded-xl border border-[#d6b35a]/60 bg-black/80 p-2.5 backdrop-blur-sm">
                            <div className="flex items-start justify-between gap-2">
                                <div>
                                    <p className="text-sm font-black text-[#e6c76f]">
                                        {selectedAirport.ident}
                                    </p>
                                    <p className="text-[10px] leading-tight text-zinc-400">
                                        {selectedAirport.name}
                                    </p>
                                </div>
                                <div className="flex items-center gap-1.5">
                                    <span
                                        className="rounded px-1.5 py-0.5 text-[10px] font-bold"
                                        style={{
                                            color: FLIGHT_CATEGORY_MARKER_COLORS[category],
                                            backgroundColor: `${FLIGHT_CATEGORY_MARKER_COLORS[category]}22`,
                                        }}
                                    >
                                        {categoryLabel}
                                    </span>
                                    <button
                                        type="button"
                                        aria-label="Deselect airport"
                                        onClick={() => {
                                            selectedAirportIdentRef.current = null;
                                            setSelectedAirport(null);
                                            scheduleDraw();
                                        }}
                                        className="text-zinc-500 transition hover:text-zinc-200"
                                    >
                                        ×
                                    </button>
                                </div>
                            </div>

                            <div className="mt-2 grid grid-cols-2 gap-2 text-center">
                                <div>
                                    <p className="text-[9px] font-semibold uppercase tracking-wide text-zinc-500">
                                        Heading
                                    </p>
                                    <p className="text-sm font-bold text-zinc-100">
                                        {String(Math.round(magneticBearingDeg) % 360).padStart(3, "0")}°M
                                    </p>
                                </div>
                                <div>
                                    <p className="text-[9px] font-semibold uppercase tracking-wide text-zinc-500">
                                        Distance
                                    </p>
                                    <p className="text-sm font-bold text-zinc-100">
                                        {distanceNm.toFixed(1)} nm
                                    </p>
                                </div>
                            </div>
                        </div>
                    );
                })() : (
                    <div ref={airportSearchContainerRef} className="absolute left-2 top-2 z-10">
                        {!airportSearchOpen ? (
                            <button
                                type="button"
                                title="Find airport"
                                aria-label="Search for an airport to connect a flight path to"
                                onClick={() => setAirportSearchOpen(true)}
                                className="flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-700 bg-black/70 text-zinc-300 backdrop-blur-sm transition hover:border-[#d6b35a]/60 hover:text-[#e6c76f]"
                            >
                                <svg
                                    viewBox="0 0 24 24"
                                    className="h-5 w-5"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                >
                                    <circle cx="11" cy="11" r="7" />
                                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                                </svg>
                            </button>
                        ) : (
                            <div className="w-[180px] rounded-xl border border-zinc-700 bg-black/80 p-2.5 backdrop-blur-sm">
                                <div className="flex items-center gap-1.5">
                                    <input
                                        type="text"
                                        autoFocus
                                        value={airportSearchQuery}
                                        onChange={(event) => {
                                            setAirportSearchQuery(event.target.value.toUpperCase());
                                            setAirportSearchError(null);
                                        }}
                                        onKeyDown={(event) => {
                                            if (event.key === "Enter") handleAirportSearchSubmit();
                                        }}
                                        placeholder="ICAO code"
                                        className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs font-semibold uppercase text-zinc-100 outline-none focus:border-[#d6b35a]/60"
                                    />
                                    <button
                                        type="button"
                                        aria-label="Search"
                                        onClick={handleAirportSearchSubmit}
                                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[#d6b35a]/50 text-[#e6c76f] transition hover:bg-zinc-900"
                                    >
                                        <svg
                                            viewBox="0 0 24 24"
                                            className="h-4 w-4"
                                            fill="none"
                                            stroke="currentColor"
                                            strokeWidth="2"
                                            strokeLinecap="round"
                                        >
                                            <circle cx="11" cy="11" r="7" />
                                            <line x1="21" y1="21" x2="16.65" y2="16.65" />
                                        </svg>
                                    </button>
                                </div>
                                {airportSearchError && (
                                    <p className="mt-1.5 text-[11px] font-semibold text-red-400">
                                        {airportSearchError}
                                    </p>
                                )}
                            </div>
                        )}
                    </div>
                )}

                <button
                    type="button"
                    title={isRadarFullscreen ? "Exit fullscreen" : "Fullscreen"}
                    aria-label={isRadarFullscreen ? "Exit fullscreen radar view" : "View radar in fullscreen"}
                    onClick={() => void toggleRadarFullscreen()}
                    className="group absolute right-2 top-2 z-10 hidden h-9 w-9 items-center justify-center rounded-xl border border-zinc-700 bg-black/70 text-zinc-400 backdrop-blur-sm transition hover:border-zinc-500 hover:text-zinc-200 sm:flex"
                >
                    <svg
                        viewBox="0 0 24 24"
                        className="h-5 w-5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    >
                        {isRadarFullscreen ? (
                            <>
                                <path d="M4 14h6v6" />
                                <path d="M20 10h-6V4" />
                                <path d="M14 10l7-7" />
                                <path d="M3 21l7-7" />
                            </>
                        ) : (
                            <>
                                <path d="M15 3h6v6" />
                                <path d="M9 21H3v-6" />
                                <path d="M21 3l-7 7" />
                                <path d="M3 21l7-7" />
                            </>
                        )}
                    </svg>
                    <span className="pointer-events-none absolute right-full top-1/2 mr-2 -translate-y-1/2 whitespace-nowrap rounded bg-black/90 px-2 py-1 text-[10px] font-semibold text-zinc-200 opacity-0 shadow-lg transition group-hover:opacity-100">
                        {isRadarFullscreen ? "Exit fullscreen" : "Fullscreen"}
                    </span>
                </button>

                <div className="absolute right-2 top-14 z-10 hidden flex-col gap-1.5 rounded-xl border border-zinc-700 bg-black/70 p-1.5 backdrop-blur-sm sm:flex">
                    <div className="flex flex-col gap-1.5">
                        <button
                            type="button"
                            title="Airspace"
                            aria-label="Toggle airspace and airport overlay"
                            aria-pressed={airspaceVisible}
                            onClick={() => setAirspaceVisible((current) => !current)}
                            className={`group relative flex h-9 w-9 items-center justify-center rounded-lg border transition ${
                                airspaceVisible
                                    ? "border-[#d6b35a] bg-[#d6b35a]/20 text-[#e6c76f]"
                                    : "border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-300"
                            }`}
                        >
                            <svg
                                viewBox="0 0 24 24"
                                className="h-5 w-5"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.8"
                            >
                                <path d="M12 3l7 4v10l-7 4-7-4V7z" />
                                <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" />
                            </svg>
                            <span className="pointer-events-none absolute right-full top-1/2 mr-2 -translate-y-1/2 whitespace-nowrap rounded bg-black/90 px-2 py-1 text-[10px] font-semibold text-zinc-200 opacity-0 shadow-lg transition group-hover:opacity-100">
                                Airspace
                            </span>
                        </button>

                        <button
                            type="button"
                            title="Borders"
                            aria-label="Toggle state and county border overlay"
                            aria-pressed={boundaryVisible}
                            onClick={() => setBoundaryVisible((current) => !current)}
                            className={`group relative flex h-9 w-9 items-center justify-center rounded-lg border transition ${
                                boundaryVisible
                                    ? "border-[#d6b35a] bg-[#d6b35a]/20 text-[#e6c76f]"
                                    : "border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-300"
                            }`}
                        >
                            <svg
                                viewBox="0 0 24 24"
                                className="h-5 w-5"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.8"
                            >
                                <rect x="4" y="4" width="16" height="16" rx="1" strokeDasharray="3 2.5" />
                            </svg>
                            <span className="pointer-events-none absolute right-full top-1/2 mr-2 -translate-y-1/2 whitespace-nowrap rounded bg-black/90 px-2 py-1 text-[10px] font-semibold text-zinc-200 opacity-0 shadow-lg transition group-hover:opacity-100">
                                Borders
                            </span>
                        </button>
                    </div>

                    <div className="h-px w-full bg-zinc-700" />

                    <div className="flex flex-col gap-1.5">
                        <button
                            type="button"
                            title="TFRs"
                            aria-label="Toggle temporary flight restriction overlay"
                            aria-pressed={tfrVisible}
                            onClick={() => setTfrVisible((current) => !current)}
                            className={`group relative flex h-9 w-9 items-center justify-center rounded-lg border transition ${
                                tfrVisible
                                    ? "border-red-400 bg-red-400/20 text-red-300"
                                    : "border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-300"
                            }`}
                        >
                            <svg
                                viewBox="0 0 24 24"
                                className="h-5 w-5"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.8"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            >
                                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                                <line x1="12" y1="9" x2="12" y2="13" />
                                <line x1="12" y1="17" x2="12.01" y2="17" />
                            </svg>
                            <span className="pointer-events-none absolute right-full top-1/2 mr-2 -translate-y-1/2 whitespace-nowrap rounded bg-black/90 px-2 py-1 text-[10px] font-semibold text-zinc-200 opacity-0 shadow-lg transition group-hover:opacity-100">
                                TFRs
                            </span>
                        </button>

                        <button
                            type="button"
                            title="G-AIRMET"
                            aria-label="Toggle G-AIRMET hazard overlay"
                            aria-pressed={gairmetVisible}
                            onClick={() => setGairmetVisible((current) => !current)}
                            className={`group relative flex h-9 w-9 items-center justify-center rounded-lg border transition ${
                                gairmetVisible
                                    ? "border-[#d6b35a] bg-[#d6b35a]/20 text-[#e6c76f]"
                                    : "border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-300"
                            }`}
                        >
                            <svg
                                viewBox="0 0 24 24"
                                className="h-5 w-5"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.8"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            >
                                <path d="M12 3.7 L21.3 20.3 L2.7 20.3 Z" />
                                <line x1="12" y1="9.3" x2="12" y2="14.3" />
                                <circle cx="12" cy="17.4" r="0.6" fill="currentColor" stroke="none" />
                            </svg>
                            <span className="pointer-events-none absolute right-full top-1/2 mr-2 -translate-y-1/2 whitespace-nowrap rounded bg-black/90 px-2 py-1 text-[10px] font-semibold text-zinc-200 opacity-0 shadow-lg transition group-hover:opacity-100">
                                G-AIRMET
                            </span>
                        </button>

                        <button
                            type="button"
                            title="SIGMETs"
                            aria-label="Toggle SIGMET hazard overlay"
                            aria-pressed={sigmetVisible}
                            onClick={() => setSigmetVisible((current) => !current)}
                            className={`group relative flex h-9 w-9 items-center justify-center rounded-lg border transition ${
                                sigmetVisible
                                    ? "border-[#d6b35a] bg-[#d6b35a]/20 text-[#e6c76f]"
                                    : "border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-300"
                            }`}
                        >
                            <svg
                                viewBox="0 0 24 24"
                                className="h-5 w-5"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.8"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            >
                                <path d="M12 3.7 L21.3 20.3 L2.7 20.3 Z" />
                                <path
                                    d="M13.1 8.6l-3.4 5.3h2.6l-1.3 4.3 4.5-5.9h-2.7z"
                                    fill="currentColor"
                                    stroke="none"
                                />
                            </svg>
                            <span className="pointer-events-none absolute right-full top-1/2 mr-2 -translate-y-1/2 whitespace-nowrap rounded bg-black/90 px-2 py-1 text-[10px] font-semibold text-zinc-200 opacity-0 shadow-lg transition group-hover:opacity-100">
                                SIGMETs
                            </span>
                        </button>

                        <button
                            type="button"
                            title="PIREPs"
                            aria-label="Toggle pilot report overlay"
                            aria-pressed={pirepVisible}
                            onClick={() => setPirepVisible((current) => !current)}
                            className={`group relative flex h-9 w-9 items-center justify-center rounded-lg border transition ${
                                pirepVisible
                                    ? "border-[#d6b35a] bg-[#d6b35a]/20 text-[#e6c76f]"
                                    : "border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-300"
                            }`}
                        >
                            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" stroke="none">
                                <path d="M12 2 L14 9 L21 13 L21 15 L14 13 L14 18 L17 20 L17 21.5 L12 20.5 L7 21.5 L7 20 L10 18 L10 13 L3 15 L3 13 L10 9 Z" />
                            </svg>
                            <span className="pointer-events-none absolute right-full top-1/2 mr-2 -translate-y-1/2 whitespace-nowrap rounded bg-black/90 px-2 py-1 text-[10px] font-semibold text-zinc-200 opacity-0 shadow-lg transition group-hover:opacity-100">
                                PIREPs
                            </span>
                        </button>
                    </div>

                    <div className="h-px w-full bg-zinc-700" />

                    <div className="flex flex-col gap-1.5">
                        <button
                            type="button"
                            title="Precipitation"
                            aria-label="Show precipitation radar (swaps out satellite)"
                            aria-pressed={radarVisible}
                            onClick={togglePrecipitation}
                            className={`group relative flex h-9 w-9 items-center justify-center rounded-lg border transition ${
                                radarVisible
                                    ? "border-[#d6b35a] bg-[#d6b35a]/20 text-[#e6c76f]"
                                    : "border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-300"
                            }`}
                        >
                            <svg
                                viewBox="0 0 24 24"
                                className="h-5 w-5"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.8"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            >
                                <path d="M12 3.2c3 4.1 6 8.1 6 11.3a6 6 0 1 1-12 0c0-3.2 3-7.2 6-11.3z" />
                            </svg>
                            <span className="pointer-events-none absolute right-full top-1/2 mr-2 -translate-y-1/2 whitespace-nowrap rounded bg-black/90 px-2 py-1 text-[10px] font-semibold text-zinc-200 opacity-0 shadow-lg transition group-hover:opacity-100">
                                Precipitation
                            </span>
                        </button>

                        <button
                            type="button"
                            title="Satellite"
                            aria-label="Show satellite imagery (swaps out precipitation)"
                            aria-pressed={satelliteVisible}
                            onClick={toggleSatellite}
                            className={`group relative flex h-9 w-9 items-center justify-center rounded-lg border transition ${
                                satelliteVisible
                                    ? "border-[#d6b35a] bg-[#d6b35a]/20 text-[#e6c76f]"
                                    : "border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-300"
                            }`}
                        >
                            <svg
                                viewBox="0 0 24 24"
                                className="h-5 w-5"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.8"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            >
                                <g transform="rotate(45 12 12)">
                                    <rect x="2" y="10" width="4" height="4" rx="0.7" />
                                    <line x1="6" y1="12" x2="9" y2="12" />
                                    <rect x="9" y="9.5" width="6" height="5" rx="1" />
                                    <line x1="15" y1="12" x2="18" y2="12" />
                                    <rect x="18" y="10" width="4" height="4" rx="0.7" />
                                    <line x1="15" y1="9.5" x2="17.5" y2="6" />
                                    <circle cx="18.2" cy="5" r="0.9" fill="currentColor" stroke="none" />
                                </g>
                            </svg>
                            <span className="pointer-events-none absolute right-full top-1/2 mr-2 -translate-y-1/2 whitespace-nowrap rounded bg-black/90 px-2 py-1 text-[10px] font-semibold text-zinc-200 opacity-0 shadow-lg transition group-hover:opacity-100">
                                Satellite
                            </span>
                        </button>

                        <button
                            type="button"
                            title="Thunderstorms"
                            aria-label="Show GFA thunderstorm forecast overlay"
                            aria-pressed={activeGfaOverlay === "thunderstorms"}
                            onClick={() => toggleGfaOverlay("thunderstorms")}
                            className={`group relative flex h-9 w-9 items-center justify-center rounded-lg border transition ${
                                activeGfaOverlay === "thunderstorms"
                                    ? "border-[#d6b35a] bg-[#d6b35a]/20 text-[#e6c76f]"
                                    : "border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-300"
                            }`}
                        >
                            <svg
                                viewBox="0 0 24 24"
                                className="h-5 w-5"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.8"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            >
                                <path d="M6.5 14.5a4 4 0 0 1 .6-7.96 5 5 0 0 1 9.5 1.9A3.6 3.6 0 0 1 16 15.5H7.2" />
                                <path
                                    d="M12.5 12.5 9.8 17h2.1l-1.4 4 3.9-5.2h-2.1l1.4-3.3z"
                                    fill="currentColor"
                                    stroke="none"
                                />
                            </svg>
                            <span className="pointer-events-none absolute right-full top-1/2 mr-2 -translate-y-1/2 whitespace-nowrap rounded bg-black/90 px-2 py-1 text-[10px] font-semibold text-zinc-200 opacity-0 shadow-lg transition group-hover:opacity-100">
                                Thunderstorms
                            </span>
                        </button>

                        <button
                            type="button"
                            title="Weather Type"
                            aria-label="Show GFA surface weather-type forecast overlay"
                            aria-pressed={activeGfaOverlay === "weatherType"}
                            onClick={() => toggleGfaOverlay("weatherType")}
                            className={`group relative flex h-9 w-9 items-center justify-center rounded-lg border transition ${
                                activeGfaOverlay === "weatherType"
                                    ? "border-[#d6b35a] bg-[#d6b35a]/20 text-[#e6c76f]"
                                    : "border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-300"
                            }`}
                        >
                            <svg
                                viewBox="0 0 24 24"
                                className="h-5 w-5"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.8"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            >
                                <path d="M7 14.5a4 4 0 0 1 .5-7.96 5 5 0 0 1 9.5 1.9A3.6 3.6 0 0 1 16.5 15.5H8" />
                                <line x1="9" y1="18" x2="8.3" y2="20.5" />
                                <line x1="13" y1="18" x2="12.3" y2="20.5" />
                                <line x1="17" y1="18" x2="16.3" y2="20.5" />
                            </svg>
                            <span className="pointer-events-none absolute right-full top-1/2 mr-2 -translate-y-1/2 whitespace-nowrap rounded bg-black/90 px-2 py-1 text-[10px] font-semibold text-zinc-200 opacity-0 shadow-lg transition group-hover:opacity-100">
                                Weather Type
                            </span>
                        </button>

                        <button
                            type="button"
                            title="Turbulence"
                            aria-label="Show GFA turbulence forecast overlay"
                            aria-pressed={activeGfaOverlay === "turbulence"}
                            onClick={() => toggleGfaOverlay("turbulence")}
                            className={`group relative flex h-9 w-9 items-center justify-center rounded-lg border transition ${
                                activeGfaOverlay === "turbulence"
                                    ? "border-[#d6b35a] bg-[#d6b35a]/20 text-[#e6c76f]"
                                    : "border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-300"
                            }`}
                        >
                            <svg
                                viewBox="0 0 24 24"
                                className="h-5 w-5"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.8"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            >
                                <path d="M2 13 6 8 9.5 16 13 8 16.5 16 20 11" />
                            </svg>
                            <span className="pointer-events-none absolute right-full top-1/2 mr-2 -translate-y-1/2 whitespace-nowrap rounded bg-black/90 px-2 py-1 text-[10px] font-semibold text-zinc-200 opacity-0 shadow-lg transition group-hover:opacity-100">
                                Turbulence
                            </span>
                        </button>

                        <button
                            type="button"
                            title="Icing"
                            aria-label="Show GFA icing forecast overlay"
                            aria-pressed={activeGfaOverlay === "icing"}
                            onClick={() => toggleGfaOverlay("icing")}
                            className={`group relative flex h-9 w-9 items-center justify-center rounded-lg border transition ${
                                activeGfaOverlay === "icing"
                                    ? "border-[#d6b35a] bg-[#d6b35a]/20 text-[#e6c76f]"
                                    : "border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-300"
                            }`}
                        >
                            <svg
                                viewBox="0 0 24 24"
                                className="h-5 w-5"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.8"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            >
                                <line x1="12" y1="3" x2="12" y2="21" />
                                <line x1="4.9" y1="7.5" x2="19.1" y2="16.5" />
                                <line x1="19.1" y1="7.5" x2="4.9" y2="16.5" />
                                <path d="M12 3 10.5 5 M12 3 13.5 5" />
                                <path d="M12 21 10.5 19 M12 21 13.5 19" />
                            </svg>
                            <span className="pointer-events-none absolute right-full top-1/2 mr-2 -translate-y-1/2 whitespace-nowrap rounded bg-black/90 px-2 py-1 text-[10px] font-semibold text-zinc-200 opacity-0 shadow-lg transition group-hover:opacity-100">
                                Icing
                            </span>
                        </button>
                    </div>
                </div>

                <div className="absolute right-2 top-2 z-20 sm:hidden">
                    {mobileControlsOpen && (
                        <div
                            className="fixed inset-0 z-10"
                            onClick={() => setMobileControlsOpen(false)}
                        />
                    )}
                    <button
                        type="button"
                        aria-label="Open map layer controls"
                        aria-expanded={mobileControlsOpen}
                        onClick={() => setMobileControlsOpen((current) => !current)}
                        className={`relative z-20 flex h-9 w-9 items-center justify-center rounded-xl border backdrop-blur-sm transition ${
                            mobileControlsOpen
                                ? "border-[#d6b35a] bg-[#d6b35a]/20 text-[#e6c76f]"
                                : "border-zinc-700 bg-black/70 text-zinc-300"
                        }`}
                    >
                        <svg
                            viewBox="0 0 24 24"
                            className="h-5 w-5"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                        >
                            <line x1="4" y1="7" x2="20" y2="7" />
                            <line x1="4" y1="12" x2="20" y2="12" />
                            <line x1="4" y1="17" x2="20" y2="17" />
                        </svg>
                    </button>

                    {mobileControlsOpen && (
                        <div className="absolute right-0 top-11 z-20 flex w-48 flex-col gap-1 rounded-xl border border-zinc-700 bg-black/90 p-2 shadow-xl backdrop-blur-sm">
                            <button
                                type="button"
                                onClick={() => void toggleRadarFullscreen()}
                                className="flex items-center gap-2 rounded-lg px-2 py-2 text-left text-xs font-semibold text-zinc-300 transition hover:bg-zinc-800"
                            >
                                <svg
                                    viewBox="0 0 24 24"
                                    className="h-4 w-4 shrink-0"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.8"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                >
                                    {isRadarFullscreen ? (
                                        <>
                                            <path d="M4 14h6v6" />
                                            <path d="M20 10h-6V4" />
                                            <path d="M14 10l7-7" />
                                            <path d="M3 21l7-7" />
                                        </>
                                    ) : (
                                        <>
                                            <path d="M15 3h6v6" />
                                            <path d="M9 21H3v-6" />
                                            <path d="M21 3l-7 7" />
                                            <path d="M3 21l7-7" />
                                        </>
                                    )}
                                </svg>
                                <span>{isRadarFullscreen ? "Exit fullscreen" : "Fullscreen"}</span>
                            </button>

                            <div className="my-1 h-px w-full bg-zinc-700" />

                            <button
                                type="button"
                                onClick={() => setAirspaceVisible((current) => !current)}
                                className={`flex items-center gap-2 rounded-lg px-2 py-2 text-left text-xs font-semibold transition ${
                                    airspaceVisible
                                        ? "bg-[#d6b35a]/20 text-[#e6c76f]"
                                        : "text-zinc-300 hover:bg-zinc-800"
                                }`}
                            >
                                <svg
                                    viewBox="0 0 24 24"
                                    className="h-4 w-4 shrink-0"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.8"
                                >
                                    <path d="M12 3l7 4v10l-7 4-7-4V7z" />
                                    <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" />
                                </svg>
                                <span>Airspace</span>
                            </button>

                            <button
                                type="button"
                                onClick={() => setBoundaryVisible((current) => !current)}
                                className={`flex items-center gap-2 rounded-lg px-2 py-2 text-left text-xs font-semibold transition ${
                                    boundaryVisible
                                        ? "bg-[#d6b35a]/20 text-[#e6c76f]"
                                        : "text-zinc-300 hover:bg-zinc-800"
                                }`}
                            >
                                <svg
                                    viewBox="0 0 24 24"
                                    className="h-4 w-4 shrink-0"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.8"
                                >
                                    <rect x="4" y="4" width="16" height="16" rx="1" strokeDasharray="3 2.5" />
                                </svg>
                                <span>Borders</span>
                            </button>

                            <div className="my-1 h-px w-full bg-zinc-700" />

                            <button
                                type="button"
                                onClick={() => setTfrVisible((current) => !current)}
                                className={`flex items-center gap-2 rounded-lg px-2 py-2 text-left text-xs font-semibold transition ${
                                    tfrVisible
                                        ? "bg-red-400/20 text-red-300"
                                        : "text-zinc-300 hover:bg-zinc-800"
                                }`}
                            >
                                <svg
                                    viewBox="0 0 24 24"
                                    className="h-4 w-4 shrink-0"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.8"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                >
                                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                                    <line x1="12" y1="9" x2="12" y2="13" />
                                    <line x1="12" y1="17" x2="12.01" y2="17" />
                                </svg>
                                <span>TFRs</span>
                            </button>

                            <button
                                type="button"
                                onClick={() => setGairmetVisible((current) => !current)}
                                className={`flex items-center gap-2 rounded-lg px-2 py-2 text-left text-xs font-semibold transition ${
                                    gairmetVisible
                                        ? "bg-[#d6b35a]/20 text-[#e6c76f]"
                                        : "text-zinc-300 hover:bg-zinc-800"
                                }`}
                            >
                                <svg
                                    viewBox="0 0 24 24"
                                    className="h-4 w-4 shrink-0"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.8"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                >
                                    <path d="M12 3.7 L21.3 20.3 L2.7 20.3 Z" />
                                    <line x1="12" y1="9.3" x2="12" y2="14.3" />
                                    <circle cx="12" cy="17.4" r="0.6" fill="currentColor" stroke="none" />
                                </svg>
                                <span>G-AIRMET</span>
                            </button>

                            <button
                                type="button"
                                onClick={() => setSigmetVisible((current) => !current)}
                                className={`flex items-center gap-2 rounded-lg px-2 py-2 text-left text-xs font-semibold transition ${
                                    sigmetVisible
                                        ? "bg-[#d6b35a]/20 text-[#e6c76f]"
                                        : "text-zinc-300 hover:bg-zinc-800"
                                }`}
                            >
                                <svg
                                    viewBox="0 0 24 24"
                                    className="h-4 w-4 shrink-0"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.8"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                >
                                    <path d="M12 3.7 L21.3 20.3 L2.7 20.3 Z" />
                                    <path
                                        d="M13.1 8.6l-3.4 5.3h2.6l-1.3 4.3 4.5-5.9h-2.7z"
                                        fill="currentColor"
                                        stroke="none"
                                    />
                                </svg>
                                <span>SIGMETs</span>
                            </button>

                            <button
                                type="button"
                                onClick={() => setPirepVisible((current) => !current)}
                                className={`flex items-center gap-2 rounded-lg px-2 py-2 text-left text-xs font-semibold transition ${
                                    pirepVisible
                                        ? "bg-[#d6b35a]/20 text-[#e6c76f]"
                                        : "text-zinc-300 hover:bg-zinc-800"
                                }`}
                            >
                                <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="currentColor" stroke="none">
                                    <path d="M12 2 L14 9 L21 13 L21 15 L14 13 L14 18 L17 20 L17 21.5 L12 20.5 L7 21.5 L7 20 L10 18 L10 13 L3 15 L3 13 L10 9 Z" />
                                </svg>
                                <span>PIREPs</span>
                            </button>

                            <div className="my-1 h-px w-full bg-zinc-700" />

                            <button
                                type="button"
                                onClick={togglePrecipitation}
                                className={`flex items-center gap-2 rounded-lg px-2 py-2 text-left text-xs font-semibold transition ${
                                    radarVisible
                                        ? "bg-[#d6b35a]/20 text-[#e6c76f]"
                                        : "text-zinc-300 hover:bg-zinc-800"
                                }`}
                            >
                                <svg
                                    viewBox="0 0 24 24"
                                    className="h-4 w-4 shrink-0"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.8"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                >
                                    <path d="M12 3.2c3 4.1 6 8.1 6 11.3a6 6 0 1 1-12 0c0-3.2 3-7.2 6-11.3z" />
                                </svg>
                                <span>Precipitation</span>
                            </button>

                            <button
                                type="button"
                                onClick={toggleSatellite}
                                className={`flex items-center gap-2 rounded-lg px-2 py-2 text-left text-xs font-semibold transition ${
                                    satelliteVisible
                                        ? "bg-[#d6b35a]/20 text-[#e6c76f]"
                                        : "text-zinc-300 hover:bg-zinc-800"
                                }`}
                            >
                                <svg
                                    viewBox="0 0 24 24"
                                    className="h-4 w-4 shrink-0"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.8"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                >
                                    <g transform="rotate(45 12 12)">
                                        <rect x="2" y="10" width="4" height="4" rx="0.7" />
                                        <line x1="6" y1="12" x2="9" y2="12" />
                                        <rect x="9" y="9.5" width="6" height="5" rx="1" />
                                        <line x1="15" y1="12" x2="18" y2="12" />
                                        <rect x="18" y="10" width="4" height="4" rx="0.7" />
                                        <line x1="15" y1="9.5" x2="17.5" y2="6" />
                                        <circle cx="18.2" cy="5" r="0.9" fill="currentColor" stroke="none" />
                                    </g>
                                </svg>
                                <span>Satellite</span>
                            </button>

                            <button
                                type="button"
                                onClick={() => toggleGfaOverlay("thunderstorms")}
                                className={`flex items-center gap-2 rounded-lg px-2 py-2 text-left text-xs font-semibold transition ${
                                    activeGfaOverlay === "thunderstorms"
                                        ? "bg-[#d6b35a]/20 text-[#e6c76f]"
                                        : "text-zinc-300 hover:bg-zinc-800"
                                }`}
                            >
                                <svg
                                    viewBox="0 0 24 24"
                                    className="h-4 w-4 shrink-0"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.8"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                >
                                    <path d="M6.5 14.5a4 4 0 0 1 .6-7.96 5 5 0 0 1 9.5 1.9A3.6 3.6 0 0 1 16 15.5H7.2" />
                                    <path
                                        d="M12.5 12.5 9.8 17h2.1l-1.4 4 3.9-5.2h-2.1l1.4-3.3z"
                                        fill="currentColor"
                                        stroke="none"
                                    />
                                </svg>
                                <span>Thunderstorms</span>
                            </button>

                            <button
                                type="button"
                                onClick={() => toggleGfaOverlay("weatherType")}
                                className={`flex items-center gap-2 rounded-lg px-2 py-2 text-left text-xs font-semibold transition ${
                                    activeGfaOverlay === "weatherType"
                                        ? "bg-[#d6b35a]/20 text-[#e6c76f]"
                                        : "text-zinc-300 hover:bg-zinc-800"
                                }`}
                            >
                                <svg
                                    viewBox="0 0 24 24"
                                    className="h-4 w-4 shrink-0"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.8"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                >
                                    <path d="M7 14.5a4 4 0 0 1 .5-7.96 5 5 0 0 1 9.5 1.9A3.6 3.6 0 0 1 16.5 15.5H8" />
                                    <line x1="9" y1="18" x2="8.3" y2="20.5" />
                                    <line x1="13" y1="18" x2="12.3" y2="20.5" />
                                    <line x1="17" y1="18" x2="16.3" y2="20.5" />
                                </svg>
                                <span>Weather Type</span>
                            </button>

                            <button
                                type="button"
                                onClick={() => toggleGfaOverlay("turbulence")}
                                className={`flex items-center gap-2 rounded-lg px-2 py-2 text-left text-xs font-semibold transition ${
                                    activeGfaOverlay === "turbulence"
                                        ? "bg-[#d6b35a]/20 text-[#e6c76f]"
                                        : "text-zinc-300 hover:bg-zinc-800"
                                }`}
                            >
                                <svg
                                    viewBox="0 0 24 24"
                                    className="h-4 w-4 shrink-0"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.8"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                >
                                    <path d="M2 13 6 8 9.5 16 13 8 16.5 16 20 11" />
                                </svg>
                                <span>Turbulence</span>
                            </button>

                            <button
                                type="button"
                                onClick={() => toggleGfaOverlay("icing")}
                                className={`flex items-center gap-2 rounded-lg px-2 py-2 text-left text-xs font-semibold transition ${
                                    activeGfaOverlay === "icing"
                                        ? "bg-[#d6b35a]/20 text-[#e6c76f]"
                                        : "text-zinc-300 hover:bg-zinc-800"
                                }`}
                            >
                                <svg
                                    viewBox="0 0 24 24"
                                    className="h-4 w-4 shrink-0"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.8"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                >
                                    <line x1="12" y1="3" x2="12" y2="21" />
                                    <line x1="4.9" y1="7.5" x2="19.1" y2="16.5" />
                                    <line x1="19.1" y1="7.5" x2="4.9" y2="16.5" />
                                </svg>
                                <span>Icing</span>
                            </button>
                        </div>
                    )}
                </div>

                <div className="absolute bottom-2 right-2 z-10 flex flex-col overflow-hidden rounded-lg border border-zinc-700 bg-black/70 shadow-lg backdrop-blur-sm">
                    <button
                        type="button"
                        aria-label="Zoom in"
                        onClick={() => handleZoomButtonClick(1)}
                        className="flex h-9 w-9 items-center justify-center text-lg font-bold text-[#e6c76f] transition hover:bg-zinc-800"
                    >
                        +
                    </button>
                    <div className="h-px w-full bg-zinc-700" />
                    <button
                        type="button"
                        title="Reset to default zoom and center on airport"
                        aria-label="Reset zoom to the default level and center on the airport"
                        onClick={handleZoomPercentClick}
                        className="flex h-7 w-9 items-center justify-center text-[10px] font-semibold text-zinc-300 transition hover:bg-zinc-800"
                    >
                        {displayZoomPercent !== null ? `${displayZoomPercent}%` : "—"}
                    </button>
                    <div className="h-px w-full bg-zinc-700" />
                    <button
                        type="button"
                        aria-label="Zoom out"
                        onClick={() => handleZoomButtonClick(-1)}
                        className="flex h-9 w-9 items-center justify-center text-lg font-bold text-[#e6c76f] transition hover:bg-zinc-800"
                    >
                        −
                    </button>
                </div>

                {(radarVisible || gairmetVisible || sigmetVisible) && (
                    <div className="pointer-events-none absolute left-2 top-28 bottom-3 z-10 hidden flex-col justify-center gap-2 overflow-y-auto sm:flex">
                        {legendCards}
                    </div>
                )}

                {(radarVisible || gairmetVisible || sigmetVisible) && (
                    <div className="absolute left-0 top-28 z-20 sm:hidden">
                        {mobileLegendOpen && (
                            <div
                                className="fixed inset-0 z-10"
                                onClick={() => setMobileLegendOpen(false)}
                            />
                        )}
                        <button
                            type="button"
                            aria-label={mobileLegendOpen ? "Hide legend" : "Show legend"}
                            aria-expanded={mobileLegendOpen}
                            onClick={() => setMobileLegendOpen((current) => !current)}
                            className={`relative z-20 flex h-14 w-6 items-center justify-center rounded-r-lg border border-l-0 backdrop-blur-sm transition ${
                                mobileLegendOpen
                                    ? "border-[#d6b35a] bg-[#d6b35a]/20 text-[#e6c76f]"
                                    : "border-zinc-700 bg-black/70 text-zinc-400"
                            }`}
                        >
                            <svg
                                viewBox="0 0 24 24"
                                className={`h-4 w-4 transition-transform ${mobileLegendOpen ? "rotate-180" : ""}`}
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            >
                                <path d="M9 6l6 6-6 6" />
                            </svg>
                        </button>

                        {mobileLegendOpen && (
                            <div className="pointer-events-none absolute left-6 top-0 z-20 flex max-h-[70vh] flex-col gap-2 overflow-y-auto">
                                {legendCards}
                            </div>
                        )}
                    </div>
                )}

                {displayScale && (
                    <div className="pointer-events-none absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 flex-col items-center gap-1.5">
                        <p className="text-sm font-bold tracking-wide text-zinc-100 [text-shadow:0_1px_4px_rgba(0,0,0,0.95)]">
                            {displayScale.nm} nm
                        </p>
                        <div className="relative" style={{ width: displayScale.px, height: 6 }}>
                            <div className="flex h-full overflow-hidden rounded-[1.5px] border border-[#e6c76f]">
                                {Array.from({ length: RADAR_SCALE_STEP_COUNT }).map((_, i) => (
                                    <div
                                        key={i}
                                        className={i % 2 === 0 ? "bg-[#e6c76f]" : "bg-black/60"}
                                        style={{ flex: 1, height: "100%" }}
                                    />
                                ))}
                            </div>
                            {Array.from({ length: RADAR_SCALE_STEP_COUNT + 1 }).map((_, i) => (
                                <div
                                    key={i}
                                    className="absolute w-px bg-[#e6c76f]"
                                    style={{
                                        left: `calc(${(i / RADAR_SCALE_STEP_COUNT) * 100}% - 0.5px)`,
                                        top: -2,
                                        height: 10,
                                    }}
                                />
                            ))}
                        </div>
                    </div>
                )}

                {zoneInfo &&
                    (zoneInfo.tfrs.length > 0 || zoneInfo.gairmets.length > 0 || zoneInfo.pireps.length > 0) &&
                    (() => {
                        const containerWidth = containerRef.current?.clientWidth ?? 800;
                        const containerHeight = containerRef.current?.clientHeight ?? 600;
                        const flipX = zoneInfo.x + 280 > containerWidth;
                        const flipY = zoneInfo.y + 260 > containerHeight;
                        return (
                            <div
                                className={`absolute z-20 w-64 rounded-xl border border-zinc-700 bg-black/90 p-3 text-xs shadow-2xl backdrop-blur-sm ${
                                    zoneInfo.pinned ? "" : "pointer-events-none"
                                }`}
                                style={{
                                    left: flipX ? undefined : zoneInfo.x + 14,
                                    right: flipX ? containerWidth - zoneInfo.x + 14 : undefined,
                                    top: flipY ? undefined : zoneInfo.y + 14,
                                    bottom: flipY ? containerHeight - zoneInfo.y + 14 : undefined,
                                }}
                            >
                                {zoneInfo.pinned && (
                                    <button
                                        type="button"
                                        aria-label="Close"
                                        onClick={() => {
                                            zoneInfoPinnedRef.current = false;
                                            setZoneInfo(null);
                                        }}
                                        className="absolute right-2 top-2 text-zinc-500 transition hover:text-zinc-200"
                                    >
                                        ✕
                                    </button>
                                )}
                                <div className="max-h-64 space-y-3 overflow-y-auto pr-4">
                                    {zoneInfo.gairmets.length > 1 && (
                                        <p className="text-[10px] font-semibold uppercase tracking-wide text-[#e6c76f]">
                                            {zoneInfo.gairmets.length} compounding hazards
                                        </p>
                                    )}
                                    {zoneInfo.gairmets.map((zone, index) => {
                                        const style = GAIRMET_HAZARD_STYLES[zone.hazard];
                                        return (
                                            <div key={`gairmet-${index}`}>
                                                <div className="flex items-center gap-1.5">
                                                    <span
                                                        className="h-2 w-2 shrink-0 rounded-full"
                                                        style={{ background: style?.stroke ?? "#999" }}
                                                    />
                                                    <p className="font-semibold text-zinc-100">
                                                        {GAIRMET_HAZARD_LABELS[zone.hazard] ?? zone.hazard}
                                                    </p>
                                                    {zone.severity && (
                                                        <span className="text-[10px] text-zinc-400">
                                                            {zone.severity}
                                                        </span>
                                                    )}
                                                </div>
                                                {zone.dueTo && (
                                                    <p className="mt-0.5 text-[11px] text-zinc-400">
                                                        {zone.dueTo}
                                                    </p>
                                                )}
                                                {(zone.base || zone.top) && (
                                                    <p className="mt-0.5 text-[11px] text-zinc-500">
                                                        {zone.base ? `${Number(zone.base) * 100} ft` : "SFC"}
                                                        {" – "}
                                                        {zone.top ? `${Number(zone.top) * 100} ft` : "—"}
                                                    </p>
                                                )}
                                                {zone.validTime && (
                                                    <p className="mt-0.5 text-[10px] text-zinc-500">
                                                        Valid {formatFinePrintTime(new Date(zone.validTime))}
                                                    </p>
                                                )}
                                            </div>
                                        );
                                    })}
                                    {zoneInfo.tfrs.map((tfr, index) => (
                                        <div key={`tfr-${index}`}>
                                            <div className="flex items-center gap-1.5">
                                                <span className="h-2 w-2 shrink-0 rounded-full bg-red-400" />
                                                <p className="font-semibold text-zinc-100">TFR — {tfr.type}</p>
                                            </div>
                                            <p className="mt-0.5 text-[11px] text-zinc-400">{tfr.title}</p>
                                        </div>
                                    ))}
                                    {zoneInfo.pireps.map((pirep, index) => (
                                        <div key={`pirep-${index}`}>
                                            <div className="flex items-center gap-1.5">
                                                <span
                                                    className="h-2 w-2 shrink-0 rounded-full"
                                                    style={{ background: PIREP_SEVERITY_COLORS[pirep.severity] }}
                                                />
                                                <p className="font-semibold text-zinc-100">
                                                    {pirep.isUrgent ? "URGENT PIREP" : "PIREP"}
                                                    {pirep.aircraftType ? ` — ${pirep.aircraftType}` : ""}
                                                </p>
                                            </div>
                                            {pirep.flightLevel !== null && (
                                                <p className="mt-0.5 text-[11px] text-zinc-400">
                                                    {(pirep.flightLevel * 100).toLocaleString()} ft
                                                </p>
                                            )}
                                            {pirep.turbulenceIntensity && (
                                                <p className="mt-0.5 text-[11px] text-zinc-400">
                                                    Turbulence: {pirep.turbulenceIntensity}
                                                    {pirep.turbulenceType ? ` ${pirep.turbulenceType}` : ""}
                                                </p>
                                            )}
                                            {pirep.icingIntensity && (
                                                <p className="mt-0.5 text-[11px] text-zinc-400">
                                                    Icing: {pirep.icingIntensity}
                                                    {pirep.icingType ? ` ${pirep.icingType}` : ""}
                                                </p>
                                            )}
                                            {pirep.skyCover && (
                                                <p className="mt-0.5 text-[11px] text-zinc-500">
                                                    Sky: {pirep.skyCover}
                                                </p>
                                            )}
                                            {pirep.wxString && (
                                                <p className="mt-0.5 text-[11px] text-zinc-500">
                                                    {pirep.wxString}
                                                </p>
                                            )}
                                            {pirep.obsTime && (
                                                <p className="mt-0.5 text-[10px] text-zinc-500">
                                                    {formatFinePrintTime(new Date(pirep.obsTime))}
                                                </p>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        );
                    })()}
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[11px] text-zinc-500">
                <p>
                    Scroll or pinch to zoom, drag to pan anywhere. Aviation data covers a{" "}
                    {RADAR_MAX_RADIUS_NM} nm radius around the station.
                </p>
                <p className="whitespace-nowrap text-[10px] text-zinc-500">
                    Geospatial data by{" "}
                    <a
                        href="https://www.esri.com"
                        target="_blank"
                        rel="noreferrer"
                        className="underline"
                    >
                        Esri
                    </a>{" "}
                    · Radar by{" "}
                    <a
                        href="https://www.weather.gov/"
                        target="_blank"
                        rel="noreferrer"
                        className="underline"
                    >
                        NOAA/NWS
                    </a>
                </p>
            </div>
        </div>
    );
}

function AirportInfoDashboardTab({
    stationInfo,
    airportDiagram,
    runways,
}: {
    stationInfo: StationInfo | null;
    airportDiagram: AirportDiagramInfo | null;
    runways: AirportRunway[];
}) {
    if (!stationInfo) {
        return (
            <div className="rounded-2xl border border-zinc-800 bg-black/55 p-6">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#d6b35a]">
                    Airport Info
                </p>
                <p className="mt-3 text-sm text-zinc-400">
                    Airport information is unavailable for this station.
                </p>
            </div>
        );
    }

    return (
        <div className="grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
            <div className="rounded-2xl border border-zinc-800 bg-black/55 p-5">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#d6b35a]">
                    Airport Information
                </p>

                <h3 className="mt-3 text-2xl font-bold text-white">
                    {stationInfo.displayName}
                </h3>

                <div className="mt-5 space-y-3 text-sm">
                    <AirportInfoRow
                        label="Location"
                        value={stationInfo.displayLocation}
                    />

                    <AirportInfoRow
                        label="Elevation"
                        value={
                            stationInfo.elevationFt !== null
                                ? `${stationInfo.elevationFt.toLocaleString()} ft`
                                : "Unavailable"
                        }
                    />

                    <AirportInfoRow
                        label="Timezone"
                        value={stationInfo.timeZone ?? "Unavailable"}
                    />

                    <AirportInfoRow
                        label="Latitude"
                        value={
                            stationInfo.latitude !== null
                                ? stationInfo.latitude.toFixed(5)
                                : "Unavailable"
                        }
                    />

                    <AirportInfoRow
                        label="Longitude"
                        value={
                            stationInfo.longitude !== null
                                ? stationInfo.longitude.toFixed(5)
                                : "Unavailable"
                        }
                    />
                </div>

                <div className="mt-5 border-t border-zinc-800 pt-5">
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#d6b35a]">
                        Runways
                    </p>

                    {runways.length > 0 ? (
                        <div className="mt-3 space-y-3">
                            {runways.map((runway) => (
                                <div
                                    key={runway.id}
                                    className="rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-3"
                                >
                                    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                                        <p className="font-bold text-white">{runway.name}</p>
                                        <p className="text-xs text-zinc-500">
                                            {runway.lengthFt !== null
                                                ? `${runway.lengthFt.toLocaleString()} ft`
                                                : "Length unavailable"}
                                            {runway.widthFt !== null
                                                ? ` x ${runway.widthFt.toLocaleString()} ft`
                                                : ""}
                                        </p>
                                    </div>

                                    <p className="mt-2 text-xs leading-5 text-zinc-400">
                                        {runway.surface ?? "Surface unavailable"}
                                        {runway.status ? ` | ${runway.status}` : ""}
                                    </p>

                                    <p className="mt-1 text-xs leading-5 text-zinc-500">
                                        {runway.endA.ident ?? "End A"}{" "}
                                        {runway.endA.headingDeg !== null
                                            ? `${runway.endA.headingDeg} deg`
                                            : "heading unavailable"}{" "}
                                        / {runway.endB.ident ?? "End B"}{" "}
                                        {runway.endB.headingDeg !== null
                                            ? `${runway.endB.headingDeg} deg`
                                            : "heading unavailable"}
                                    </p>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <p className="mt-3 text-sm text-zinc-500">
                            Runway data unavailable.
                        </p>
                    )}
                </div>

            </div>

            <AirportDiagramPreviewCard airportDiagram={airportDiagram} />

        </div>
    );
}

function AirportInfoRow({
    label,
    value,
}: {
    label: string;
    value: string;
}) {
    return (
        <div className="rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-3">
            <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-zinc-500">
                {label}
            </p>
            <p className="mt-1 text-zinc-200">{value}</p>
        </div>
    );
}

function AirportDiagramPreviewCard({
    airportDiagram,
}: {
    airportDiagram: AirportDiagramInfo | null;
}) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const renderTaskRef = useRef<{ cancel: () => void } | null>(null);

    const [loadingPreview, setLoadingPreview] = useState(false);
    const [previewError, setPreviewError] = useState("");

    useEffect(() => {
        let cancelled = false;

        async function renderPreview() {
            if (!airportDiagram?.diagramPdfUrl || !canvasRef.current) {
                return;
            }

            setLoadingPreview(true);
            setPreviewError("");

            // Cancel any previous render on this same canvas before starting a new one.
            if (renderTaskRef.current) {
                renderTaskRef.current.cancel();
                renderTaskRef.current = null;
            }

            try {
                const pdfjs = await import("pdfjs-dist");

                pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

                const proxyUrl = `/api/airport/diagram/file?url=${encodeURIComponent(
                    airportDiagram.diagramPdfUrl
                )}`;

                const loadingTask = pdfjs.getDocument(proxyUrl);
                const pdf = await loadingTask.promise;
                const page = await pdf.getPage(1);

                if (cancelled || !canvasRef.current) {
                    return;
                }

                const canvas = canvasRef.current;
                const context = canvas.getContext("2d");

                if (!context) {
                    throw new Error("Canvas context unavailable.");
                }

                const containerWidth = canvas.parentElement?.clientWidth ?? 700;

                const initialViewport = page.getViewport({ scale: 1 });
                const scale = containerWidth / initialViewport.width;
                const viewport = page.getViewport({ scale });

                const outputScale = window.devicePixelRatio || 1;

                canvas.width = Math.floor(viewport.width * outputScale);
                canvas.height = Math.floor(viewport.height * outputScale);
                canvas.style.width = `${viewport.width}px`;
                canvas.style.height = `${viewport.height}px`;

                context.setTransform(outputScale, 0, 0, outputScale, 0, 0);
                context.clearRect(0, 0, canvas.width, canvas.height);

                const renderTask = page.render({
                    canvas,
                    canvasContext: context,
                    viewport,
                });

                renderTaskRef.current = renderTask;

                await renderTask.promise;

                if (!cancelled) {
                    renderTaskRef.current = null;
                    setLoadingPreview(false);
                }
            } catch (error) {
                if (cancelled) {
                    return;
                }

                const message =
                    error instanceof Error ? error.message : "Unable to render diagram preview.";

                // Ignore expected PDF.js cancellation messages.
                if (message.toLowerCase().includes("cancel")) {
                    return;
                }

                setLoadingPreview(false);
                setPreviewError(message);
            }
        }

        void renderPreview();

        return () => {
            cancelled = true;

            if (renderTaskRef.current) {
                renderTaskRef.current.cancel();
                renderTaskRef.current = null;
            }
        };
    }, [airportDiagram?.diagramPdfUrl]);

    return (
        <div className="rounded-2xl border border-zinc-800 bg-black/55 p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#d6b35a]">
                        FAA Airport Diagram
                    </p>
                </div>

                {airportDiagram?.cycle && (
                    <p className="rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-400">
                        Cycle {airportDiagram.cycle}
                    </p>
                )}
            </div>

            {airportDiagram?.diagramPdfUrl ? (
                <>
                    <a
                        href={airportDiagram.diagramPdfUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-4 block overflow-hidden rounded-2xl border border-zinc-700 bg-zinc-950 transition hover:border-[#d6b35a]/50"
                    >
                        <div className="relative">
                            {loadingPreview && (
                                <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/50 text-sm text-zinc-200">
                                    Loading diagram preview...
                                </div>
                            )}

                            <canvas
                                ref={canvasRef}
                                className="block h-auto w-full bg-white"
                            />
                        </div>
                    </a>

                    <div className="mt-4 flex flex-col gap-3 sm:flex-row">
                        <a
                            href={airportDiagram.diagramPdfUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex rounded-xl border border-[#d6b35a]/50 bg-[#d6b35a]/10 px-5 py-3 text-sm font-bold text-[#e6c76f] transition hover:bg-[#d6b35a]/20"
                        >
                            Open PDF
                        </a>

                        <a
                            href={airportDiagram.faaSearchResultsUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex rounded-xl border border-zinc-700 bg-black px-5 py-3 text-sm font-bold text-zinc-200 transition hover:bg-zinc-900"
                        >
                            Open FAA Search Result
                        </a>
                    </div>

                    {previewError && (
                        <p className="mt-4 text-xs leading-5 text-amber-300">
                            Preview issue: {previewError}
                        </p>
                    )}
                </>
            ) : (
                <div className="mt-4 flex min-h-64 items-center justify-center rounded-2xl border border-dashed border-zinc-700 bg-zinc-950 p-6 text-center">
                    <div>
                        <p className="text-lg font-bold text-white">
                            Diagram Preview Unavailable
                        </p>

                        <p className="mt-2 max-w-md text-sm leading-6 text-zinc-400">
                            A direct FAA airport diagram PDF was not found for this airport.
                            Use the official FAA links below as backup.
                        </p>

                        <div className="mt-5 flex flex-col items-center justify-center gap-3 sm:flex-row">
                            {airportDiagram?.faaAirportDiagramPageUrl && (
                                <a
                                    href={airportDiagram.faaAirportDiagramPageUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="inline-flex rounded-xl border border-[#d6b35a]/50 bg-[#d6b35a]/10 px-5 py-3 text-sm font-bold text-[#e6c76f] transition hover:bg-[#d6b35a]/20"
                                >
                                    FAA Diagram Page
                                </a>
                            )}

                            {airportDiagram?.faaSearchUrl && (
                                <a
                                    href={airportDiagram.faaSearchUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="inline-flex rounded-xl border border-zinc-700 bg-black px-5 py-3 text-sm font-bold text-zinc-200 transition hover:bg-zinc-900"
                                >
                                    FAA d-TPP Search
                                </a>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {airportDiagram?.note && (
                <p className="mt-4 text-xs leading-5 text-zinc-500">
                    {airportDiagram.note}
                </p>
            )}
        </div>
    );
}

function DashboardTabButton({
    active,
    onClick,
    children,
}: {
    active: boolean;
    onClick: () => void;
    children: ReactNode;
}) {
    return (
        <button
            onClick={onClick}
            className={`w-full rounded-xl px-4 py-3 text-sm font-bold transition ${active
                    ? "bg-[#d6b35a] text-black"
                    : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"
                }`}
        >
            {children}
        </button>
    );
}

function LiveAirportClock({
    now,
    timeZone,
}: {
    now: Date;
    timeZone: string | null | undefined;
}) {
    const clockZulu = formatLiveAirportClockZulu(now);
    const clockTime = formatLiveAirportClockTime(now, timeZone);
    const clockZone = formatLiveAirportClockZone(now, timeZone);

    return (
        <div
            className="inline-flex w-fit flex-wrap items-center gap-2 whitespace-nowrap rounded-2xl border border-zinc-700 bg-black/65 px-4 py-3 text-sm font-semibold text-zinc-200"
            aria-label={`Current time: ${clockZulu} Zulu, ${clockTime} ${clockZone}`}
        >
            <span className="text-white">
                <ClockIcon />
            </span>

            <span className="tabular-nums text-white">{clockZulu}</span>

            <span className="text-zinc-600">|</span>

            <span className="tabular-nums text-white">
                {clockTime}
            </span>

            {clockZone && (
                <span className="text-zinc-400">
                    {clockZone}
                </span>
            )}
        </div>
    );
}

function formatLiveAirportClockZulu(now: Date): string {
    try {
        return `${new Intl.DateTimeFormat("en-US", {
            timeZone: "UTC",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
        })
            .format(now)
            .replace(":", "")}Z`;
    } catch {
        return "----Z";
    }
}

function formatLiveAirportClockTime(
    now: Date,
    timeZone: string | null | undefined
): string {
    if (!timeZone) {
        return "--:--:--";
    }

    try {
        return new Intl.DateTimeFormat("en-US", {
            timeZone,
            hour: "numeric",
            minute: "2-digit",
            second: "2-digit",
            hour12: true,
        }).format(now);
    } catch {
        return "--:--:--";
    }
}

function formatLiveAirportClockZone(
    now: Date,
    timeZone: string | null | undefined
): string {
    if (!timeZone) {
        return "";
    }

    try {
        const parts = new Intl.DateTimeFormat("en-US", {
            timeZone,
            timeZoneName: "short",
        }).formatToParts(now);

        return parts.find((part) => part.type === "timeZoneName")?.value ?? "";
    } catch {
        return "";
    }
}

function ObservationTimeBubble({
    metar,
    now,
    stationInfo,
}: {
    metar: NormalizedMetar;
    now: Date;
    stationInfo: StationInfo | null;
}) {
    const ageMinutes = getMetarAgeMinutes(metar, now);
    const ageColor = getMetarAgeColor(ageMinutes);

    return (
        <div className="inline-flex w-fit flex-wrap items-center gap-1.5 rounded-2xl border border-zinc-700 bg-black/65 px-3 py-2 text-xs font-semibold text-zinc-200 sm:gap-2 sm:px-4 sm:py-3 sm:text-sm">
            <span className={`inline-flex items-center gap-1.5 sm:gap-2 ${ageColor}`}>
                <HourglassIcon className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                {formatMetarAge(ageMinutes)}
            </span>

            <span className="text-zinc-600">|</span>

            <span>{formatZuluObservation(metar)}</span>

            <span className="text-zinc-600">|</span>

            <span>{formatLocalObservation(metar, stationInfo?.timeZone)}</span>
        </div>
    );
}

function TafIssuedBubble({
    issueTime,
    timeZone,
    now,
    solid = false,
}: {
    issueTime?: string | null;
    timeZone?: string | null;
    now: Date;
    solid?: boolean;
}) {
    const date = issueTime ? new Date(issueTime) : null;
    const isValid = date !== null && !Number.isNaN(date.getTime());
    const ageMinutes = isValid ? getTafAgeMinutes(date, now) : null;
    const ageColor = getTafAgeColor(ageMinutes);

    return (
        <div
            className={`inline-flex w-fit flex-wrap items-center gap-1.5 rounded-2xl border border-zinc-700 px-3 py-2 text-xs font-semibold text-zinc-200 sm:gap-2 sm:px-4 sm:py-3 sm:text-sm ${solid ? "bg-zinc-950" : "bg-black/65"}`}
        >
            <span className={`inline-flex items-center gap-1.5 sm:gap-2 ${ageColor}`}>
                <HourglassIcon className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                {formatTafAge(ageMinutes)}
            </span>

            <span className="text-zinc-600">|</span>

            <span>{isValid ? formatZuluFromDate(date) : "Zulu unavailable"}</span>

            <span className="text-zinc-600">|</span>

            <span>{isValid ? formatLocalFromDate(date, timeZone) : "LT unavailable"}</span>
        </div>
    );
}

function formatFinePrintTime(date: Date): string {
    return new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
    }).format(date);
}

function formatRadarTickTime(date: Date): string {
    return new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        minute: "2-digit",
    }).format(date);
}

function LastFetchFinePrint({
    label,
    lastAttempt,
    onResync,
}: {
    label: string;
    lastAttempt: Date | null;
    onResync: () => void;
}) {
    return (
        <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-zinc-500">
            <span>
                Last sync: {lastAttempt ? formatFinePrintTime(lastAttempt) : "—"}
            </span>
            <button
                type="button"
                onClick={onResync}
                aria-label={`Resync ${label}`}
                className="flex h-4 w-4 items-center justify-center text-[#e6c76f] transition hover:text-white"
            >
                <svg
                    viewBox="0 0 24 24"
                    className="h-3 w-3"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                >
                    <polyline points="23 4 23 10 17 10" />
                    <polyline points="1 20 1 14 7 14" />
                    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                </svg>
            </button>
        </p>
    );
}

function formatZuluFromDate(date: Date): string {
    return `${new Intl.DateTimeFormat("en-US", {
        timeZone: "UTC",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    })
        .format(date)
        .replace(":", "")}Z`;
}

function formatLocalFromDate(date: Date, timeZone?: string | null): string {
    if (!timeZone) return "LT unavailable";

    return new Intl.DateTimeFormat("en-US", {
        timeZone,
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
    }).format(date);
}

function RaindropIcon() {
    return (
        <svg
            className="h-3 w-3 shrink-0"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
        >
            <path
                d="M12 3c3.2 4.4 6 8.2 6 11.2a6 6 0 1 1-12 0C6 11.2 8.8 7.4 12 3Z"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinejoin="round"
            />
        </svg>
    );
}

function ClockIcon() {
    return (
        <svg
            className="h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
        >
            <circle
                cx="12"
                cy="12"
                r="9"
                stroke="currentColor"
                strokeWidth="2"
            />
            <path
                d="M12 7v5l3 2"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

function HourglassIcon({ className = "h-4 w-4" }: { className?: string }) {
    return (
        <svg
            className={className}
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
        >
            <path
                d="M6 3h12M6 21h12"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
            />

            <path
                d="M7 3c0 4 1.5 6.2 5 9-3.5 2.8-5 5-5 9M17 3c0 4-1.5 6.2-5 9 3.5 2.8 5 5 5 9"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
            />

            <path
                d="M9 18h6"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
            />
        </svg>
    );
}

function getObservationDateUtc(metar: NormalizedMetar): Date | null {
    const { day, hourUtc, minuteUtc } = metar.observed;

    if (day === null || hourUtc === null || minuteUtc === null) {
        return null;
    }

    const now = new Date();

    let observed = new Date(
        Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            day,
            hourUtc,
            minuteUtc
        )
    );

    const differenceDays =
        (observed.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);

    if (differenceDays > 15) {
        observed = new Date(
            Date.UTC(
                now.getUTCFullYear(),
                now.getUTCMonth() - 1,
                day,
                hourUtc,
                minuteUtc
            )
        );
    }

    if (differenceDays < -20) {
        observed = new Date(
            Date.UTC(
                now.getUTCFullYear(),
                now.getUTCMonth() + 1,
                day,
                hourUtc,
                minuteUtc
            )
        );
    }

    return observed;
}

function getMetarAgeMinutes(
    metar: NormalizedMetar,
    now: Date
): number | null {
    const observed = getObservationDateUtc(metar);

    if (!observed) return null;

    return Math.max(
        0,
        Math.round((now.getTime() - observed.getTime()) / 60_000)
    );
}

function getMetarAgeColor(ageMinutes: number | null): string {
    if (ageMinutes === null) return "text-white";
    if (ageMinutes >= 40) return "text-red-400";
    if (ageMinutes >= 20) return "text-yellow-300";
    return "text-white";
}

function formatMetarAge(ageMinutes: number | null): string {
    if (ageMinutes === null) return "Age unavailable";
    return `${ageMinutes} min ago`;
}

function getTafAgeMinutes(issueDate: Date, now: Date): number | null {
    return Math.max(
        0,
        Math.round((now.getTime() - issueDate.getTime()) / 60_000)
    );
}

function getTafAgeColor(ageMinutes: number | null): string {
    if (ageMinutes === null) return "text-zinc-200";
    if (ageMinutes >= 360) return "text-red-400";
    if (ageMinutes >= 240) return "text-yellow-300";
    return "text-zinc-200";
}

function formatTafAge(ageMinutes: number | null): string {
    if (ageMinutes === null) return "Age unavailable";
    if (ageMinutes < 60) return `${ageMinutes} min ago`;

    const hours = Math.floor(ageMinutes / 60);
    const minutes = ageMinutes % 60;

    return minutes === 0 ? `${hours}h ago` : `${hours}h ${minutes}m ago`;
}

function formatZuluObservation(metar: NormalizedMetar): string {
    const { hourUtc, minuteUtc } = metar.observed;

    if (hourUtc === null || minuteUtc === null) {
        return "Zulu unavailable";
    }

    return `${String(hourUtc).padStart(2, "0")}${String(minuteUtc).padStart(
        2,
        "0"
    )}Z`;
}

function formatLocalObservation(
    metar: NormalizedMetar,
    timeZone: string | null | undefined
): string {
    const observed = getObservationDateUtc(metar);

    if (!observed) return "LT unavailable";

    if (!timeZone) {
        return "LT unavailable";
    }

    return new Intl.DateTimeFormat("en-US", {
        timeZone,
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
    }).format(observed);
}

const INFO_TOOLTIP_WIDTH = 224;
const INFO_TOOLTIP_MARGIN = 8;

function InfoTooltip({ text }: { text: string }) {
    const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
    const buttonRef = useRef<HTMLButtonElement | null>(null);

    function show() {
        const rect = buttonRef.current?.getBoundingClientRect();
        if (!rect) return;

        const left = Math.min(
            Math.max(
                rect.left + rect.width / 2 - INFO_TOOLTIP_WIDTH / 2,
                INFO_TOOLTIP_MARGIN
            ),
            window.innerWidth - INFO_TOOLTIP_WIDTH - INFO_TOOLTIP_MARGIN
        );

        setCoords({ top: rect.top - INFO_TOOLTIP_MARGIN, left });
    }

    function hide() {
        setCoords(null);
    }

    return (
        <span className="relative inline-flex">
            <button
                ref={buttonRef}
                type="button"
                onMouseEnter={show}
                onMouseLeave={hide}
                onFocus={show}
                onBlur={hide}
                className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-zinc-600 p-0 text-zinc-400 transition hover:border-[#d6b35a]/60 hover:text-[#e6c76f] focus:border-[#d6b35a]/60 focus:text-[#e6c76f] focus:outline-none"
                aria-label="More information"
            >
                <svg
                    viewBox="0 0 24 24"
                    className="h-2.5 w-2.5"
                    fill="currentColor"
                    aria-hidden="true"
                >
                    <circle cx="12" cy="6.5" r="2" />
                    <rect x="10.25" y="10.5" width="3.5" height="9.5" rx="1.2" />
                </svg>
            </button>

            {coords &&
                typeof document !== "undefined" &&
                createPortal(
                    <span
                        role="tooltip"
                        style={{ top: coords.top, left: coords.left, width: INFO_TOOLTIP_WIDTH }}
                        className="pointer-events-none fixed z-50 -translate-y-full rounded-lg border border-zinc-700 bg-zinc-900 p-2.5 text-left text-xs font-normal normal-case leading-5 tracking-normal text-zinc-300 shadow-xl"
                    >
                        {text}
                    </span>,
                    document.body
                )}
        </span>
    );
}

function WeatherCard({
    label,
    value,
    detail,
    accent,
    info,
}: {
    label: string;
    value: string;
    detail: string;
    accent: "gold" | "silver";
    info?: string;
}) {
    const accentClass =
        accent === "gold" ? "border-[#d6b35a]/30" : "border-zinc-700";

    return (
        <div className={`rounded-2xl border ${accentClass} bg-black/55 p-5`}>
            <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
                {label}
                {info && <InfoTooltip text={info} />}
            </p>
            <p className="mt-3 text-2xl font-bold text-white">{value}</p>
            <p className="mt-2 text-sm leading-6 text-zinc-400">{detail}</p>
        </div>
    );
}

function RunwayWindWidget({
    metar,
    runways,
    now,
    stationInfo,
    taf,
    fullscreen = false,
}: {
    metar: NormalizedMetar;
    runways: AirportRunway[];
    now?: Date;
    stationInfo?: StationInfo | null;
    taf: TafResponse | null;
    fullscreen?: boolean;
}) {
    const [selectedEnd, setSelectedEnd] = useState<RunwayEnd | null>(null);
    const [compassRotation, setCompassRotation] = useState(0);

    if (runways.length === 0) {
        return (
            <div className="mb-6 rounded-2xl border border-zinc-800 bg-black/55 p-5">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#d6b35a]">
                    Visual Decoder
                </p>
                <p className="mt-2 text-sm text-zinc-400">
                    Runway data is unavailable for this airport.
                </p>
            </div>
        );
    }

    const windDirectionDeg =
        metar.wind.variable || metar.wind.directionDeg === null
            ? null
            : metar.wind.directionDeg;

    const windSpeedKt = metar.wind.speedKt ?? 0;

    const runwayEnds = getRunwayEnds(runways);

    if (runwayEnds.length === 0) {
        return (
            <div className="mb-6 rounded-2xl border border-zinc-800 bg-black/55 p-5">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#d6b35a]">
                    Visual Decoder
                </p>
                <p className="mt-2 text-sm text-zinc-400">
                    Runway headings are unavailable for this airport.
                </p>
            </div>
        );
    }

    const calculatedEnds: CalculatedRunwayEnd[] = runwayEnds.map((runwayEnd) => ({
        ...runwayEnd,
        component: calculateRunwayWindComponent(
            windDirectionDeg ?? 0,
            windSpeedKt,
            runwayEnd.headingDeg
        ),
        gustComponent:
            metar.wind.gustKt !== null
                ? calculateRunwayWindComponent(
                    windDirectionDeg ?? 0,
                    metar.wind.gustKt,
                    runwayEnd.headingDeg
                )
                : null,
    }));

    const bestRunway = [...calculatedEnds].sort((a, b) => {
        if (b.component.headwindKt !== a.component.headwindKt) {
            return b.component.headwindKt - a.component.headwindKt;
        }

        return a.component.crosswindKt - b.component.crosswindKt;
    })[0];

    const activeRunway =
        selectedEnd !== null
            ? calculatedEnds.find((end) => end.ident === selectedEnd.ident) ??
            bestRunway
            : bestRunway;

    function handleSelectEnd(runwayEnd: RunwayEnd) {
        setSelectedEnd(runwayEnd);
        setCompassRotation(runwayEnd.headingDeg);
    }

    function handleSetCompassRotation(rotationDeg: number) {
        setSelectedEnd(null);
        setCompassRotation(normalizeAngle360(rotationDeg));
    }

    function handleResetNorthUp() {
        setSelectedEnd(null);
        setCompassRotation(0);
    }

    function handleOrientToInflight() {
        setSelectedEnd(null);
        setCompassRotation(200);
    }

    const showResetButton =
        selectedEnd !== null || Math.round(normalizeAngle360(compassRotation)) !== 0;

    return (
        <div
            className={
                fullscreen
                    ? "relative h-full min-h-0 overflow-hidden rounded-3xl border border-[#d6b35a]/25 bg-black/55 p-2"
                    : "mb-6 rounded-2xl border border-[#d6b35a]/25 bg-black/55 p-5"
            }
        >
            {fullscreen ? (
                <div className="absolute inset-2 flex gap-4">
                    <div className="flex min-w-0 flex-1 items-center justify-center overflow-hidden">
                        <RunwayCompassSvg
                            runways={runways}
                            runwayEnds={calculatedEnds}
                            selectedEnd={selectedEnd}
                            bestRunwayIdent={bestRunway?.ident ?? null}
                            activeRunway={activeRunway}
                            windDirectionDeg={windDirectionDeg}
                            windSpeedKt={windSpeedKt}
                            windVariable={metar.wind.variable}
                            compassRotation={compassRotation}
                            visibilitySm={metar.visibility.statuteMiles}
                            showResetButton={showResetButton}
                            onResetNorthUp={handleResetNorthUp}
                            onSelectEnd={handleSelectEnd}
                            onCompassRotationChange={handleSetCompassRotation}
                            onOrientToInflight={handleOrientToInflight}
                            fullscreen
                        />
                    </div>

                    <div className="flex min-w-0 flex-1 flex-col overflow-hidden min-[1250px]:items-center min-[1250px]:justify-center">
                        {now && (
                            <div className="flex flex-none justify-end pb-2 min-[1250px]:hidden">
                                <ObservationTimeBubble
                                    metar={metar}
                                    now={now}
                                    stationInfo={stationInfo ?? null}
                                />
                            </div>
                        )}

                        <div className="flex min-h-0 w-full flex-1 items-center justify-center">
                            <CloudCeilingPreviewSvg
                                metar={metar}
                                fullscreen
                            />
                        </div>
                    </div>

                    <div className="relative hidden w-fit flex-none flex-col items-end overflow-hidden min-[1250px]:flex">
                        {now && (
                            <div className="flex-none pb-2">
                                <ObservationTimeBubble
                                    metar={metar}
                                    now={now}
                                    stationInfo={stationInfo ?? null}
                                />
                            </div>
                        )}

                        <div className="flex w-72 min-h-0 flex-1 flex-col justify-center gap-4 overflow-y-auto pt-2">
                            <WeatherMinimumsPanel metar={metar} bestRunway={bestRunway} />
                            <NightStackingPanel
                                taf={taf}
                                timeZone={stationInfo?.timeZone}
                                latitude={stationInfo?.latitude}
                                longitude={stationInfo?.longitude}
                            />
                        </div>
                    </div>
                </div>
            ) : (
                <div className="grid grid-cols-1 gap-5 min-[1350px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                    <div className="flex min-w-0 items-center justify-center">
                        <RunwayCompassSvg
                            runways={runways}
                            runwayEnds={calculatedEnds}
                            selectedEnd={selectedEnd}
                            bestRunwayIdent={bestRunway?.ident ?? null}
                            activeRunway={activeRunway}
                            windDirectionDeg={windDirectionDeg}
                            windSpeedKt={windSpeedKt}
                            windVariable={metar.wind.variable}
                            compassRotation={compassRotation}
                            visibilitySm={metar.visibility.statuteMiles}
                            showResetButton={showResetButton}
                            onResetNorthUp={handleResetNorthUp}
                            onSelectEnd={handleSelectEnd}
                            onCompassRotationChange={handleSetCompassRotation}
                            onOrientToInflight={handleOrientToInflight}
                        />
                    </div>

                    <div className="flex min-w-0 items-center justify-center">
                        <CloudCeilingPreviewSvg metar={metar} />
                    </div>

                    <div className="flex w-full min-w-0 flex-col justify-center gap-4 min-[1350px]:w-72">
                        <WeatherMinimumsPanel metar={metar} bestRunway={bestRunway} />
                        <NightStackingPanel
                            taf={taf}
                            timeZone={stationInfo?.timeZone}
                            latitude={stationInfo?.latitude}
                            longitude={stationInfo?.longitude}
                        />
                    </div>
                </div>
            )}
        </div>
    );
}

function RunwayCompassSvg({
    runways,
    runwayEnds,
    selectedEnd,
    bestRunwayIdent,
    activeRunway,
    windDirectionDeg,
    windSpeedKt,
    windVariable = false,
    compassRotation,
    showResetButton,
    onResetNorthUp,
    onSelectEnd,
    visibilitySm,
    onCompassRotationChange,
    onOrientToInflight,
    fullscreen = false,
}: {
    runways: AirportRunway[];
    runwayEnds: CalculatedRunwayEnd[];
    selectedEnd: RunwayEnd | null;
    bestRunwayIdent: string | null;
    activeRunway: CalculatedRunwayEnd | undefined;
    windDirectionDeg: number | null;
    windSpeedKt: number;
    windVariable?: boolean;
    compassRotation: number;
    showResetButton: boolean;
    onResetNorthUp: () => void;
    onSelectEnd: (runwayEnd: RunwayEnd) => void;
    visibilitySm: number | null;
    onCompassRotationChange: (rotationDeg: number) => void;
    onOrientToInflight: () => void;
    fullscreen?: boolean;
}) {
    const center = 200;
    const radius = 158;

    const dragStateRef = useRef<{
        pointerId: number;
        startAngleDeg: number;
        startRotationDeg: number;
        startClientX: number;
        startClientY: number;
        isDragging: boolean;
    } | null>(null);

    const [windDisplayMode, setWindDisplayMode] =
        useState<WindDisplayMode>("animated");

    const airportIdent = runways[0]?.airportIdent?.toUpperCase() ?? "";

    const airportFeatures =
        airportIdent === "KFCM" || airportIdent === "FCM"
            ? [KFCM_INFLIGHT_FEATURE]
            : [];

    const { runwayLayout, featureLayout } = buildAirportMapLayout(
        runways,
        compassRotation,
        center,
        selectedEnd,
        airportFeatures
    );

    function displayAngle(angleDeg: number): number {
        return normalizeAngle360(angleDeg - compassRotation);
    }

    const hasWindAnimation = windDirectionDeg !== null && windSpeedKt > 0;

    const windDisplayAngle = hasWindAnimation
        ? displayAngle(windDirectionDeg)
        : null;

    const windLabel =
        windDirectionDeg !== null
            ? `${windDirectionDeg}° ${windSpeedKt} kt`
            : windVariable
                ? `VRB ${windSpeedKt} kt`
                : `${windSpeedKt} kt`;

    const windModeLabel =
        windDisplayMode === "animated"
            ? "Animated wind"
            : windDisplayMode === "direction"
                ? "Wind direction"
                : "Wind hidden";

    // Round the heading beneath the red pointer to the nearest 10 degrees.
    const headingAtPointer = normalizeAngle360(
        Math.round(normalizeAngle360(compassRotation) / 10) * 10
    );

    const headingAtPointerLabel =
        `${String(headingAtPointer).padStart(3, "0")}°`;

    // Wind components now use the compass heading rather than the
    // selected or automatically recommended runway.
    const dynamicWindComponent =
        windDirectionDeg !== null
            ? calculateRunwayWindComponent(
                windDirectionDeg,
                windSpeedKt,
                headingAtPointer
            )
            : null;

    const visibilityLabel = formatCompassVisibility(visibilitySm);

    function cycleWindDisplayMode() {
        setWindDisplayMode((currentMode) => {
            if (currentMode === "animated") return "direction";
            if (currentMode === "direction") return "hidden";
            return "animated";
        });
    }

    function getPointerAngle(event: PointerEvent<SVGSVGElement>): number | null {
        const bounds = event.currentTarget.getBoundingClientRect();

        if (bounds.width === 0 || bounds.height === 0) return null;

        const x = event.clientX - bounds.left - bounds.width / 2;
        const y = event.clientY - bounds.top - bounds.height / 2;

        return normalizeAngle360((Math.atan2(x, -y) * 180) / Math.PI);
    }

    function beginCompassDrag(event: PointerEvent<SVGSVGElement>) {
        if (event.pointerType === "mouse" && event.button !== 0) return;

        const target = event.target;

        if (
            target instanceof Element &&
            target.closest("[data-compass-control='true']")
        ) {
            return;
        }

        const pointerAngle = getPointerAngle(event);
        if (pointerAngle === null) return;

        dragStateRef.current = {
            pointerId: event.pointerId,
            startAngleDeg: pointerAngle,
            startRotationDeg: compassRotation,
            startClientX: event.clientX,
            startClientY: event.clientY,
            isDragging: false,
        };

        event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault();
    }

    function dragCompass(event: PointerEvent<SVGSVGElement>) {
        const dragState = dragStateRef.current;
        if (!dragState || dragState.pointerId !== event.pointerId) return;

        const pointerAngle = getPointerAngle(event);
        if (pointerAngle === null) return;

        const pointerTravel = Math.hypot(
            event.clientX - dragState.startClientX,
            event.clientY - dragState.startClientY
        );

        if (!dragState.isDragging && pointerTravel < 3) return;

        dragState.isDragging = true;
        onCompassRotationChange(
            dragState.startRotationDeg -
            normalizeAngle180(pointerAngle - dragState.startAngleDeg)
        );

        event.preventDefault();
    }

    function endCompassDrag(event: PointerEvent<SVGSVGElement>) {
        const dragState = dragStateRef.current;
        if (!dragState || dragState.pointerId !== event.pointerId) return;

        dragStateRef.current = null;

        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
    }

    return (
        <svg
            viewBox="0 0 400 400"
            className={
                fullscreen
                    ? "h-full w-full max-h-full max-w-full rounded-2xl bg-transparent"
                    : "h-auto w-full rounded-2xl bg-transparent"
            }
            role="img"
            aria-label="Runway and wind compass"
            style={{ touchAction: "none", cursor: "grab" }}
            onPointerDown={beginCompassDrag}
            onPointerMove={dragCompass}
            onPointerUp={endCompassDrag}
            onPointerCancel={endCompassDrag}
        >

            <defs>
                <clipPath id="compass-face-clip">
                    <circle cx={center} cy={center} r={radius - 2} />
                </clipPath>

                <clipPath id="wind-field-clip">
                    <circle cx={center} cy={center} r={radius - 6} />
                </clipPath>
            </defs>

            <circle
                cx={center}
                cy={center}
                r={radius}
                fill="transparent"
                stroke="#3f3f46"
                strokeWidth="1"
            />

            {Array.from({ length: 72 }).map((_, index) => {
                const angle = index * 5;
                const isMajor = index % 6 === 0;

                const outer = polarPoint(
                    center,
                    center,
                    radius,
                    displayAngle(angle)
                );

                const inner = polarPoint(
                    center,
                    center,
                    radius - (isMajor ? 16 : 8),
                    displayAngle(angle)
                );

                return (
                    <line
                        key={angle}
                        x1={outer.x}
                        y1={outer.y}
                        x2={inner.x}
                        y2={inner.y}
                        stroke={isMajor ? "#a1a1aa" : "#52525b"}
                        strokeWidth={isMajor ? 1.5 : 0.75}
                    />
                );
            })}

            {[
                { label: "N", angle: 0 },
                { label: "E", angle: 90 },
                { label: "S", angle: 180 },
                { label: "W", angle: 270 },
            ].map((point) => {
                const displayedAngle = displayAngle(point.angle);
                const pos = polarPoint(center, center, radius - 34, displayedAngle);
                const textRotation = getTangentTextRotation(displayedAngle);

                return (
                    <text
                        key={point.label}
                        x={pos.x}
                        y={pos.y}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fill="#d4d4d8"
                        fontSize="22"
                        fontWeight="700"
                        transform={`rotate(${textRotation} ${pos.x} ${pos.y})`}
                    >
                        {point.label}
                    </text>
                );
            })}

            {[
                { label: "03", angle: 30 },
                { label: "06", angle: 60 },
                { label: "12", angle: 120 },
                { label: "15", angle: 150 },
                { label: "21", angle: 210 },
                { label: "24", angle: 240 },
                { label: "30", angle: 300 },
                { label: "33", angle: 330 },
            ].map((point) => {
                const displayedAngle = displayAngle(point.angle);
                const pos = polarPoint(center, center, radius - 42, displayedAngle);
                const textRotation = getTangentTextRotation(displayedAngle);

                return (
                    <text
                        key={point.label}
                        x={pos.x}
                        y={pos.y}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fill="#71717a"
                        fontSize="16"
                        fontWeight="600"
                        transform={`rotate(${textRotation} ${pos.x} ${pos.y})`}
                    >
                        {point.label}
                    </text>
                );
            })}

            <g clipPath="url(#compass-face-clip)">
                {runwayLayout.map((layout) => (
                    <CompassRunwayPair
                        key={layout.runway.id}
                        layout={layout}
                        runwayEnds={runwayEnds}
                        selectedEnd={selectedEnd}
                        bestRunwayIdent={bestRunwayIdent}
                        onSelectEnd={onSelectEnd}
                    />
                ))}

                {windDisplayMode === "animated" && (
                    <WindFieldAnimation
                        center={center}
                        radius={radius}
                        windDisplayAngle={windDisplayAngle}
                        windSpeedKt={windSpeedKt}
                    />
                )}

                {windDisplayMode === "direction" && (
                    <WindDirectionArrow
                        center={center}
                        radius={radius}
                        windDisplayAngle={windDisplayAngle}
                    />
                )}

                {featureLayout.map((layout) => (
                    <CompassFeatureMarker
                        key={layout.feature.id}
                        layout={layout}
                        labelSide={getInflightLabelSide(layout.point, runwayLayout)}
                        onOrientToInflight={onOrientToInflight}
                    />
                ))}
            </g>

            <circle
                cx={center}
                cy={center}
                r={radius}
                fill="none"
                stroke="#3f3f46"
                strokeWidth="1.5"
                pointerEvents="none"
            />

            <circle cx={center} cy={center} r="4" fill="#e6c76f" />

            <CompassVisibilityBadge label={visibilityLabel} />

            <CompassHeadingPointer label={headingAtPointerLabel} />

            {activeRunway && (
                <RunwayStatusBadge
                    activeRunway={activeRunway}
                    selectedEnd={selectedEnd}
                />
            )}

            {showResetButton && (
                <g
                    data-compass-control="true"
                    onClick={onResetNorthUp}
                    style={{ cursor: "pointer" }}
                    role="button"
                    aria-label="Reset north up"
                >
                    <title>Reset compass to north-up</title>

                    <rect
                        x="334"
                        y="18"
                        width="52"
                        height="24"
                        rx="12"
                        fill="#050505"
                        stroke="#d6b35a"
                        strokeWidth="1.1"
                    />

                    <text
                        x="360"
                        y="31"
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fill="#e6c76f"
                        fontSize="9"
                        fontWeight="850"
                    >
                        RESET
                    </text>
                </g>
            )}

            <g>
                <rect
                    x="140"
                    y="358"
                    width="120"
                    height="30"
                    rx="15"
                    fill="#050505"
                    stroke="#d6b35a"
                />

                <text
                    x="200"
                    y="374"
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fill="#e6c76f"
                    fontSize="15"
                    fontWeight="850"
                >
                    {windLabel}
                </text>
            </g>

            <g
                data-compass-control="true"
                onClick={cycleWindDisplayMode}
                onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        cycleWindDisplayMode();
                    }
                }}
                style={{ cursor: "pointer" }}
                role="button"
                tabIndex={0}
                aria-label={`Wind display mode: ${windModeLabel}. Click to change.`}
            >
                <title>{`Wind display: ${windModeLabel}`}</title>

                <WindModeIcon mode={windDisplayMode} x={37} y={367} />
            </g>

            {dynamicWindComponent && (
                <WindComponentStack
                    component={dynamicWindComponent}
                    x={320}
                    y={350}
                />
            )}
        </svg>
    );
}

function getInflightLabelSide(
    featurePoint: SvgPoint,
    runwayLayout: RunwayLayout[]
): InflightLabelSide {
    const candidates: { side: InflightLabelSide; center: SvgPoint }[] = [
        {
            side: "left",
            center: { x: featurePoint.x - 22, y: featurePoint.y - 9.5 },
        },
        {
            side: "right",
            center: { x: featurePoint.x + 22, y: featurePoint.y - 9.5 },
        },
        {
            side: "middle",
            center: { x: featurePoint.x, y: featurePoint.y + 9 },
        },
    ];

    return candidates
        .map((candidate) => ({
            side: candidate.side,
            score: getInflightLabelClearanceScore(candidate.center, runwayLayout),
        }))
        .sort((a, b) => b.score - a.score)[0].side;
}

function getInflightLabelClearanceScore(
    labelCenter: SvgPoint,
    runwayLayout: RunwayLayout[]
): number {
    const labelHalfWidth = 22;
    const labelHalfHeight = 9;

    const samplePoints = [
        labelCenter,
        { x: labelCenter.x - labelHalfWidth, y: labelCenter.y - labelHalfHeight },
        { x: labelCenter.x + labelHalfWidth, y: labelCenter.y - labelHalfHeight },
        { x: labelCenter.x - labelHalfWidth, y: labelCenter.y + labelHalfHeight },
        { x: labelCenter.x + labelHalfWidth, y: labelCenter.y + labelHalfHeight },
    ];

    let closestDistance = Number.POSITIVE_INFINITY;

    runwayLayout.forEach((layout) => {
        samplePoints.forEach((point) => {
            closestDistance = Math.min(
                closestDistance,
                distancePointToSegment(point, layout.start, layout.end),
                distanceBetweenPoints(point, layout.start),
                distanceBetweenPoints(point, layout.end)
            );
        });
    });

    return closestDistance;
}

function distancePointToSegment(
    point: SvgPoint,
    segmentStart: SvgPoint,
    segmentEnd: SvgPoint
): number {
    const dx = segmentEnd.x - segmentStart.x;
    const dy = segmentEnd.y - segmentStart.y;
    const lengthSquared = dx * dx + dy * dy;

    if (lengthSquared === 0) {
        return distanceBetweenPoints(point, segmentStart);
    }

    const t = Math.max(
        0,
        Math.min(
            1,
            ((point.x - segmentStart.x) * dx + (point.y - segmentStart.y) * dy) /
            lengthSquared
        )
    );

    return distanceBetweenPoints(point, {
        x: segmentStart.x + t * dx,
        y: segmentStart.y + t * dy,
    });
}

function distanceBetweenPoints(pointA: SvgPoint, pointB: SvgPoint): number {
    return Math.hypot(pointA.x - pointB.x, pointA.y - pointB.y);
}

function CompassFeatureMarker({
    layout,
    labelSide,
    onOrientToInflight,
}: {
    layout: AirportMapFeatureLayout;
    labelSide: InflightLabelSide;
    onOrientToInflight: () => void;
}) {
    const { point } = layout;

    const labelX =
        labelSide === "left" ? -22 : labelSide === "right" ? 22 : 0;

    const labelLineOneY = labelSide === "middle" ? 5 : -13;
    const labelLineTwoY = labelSide === "middle" ? 12 : -6;

    return (
        <g transform={`translate(${point.x} ${point.y})`}>
            <g
                data-compass-control="true"
                style={{ cursor: "pointer", outline: "none" }}
                onClick={(event) => {
                    event.stopPropagation();
                    onOrientToInflight();
                }}
                onMouseDown={(event) => {
                    event.preventDefault();
                }}
            >
                <title>Orient to inflight view</title>

                <circle cx="0" cy="-13" r="12" fill="transparent" />

                <image
                    href="/icons/ping_icon.png"
                    x="-11"
                    y="-22"
                    width="22"
                    height="22"
                    preserveAspectRatio="xMidYMid meet"
                    pointerEvents="none"
                />
            </g>

            <text
                x={labelX}
                y={labelLineOneY}
                textAnchor="middle"
                dominantBaseline="middle"
                fill="#e6c76f"
                fontSize="6.5"
                fontWeight="750"
                letterSpacing="0.25"
                pointerEvents="none"
            >
                Inflight
            </text>

            <text
                x={labelX}
                y={labelLineTwoY}
                textAnchor="middle"
                dominantBaseline="middle"
                fill="#e6c76f"
                fontSize="6.5"
                fontWeight="750"
                letterSpacing="0.25"
                pointerEvents="none"
            >
                Aviation
            </text>
        </g>
    );
}

function CompassVisibilityBadge({ label }: { label: string }) {
    return (
        <g pointerEvents="none">
            <image
                href="/icons/visibility.png"
                x="18"
                y="19"
                width="24"
                height="24"
                preserveAspectRatio="xMidYMid meet"
            />

            <text
                x="48"
                y="32"
                dominantBaseline="middle"
                fill="#e6c76f"
                fontSize="13"
                fontWeight="850"
            >
                {label}
            </text>
        </g>
    );
}

function CompassHeadingPointer({ label }: { label: string }) {
    return (
        <g pointerEvents="none">
            <rect
                x="169"
                y="15"
                width="62"
                height="22"
                rx="11"
                fill="#050505"
                stroke="#ef4444"
                strokeWidth="1.2"
            />

            <text
                x="200"
                y="27"
                textAnchor="middle"
                dominantBaseline="middle"
                fill="#fecaca"
                fontSize="11"
                fontWeight="900"
            >
                {label}
            </text>

            <path
                d="M 200 50 L 190 34 L 210 34 Z"
                fill="#ef4444"
                stroke="#fecaca"
                strokeWidth="0.8"
            />
        </g>
    );
}

function WindDirectionArrow({
    center,
    radius,
    windDisplayAngle,
}: {
    center: number;
    radius: number;
    windDisplayAngle: number | null;
}) {
    if (windDisplayAngle === null) {
        return null;
    }

    const startY = center - radius + 25;
    const endY = center + radius - 22;

    return (
        <g
            clipPath="url(#wind-field-clip)"
            pointerEvents="none"
            opacity="0.88"
            transform={`rotate(${windDisplayAngle} ${center} ${center})`}
        >
            {/* Bigger arrowhead at the wind source/start */}
            <path
                d={`
                    M ${center} ${startY}
                    L ${center - 12} ${startY - 18}
                    M ${center} ${startY}
                    L ${center + 12} ${startY - 18}
                `}
                fill="none"
                stroke="#e6c76f"
                strokeWidth="6"
                strokeLinecap="round"
                strokeLinejoin="round"
            />

            {/* Dashed wind direction line across the compass */}
            <line
                x1={center}
                y1={startY + 12}
                x2={center}
                y2={endY}
                stroke="#e6c76f"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeDasharray="7 9"
            />
        </g>
    );
}

function WindModeIcon({
    mode,
    x,
    y,
}: {
    mode: WindDisplayMode;
    x: number;
    y: number;
}) {
    const iconHref =
        mode === "animated"
            ? "/icons/wind_icon.png"
            : mode === "direction"
                ? "/icons/wind_arrow_icon.png"
                : "/icons/wind_hidden_icon.png";

    return (
        <image
            href={iconHref}
            x={x - 15}
            y={y - 15}
            width="30"
            height="30"
            preserveAspectRatio="xMidYMid meet"
        />
    );
}

function getWindSnakeFlowPath({
    laneX,
    spawnY,
    exitY,
    amplitude,
    phase,
    waveCount,
}: {
    laneX: number;
    spawnY: number;
    exitY: number;
    amplitude: number;
    phase: number;
    waveCount: number;
}): string {
    const steps = 100;
    const points = Array.from({ length: steps + 1 }, (_, index) => {
        const t = index / steps;
        const y = spawnY + (exitY - spawnY) * t;

        const edgeFade = Math.sin(Math.PI * t);
        const x =
            laneX +
            Math.sin(phase + t * waveCount * Math.PI * 2) *
            amplitude *
            edgeFade;

        return `${x.toFixed(1)} ${y.toFixed(1)}`;
    });

    return `M ${points[0]} ` + points.slice(1).map((point) => `L ${point}`).join(" ");
}

function WindFieldAnimation({
    center,
    radius,
    windDisplayAngle,
    windSpeedKt,
}: {
    center: number;
    radius: number;
    windDisplayAngle: number | null;
    windSpeedKt: number;
}) {
    if (windDisplayAngle === null || windSpeedKt <= 0) {
        return null;
    }

    const windIntensity = Math.min(windSpeedKt / 30, 1);

    const flowDuration = Math.max(1.1, 7.2 - windSpeedKt * 0.17);
    const slitherDuration = Math.max(1.1, 3.4 - windIntensity * 1.3);

    const streamAmplitude = 3.0 + windIntensity * 6.0;
    const waveCount = 5.0 + windIntensity * 4.0;

    const strokeWidth =
        windSpeedKt >= 20 ? 2 : windSpeedKt >= 10 ? 1.65 : 1.35;

    const spawnY = -radius - 115;
    const exitY = radius + 115;

    const pathMeasure = 1000;

    function randomUnit(seed: number): number {
        const x = Math.sin(seed * 9999) * 10000;
        return x - Math.floor(x);
    }

    function randomRange(seed: number, min: number, max: number): number {
        return min + randomUnit(seed) * (max - min);
    }

    const streamCount = Math.round(15 + windIntensity * 15);
    const laneSpread = radius * 1.06;

    const windStreams = Array.from({ length: streamCount }, (_, index) => {
        const seed = index * 41.91 + windSpeedKt * 0.77;

        const baseLaneX =
            streamCount === 1
                ? 0
                : -laneSpread + (index / (streamCount - 1)) * laneSpread * 2;

        return {
            laneX: baseLaneX + randomRange(seed + 1, -8, 8),
            phase: randomRange(seed + 2, 0, Math.PI * 2),
            delay: Number((-randomRange(seed + 3, 0, flowDuration)).toFixed(2)),
            opacity: Number(randomRange(seed + 4, 0.3, 0.7).toFixed(2)),
            visibleLength: Math.round(randomRange(seed + 5, 50, 200)),
            amplitudeScale: randomRange(seed + 6, 0.75, 1.25),
        };
    });

    return (
        <g clipPath="url(#wind-field-clip)" pointerEvents="none">
            <g transform={`translate(${center} ${center}) rotate(${windDisplayAngle})`}>
                {windStreams.map((stream, index) => {
                    const amplitude = streamAmplitude * stream.amplitudeScale;

                    const pathA = getWindSnakeFlowPath({
                        laneX: stream.laneX,
                        spawnY,
                        exitY,
                        amplitude,
                        phase: stream.phase,
                        waveCount,
                    });

                    const pathB = getWindSnakeFlowPath({
                        laneX: stream.laneX,
                        spawnY,
                        exitY,
                        amplitude: amplitude * 1.15,
                        phase: stream.phase + Math.PI * 0.65,
                        waveCount,
                    });

                    const pathC = getWindSnakeFlowPath({
                        laneX: stream.laneX,
                        spawnY,
                        exitY,
                        amplitude: amplitude * 0.85,
                        phase: stream.phase + Math.PI * 1.25,
                        waveCount,
                    });

                    return (
                        <path
                            key={index}
                            d={pathA}
                            fill="none"
                            stroke="#e6c76f"
                            strokeWidth={strokeWidth}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            opacity={stream.opacity}
                            pathLength={pathMeasure}
                            strokeDasharray={`${stream.visibleLength} ${pathMeasure}`}
                            strokeDashoffset={pathMeasure}
                        >
                            <animate
                                attributeName="stroke-dashoffset"
                                from={pathMeasure}
                                to={-stream.visibleLength}
                                dur={`${flowDuration}s`}
                                begin={`${stream.delay}s`}
                                repeatCount="indefinite"
                            />

                            <animate
                                attributeName="d"
                                values={`${pathA}; ${pathB}; ${pathC}; ${pathA}`}
                                dur={`${slitherDuration}s`}
                                begin={`${stream.delay}s`}
                                repeatCount="indefinite"
                            />
                        </path>
                    );
                })}
            </g>
        </g>
    );
}

function RunwayStatusBadge({
    activeRunway,
    selectedEnd,
}: {
    activeRunway: CalculatedRunwayEnd;
    selectedEnd: RunwayEnd | null;
}) {
    const label = selectedEnd
        ? `RWY ${activeRunway.ident}`
        : `BEST RWY ${activeRunway.ident}`;

    return (
        <g>
            <rect
                x="120"
                y="10"
                width="160"
                height="34"
                rx="17"
                fill="#050505"
                stroke="#3f3f46"
            />

            <text
                x="200"
                y="28"
                textAnchor="middle"
                dominantBaseline="middle"
                fill="#e6c76f"
                fontSize="12"
                fontWeight="850"
            >
                {label}
            </text>
        </g>
    );
}

function WindComponentStack({
    component,
    x,
    y,
}: {
    component: RunwayWindComponent;
    x: number;
    y: number;
}) {
    const isTailwind = component.headwindKt < 0;

    return (
        <g transform={`translate(${x} ${y})`}>
            {/* Headwind / tailwind component */}
            <g transform="translate(0 0)">
                <path
                    d={
                        isTailwind
                            ? "M 0 10 L 0 -10 M -5 -5 L 0 -10 L 5 -5"
                            : "M 0 -10 L 0 10 M -5 5 L 0 10 L 5 5"
                    }
                    fill="none"
                    stroke="#e6c76f"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                />

                <text
                    x="18"
                    y="1"
                    textAnchor="start"
                    dominantBaseline="middle"
                    fill="#e6c76f"
                    fontSize="13"
                    fontWeight="850"
                >
                    {Math.abs(component.headwindKt)} kt
                </text>
            </g>

            {/* Crosswind component */}
            <g transform="translate(0 24)">
                {component.crosswindFrom === "left" && (
                    <path
                        d="M -9 0 L 10 0 M 5 -5 L 10 0 L 5 5"
                        fill="none"
                        stroke="#e6c76f"
                        strokeWidth="2.4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    />
                )}

                {component.crosswindFrom === "right" && (
                    <path
                        d="M 9 0 L -10 0 M -5 -5 L -10 0 L -5 5"
                        fill="none"
                        stroke="#e6c76f"
                        strokeWidth="2.4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    />
                )}

                {component.crosswindFrom === "centerline" && (
                    <path
                        d="M -10 0 L 10 0"
                        fill="none"
                        stroke="#e6c76f"
                        strokeWidth="2.4"
                        strokeLinecap="round"
                    />
                )}

                <text
                    x="18"
                    y="1"
                    textAnchor="start"
                    dominantBaseline="middle"
                    fill="#e6c76f"
                    fontSize="13"
                    fontWeight="850"
                >
                    {component.crosswindKt} kt
                </text>
            </g>
        </g>
    );
}

type CriteriaStatus = "pass" | "warn" | "fail";

const CRITERIA_STATUS_STYLES: Record<
    CriteriaStatus,
    { bg: string; text: string; icon: string }
> = {
    pass: { bg: "bg-emerald-400", text: "text-emerald-950", icon: "✓" },
    warn: { bg: "bg-amber-400", text: "text-amber-950", icon: "!" },
    fail: { bg: "bg-red-400", text: "text-red-950", icon: "×" },
};

function CriteriaDot({ status }: { status: CriteriaStatus }) {
    const style = CRITERIA_STATUS_STYLES[status];

    return (
        <span
            className={`flex h-4 w-4 flex-none items-center justify-center rounded-full text-[10px] font-black leading-none ${style.bg} ${style.text}`}
        >
            {style.icon}
        </span>
    );
}

const OVERALL_STATUS_LABELS: Record<CriteriaStatus, string> = {
    pass: "Go",
    warn: "Caution",
    fail: "No-Go",
};

const OVERALL_STATUS_STYLES: Record<CriteriaStatus, string> = {
    pass: "border-emerald-400/50 bg-emerald-400/15 text-emerald-200",
    warn: "border-amber-400/50 bg-amber-400/15 text-amber-200",
    fail: "border-red-400/50 bg-red-400/15 text-red-200",
};

function OverallStatusIndicator({ status }: { status: CriteriaStatus }) {
    return (
        <span
            className={`ml-auto flex-none rounded-full border px-2 py-1 text-[10px] font-black uppercase tracking-[0.08em] ${OVERALL_STATUS_STYLES[status]}`}
        >
            {OVERALL_STATUS_LABELS[status]}
        </span>
    );
}

function WeatherMinimumsPanel({
    metar,
    bestRunway,
}: {
    metar: NormalizedMetar;
    bestRunway: CalculatedRunwayEnd | undefined;
}) {
    const windKt = metar.wind.gustKt ?? metar.wind.speedKt ?? 0;
    const ceilingFtAgl = metar.ceiling.feetAgl;
    const visibilitySm = metar.visibility.statuteMiles;
    const crosswindKt = bestRunway?.component.crosswindKt ?? null;

    const rows = OPERATIONAL_MINIMUMS.map((minimum) => {
        const ceilingOk =
            minimum.ceilingFtAgl === null ||
            ceilingFtAgl === null ||
            ceilingFtAgl >= minimum.ceilingFtAgl;

        const visibilityOk =
            minimum.visibilitySm === null ||
            visibilitySm === null ||
            visibilitySm >= minimum.visibilitySm;

        const windOk = windKt <= minimum.maxWindsKt;

        const crosswindOk =
            typeof minimum.crosswindKt !== "number" ||
            crosswindKt === null ||
            crosswindKt <= minimum.crosswindKt;

        return {
            minimum,
            passes: ceilingOk && visibilityOk && windOk && crosswindOk,
        };
    });

    const failCount = rows.filter((row) => !row.passes).length;
    const overall: CriteriaStatus =
        failCount === 0 ? "pass" : failCount === rows.length ? "fail" : "warn";

    return (
        <div className="flex flex-col pl-3">
            <p className="flex flex-wrap items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.2em] text-[#d6b35a]">
                <span className="whitespace-nowrap">Weather Minimums</span>
                <InfoTooltip text="Compares the current METAR (and best-runway crosswind) against Inflight's operational minimums for each type of flight. Go means every category is flyable, caution means only some are, and no-go means none are." />
                <OverallStatusIndicator status={overall} />
            </p>

            <div className="mt-2 flex flex-col divide-y divide-zinc-800/70">
                {rows.map(({ minimum, passes }) => (
                    <div
                        key={minimum.operation}
                        className="flex items-center gap-2.5 py-2.5 text-sm font-semibold text-zinc-200"
                    >
                        <CriteriaDot status={passes ? "pass" : "fail"} />
                        {minimum.label}
                    </div>
                ))}
            </div>
        </div>
    );
}

function getNightStackingStatus(
    taf: TafResponse | null,
    timeZone?: string | null,
    latitude?: number | null,
    longitude?: number | null
): {
    wind: CriteriaStatus;
    precip: CriteriaStatus;
    thunderstorms: CriteriaStatus;
    hasData: boolean;
} {
    if (!taf) {
        return { wind: "pass", precip: "pass", thunderstorms: "pass", hasData: false };
    }

    const slots = buildTafHourlySlots(taf, timeZone, latitude, longitude);
    const nightSlots = slots.filter((slot) => slot.isNightCurrency);

    if (nightSlots.length === 0) {
        return { wind: "pass", precip: "pass", thunderstorms: "pass", hasData: false };
    }

    const maxWindKt = Math.max(
        0,
        ...nightSlots.map((slot) => Number(slot.block.windSpeedKt ?? 0))
    );

    const wind: CriteriaStatus =
        maxWindKt > NIGHT_STACKING_RAMP_ELIGIBILITY.maxSustainedWindsKt
            ? "fail"
            : maxWindKt >= NIGHT_STACKING_RAMP_ELIGIBILITY.maxSustainedWindsKt - 2
                ? "warn"
                : "pass";

    // Any forecasted precip or storms — PROB or otherwise — violates the flat
    // "0% precip" / "no storms" requirement, so it's a hard fail, not a caution.
    const hasPrecip = nightSlots.some(
        (slot) => getPrecipChanceLabel(slot.block.weather) !== null
    );

    const hasThunderstorms = nightSlots.some((slot) =>
        (slot.block.weather ?? "").toUpperCase().includes("TS")
    );

    // "Evolving" risk: nothing forecast has crossed the line yet, but TEMPO
    // groups or a low broken/overcast ceiling suggest unsettled conditions
    // that could still tip into precip or storms overnight.
    const hasTempo = nightSlots.some((slot) =>
        (slot.block.change ?? "").toUpperCase().includes("TEMPO")
    );

    const hasLowBrokenOrOvercastCeiling = nightSlots.some((slot) =>
        (slot.block.sky ?? []).some((layer) => {
            const cover = (layer.cover ?? "").toUpperCase();
            const base = layer.baseFtAgl;

            return (
                (cover === "BKN" || cover === "OVC") &&
                base !== null &&
                base !== undefined &&
                base < 3000
            );
        })
    );

    const evolvingRisk = hasTempo || hasLowBrokenOrOvercastCeiling;

    const precip: CriteriaStatus = hasPrecip ? "fail" : evolvingRisk ? "warn" : "pass";
    const thunderstorms: CriteriaStatus = hasThunderstorms
        ? "fail"
        : evolvingRisk
            ? "warn"
            : "pass";

    return { wind, precip, thunderstorms, hasData: true };
}

function NightStackingPanel({
    taf,
    timeZone,
    latitude,
    longitude,
}: {
    taf: TafResponse | null;
    timeZone?: string | null;
    latitude?: number | null;
    longitude?: number | null;
}) {
    const status = getNightStackingStatus(taf, timeZone, latitude, longitude);

    const rows = [
        {
            key: "wind",
            label: `Winds ≤ ${NIGHT_STACKING_RAMP_ELIGIBILITY.maxSustainedWindsKt} kt overnight`,
            status: status.wind,
        },
        {
            key: "precip",
            label: "No overnight precip forecast",
            status: status.precip,
        },
        {
            key: "storms",
            label: `No storms within ${NIGHT_STACKING_RAMP_ELIGIBILITY.thunderstormFreeRadiusNm} NM overnight`,
            status: status.thunderstorms,
        },
    ];

    const overall: CriteriaStatus = rows.some((row) => row.status === "fail")
        ? "fail"
        : rows.some((row) => row.status === "warn")
            ? "warn"
            : "pass";

    return (
        <div className="flex flex-col pl-3">
            <p className="flex flex-wrap items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.2em] text-[#d6b35a]">
                <span className="whitespace-nowrap">Night Stacking</span>
                <InfoTooltip text="Whether tonight's TAF supports leaving a non-Cirrus aircraft on the ramp overnight instead of hangaring it, per Inflight's ramp-eligibility criteria. These thresholds are specific to Inflight's KFCM ramp operations. No-go means the forecast already crosses the line; caution means conditions look unsettled (TEMPO groups or a low ceiling) and could still turn red." />
                {status.hasData && <OverallStatusIndicator status={overall} />}
            </p>

            {status.hasData ? (
                <div className="mt-2 flex flex-col divide-y divide-zinc-800/70">
                    {rows.map((row) => (
                        <div
                            key={row.key}
                            className="flex items-center gap-2.5 py-2.5 text-sm font-semibold text-zinc-200"
                        >
                            <CriteriaDot status={row.status} />
                            {row.label}
                        </div>
                    ))}
                </div>
            ) : (
                <p className="mt-2 text-sm text-zinc-500">Loading overnight forecast…</p>
            )}
        </div>
    );
}

function CloudCeilingPreviewSvg({
    metar,
    fullscreen = false,
}: {
    metar: NormalizedMetar;
    fullscreen?: boolean;
    }) {
    const ceiling = metar.ceiling.feetAgl;

    const cloudLayers = metar.clouds
        .filter((cloud) => cloud.baseFeetAgl !== null)
        .slice(0, 5);

    const highestCloudBase = Math.max(
        0,
        ...cloudLayers.map((cloud) => cloud.baseFeetAgl ?? 0),
        ceiling ?? 0
    );

    const scaleTopFeet = Math.max(
        6000,
        Math.ceil((highestCloudBase + 1200) / 3000) * 3000
    );

    const altitudeTicks = buildAltitudeTicks(scaleTopFeet);

    const graphTop = 35;
    const graphBottom = 365;
    const graphHeight = graphBottom - graphTop;

    function altitudeToY(feet: number): number {
        const cappedFeet = Math.min(Math.max(feet, 0), scaleTopFeet);
        return graphBottom - (cappedFeet / scaleTopFeet) * graphHeight;
    }

    const graphLeft = 42;
    const graphRight = 300;
    const textX = 372;

    return (
        <svg
            viewBox="0 0 400 400"
            className={
                fullscreen
                    ? "h-full w-full max-h-full max-w-full rounded-2xl bg-transparent"
                    : "h-auto w-full rounded-2xl bg-transparent"
            }
            role="img"
            aria-label="Cloud and ceiling visualization"
        >

            {altitudeTicks.map((altitude) => {
                const y = altitudeToY(altitude);

                return (
                    <g key={altitude}>
                        <line
                            x1={graphLeft}
                            y1={y}
                            x2={graphRight}
                            y2={y}
                            stroke="#27272a"
                            strokeWidth="1"
                            strokeDasharray="4 6"
                        />

                        <text
                            x="30"
                            y={y}
                            textAnchor="end"
                            dominantBaseline="middle"
                            fill="#71717a"
                            fontSize="10"
                            fontWeight="600"
                        >
                            {altitude === 0 ? "SFC" : formatAltitudeTick(altitude)}
                        </text>
                    </g>
                );
            })}

            <rect
                x={graphLeft}
                y={graphBottom}
                width={graphRight - graphLeft}
                height="10"
                rx="5"
                fill="#3f3f46"
            />

            {cloudLayers.length > 0 ? (
                cloudLayers.map((cloud, index) => {
                    const baseFeet = cloud.baseFeetAgl ?? 0;
                    const y = altitudeToY(baseFeet);
                    const cloudEighths = getCloudEighths(cloud.cover);
                    const isCeilingLayer =
                        ceiling !== null &&
                        baseFeet === ceiling &&
                        isCeilingCloudCover(cloud.cover);

                    return (
                        <g key={`${cloud.cover}-${baseFeet}-${index}`}>
                            <line
                                x1={graphLeft}
                                y1={y}
                                x2={graphRight}
                                y2={y}
                                stroke={isCeilingLayer ? "#e6c76f" : "#ffffff"}
                                strokeWidth={isCeilingLayer ? "3" : "1.5"}
                                opacity={isCeilingLayer ? "1" : "0.7"}
                                strokeLinecap="round"
                            />

                            <CloudCoverageIcons
                                lineStartX={graphLeft}
                                lineEndX={graphRight}
                                y={y - 27}
                                eighths={cloudEighths}
                                layerIndex={index}
                            />

                            <text
                                x={textX}
                                y={y}
                                textAnchor="end"
                                dominantBaseline="middle"
                                fill={isCeilingLayer ? "#e6c76f" : "#ffffff"}
                                opacity={isCeilingLayer ? "1" : "0.9"}
                                fontSize="9.5"
                                fontWeight="550"
                            >
                                {cloud.cover} {baseFeet.toLocaleString()} ft
                            </text>
                        </g>
                    );
                })
            ) : (
                <g>
                    <text
                        x="170"
                        y="200"
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fill="#d4d4d8"
                        fontSize="18"
                        fontWeight="800"
                    >
                        CLR
                    </text>
                </g>
            )}
        </svg>
    );
}

function CloudCoverageIcons({
    lineStartX,
    lineEndX,
    y,
    eighths,
    layerIndex,
}: {
    lineStartX: number;
    lineEndX: number;
    y: number;
    eighths: number;
    layerIndex: number;
}) {
    if (eighths <= 0) {
        return null;
    }

    const iconWidth = 50;
    const iconHeight = 40;

    const segmentCount = 8;
    const lineLength = lineEndX - lineStartX;
    const segmentWidth = lineLength / segmentCount;

    const chosenSegments = getRandomCoverageSegments(eighths, layerIndex);

    return (
        <g pointerEvents="none">
            {chosenSegments.flatMap((segmentIndex, segmentOrder) => {
                const cloudCount = getCloudCountForSegment(segmentIndex, layerIndex);
                const segmentStartX = lineStartX + segmentIndex * segmentWidth;

                return Array.from({ length: cloudCount }).map((_, cloudIndex) => {
                    const progress =
                        cloudCount === 1
                            ? 0.5
                            : (cloudIndex + 1) / (cloudCount + 1);

                    const baseX = segmentStartX + segmentWidth * progress;

                    const jitterX =
                        getSegmentCloudJitter(segmentIndex, layerIndex, cloudIndex) *
                        (segmentWidth * 0.12);

                    const jitterY =
                        getVerticalCloudJitter(segmentIndex, layerIndex, cloudIndex);

                    const variant = getCloudImageVariant(
                        cloudIndex + segmentOrder,
                        layerIndex + segmentIndex
                    );

                    const iconHref =
                        variant === 1
                            ? "/icons/cloud.png"
                            : variant === 2
                                ? "/icons/cloud_long.png"
                                : "/icons/cloud_cirrus.png";

                    const scale = getCloudScale(segmentIndex, layerIndex, cloudIndex);

                    return (
                        <image
                            key={`${segmentIndex}-${cloudIndex}`}
                            href={iconHref}
                            x={baseX + jitterX - (iconWidth * scale) / 2}
                            y={y + jitterY}
                            width={iconWidth * scale}
                            height={iconHeight * scale}
                            preserveAspectRatio="xMidYMid meet"
                            opacity="0.95"
                        />
                    );
                });
            })}
        </g>
    );
}

function getCloudCountForSegment(segmentIndex: number, layerIndex: number): number {
    return pseudoRandom(segmentIndex * 13.17 + layerIndex * 27.41) > 0.5 ? 3 : 2;
}

function getSegmentCloudJitter(
    segmentIndex: number,
    layerIndex: number,
    cloudIndex: number
): number {
    return (
        pseudoRandom(segmentIndex * 19.31 + layerIndex * 11.73 + cloudIndex * 7.19) * 2 -
        1
    );
}

function getVerticalCloudJitter(
    segmentIndex: number,
    layerIndex: number,
    cloudIndex: number
): number {
    return (
        pseudoRandom(segmentIndex * 23.11 + layerIndex * 9.41 + cloudIndex * 5.03) * 6 -
        3
    );
}

function getCloudScale(
    segmentIndex: number,
    layerIndex: number,
    cloudIndex: number
): number {
    return 0.9 + pseudoRandom(segmentIndex * 17.77 + layerIndex * 14.13 + cloudIndex * 3.91) * 0.35;
}

function getRandomCoverageSegments(
    eighths: number,
    layerIndex: number
): number[] {
    const segmentIndices = Array.from({ length: 8 }, (_, index) => index);

    const shuffled = [...segmentIndices].sort((a, b) => {
        return pseudoRandom(a + layerIndex * 10.37) - pseudoRandom(b + layerIndex * 10.37);
    });

    return shuffled.slice(0, Math.min(eighths, 8)).sort((a, b) => a - b);
}

function pseudoRandom(seed: number): number {
    const x = Math.sin(seed * 91.345) * 10000;
    return x - Math.floor(x);
}

function getCloudImageVariant(index: number, layerIndex: number): 1 | 2 | 3 {
    const value = pseudoRandom((index + 1) * 17.21 + (layerIndex + 1) * 43.77);

    if (value < 0.333) return 1;
    if (value < 0.666) return 2;
    return 3;
}

function getCloudEighths(cover: string): number {
    const normalizedCover = cover.toUpperCase();

    if (normalizedCover === "CLR" || normalizedCover === "SKC" || normalizedCover === "NSC") {
        return 0;
    }

    if (normalizedCover === "FEW") {
        return 1;
    }

    if (normalizedCover === "SCT") {
        return 3;
    }

    if (normalizedCover === "BKN") {
        return 6;
    }

    if (normalizedCover === "OVC" || normalizedCover === "VV") {
        return 8;
    }

    return 1;
}

function isCeilingCloudCover(cover: string): boolean {
    const normalizedCover = cover.toUpperCase();

    return (
        normalizedCover === "BKN" ||
        normalizedCover === "OVC" ||
        normalizedCover === "VV"
    );
}

function buildAltitudeTicks(scaleTopFeet: number): number[] {
    const step =
        scaleTopFeet <= 6000
            ? 2000
            : scaleTopFeet <= 12000
                ? 3000
                : scaleTopFeet <= 24000
                    ? 6000
                    : 10000;

    const ticks: number[] = [];

    for (let altitude = 0; altitude <= scaleTopFeet; altitude += step) {
        ticks.push(altitude);
    }

    if (ticks[ticks.length - 1] !== scaleTopFeet) {
        ticks.push(scaleTopFeet);
    }

    return ticks;
}

function formatAltitudeTick(feet: number): string {
    if (feet >= 10000) {
        return `${Math.round(feet / 1000)}k`;
    }

    return `${feet / 1000}k`;
}

function CompassRunwayPair({
    layout,
    runwayEnds,
    selectedEnd,
    bestRunwayIdent,
    onSelectEnd,
}: {
    layout: RunwayLayout;
    runwayEnds: RunwayEnd[];
    selectedEnd: RunwayEnd | null;
    bestRunwayIdent: string | null;
    onSelectEnd: (runwayEnd: RunwayEnd) => void;
}) {
    const { runway, start, end } = layout;

    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const runwayLength = Math.sqrt(dx * dx + dy * dy);
    const runwayAngleDeg = (Math.atan2(dy, dx) * 180) / Math.PI - 90;

    const midpointX = (start.x + end.x) / 2;
    const midpointY = (start.y + end.y) / 2;

    const runwayWidth =
        runway.widthFt !== null && runway.widthFt >= 100 ? 18 : 14;

    const endA = runwayEnds.find(
        (runwayEnd) =>
            runwayEnd.runwayId === runway.id &&
            runwayEnd.ident === runway.endA.ident
    );

    const endB = runwayEnds.find(
        (runwayEnd) =>
            runwayEnd.runwayId === runway.id &&
            runwayEnd.ident === runway.endB.ident
    );

    const isSelected =
        selectedEnd?.ident === runway.endA.ident ||
        selectedEnd?.ident === runway.endB.ident;

    const isBest =
        bestRunwayIdent === runway.endA.ident ||
        bestRunwayIdent === runway.endB.ident;

    const runwayFill = isSelected
        ? "#737373"
        : isBest
            ? "#5a5a5a"
            : "#606060";

    const runwayStroke = isSelected
        ? "#f5d77e"
        : isBest
            ? "#d4d4d8"
            : "#a1a1aa";

    const thresholdStripeCount = 4;
    const thresholdStripeWidth = 1.8;
    const thresholdStripeGap = 1.5;
    const thresholdStripeHeight = 10;
    const thresholdInset = 2;

    const totalThresholdWidth =
        thresholdStripeCount * thresholdStripeWidth +
        (thresholdStripeCount - 1) * thresholdStripeGap;

    const thresholdStartX = -totalThresholdWidth / 2;

    const centerlineStartY =
        -runwayLength / 2 + thresholdInset + thresholdStripeHeight + 4;

    const centerlineEndY =
        runwayLength / 2 - thresholdInset - thresholdStripeHeight - 4;

    const labelOffset = 8;
    const labelFontSize = 8;

    return (
        <g
            transform={`translate(${midpointX} ${midpointY}) rotate(${runwayAngleDeg})`}
            style={{ cursor: "pointer" }}
        >
            {/* Runway body */}
            <rect
                x={-runwayWidth / 2}
                y={-runwayLength / 2}
                width={runwayWidth}
                height={runwayLength}
                rx="3"
                fill={runwayFill}
                stroke={runwayStroke}
                strokeWidth="0.9"
                opacity="0.96"
            />

            {/* Center dashed line now extends close to the threshold stripes */}
            <line
                x1="0"
                y1={centerlineStartY}
                x2="0"
                y2={centerlineEndY}
                stroke="#f8fafc"
                strokeWidth="1.2"
                strokeDasharray="8 6"
                opacity="0.9"
            />

            {/* Threshold stripes - top end */}
            {Array.from({ length: thresholdStripeCount }).map((_, index) => (
                <rect
                    key={`top-threshold-${index}`}
                    x={
                        thresholdStartX +
                        index * (thresholdStripeWidth + thresholdStripeGap)
                    }
                    y={-runwayLength / 2 + thresholdInset}
                    width={thresholdStripeWidth}
                    height={thresholdStripeHeight}
                    fill="#ffffff"
                    opacity="0.95"
                />
            ))}

            {/* Threshold stripes - bottom end */}
            {Array.from({ length: thresholdStripeCount }).map((_, index) => (
                <rect
                    key={`bottom-threshold-${index}`}
                    x={
                        thresholdStartX +
                        index * (thresholdStripeWidth + thresholdStripeGap)
                    }
                    y={runwayLength / 2 - thresholdInset - thresholdStripeHeight}
                    width={thresholdStripeWidth}
                    height={thresholdStripeHeight}
                    fill="#ffffff"
                    opacity="0.95"
                />
            ))}

            {/* Runway identifiers outside the runway ends */}
            {endA && (
                <g
                    data-compass-control="true"
                    onClick={(event) => {
                        event.stopPropagation();
                        onSelectEnd(endA);
                    }}
                >
                    <title>{`View from runway ${endA.ident}`}</title>

                    <text
                        x="0"
                        y={-runwayLength / 2 - labelOffset}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fill="#ffffff"
                        fontSize={labelFontSize}
                        fontWeight="800"
                        transform={`rotate(180 0 ${-runwayLength / 2 - labelOffset})`}
                    >
                        {endA.ident}
                    </text>

                    <circle
                        cx="0"
                        cy={-runwayLength / 2 - labelOffset}
                        r="9"
                        fill="transparent"
                    />
                </g>
            )}

            {endB && (
                <g
                    data-compass-control="true"
                    onClick={(event) => {
                        event.stopPropagation();
                        onSelectEnd(endB);
                    }}
                >
                    <title>{`View from runway ${endB.ident}`}</title>

                    <text
                        x="0"
                        y={runwayLength / 2 + labelOffset}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fill="#ffffff"
                        fontSize={labelFontSize}
                        fontWeight="800"
                    >
                        {endB.ident}
                    </text>

                    <circle
                        cx="0"
                        cy={runwayLength / 2 + labelOffset}
                        r="9"
                        fill="transparent"
                    />
                </g>
            )}
        </g>
    );
}

function RemarksSection({ remarks }: { remarks: string | null }) {
    const remarkBubbles = getRemarkBubbles(remarks);

    if (remarkBubbles.length === 0) {
        return null;
    }

    return (
        <div className="mt-6 rounded-2xl border border-zinc-800 bg-black/55 p-5">
            <div className="mb-4 flex items-center gap-4">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#d6b35a]">
                    Remarks
                </p>
                <div className="h-px flex-1 bg-zinc-800" />
            </div>

            <div className="space-y-3">
                {remarkBubbles.map((remark, index) => (
                    <div
                        key={`${index}-${remark.code}`}
                        className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-4 py-3"
                    >
                        <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-zinc-400">
                            {remark.code}
                        </p>
                        <p className="mt-1 text-xs leading-5 text-zinc-200">
                            {remark.meaning}
                        </p>
                    </div>
                ))}
            </div>
        </div>
    );
}

function EmptyState() {
    return (
        <section className="mt-8 rounded-3xl border border-dashed border-zinc-800 bg-zinc-950/50 p-8 text-center">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[#d6b35a]">
                Ready
            </p>
            <h2 className="mt-2 text-2xl font-bold text-white">
                Fetch KFCM or decode a pasted METAR.
            </h2>
            <p className="mt-3 text-zinc-400">
                The decoded dashboard will appear here.
            </p>
        </section>
    );
}

type QuizDifficulty = "easy" | "amateur" | "expert";

type QuizQuestion = {
    id: string;
    label: string;
    level: QuizDifficulty;
    kind: "text" | "select" | "clouds";
    placeholder?: string;
    options?: string[];
    correctDisplay: string;
    isCorrect: (input: string) => boolean;
    getNote?: (input: string) => string | null;
};

const QUIZ_DIFFICULTY_ORDER: QuizDifficulty[] = ["easy", "amateur", "expert"];

const QUIZ_DIFFICULTY_LABELS: Record<QuizDifficulty, string> = {
    easy: "Beginner",
    amateur: "Amateur",
    expert: "Expert",
};

function parseQuizTimeInput(input: string): { hour: number; minute: number } | null {
    const match = input.trim().match(/(\d{1,2}):?(\d{2})?\s*(AM|PM)?/i);
    if (!match) return null;

    let hour = Number(match[1]);
    const minute = match[2] ? Number(match[2]) : 0;
    const meridiem = match[3]?.toUpperCase();

    if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
    if (meridiem === "PM" && hour < 12) hour += 12;
    if (meridiem === "AM" && hour === 12) hour = 0;

    return { hour: hour % 24, minute };
}

function getQuizLocalHourMinute(
    metar: NormalizedMetar,
    timeZone: string | null | undefined
): { hour: number; minute: number } | null {
    const observed = getObservationDateUtc(metar);
    if (!observed || !timeZone) return null;

    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
    }).formatToParts(observed);

    const hour = Number(parts.find((part) => part.type === "hour")?.value);
    const minute = Number(parts.find((part) => part.type === "minute")?.value);

    if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
    return { hour, minute };
}

function getQuizLocalZoneAbbreviation(
    metar: NormalizedMetar,
    timeZone: string | null | undefined
): string {
    const observed = getObservationDateUtc(metar);
    if (!observed || !timeZone) return "";

    try {
        const parts = new Intl.DateTimeFormat("en-US", {
            timeZone,
            timeZoneName: "short",
        }).formatToParts(observed);

        return parts.find((part) => part.type === "timeZoneName")?.value ?? "";
    } catch {
        return "";
    }
}

function parseQuizLocalTimeAnswer(input: string): { hour: number; minute: number } | null {
    const [hourText, minuteText, meridiem] = input.split("|");
    if (!hourText || !minuteText) return null;

    const hour12 = Number(hourText);
    const minute = Number(minuteText);
    if (Number.isNaN(hour12) || Number.isNaN(minute)) return null;

    const hour = (hour12 % 12) + (meridiem === "PM" ? 12 : 0);
    return { hour, minute };
}

function parseQuizNumber(input: string): number | null {
    const match = input.trim().match(/\d+(\.\d+)?/);
    if (!match) return null;
    const num = Number(match[0]);
    return Number.isNaN(num) ? null : num;
}

function parseQuizWindDirectionInput(input: string): {
    variable: boolean;
    direction: number | null;
} {
    const cleaned = input.trim().toUpperCase();
    if (/VRB|VARIABLE/.test(cleaned)) {
        return { variable: true, direction: null };
    }
    return { variable: false, direction: parseQuizNumber(cleaned) };
}

function parseQuizSignedTemp(input: string): number | null {
    const cleaned = input.trim().toUpperCase().replace(/^M(\d+)/, "-$1");
    const match = cleaned.match(/-?\d+/);
    if (!match) return null;
    const num = Number(match[0]);
    return Number.isNaN(num) ? null : num;
}

const QUIZ_CLOUD_COVER_OPTIONS: { value: string; label: string }[] = [
    { value: "FEW", label: "Few" },
    { value: "SCT", label: "Scattered" },
    { value: "BKN", label: "Broken" },
    { value: "OVC", label: "Overcast" },
    { value: "VV", label: "Vertical Visibility" },
    { value: "SKC", label: "Sky Clear" },
    { value: "CLR", label: "Clear" },
];

type QuizCloudEntry = { cover: string; base: string };

function serializeQuizCloudEntries(entries: QuizCloudEntry[]): string {
    return entries
        .filter((entry) => entry.cover)
        .map((entry) => `${entry.cover}:${entry.base}`)
        .join("|");
}

function parseQuizCloudAnswer(input: string): { cover: string; base: number | null }[] {
    return input
        .split("|")
        .filter(Boolean)
        .map((part) => {
            const [cover, base] = part.split(":");
            return {
                cover: (cover ?? "").toUpperCase(),
                base: base ? Number(base) : null,
            };
        });
}

function getQuizCloudLayerResults(
    metar: NormalizedMetar,
    userAnswerRaw: string
): { label: string; correct: boolean }[] {
    const entries = parseQuizCloudAnswer(userAnswerRaw);

    if (metar.clouds.length === 0) {
        return [
            {
                label: "CLR",
                correct: entries.some(
                    (entry) => entry.cover === "CLR" || entry.cover === "SKC"
                ),
            },
        ];
    }

    return metar.clouds.map((cloud) => ({
        label:
            cloud.baseFeetAgl !== null
                ? `${cloud.cover} ${cloud.baseFeetAgl.toLocaleString()}`
                : cloud.cover,
        correct: entries.some(
            (entry) =>
                entry.cover === cloud.cover &&
                (cloud.baseFeetAgl === null
                    ? entry.base === null
                    : entry.base === cloud.baseFeetAgl)
        ),
    }));
}

function parseQuizAltimeterInput(input: string): number | null {
    const cleaned = input.trim().toUpperCase().replace(/^A/, "");
    if (!cleaned.includes(".")) return null;

    const num = Number(cleaned);
    return Number.isNaN(num) ? null : num;
}

function isQuizAltimeterMissingDecimal(input: string, correctInHg: number): boolean {
    const cleaned = input.trim().toUpperCase().replace(/^A/, "");
    if (cleaned.includes(".")) return false;

    const digitsOnly = cleaned.replace(/[^\d]/g, "");
    if (digitsOnly.length !== 4) return false;

    return Math.abs(Number(digitsOnly) / 100 - correctInHg) < 0.005;
}

function buildQuizQuestions(
    metar: NormalizedMetar,
    timeZone: string | null | undefined
): QuizQuestion[] {
    const questions: QuizQuestion[] = [];

    const { hourUtc, minuteUtc } = metar.observed;
    if (hourUtc !== null && minuteUtc !== null) {
        questions.push({
            id: "zuluTime",
            label: "Observation time (Zulu)",
            level: "easy",
            kind: "text",
            placeholder: "e.g. 1453",
            correctDisplay: formatZuluObservation(metar),
            isCorrect: (input) => {
                const parsed = parseQuizTimeInput(input);
                return (
                    parsed !== null &&
                    parsed.hour === hourUtc &&
                    parsed.minute === minuteUtc
                );
            },
        });
    }

    const localTime = getQuizLocalHourMinute(metar, timeZone);
    if (localTime) {
        questions.push({
            id: "localStationTime",
            label: "Observation time (local)",
            level: "expert",
            kind: "text",
            correctDisplay: formatLocalObservation(metar, timeZone),
            isCorrect: (input) => {
                const parsed = parseQuizLocalTimeAnswer(input);
                return (
                    parsed !== null &&
                    parsed.hour === localTime.hour &&
                    parsed.minute === localTime.minute
                );
            },
        });
    }

    questions.push({
        id: "windDirection",
        label: "Wind direction (deg)",
        level: "easy",
        kind: "text",
        correctDisplay: metar.wind.variable
            ? "Variable"
            : metar.wind.directionDeg !== null
              ? `${metar.wind.directionDeg}°`
              : "Not reported",
        isCorrect: (input) => {
            const parsed = parseQuizWindDirectionInput(input);

            if (metar.wind.variable) {
                return parsed.variable;
            }

            return (
                metar.wind.directionDeg !== null &&
                parsed.direction === metar.wind.directionDeg
            );
        },
    });

    questions.push({
        id: "windSpeed",
        label: "Wind speed (kt)",
        level: "easy",
        kind: "text",
        correctDisplay:
            metar.wind.speedKt === null ? "Not reported" : `${metar.wind.speedKt} kt`,
        isCorrect: (input) => {
            if (metar.wind.speedKt === null) return false;
            return parseQuizNumber(input) === metar.wind.speedKt;
        },
    });

    if (metar.wind.gustKt !== null) {
        questions.push({
            id: "windGust",
            label: "Wind gust (kt)",
            level: "easy",
            kind: "text",
            correctDisplay: `${metar.wind.gustKt} kt`,
            isCorrect: (input) => parseQuizNumber(input) === metar.wind.gustKt,
        });
    }

    questions.push({
        id: "visibility",
        label: "Visibility (SM)",
        level: "amateur",
        kind: "text",
        correctDisplay: formatVisibility(metar),
        isCorrect: (input) => {
            if (metar.visibility.statuteMiles === null) return false;
            const num = Number(input.trim().replace(/SM$/i, ""));
            return !Number.isNaN(num) && num === metar.visibility.statuteMiles;
        },
    });

    questions.push({
        id: "clouds",
        label: "Cloud layers",
        level: "amateur",
        kind: "clouds",
        correctDisplay: formatClouds(metar),
        isCorrect: (input) => {
            const entries = parseQuizCloudAnswer(input);

            if (metar.clouds.length === 0) {
                return entries.some(
                    (entry) => entry.cover === "CLR" || entry.cover === "SKC"
                );
            }

            return metar.clouds.every((cloud) =>
                entries.some(
                    (entry) =>
                        entry.cover === cloud.cover &&
                        (cloud.baseFeetAgl === null
                            ? entry.base === null
                            : entry.base === cloud.baseFeetAgl)
                )
            );
        },
    });

    questions.push({
        id: "flightCategory",
        label: "Flight category",
        level: "expert",
        kind: "select",
        options: ["VFR", "MVFR", "IFR", "LIFR"],
        correctDisplay: metar.flightCategory,
        isCorrect: (input) => input === metar.flightCategory,
    });

    questions.push({
        id: "ceiling",
        label: "Ceiling (ft AGL)",
        level: "expert",
        kind: "text",
        correctDisplay: formatCeiling(metar),
        isCorrect: (input) => {
            const cleaned = input.trim().toUpperCase();

            if (metar.ceiling.feetAgl === null) {
                return /N\/?A|NONE|UNLIMITED|NO CEILING|CLR|SKC/.test(cleaned);
            }

            const num = Number(cleaned.replace(/[^\d]/g, ""));
            return !Number.isNaN(num) && num === metar.ceiling.feetAgl;
        },
    });

    questions.push({
        id: "temperature",
        label: "Temperature (°C)",
        level: "expert",
        kind: "text",
        correctDisplay:
            metar.temperature.celsius !== null
                ? `${metar.temperature.celsius} C / ${metar.temperature.fahrenheit} F`
                : "Not reported",
        isCorrect: (input) => {
            if (metar.temperature.celsius === null) return false;
            return parseQuizSignedTemp(input) === metar.temperature.celsius;
        },
    });

    questions.push({
        id: "dewpoint",
        label: "Dewpoint (°C)",
        level: "expert",
        kind: "text",
        correctDisplay:
            metar.dewpoint.celsius !== null
                ? `${metar.dewpoint.celsius} C / ${metar.dewpoint.fahrenheit} F`
                : "Not reported",
        isCorrect: (input) => {
            if (metar.dewpoint.celsius === null) return false;
            return parseQuizSignedTemp(input) === metar.dewpoint.celsius;
        },
    });

    questions.push({
        id: "altimeter",
        label: "Altimeter (inHg)",
        level: "expert",
        kind: "text",
        correctDisplay: formatAltimeter(metar),
        isCorrect: (input) => {
            const parsed = parseQuizAltimeterInput(input);
            return (
                parsed !== null &&
                metar.altimeter.inHg !== null &&
                Math.abs(parsed - metar.altimeter.inHg) < 0.005
            );
        },
        getNote: (input) => {
            if (metar.altimeter.inHg === null) return null;
            return isQuizAltimeterMissingDecimal(input, metar.altimeter.inHg)
                ? "Don't forget the decimal point!"
                : null;
        },
    });

    if (metar.weather.length > 0) {
        questions.push({
            id: "weather",
            label: "Present weather",
            level: "expert",
            kind: "text",
            correctDisplay: metar.weather.join(" "),
            isCorrect: (input) => {
                const cleaned = input.toUpperCase();
                return metar.weather.every((code) => cleaned.includes(code.toUpperCase()));
            },
        });
    }

    return questions;
}

function QuizPanel({
    metar,
    rawText,
    timeZone,
    onContinue,
}: {
    metar: NormalizedMetar;
    rawText: string;
    timeZone: string | null | undefined;
    onContinue: () => void;
}) {
    const [difficulty, setDifficulty] = useState<QuizDifficulty>("easy");
    const [answers, setAnswers] = useState<Record<string, string>>({});
    const [submitted, setSubmitted] = useState(false);
    const [cloudEntries, setCloudEntries] = useState<QuizCloudEntry[]>([
        { cover: "", base: "" },
    ]);
    const [gustAdded, setGustAdded] = useState(false);

    const questions = buildQuizQuestions(metar, timeZone).filter(
        (question) =>
            QUIZ_DIFFICULTY_ORDER.indexOf(question.level) <=
                QUIZ_DIFFICULTY_ORDER.indexOf(difficulty) &&
            (question.id !== "windGust" || gustAdded || submitted)
    );

    const correctCount = questions.filter((question) =>
        question.isCorrect((answers[question.id] ?? "").trim())
    ).length;

    function updateAnswer(id: string, value: string) {
        setAnswers((current) => ({ ...current, [id]: value }));
    }

    function updateCloudEntry(index: number, field: "cover" | "base", value: string) {
        setCloudEntries((current) => {
            const next = current.map((entry, i) => {
                if (i !== index) return entry;
                const updated = { ...entry, [field]: value };
                if (field === "cover" && (value === "CLR" || value === "SKC")) {
                    updated.base = "";
                }
                return updated;
            });
            updateAnswer("clouds", serializeQuizCloudEntries(next));
            return next;
        });
    }

    function addCloudEntry() {
        setCloudEntries((current) => {
            const next = [...current, { cover: "", base: "" }];
            updateAnswer("clouds", serializeQuizCloudEntries(next));
            return next;
        });
    }

    function removeCloudEntry(index: number) {
        setCloudEntries((current) => {
            const next = current.filter((_, i) => i !== index);
            updateAnswer("clouds", serializeQuizCloudEntries(next));
            return next;
        });
    }

    function retry() {
        setAnswers({});
        setSubmitted(false);
        setCloudEntries([{ cover: "", base: "" }]);
        setGustAdded(false);
    }

    return (
        <section className="mt-8 rounded-3xl border border-[#d6b35a]/25 bg-zinc-950/80 p-6 shadow-2xl sm:p-8">
            <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.2em] text-[#d6b35a]">
                Quiz Mode
                <InfoTooltip text="Read the raw METAR below, answer each question, then submit to see a graded, side-by-side comparison." />
            </p>

            <h2 className="mt-2 text-2xl font-bold text-white">
                {submitted ? "Your results" : "Decode the current METAR"}
            </h2>

            <div className="mt-4 rounded-2xl border border-zinc-800 bg-black/60 p-4">
                <pre className="whitespace-pre-wrap break-words font-mono text-sm leading-6 text-zinc-100">
                    {rawText}
                </pre>
            </div>

            <div className="mt-4">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
                    Difficulty
                </p>

                <div
                    className={`relative mt-2 flex items-center rounded-full border border-zinc-700 bg-black/40 p-1 text-xs font-black tracking-[0.08em] ${
                        submitted ? "pointer-events-none opacity-50" : ""
                    }`}
                >
                    <span
                        aria-hidden="true"
                        className="absolute inset-y-1 left-1 w-1/3 rounded-full bg-[#d6b35a] transition-transform duration-200 ease-out"
                        style={{
                            transform: `translateX(${QUIZ_DIFFICULTY_ORDER.indexOf(difficulty) * 100}%)`,
                        }}
                    />

                    {QUIZ_DIFFICULTY_ORDER.map((level) => (
                        <button
                            key={level}
                            onClick={() => setDifficulty(level)}
                            className={`relative z-10 w-1/3 rounded-full py-2 uppercase transition-colors ${
                                difficulty === level ? "text-black" : "text-zinc-400"
                            }`}
                        >
                            {QUIZ_DIFFICULTY_LABELS[level]}
                        </button>
                    ))}
                </div>
            </div>

            {submitted && (
                <p
                    className={`mt-4 text-sm font-bold ${
                        correctCount === questions.length ? "text-emerald-300" : "text-[#e6c76f]"
                    }`}
                >
                    {correctCount} / {questions.length} correct
                </p>
            )}

            <div className="relative mt-4 grid grid-cols-2 items-start gap-x-4 gap-y-3">
                {questions.map((question, index) => {
                    return (
                        <div key={question.id} style={{ gridRow: index + 1, gridColumn: 1 }}>
                            <label className="block h-4 text-xs font-semibold text-zinc-400">
                                {question.label}
                            </label>

                            {question.kind === "select" ? (
                                    <select
                                        value={answers[question.id] ?? ""}
                                        onChange={(event) =>
                                            updateAnswer(question.id, event.target.value)
                                        }
                                        disabled={submitted}
                                        className="mt-1 h-[42px] w-full rounded-xl border border-zinc-700 bg-black px-3 text-sm text-white outline-none focus:border-[#d6b35a]/60 disabled:opacity-50"
                                    >
                                        <option value="" disabled>
                                            Choose…
                                        </option>
                                        {question.options?.map((option) => (
                                            <option key={option} value={option}>
                                                {option}
                                            </option>
                                        ))}
                                    </select>
                                ) : question.kind === "clouds" ? (
                                    <div className="mt-1 space-y-2">
                                        {cloudEntries.map((entry, index) => (
                                            <div key={index} className="flex items-center gap-2">
                                                <select
                                                    value={entry.cover}
                                                    onChange={(event) =>
                                                        updateCloudEntry(
                                                            index,
                                                            "cover",
                                                            event.target.value
                                                        )
                                                    }
                                                    disabled={submitted}
                                                    className="h-[42px] w-40 shrink-0 rounded-xl border border-zinc-700 bg-black px-2 text-sm text-white outline-none focus:border-[#d6b35a]/60 disabled:opacity-50"
                                                >
                                                    <option value="" disabled>
                                                        Cover…
                                                    </option>
                                                    {QUIZ_CLOUD_COVER_OPTIONS.map((option) => (
                                                        <option key={option.value} value={option.value}>
                                                            {option.label}
                                                        </option>
                                                    ))}
                                                </select>

                                                <input
                                                    value={entry.base}
                                                    onChange={(event) =>
                                                        updateCloudEntry(
                                                            index,
                                                            "base",
                                                            event.target.value
                                                        )
                                                    }
                                                    disabled={
                                                        submitted ||
                                                        entry.cover === "CLR" ||
                                                        entry.cover === "SKC"
                                                    }
                                                    className="h-[42px] w-full rounded-xl border border-zinc-700 bg-black px-3 text-sm text-white outline-none focus:border-[#d6b35a]/60 disabled:opacity-40"
                                                />

                                                <span className="shrink-0 text-xs text-zinc-500">
                                                    ft AGL
                                                </span>

                                                {cloudEntries.length > 1 && (
                                                    <button
                                                        type="button"
                                                        onClick={() => removeCloudEntry(index)}
                                                        disabled={submitted}
                                                        className="shrink-0 rounded-lg px-2 py-2 text-sm font-black text-red-400 transition hover:bg-red-500/10 hover:text-red-300 disabled:opacity-40"
                                                    >
                                                        ✕
                                                    </button>
                                                )}
                                            </div>
                                        ))}

                                        <button
                                            type="button"
                                            onClick={addCloudEntry}
                                            disabled={submitted}
                                            className="ml-2 text-xs font-black uppercase tracking-[0.08em] text-[#e6c76f] transition hover:text-white disabled:opacity-40"
                                        >
                                            + Add
                                        </button>
                                    </div>
                                ) : question.id === "localStationTime" ? (
                                    <div className="mt-1 flex w-full items-center gap-2">
                                        <input
                                            value={(answers[question.id] ?? "").split("|")[0] ?? ""}
                                            onChange={(event) => {
                                                const parts = (answers[question.id] ?? "").split("|");
                                                const digits = event.target.value
                                                    .replace(/\D/g, "")
                                                    .slice(0, 2);
                                                updateAnswer(
                                                    question.id,
                                                    `${digits}|${parts[1] ?? ""}|${parts[2] ?? ""}`
                                                );
                                            }}
                                            disabled={submitted}
                                            inputMode="numeric"
                                            maxLength={2}
                                            placeholder="HH"
                                            className="h-[42px] w-14 shrink-0 rounded-xl border border-zinc-700 bg-black px-2 text-center text-sm text-white outline-none placeholder:text-zinc-600 focus:border-[#d6b35a]/60 disabled:opacity-50"
                                        />

                                        <span className="shrink-0 text-lg font-bold text-zinc-500">
                                            :
                                        </span>

                                        <input
                                            value={(answers[question.id] ?? "").split("|")[1] ?? ""}
                                            onChange={(event) => {
                                                const parts = (answers[question.id] ?? "").split("|");
                                                const digits = event.target.value
                                                    .replace(/\D/g, "")
                                                    .slice(0, 2);
                                                updateAnswer(
                                                    question.id,
                                                    `${parts[0] ?? ""}|${digits}|${parts[2] ?? ""}`
                                                );
                                            }}
                                            disabled={submitted}
                                            inputMode="numeric"
                                            maxLength={2}
                                            placeholder="MM"
                                            className="h-[42px] w-14 shrink-0 rounded-xl border border-zinc-700 bg-black px-2 text-center text-sm text-white outline-none placeholder:text-zinc-600 focus:border-[#d6b35a]/60 disabled:opacity-50"
                                        />

                                        <select
                                            value={(answers[question.id] ?? "").split("|")[2] ?? ""}
                                            onChange={(event) => {
                                                const parts = (answers[question.id] ?? "").split("|");
                                                updateAnswer(
                                                    question.id,
                                                    `${parts[0] ?? ""}|${parts[1] ?? ""}|${event.target.value}`
                                                );
                                            }}
                                            disabled={submitted}
                                            className="h-[42px] w-24 shrink-0 rounded-xl border border-zinc-700 bg-black px-2 text-sm text-white outline-none focus:border-[#d6b35a]/60 disabled:opacity-50"
                                        >
                                            <option value="" disabled>
                                                Select
                                            </option>
                                            <option value="AM">AM</option>
                                            <option value="PM">PM</option>
                                        </select>

                                        <span className="shrink-0 text-sm font-semibold text-zinc-400">
                                            {getQuizLocalZoneAbbreviation(metar, timeZone)}
                                        </span>
                                    </div>
                                ) : question.id === "ceiling" ? (
                                    <div className="mt-1 flex w-full items-center gap-2">
                                        <input
                                            value={
                                                (answers[question.id] ?? "") === "N/A"
                                                    ? ""
                                                    : answers[question.id] ?? ""
                                            }
                                            onChange={(event) =>
                                                updateAnswer(question.id, event.target.value)
                                            }
                                            disabled={
                                                submitted || (answers[question.id] ?? "") === "N/A"
                                            }
                                            className="h-[42px] w-full rounded-xl border border-zinc-700 bg-black px-3 text-sm text-white outline-none focus:border-[#d6b35a]/60 disabled:opacity-50"
                                        />

                                        <label className="flex shrink-0 items-center gap-1.5 text-xs font-semibold text-zinc-400">
                                            <input
                                                type="checkbox"
                                                checked={(answers[question.id] ?? "") === "N/A"}
                                                onChange={(event) =>
                                                    updateAnswer(
                                                        question.id,
                                                        event.target.checked ? "N/A" : ""
                                                    )
                                                }
                                                disabled={submitted}
                                                className="h-4 w-4 rounded border-zinc-600 bg-black accent-[#d6b35a]"
                                            />
                                            N/A
                                        </label>
                                    </div>
                                ) : (
                                    <input
                                        value={answers[question.id] ?? ""}
                                        onChange={(event) =>
                                            updateAnswer(question.id, event.target.value)
                                        }
                                        disabled={submitted}
                                        placeholder={question.placeholder}
                                        className="mt-1 h-[42px] w-full rounded-xl border border-zinc-700 bg-black px-3 text-sm text-white outline-none placeholder:text-zinc-600 focus:border-[#d6b35a]/60 disabled:opacity-50"
                                    />
                                )}

                                {question.id === "windSpeed" &&
                                    metar.wind.gustKt !== null &&
                                    !gustAdded &&
                                    !submitted && (
                                        <button
                                            type="button"
                                            onClick={() => setGustAdded(true)}
                                            className="mt-1 block text-xs font-black uppercase tracking-[0.08em] text-[#e6c76f] transition hover:text-white"
                                        >
                                            + Add Gust
                                        </button>
                                    )}
                        </div>
                    );
                })}

                {questions.map((question, index) => {
                    const userAnswer = (answers[question.id] ?? "").trim();
                    const correct = userAnswer !== "" && question.isCorrect(userAnswer);

                    return (
                        <div
                            key={question.id}
                            style={{ gridRow: index + 1, gridColumn: 2 }}
                            className={`mx-3 ${index === questions.length - 1 ? "mb-3" : ""}`}
                        >
                            <span aria-hidden="true" className="invisible block h-4 text-xs font-semibold">
                                {question.label}
                            </span>

                            {question.kind === "clouds" ? (
                                <div className="mt-1 space-y-2">
                                    {submitted
                                        ? getQuizCloudLayerResults(metar, userAnswer).map(
                                              (result, layerIndex) => (
                                                  <div
                                                      key={layerIndex}
                                                      className={`flex h-[42px] items-center rounded-xl border px-3 text-sm font-semibold ${
                                                          result.correct
                                                              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                                                              : "border-red-500/40 bg-red-500/10 text-red-300"
                                                      }`}
                                                  >
                                                      {result.label}
                                                  </div>
                                              )
                                          )
                                        : cloudEntries.map((_, layerIndex) => (
                                              <div
                                                  key={layerIndex}
                                                  className="h-[42px] rounded-xl border border-zinc-600 bg-zinc-800/80"
                                              />
                                          ))}
                                </div>
                            ) : (
                                <div
                                    className={`mt-1 flex min-h-[42px] flex-col justify-center rounded-xl border px-3 py-2 text-sm font-semibold ${
                                        submitted
                                            ? correct
                                                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                                                : "border-red-500/40 bg-red-500/10 text-red-300"
                                            : "border-zinc-600 bg-zinc-800/80"
                                    }`}
                                >
                                    <span>{submitted ? question.correctDisplay : ""}</span>

                                    {submitted && question.getNote?.(userAnswer) && (
                                        <span className="mt-0.5 text-[11px] font-semibold text-amber-400">
                                            {question.getNote(userAnswer)}
                                        </span>
                                    )}
                                </div>
                            )}
                        </div>
                    );
                })}

                {!submitted && (
                    <div
                        style={{
                            gridRow: `1 / span ${questions.length}`,
                            gridColumn: 2,
                            backgroundImage:
                                "repeating-linear-gradient(45deg, rgba(214,179,90,0.32) 0px, rgba(214,179,90,0.32) 3px, transparent 3px, transparent 11px)",
                        }}
                        className="mx-1 mb-1 mt-3 flex flex-col items-center justify-center self-stretch rounded-2xl border border-[#d6b35a]/40"
                    >
                        <button
                            onClick={() => {
                                if (metar.wind.gustKt !== null && !gustAdded) {
                                    updateAnswer("windGust", "0");
                                }
                                setSubmitted(true);
                            }}
                            className="flex items-center gap-2 rounded-xl border border-[#d6b35a]/60 bg-black px-6 py-3 text-sm font-black uppercase tracking-[0.08em] text-[#e6c76f] shadow-lg shadow-black/60 transition hover:scale-[1.03] hover:bg-zinc-900"
                        >
                            <svg
                                viewBox="0 0 24 24"
                                className="h-4 w-4"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            >
                                <path d="M4 12.5l5 5L20 6.5" />
                            </svg>
                            Grade
                        </button>
                    </div>
                )}
            </div>

            {submitted && (
                <div className="mt-5 flex flex-wrap gap-3">
                    <button
                        onClick={retry}
                        className="rounded-xl border border-zinc-700 px-5 py-3 font-bold text-zinc-300 transition hover:border-zinc-600 hover:text-white"
                    >
                        Try Again
                    </button>

                    <button
                        onClick={onContinue}
                        className="rounded-xl border border-[#d6b35a]/50 bg-[#d6b35a]/10 px-5 py-3 font-bold text-[#e6c76f] transition hover:bg-[#d6b35a]/20"
                    >
                        Continue
                    </button>
                </div>
            )}
        </section>
    );
}

function formatWind(metar: NormalizedMetar): string {
    if (metar.wind.speedKt === null) return "Not reported";

    if (metar.wind.variable) {
        return `VRB at ${metar.wind.speedKt} kt`;
    }

    return `${metar.wind.directionDeg ?? "---"} deg at ${metar.wind.speedKt} kt`;
}

function formatWindDetail(metar: NormalizedMetar): string {
    if (metar.wind.gustKt) {
        return `Gusting to ${metar.wind.gustKt} kt`;
    }

    return "No gusts reported";
}

function formatVisibility(metar: NormalizedMetar): string {
    if (metar.visibility.statuteMiles === null) return "Not reported";
    return `${metar.visibility.statuteMiles} SM`;
}

function formatCompassVisibility(visibilitySm: number | null): string {
    if (visibilitySm === null) return "-- SM";

    const roundedVisibility = Number.isInteger(visibilitySm)
        ? String(visibilitySm)
        : visibilitySm.toFixed(1).replace(/\.0$/, "");

    return `${roundedVisibility} SM`;
}

function formatCeiling(metar: NormalizedMetar): string {
    if (metar.ceiling.feetAgl === null) return "No ceiling";
    return `${metar.ceiling.feetAgl.toLocaleString()} ft AGL`;
}

function formatClouds(metar: NormalizedMetar): string {
    if (metar.clouds.length === 0) return "CLR";

    return metar.clouds
        .map((cloud) => {
            const base = cloud.baseFeetAgl
                ? cloud.baseFeetAgl.toLocaleString()
                : "---";

            return `${cloud.cover} ${base}`;
        })
        .join(", ");
}

function formatTemperature(metar: NormalizedMetar): string {
    const tempC = metar.temperature.celsius ?? "--";
    const tempF = metar.temperature.fahrenheit ?? "--";
    const dewC = metar.dewpoint.celsius ?? "--";
    const dewF = metar.dewpoint.fahrenheit ?? "--";

    return `${tempC} C / ${tempF} F, dew ${dewC} C / ${dewF} F`;
}

function formatAltimeter(metar: NormalizedMetar): string {
    if (metar.altimeter.inHg === null) return "Not reported";
    return `${metar.altimeter.inHg.toFixed(2)} inHg`;
}

function getFlightCategoryDescription(metar: NormalizedMetar): string {
    switch (metar.flightCategory) {
        case "VFR":
            return "Visual conditions.";
        case "MVFR":
            return "Marginal visual conditions.";
        case "IFR":
            return "Instrument conditions.";
        case "LIFR":
            return "Low instrument conditions.";
        default:
            return "Category unavailable.";
    }
}

function getVisibilityDescription(metar: NormalizedMetar): string {
    const visibility = metar.visibility.statuteMiles;

    if (visibility === null) return "Visibility is not reported.";
    if (visibility > 5) return "Visibility is above basic VFR threshold.";
    if (visibility >= 3) return "Visibility is marginal for VFR operations.";
    if (visibility >= 1) return "Visibility is in IFR range.";
    return "Visibility is in LIFR range.";
}

function getCeilingDescription(metar: NormalizedMetar): string {
    const ceiling = metar.ceiling.feetAgl;

    if (ceiling === null) return "No BKN, OVC, or VV ceiling reported.";
    if (ceiling > 3000) return "Ceiling is above basic VFR threshold.";
    if (ceiling >= 1000) return "Ceiling is in MVFR range.";
    if (ceiling >= 500) return "Ceiling is in IFR range.";
    return "Ceiling is in LIFR range.";
}

function getCloudDescription(metar: NormalizedMetar): string {
    if (metar.clouds.length === 0) {
        return "Clear conditions reported.";
    }

    const ceilingLayers = metar.clouds.filter((cloud) =>
        ["BKN", "OVC", "VV"].includes(cloud.cover)
    );

    if (ceilingLayers.length === 0) {
        return "Clouds reported, but no ceiling layer.";
    }

    return "Ceiling layer present.";
}

function getSpreadDescription(metar: NormalizedMetar): string {
    const temp = metar.temperature.celsius;
    const dew = metar.dewpoint.celsius;

    if (temp === null || dew === null) return "Temperature spread unavailable.";

    const spread = temp - dew;

    if (spread <= 2) {
        return `Temp/dewpoint spread is ${spread} C. Watch for fog or low cloud potential.`;
    }

    if (spread <= 5) {
        return `Temp/dewpoint spread is ${spread} C. Moisture is relatively close.`;
    }

    return `Temp/dewpoint spread is ${spread} C.`;
}

function getRemarkBubbles(remarks: string | null): RemarkBubble[] {
    if (!remarks) return [];

    return remarks
        .split(/\s+/)
        .map((token) => token.trim())
        .filter(Boolean)
        .map(decodeRemarkToken);
}

function decodeRemarkToken(token: string): RemarkBubble {
    if (token === "AO1") {
        return {
            code: token,
            meaning: "Automated station without precipitation discriminator.",
        };
    }

    if (token === "AO2") {
        return {
            code: token,
            meaning: "Automated station with precipitation discriminator.",
        };
    }

    if (token === "COR") {
        return {
            code: token,
            meaning: "Corrected observation.",
        };
    }

    if (token === "AUTO") {
        return {
            code: token,
            meaning: "Fully automated observation.",
        };
    }

    if (/^SLP\d{3}$/.test(token)) {
        const pressure = decodeSeaLevelPressure(token);

        return {
            code: token,
            meaning:
                pressure === null
                    ? "Sea-level pressure remark."
                    : `Sea-level pressure ${pressure.toFixed(1)} hPa.`,
        };
    }

    if (/^T[01]\d{3}[01]\d{3}$/.test(token)) {
        const decoded = decodePreciseTempDewpoint(token);

        return {
            code: token,
            meaning:
                decoded ??
                "Precise temperature/dewpoint in tenths of a degree Celsius.",
        };
    }

    if (/^1[01]\d{3}$/.test(token)) {
        const temp = decodeSignedTenthsTemperature(token.slice(1));

        return {
            code: token,
            meaning:
                temp === null
                    ? "Six-hour maximum temperature remark."
                    : `Six-hour maximum temperature ${temp.toFixed(1)} C.`,
        };
    }

    if (/^2[01]\d{3}$/.test(token)) {
        const temp = decodeSignedTenthsTemperature(token.slice(1));

        return {
            code: token,
            meaning:
                temp === null
                    ? "Six-hour minimum temperature remark."
                    : `Six-hour minimum temperature ${temp.toFixed(1)} C.`,
        };
    }

    if (/^5\d{4}$/.test(token)) {
        const tendencyCode = token[1];
        const change = Number(token.slice(2)) / 10;

        return {
            code: token,
            meaning: `Three-hour pressure tendency code ${tendencyCode}; pressure changed ${change.toFixed(
                1
            )} hPa.`,
        };
    }

    if (/^P\d{4}$/.test(token)) {
        const precip = Number(token.slice(1)) / 100;

        return {
            code: token,
            meaning: `${precip.toFixed(2)} inches of precipitation reported.`,
        };
    }

    if (token === "TSNO") {
        return {
            code: token,
            meaning: "Thunderstorm information not available.",
        };
    }

    if (token === "PNO") {
        return {
            code: token,
            meaning: "Precipitation amount not available.",
        };
    }

    if (token === "PRESFR") {
        return {
            code: token,
            meaning: "Pressure falling rapidly.",
        };
    }

    if (token === "PRESRR") {
        return {
            code: token,
            meaning: "Pressure rising rapidly.",
        };
    }

    return {
        code: token,
        meaning: "Remark code not decoded yet.",
    };
}

function decodeSeaLevelPressure(token: string): number | null {
    const value = Number(token.slice(3));

    if (!Number.isFinite(value)) return null;

    if (value < 500) {
        return 1000 + value / 10;
    }

    return 900 + value / 10;
}

function decodeSignedTenthsTemperature(value: string): number | null {
    if (!/^[01]\d{3}$/.test(value)) return null;

    const sign = value[0] === "1" ? -1 : 1;
    const magnitude = Number(value.slice(1)) / 10;

    if (!Number.isFinite(magnitude)) return null;

    return sign * magnitude;
}

function decodePreciseTempDewpoint(token: string): string | null {
    const temperature = decodeSignedTenthsTemperature(token.slice(1, 5));
    const dewpoint = decodeSignedTenthsTemperature(token.slice(5, 9));

    if (temperature === null || dewpoint === null) return null;

    return `Precise temp ${temperature.toFixed(1)} C; dewpoint ${dewpoint.toFixed(
        1
    )} C.`;
}

function getRunwayEnds(runways: AirportRunway[]): RunwayEnd[] {
    return runways.flatMap((runway) => {
        const ends: RunwayEnd[] = [];

        if (runway.endA.ident && runway.endA.headingDeg !== null) {
            ends.push({
                runwayId: runway.id,
                pairName: runway.name,
                ident: runway.endA.ident,
                headingDeg: runway.endA.headingDeg,
            });
        }

        if (runway.endB.ident && runway.endB.headingDeg !== null) {
            ends.push({
                runwayId: runway.id,
                pairName: runway.name,
                ident: runway.endB.ident,
                headingDeg: runway.endB.headingDeg,
            });
        }

        return ends;
    });
}

function calculateRunwayWindComponent(
    windDirectionDeg: number,
    windSpeedKt: number,
    runwayHeadingDeg: number
): RunwayWindComponent {
    const angleDeg = normalizeAngle180(windDirectionDeg - runwayHeadingDeg);
    const angleRad = (angleDeg * Math.PI) / 180;

    const headwind = windSpeedKt * Math.cos(angleRad);
    const crosswind = windSpeedKt * Math.sin(angleRad);

    return {
        headwindKt: Math.round(headwind),
        crosswindKt: Math.round(Math.abs(crosswind)),
        crosswindFrom:
            Math.abs(crosswind) < 0.5
                ? "centerline"
                : crosswind > 0
                    ? "right"
                    : "left",
    };
}

function normalizeAngle180(angleDeg: number): number {
    let angle = angleDeg;

    while (angle > 180) angle -= 360;
    while (angle < -180) angle += 360;

    return angle;
}

function normalizeAngle360(angleDeg: number): number {
    let angle = angleDeg % 360;

    if (angle < 0) {
        angle += 360;
    }

    return angle;
}

function polarPoint(
    centerX: number,
    centerY: number,
    radius: number,
    angleDeg: number
): { x: number; y: number } {
    const angleRad = (angleDeg * Math.PI) / 180;

    return {
        x: centerX + radius * Math.sin(angleRad),
        y: centerY - radius * Math.cos(angleRad),
    };
}

function buildAirportMapLayout(
    runways: AirportRunway[],
    rotationDeg: number,
    center: number,
    selectedEnd: RunwayEnd | null = null,
    features: AirportMapFeature[] = []
): AirportMapLayout {
    const endpoints = runways.flatMap((runway) => [
        {
            runway,
            end: "A" as const,
            latitude: runway.endA.latitude,
            longitude: runway.endA.longitude,
        },
        {
            runway,
            end: "B" as const,
            latitude: runway.endB.latitude,
            longitude: runway.endB.longitude,
        },
    ]);

    const validEndpoints = endpoints.filter(
        (point) => point.latitude !== null && point.longitude !== null
    );

    if (validEndpoints.length === 0) {
        return {
            runwayLayout: [],
            featureLayout: [],
        };
    }

    const airportAverageLatitude =
        validEndpoints.reduce((sum, point) => sum + (point.latitude ?? 0), 0) /
        validEndpoints.length;

    const airportAverageLongitude =
        validEndpoints.reduce((sum, point) => sum + (point.longitude ?? 0), 0) /
        validEndpoints.length;

    const selectedRunway = selectedEnd
        ? runways.find((runway) => runway.id === selectedEnd.runwayId)
        : null;

    const selectedRunwayHasCoordinates =
        selectedRunway?.endA.latitude !== null &&
        selectedRunway?.endA.longitude !== null &&
        selectedRunway?.endB.latitude !== null &&
        selectedRunway?.endB.longitude !== null;

    const originLatitude =
        selectedRunway && selectedRunwayHasCoordinates
            ? ((selectedRunway.endA.latitude ?? 0) +
                (selectedRunway.endB.latitude ?? 0)) /
            2
            : airportAverageLatitude;

    const originLongitude =
        selectedRunway && selectedRunwayHasCoordinates
            ? ((selectedRunway.endA.longitude ?? 0) +
                (selectedRunway.endB.longitude ?? 0)) /
            2
            : airportAverageLongitude;

    const cosLatitude = Math.cos((airportAverageLatitude * Math.PI) / 180);

    const referencePoints = validEndpoints.map((point) => {
        const xEast =
            ((point.longitude ?? 0) - airportAverageLongitude) * cosLatitude;
        const yNorth = (point.latitude ?? 0) - airportAverageLatitude;

        return {
            x: xEast,
            y: yNorth,
        };
    });

    const maxExtent =
        Math.max(
            ...referencePoints.map((point) => Math.abs(point.x)),
            ...referencePoints.map((point) => Math.abs(point.y)),
            0.0001
        ) * 1.25;

    const scale = 150 / maxExtent;

    function projectPoint(latitude: number, longitude: number): SvgPoint {
        const xEast = (longitude - originLongitude) * cosLatitude;
        const yNorth = latitude - originLatitude;

        const rotated = rotateLocalPoint(xEast, yNorth, rotationDeg);

        return {
            x: center + rotated.x * scale,
            y: center - rotated.y * scale,
        };
    }

    const localPoints = validEndpoints.map((point) => ({
        runway: point.runway,
        end: point.end,
        point: projectPoint(point.latitude ?? 0, point.longitude ?? 0),
    }));

    const runwayLayout = runways
        .map((runway) => {
            const startPoint = localPoints.find(
                (point) => point.runway.id === runway.id && point.end === "A"
            );

            const endPoint = localPoints.find(
                (point) => point.runway.id === runway.id && point.end === "B"
            );

            if (!startPoint || !endPoint) {
                return null;
            }

            return {
                runway,
                start: startPoint.point,
                end: endPoint.point,
            };
        })
        .filter((layout): layout is RunwayLayout => layout !== null);

    const featureLayout = features.map((feature) => ({
        feature,
        point: projectPoint(feature.latitude, feature.longitude),
    }));

    return {
        runwayLayout,
        featureLayout,
    };
}

function rotateLocalPoint(
    xEast: number,
    yNorth: number,
    rotationDeg: number
): { x: number; y: number } {
    const rotationRad = (rotationDeg * Math.PI) / 180;

    return {
        x: xEast * Math.cos(rotationRad) - yNorth * Math.sin(rotationRad),
        y: xEast * Math.sin(rotationRad) + yNorth * Math.cos(rotationRad),
    };
}

function getTangentTextRotation(angleDeg: number): number {
    const normalized = normalizeAngle360(angleDeg);

    // Keep left-side labels from appearing upside down
    return normalized > 90 && normalized < 270
        ? normalized + 180
        : normalized;
}
