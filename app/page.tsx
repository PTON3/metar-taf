"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { FlightCategory, NormalizedMetar } from "@/lib/metar/types";

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

const FLIGHT_CATEGORY_STYLES: Record<FlightCategory, string> = {
    VFR: "border-emerald-400/50 bg-emerald-400/15 text-emerald-200",
    MVFR: "border-sky-400/50 bg-sky-400/15 text-sky-200",
    IFR: "border-red-400/50 bg-red-400/15 text-red-200",
    LIFR: "border-fuchsia-400/50 bg-fuchsia-400/15 text-fuchsia-200",
    UNKNOWN: "border-zinc-500/50 bg-zinc-500/15 text-zinc-200",
};

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

    const [loading, setLoading] = useState(false);
    const latestStationRef = useRef(station);
    const latestActiveTabRef = useRef(activeTab);

    useEffect(() => {
        latestStationRef.current = station;
    }, [station]);

    useEffect(() => {
        latestActiveTabRef.current = activeTab;
    }, [activeTab]);

    async function fetchLiveMetar(stationToFetch = station) {
        const cleanStation = stationToFetch.trim().toUpperCase();

        setLoading(true);
        setError("");
        setStation(cleanStation);

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
        void fetchLiveMetar("KFCM");

        const refreshTimer = window.setInterval(() => {
            if (latestActiveTabRef.current === "lookup") {
                void fetchLiveMetar(latestStationRef.current);
            }
        }, 5 * 60 * 1000);

        return () => window.clearInterval(refreshTimer);

        // Run once on page load, then refresh the current live ICAO lookup every 5 minutes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <main className="min-h-screen bg-[#050505] text-zinc-100">
            <div className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_top_left,_rgba(214,179,90,0.16),_transparent_35%),radial-gradient(circle_at_top_right,_rgba(255,255,255,0.08),_transparent_30%)]" />

            <div className="mx-auto max-w-7xl px-6 py-8">
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
                        stationInfo={stationInfo}
                        airportDiagram={airportDiagram}
                        runways={runways}
                    />
                    ) : (
                    <EmptyState />
                )}

                <footer className="mt-10 border-t border-zinc-900 pt-5 text-center">
                    <p className="text-[11px] leading-5 text-zinc-500">
                        Created by Preston Vaughn for Inflight Aviation. METAR data provided by
                        AviationWeather.gov.
                    </p>
                </footer>

            </div>
        </main>
    );
}

function MetarDashboard({
    metar,
    rawMetar,
    stationInfo,
    airportDiagram,
    runways,
}: {
    metar: NormalizedMetar;
    rawMetar: string;
    stationInfo: StationInfo | null;
    airportDiagram: AirportDiagramInfo | null;
    runways: AirportRunway[];

}) {
    const [now, setNow] = useState(() => new Date());
    const [activeDashboardTab, setActiveDashboardTab] =
        useState<DashboardTab>("weather");

    const categoryStyle = FLIGHT_CATEGORY_STYLES[metar.flightCategory];

    useEffect(() => {
        const timer = window.setInterval(() => {
            setNow(new Date());
        }, 60_000);

        return () => window.clearInterval(timer);
    }, []);

    return (
        <section className="mt-8 overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-950/90 shadow-2xl">
            <div className="border-b border-zinc-800 bg-gradient-to-r from-black via-zinc-950 to-[#171307] p-6">
                <div className="flex flex-col gap-4">
                    <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#d6b35a]">
                            Decoded Airport Weather
                        </p>

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

                {activeDashboardTab === "taf" && <TafDashboardTab />}

                {activeDashboardTab === "airport" && (
                    <AirportInfoDashboardTab
                        stationInfo={stationInfo}
                        airportDiagram={airportDiagram}
                        runways={runways}
                    />
                )}
            </div>
        </section>
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

function TafDashboardTab() {
    return (
        <div className="rounded-2xl border border-dashed border-zinc-800 bg-black/55 p-8 text-center">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#d6b35a]">
                TAF
            </p>
            <h3 className="mt-2 text-2xl font-bold text-white">
                TAF Decoder Coming Soon
            </h3>
            <p className="mx-auto mt-3 max-w-2xl text-sm leading-6 text-zinc-400">
                This tab will eventually show a decoded TAF timeline, forecast
                flight category changes, forecast winds, ceiling and visibility
                changes, and temporary/probability groups.
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
}: {
    metar: NormalizedMetar;
    runways: AirportRunway[];
}) {
    const [selectedEnd, setSelectedEnd] = useState<RunwayEnd | null>(null);

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
    const hasWindDirection = windDirectionDeg !== null && windSpeedKt > 0;

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

    const compassRotation = selectedEnd?.headingDeg ?? 0;

    return (
        <div className="mb-6 rounded-2xl border border-[#d6b35a]/25 bg-black/55 p-5">
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

            <div className="mt-5 grid gap-5 xl:grid-cols-2">
                <RunwayCompassSvg
                    runways={runways}
                    runwayEnds={calculatedEnds}
                    selectedEnd={selectedEnd}
                    bestRunwayIdent={bestRunway?.ident ?? null}
                    activeRunway={activeRunway}
                    windDirectionDeg={windDirectionDeg}
                    windSpeedKt={windSpeedKt}
                    compassRotation={compassRotation}
                    showResetButton={selectedEnd !== null}
                    onResetNorthUp={() => setSelectedEnd(null)}
                    onSelectEnd={setSelectedEnd}
                />

                <CloudCeilingPreviewSvg metar={metar} />
            </div>
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
}) {
    const center = 200;
    const radius = 158;

    const [windDisplayMode, setWindDisplayMode] =
        useState<WindDisplayMode>("animated");

    const runwayLayout = buildRunwayLayout(runways, compassRotation, center);

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

    function cycleWindDisplayMode() {
        setWindDisplayMode((currentMode) => {
            if (currentMode === "animated") return "direction";
            if (currentMode === "direction") return "hidden";
            return "animated";
        });
    }

    return (
        <svg
            viewBox="0 0 400 400"
            className="h-auto w-full rounded-2xl bg-black"
            role="img"
            aria-label="Runway and wind compass"
        >
            <defs>
                <clipPath id="wind-field-clip">
                    <circle cx={center} cy={center} r={radius - 6} />
                </clipPath>

            </defs>

            <circle
                cx={center}
                cy={center}
                r={radius}
                fill="#050505"
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

            <circle cx={center} cy={center} r="4" fill="#e6c76f" />

            {activeRunway && (
                <RunwayStatusBadge
                    activeRunway={activeRunway}
                    selectedEnd={selectedEnd}
                />
            )}

            {showResetButton && (
                <g
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
        : `BEST RWY ${activeRunway.pairName}`;

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
                        d="M 9 0 L -10 0 M -5 -5 L -10 0 L -5 5"
                        fill="none"
                        stroke="#e6c76f"
                        strokeWidth="2.4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    />
                )}

                {component.crosswindFrom === "right" && (
                    <path
                        d="M -9 0 L 10 0 M 5 -5 L 10 0 L 5 5"
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

function CloudCeilingPreviewSvg({ metar }: { metar: NormalizedMetar }) {
    const ceiling = metar.ceiling.feetAgl;
    const cloudLayers = metar.clouds.slice(0, 3);

    function altitudeToY(feet: number): number {
        const cappedFeet = Math.min(Math.max(feet, 0), 12000);
        return 330 - (cappedFeet / 12000) * 240;
    }

    return (
        <svg
            viewBox="0 0 400 400"
            className="h-auto w-full rounded-2xl bg-black"
            role="img"
            aria-label="Cloud and ceiling visualization"
        >
            <rect x="0" y="0" width="400" height="400" fill="#050505" />

            {[0, 3000, 6000, 9000, 12000].map((altitude) => {
                const y = altitudeToY(altitude);

                return (
                    <g key={altitude}>
                        <line
                            x1="42"
                            y1={y}
                            x2="370"
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
                            {altitude === 0 ? "SFC" : `${altitude / 1000}k`}
                        </text>
                    </g>
                );
            })}

            <rect x="42" y="330" width="328" height="10" rx="5" fill="#3f3f46" />

            {cloudLayers.length > 0 ? (
                cloudLayers.map((cloud, index) => {
                    const y =
                        cloud.baseFeetAgl !== null
                            ? altitudeToY(cloud.baseFeetAgl)
                            : 150 + index * 42;

                    return (
                        <g key={`${cloud.cover}-${index}`}>
                            <CloudIcon x={120 + index * 58} y={y} />
                            <text
                                x={200}
                                y={y + 34}
                                textAnchor="middle"
                                fill="#d4d4d8"
                                fontSize="12"
                                fontWeight="700"
                            >
                                {cloud.cover}{" "}
                                {cloud.baseFeetAgl !== null
                                    ? `${cloud.baseFeetAgl.toLocaleString()} ft`
                                    : ""}
                            </text>
                        </g>
                    );
                })
            ) : (
                <text
                    x="200"
                    y="190"
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fill="#d4d4d8"
                    fontSize="18"
                    fontWeight="800"
                >
                    CLR
                </text>
            )}

            {ceiling !== null && (
                <g>
                    <line
                        x1="60"
                        y1={altitudeToY(ceiling)}
                        x2="350"
                        y2={altitudeToY(ceiling)}
                        stroke="#e6c76f"
                        strokeWidth="3"
                    />
                    <rect
                        x="110"
                        y={altitudeToY(ceiling) - 34}
                        width="180"
                        height="26"
                        rx="13"
                        fill="#050505"
                        stroke="#d6b35a"
                    />
                    <text
                        x="200"
                        y={altitudeToY(ceiling) - 20}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fill="#ffffff"
                        fontSize="12"
                        fontWeight="800"
                    >
                        Ceiling {ceiling.toLocaleString()} ft
                    </text>
                </g>
            )}
        </svg>
    );
}

function CloudIcon({ x, y }: { x: number; y: number }) {
    return (
        <g transform={`translate(${x} ${y})`}>
            <circle cx="0" cy="0" r="14" fill="#d4d4d8" />
            <circle cx="18" cy="-6" r="18" fill="#d4d4d8" />
            <circle cx="38" cy="2" r="13" fill="#d4d4d8" />
            <rect x="-2" y="0" width="48" height="15" rx="7" fill="#d4d4d8" />
        </g>
    );
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

function buildRunwayLayout(
    runways: AirportRunway[],
    rotationDeg: number,
    center: number
): RunwayLayout[] {
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
        return [];
    }

    const averageLatitude =
        validEndpoints.reduce((sum, point) => sum + (point.latitude ?? 0), 0) /
        validEndpoints.length;

    const averageLongitude =
        validEndpoints.reduce((sum, point) => sum + (point.longitude ?? 0), 0) /
        validEndpoints.length;

    const cosLatitude = Math.cos((averageLatitude * Math.PI) / 180);

    const localPoints = validEndpoints.map((point) => {
        const xEast = ((point.longitude ?? 0) - averageLongitude) * cosLatitude;
        const yNorth = (point.latitude ?? 0) - averageLatitude;
        const rotated = rotateLocalPoint(xEast, yNorth, rotationDeg);

        return {
            runway: point.runway,
            end: point.end,
            x: rotated.x,
            y: rotated.y,
        };
    });

    const maxExtent =
        Math.max(
            ...localPoints.map((point) => Math.abs(point.x)),
            ...localPoints.map((point) => Math.abs(point.y)),
            0.0001
        ) * 1.25;

    const scale = 150 / maxExtent;

    function toSvgPoint(point: { x: number; y: number }): SvgPoint {
        return {
            x: center + point.x * scale,
            y: center - point.y * scale,
        };
    }

    return runways
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
                start: toSvgPoint(startPoint),
                end: toSvgPoint(endPoint),
            };
        })
        .filter((layout): layout is RunwayLayout => layout !== null);
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
