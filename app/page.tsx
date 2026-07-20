"use client";

import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import type { FlightCategory, NormalizedMetar } from "@/lib/metar/types";
import * as SunCalc from "suncalc";
import Image from "next/image";

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
type DashboardTab = "weather" | "taf" | "airport";

type TafSkyCondition = {
    cover?: string | null;
    baseFtAgl?: number | null;
};

type TafForecastBlock = {
    change?: string | null;
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

const TAF_FULLSCREEN_BASE_HEIGHT = 440;
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
    markers: TafTimelineMarker[];
    isNightCurrency: boolean;
};

type InflightLabelSide = "left" | "right" | "middle";

export default function Home() {
    const [activeTab, setActiveTab] = useState<DecoderTab>("lookup");
    const [station, setStation] = useState("KFCM");
    const [rawInput, setRawInput] = useState("");

    const [metar, setMetar] = useState<NormalizedMetar | null>(null);
    const [rawMetar, setRawMetar] = useState<string | null>(null);
    const [stationInfo, setStationInfo] = useState<StationInfo | null>(null);
    const [airportDiagram, setAirportDiagram] = useState<AirportDiagramInfo | null>(null);
    const [runways, setRunways] = useState<AirportRunway[]>([]);
    const [error, setError] = useState("");

    const [loading, setLoading] = useState(true);
    const latestStationRef = useRef(station);
    const latestActiveTabRef = useRef(activeTab);

    useEffect(() => {
        latestStationRef.current = station;
    }, [station]);

    useEffect(() => {
        latestActiveTabRef.current = activeTab;
    }, [activeTab]);

    async function loadLiveMetar(cleanStation: string) {
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
        }
    }

    function fetchLiveMetar(stationToFetch = station) {
        const cleanStation = stationToFetch.trim().toUpperCase();

        setLoading(true);
        setError("");
        setStation(cleanStation);
        latestStationRef.current = cleanStation;

        void loadLiveMetar(cleanStation);
    }

    async function decodeRawMetar() {
        setLoading(true);
        setError("");

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
                void fetchLiveMetar(latestStationRef.current);
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
                <header className="mb-8 border-b border-[#d6b35a]/20 pb-8">
                    <div className="mb-4 inline-flex items-center gap-3 rounded-full border border-[#d6b35a]/30 bg-[#d6b35a]/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-[#e6c76f]">
                        Inflight Aviation
                    </div>

                    <h1 className="max-w-3xl text-4xl font-bold tracking-tight text-white md:text-6xl">
                        Weather
                    </h1>

                </header>

                <section className="rounded-3xl border border-zinc-800 bg-zinc-950/80 p-5 shadow-2xl">
                    <div className="mb-5 flex rounded-2xl border border-zinc-800 bg-black p-1">
                        <TabButton
                            active={activeTab === "lookup"}
                            onClick={() => setActiveTab("lookup")}
                        >
                            ICAO Lookup
                        </TabButton>

                        <TabButton
                            active={activeTab === "raw"}
                            onClick={() => setActiveTab("raw")}
                        >
                            Decode Raw METAR
                        </TabButton>
                    </div>

                    {activeTab === "lookup" && (
                        <div>
                            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#d6b35a]">
                                Current conditions
                            </p>

                            <h2 className="mt-2 mb-5 text-2xl font-bold text-white">
                                Live airport lookup
                            </h2>

                            <div className="flex flex-col gap-3 sm:flex-row">
                                <input
                                    value={station}
                                    onChange={(event) =>
                                        setStation(event.target.value.toUpperCase())
                                    }
                                    className="w-full rounded-xl border border-zinc-700 bg-black px-4 py-3 text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-[#d6b35a]"
                                    placeholder="KFCM"
                                />

                                <button
                                    onClick={() => fetchLiveMetar()}
                                    disabled={loading}
                                    className="mt-3 rounded-xl border border-[#d6b35a]/50 bg-[#d6b35a]/10 px-5 py-3 font-bold text-[#e6c76f] transition hover:bg-[#d6b35a]/20 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    {loading ? "Loading..." : "Fetch"}
                                </button>
                            </div>

                            <p className="mt-3 text-sm text-zinc-500">
                                Valid for any airport with an ICAO code and reports METAR data to AviationWeather.gov
                            </p>
                        </div>
                    )}

                    {activeTab === "raw" && (
                        <div>
                            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#d6b35a]">
                                Copy and paste
                            </p>

                            <h2 className="mt-2 mb-5 text-2xl font-bold text-white">
                                Decode raw METAR
                            </h2>

                            <div className="flex flex-col gap-3 sm:flex-row">

                                <textarea
                                    value={rawInput}
                                    onChange={(event) => setRawInput(event.target.value)}
                                    className="min-h-20 w-full rounded-xl border border-zinc-700 bg-black px-4 py-3 font-mono text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-[#d6b35a]"
                                    placeholder="KFCM 011753Z AUTO 35012KT 10SM FEW050 SCT250 22/15 A2992 RMK AO2"
                                />

                                <button
                                    onClick={decodeRawMetar}
                                    disabled={loading}
                                    className="mt-3 rounded-xl border border-[#d6b35a]/50 bg-[#d6b35a]/10 px-5 py-3 font-bold text-[#e6c76f] transition hover:bg-[#d6b35a]/20 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    {loading ? "Loading..." : "Decode"}
                                </button>
                            </div>

                        </div>
                    )}
                </section>

                {error && (
                    <div className="mt-6 rounded-2xl border border-red-500/40 bg-red-950/30 p-4 text-red-200">
                        {error}
                    </div>
                )}

                {metar ? (
                    <MetarDashboard
                        metar={metar}
                        rawMetar={rawMetar ?? metar.raw}
                        station={station}
                        stationInfo={stationInfo}
                        airportDiagram={airportDiagram}
                        runways={runways}
                    />
                    ) : (
                    <EmptyState />
                )}

                <footer className="mt-10 border-t border-zinc-900 pt-5 text-center">
                    <p className="text-[11px] leading-5 text-zinc-500">
                        Created by Preston Vaughn for Inflight Aviation. METAR and TAF data provided by
                        AviationWeather.gov. Airport information provided by FAA.gov.
                    </p>
                </footer>

            </div>
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
}: {
    metar: NormalizedMetar;
    rawMetar: string;
    station: string;
    stationInfo: StationInfo | null;
    airportDiagram: AirportDiagramInfo | null;
    runways: AirportRunway[];
}) {
    const [now, setNow] = useState(() => new Date());
    const [activeDashboardTab, setActiveDashboardTab] =
        useState<DashboardTab>("weather");

    const [isFullscreenOpen, setIsFullscreenOpen] = useState(false);
    const fullscreenRef = useRef<HTMLDivElement | null>(null);

    const categoryStyle = FLIGHT_CATEGORY_STYLES[metar.flightCategory];

    useEffect(() => {
        const timer = window.setInterval(() => {
            setNow(new Date());
        }, 60_000);

        return () => window.clearInterval(timer);
    }, []);

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
                                    className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-zinc-700 bg-black/70 text-zinc-300 transition hover:border-[#d6b35a]/50 hover:bg-[#d6b35a]/10 hover:text-[#e6c76f]"
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

                            <div className="mt-3 flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
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

                                <ObservationTimeBubble
                                    metar={metar}
                                    now={now}
                                    stationInfo={stationInfo}
                                />
                            </div>
                        </div>

                        <div
                            className={`rounded-2xl border px-5 py-3 text-center ${categoryStyle}`}
                        >
                            <p className="text-xs font-semibold uppercase tracking-[0.2em]">
                                Flight Category
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
                        />
                    )}

                    {activeDashboardTab === "taf" && (
                        <TafDashboardTab
                            station={metar.station ?? station}
                            timeZone={stationInfo?.timeZone}
                            latitude={stationInfo?.latitude}
                            longitude={stationInfo?.longitude}
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
                            <div className="h-[120px] flex-none rounded-3xl border border-zinc-800 bg-gradient-to-r from-black via-zinc-950 to-[#171307] p-4 shadow-2xl">
                                <div
                                    style={{
                                        gridTemplateColumns: "minmax(0, 560px) minmax(0, 1fr) auto",
                                    }}
                                    className="grid h-full items-center gap-6"
                                >
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

                                    <div
                                        style={{ width: "calc(100% - 48px)" }}
                                        className={`h-[78px] min-w-0 justify-self-start rounded-2xl border px-7 py-3 text-center ${categoryStyle}`}
                                    >
                                        <p className="text-3xl font-black leading-none">
                                            {metar.flightCategory}
                                        </p>

                                        <p className="mt-2 text-sm font-semibold">
                                            {getFlightCategoryDescription(metar)}
                                        </p>
                                    </div>

                                    <div className="flex shrink-0 items-center gap-3">
                                        <ObservationTimeBubble
                                            metar={metar}
                                            now={now}
                                            stationInfo={stationInfo}
                                        />

                                        <button
                                            type="button"
                                            onClick={closeFullscreenDashboard}
                                            className="rounded-full border border-zinc-700 bg-black/70 px-4 py-2 text-[11px] font-black uppercase tracking-[0.16em] text-zinc-200 transition hover:border-[#d6b35a]/50 hover:text-[#e6c76f]"
                                        >
                                            Exit
                                        </button>
                                    </div>
                                </div>
                            </div>

                            <div className="min-h-0 flex-1 overflow-hidden">
                                <RunwayWindWidget metar={metar} runways={runways} fullscreen />
                            </div>

                            <div className="h-[clamp(240px,30dvh,360px)] flex-none overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-950/90 p-2 shadow-2xl sm:p-3">
                                <div className="flex h-full w-full flex-col justify-end">
                                    <TafDashboardTab
                                        station={metar.station ?? station}
                                        timeZone={stationInfo?.timeZone}
                                        latitude={stationInfo?.latitude}
                                        longitude={stationInfo?.longitude}
                                        hourlyOnly
                                        fullscreen
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
}: {
    metar: NormalizedMetar;
    rawMetar: string;
    runways: AirportRunway[];
}) {
    return (
        <>

            <RunwayWindWidget metar={metar} runways={runways} />

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                <WeatherCard
                    label="Wind"
                    value={formatWind(metar)}
                    detail={formatWindDetail(metar)}
                    accent="gold"
                />

                <WeatherCard
                    label="Visibility"
                    value={formatVisibility(metar)}
                    detail={getVisibilityDescription(metar)}
                    accent="silver"
                />

                <WeatherCard
                    label="Ceiling"
                    value={formatCeiling(metar)}
                    detail={getCeilingDescription(metar)}
                    accent="silver"
                />

                <WeatherCard
                    label="Clouds"
                    value={formatClouds(metar)}
                    detail={getCloudDescription(metar)}
                    accent="gold"
                />

                <WeatherCard
                    label="Temp / Dewpoint"
                    value={formatTemperature(metar)}
                    detail={getSpreadDescription(metar)}
                    accent="silver"
                />

                <WeatherCard
                    label="Altimeter"
                    value={formatAltimeter(metar)}
                    detail="Pressure setting"
                    accent="gold"
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
    const [isDragging, setIsDragging] = useState(false);
    const [startX, setStartX] = useState(0);
    const [scrollLeft, setScrollLeft] = useState(0);

    const [tafScale, setTafScale] = useState(1);

    useEffect(() => {
        if (!fullscreen) {
            return;
        }

        const slider = scrollRef.current;
        if (!slider) return;

        const updateScale = () => {
            const availableHeight = slider.clientHeight;
            const nextScale = Math.min(
                1,
                Math.max(
                    TAF_FULLSCREEN_MIN_SCALE,
                    availableHeight / TAF_FULLSCREEN_BASE_HEIGHT
                )
            );

            setTafScale(Number(nextScale.toFixed(3)));
        };

        const frame = window.requestAnimationFrame(updateScale);
        const observer = new ResizeObserver(updateScale);

        observer.observe(slider);
        window.addEventListener("resize", updateScale);

        return () => {
            window.cancelAnimationFrame(frame);
            observer.disconnect();
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
                            height: `${TAF_FULLSCREEN_BASE_HEIGHT * tafScale}px`,
                            position: "relative",
                            flex: "0 0 auto",
                        }
                        : undefined
                }
                className={fullscreen ? "" : "flex min-w-max gap-3"}
            >
                <div
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
                    className={`flex min-w-max ${fullscreen ? "h-[440px] items-end gap-3" : "gap-3"}`}
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
                            className="flex h-[420px] w-[155px] shrink-0 flex-col"
                        >
                            <article
                                className="flex h-[380px] flex-none flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-gradient-to-b from-black/70 to-zinc-950 p-4 shadow-lg"
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

                                <div className="mt-0 flex h-30 items-center justify-center">
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

                                <p className="min-h-[20px] text-center text-sm font-semibold leading-5 text-white">
                                    {slot.weatherLabel}
                                </p>

                                <div className="mt-1 min-h-[30px]">
                                    {slot.change !== "BASE" && (
                                        <p className="rounded-full border border-[#d6b35a]/30 bg-[#d6b35a]/10 px-2 py-1 text-center text-[10px] font-bold uppercase tracking-[0.12em] text-[#e6c76f]">
                                            {slot.change}
                                        </p>
                                    )}
                                </div>

                                <div className="mt-2 space-y-2 rounded-xl border border-zinc-800 bg-black/35 p-3 text-xs">
                                    <TafHourRow label="Vis" value={slot.visibility} />
                                    <TafHourRow label="Ceil" value={slot.ceiling} />
                                    <TafHourRow label="Wind" value={slot.wind} />
                                    <TafHourRow label="Gust" value={slot.gusts} />
                                </div>
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
}: {
    station?: string;
    timeZone?: string | null;
    latitude?: number | null;
    longitude?: number | null;
    hourlyOnly?: boolean;
    fullscreen?: boolean;
}) {
    const [taf, setTaf] = useState<TafResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const latestTafRef = useRef<TafResponse | null>(null);

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

            try {
                if (showLoading || !latestTafRef.current) {
                    setLoading(true);
                }

                const response = await fetch(
                    `/api/taf?station=${encodeURIComponent(station)}`,
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
                setError(null);
            } catch (err) {
                if (err instanceof DOMException && err.name === "AbortError") {
                    return;
                }

                if (!latestTafRef.current) {
                    setError(
                        err instanceof Error
                            ? err.message
                            : "Something went wrong loading the TAF."
                    );
                }
            } finally {
                if (isActive && !requestController.signal.aborted) {
                    setLoading(false);
                }
            }
        }

        const initialLoadTimer = window.setTimeout(() => {
            latestTafRef.current = null;
            setTaf(null);
            setError(null);
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
    }, [station]);

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
        <div className="space-y-4 rounded-2xl border border-zinc-800 bg-black/55 p-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#d6b35a]">
                        TAF
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
            </div>

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
        <div className="inline-flex w-fit flex-wrap items-center gap-2 rounded-2xl border border-zinc-700 bg-black/65 px-4 py-3 text-sm font-semibold text-zinc-200">
            <span className={`inline-flex items-center gap-2 ${ageColor}`}>
                <ClockIcon />
                {formatMetarAge(ageMinutes)}
            </span>

            <span className="text-zinc-600">|</span>

            <span>{formatZuluObservation(metar)}</span>

            <span className="text-zinc-600">|</span>

            <span>{formatLocalObservation(metar, stationInfo?.timeZone)}</span>
        </div>
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

function TabButton({
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

function WeatherCard({
    label,
    value,
    detail,
    accent,
}: {
    label: string;
    value: string;
    detail: string;
    accent: "gold" | "silver";
}) {
    const accentClass =
        accent === "gold" ? "border-[#d6b35a]/30" : "border-zinc-700";

    return (
        <div className={`rounded-2xl border ${accentClass} bg-black/55 p-5`}>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
                {label}
            </p>
            <p className="mt-3 text-2xl font-bold text-white">{value}</p>
            <p className="mt-2 text-sm leading-6 text-zinc-400">{detail}</p>
        </div>
    );
}

function RunwayWindWidget({
    metar,
    runways,
    fullscreen = false,
}: {
    metar: NormalizedMetar;
    runways: AirportRunway[];
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
            {!fullscreen && (
                <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                    <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#d6b35a]">
                            Visual Decoder
                        </p>
                        <p className="mt-2 text-sm leading-6 text-zinc-400">
                            Select a runway on the graphic to rotate into that runway’s point of view.
                        </p>
                    </div>
                </div>
            )}

            {fullscreen ? (
                <>
                    <div
                        style={{
                            position: "absolute",
                            top: "8px",
                            bottom: "8px",
                            left: "8px",
                            width: "calc(50% - 12px)",
                            overflow: "hidden",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                        }}
                    >
                        <RunwayCompassSvg
                            runways={runways}
                            runwayEnds={calculatedEnds}
                            selectedEnd={selectedEnd}
                            bestRunwayIdent={bestRunway?.ident ?? null}
                            activeRunway={activeRunway}
                            windDirectionDeg={windDirectionDeg}
                            windSpeedKt={windSpeedKt}
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

                    <div
                        style={{
                            position: "absolute",
                            top: "8px",
                            bottom: "8px",
                            right: "8px",
                            width: "calc(50% - 12px)",
                            overflow: "hidden",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                        }}
                    >
                        <CloudCeilingPreviewSvg
                            metar={metar}
                            fullscreen
                        />
                    </div>
                </>
            ) : (
                <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
                    <div className="min-w-0">
                        <RunwayCompassSvg
                            runways={runways}
                            runwayEnds={calculatedEnds}
                            selectedEnd={selectedEnd}
                            bestRunwayIdent={bestRunway?.ident ?? null}
                            activeRunway={activeRunway}
                            windDirectionDeg={windDirectionDeg}
                            windSpeedKt={windSpeedKt}
                            compassRotation={compassRotation}
                            visibilitySm={metar.visibility.statuteMiles}
                            showResetButton={showResetButton}
                            onResetNorthUp={handleResetNorthUp}
                            onSelectEnd={handleSelectEnd}
                            onCompassRotationChange={handleSetCompassRotation}
                            onOrientToInflight={handleOrientToInflight}
                        />
                    </div>

                    <div className="min-w-0">
                        <CloudCeilingPreviewSvg metar={metar} />
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
            : `${windSpeedKt} kt`;

    const windModeLabel =
        windDisplayMode === "animated"
            ? "Animated wind"
            : windDisplayMode === "direction"
                ? "Wind direction"
                : "Wind hidden";

    const headingAtPointer = Math.round(normalizeAngle360(compassRotation)) % 360;
    const headingAtPointerLabel = `${String(headingAtPointer).padStart(3, "0")}°`;
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

            {activeRunway && (
                <WindComponentStack
                    component={activeRunway.component}
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
                {remarkBubbles.map((remark) => (
                    <div
                        key={`${remark.code}-${remark.meaning}`}
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
