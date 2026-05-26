"use client";

import { useEffect, useState, type ReactNode } from "react";
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

type StationInfoResponse = {
    data?: StationInfo;
    error?: string;
};

type RemarkBubble = {
    code: string;
    meaning: string;
};

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
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);


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

    useEffect(() => {
        void fetchLiveMetar("KFCM");
        // Run once on page load so the app defaults to KFCM.
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
                        METAR Visual Decoder
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
}: {
    metar: NormalizedMetar;
    rawMetar: string;
    stationInfo: StationInfo | null;
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
                            Weather
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
                    <WeatherDashboardTab metar={metar} rawMetar={rawMetar} />
                )}

                {activeDashboardTab === "taf" && <TafDashboardTab />}

                {activeDashboardTab === "airport" && (
                    <AirportInfoDashboardTab stationInfo={stationInfo} />
                )}
            </div>
        </section>
    );
}

function WeatherDashboardTab({
    metar,
    rawMetar,
}: {
    metar: NormalizedMetar;
    rawMetar: string;
}) {
    return (
        <>
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
}: {
    stationInfo: StationInfo | null;
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
            </div>

            <div className="rounded-2xl border border-zinc-800 bg-black/55 p-5">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#d6b35a]">
                    FAA Airport Diagram
                </p>

                <div className="mt-4 flex min-h-64 items-center justify-center rounded-2xl border border-dashed border-zinc-700 bg-zinc-950 p-6 text-center">
                    <div>
                        <p className="text-lg font-bold text-white">
                            Diagram Preview Placeholder
                        </p>
                        <p className="mt-2 max-w-md text-sm leading-6 text-zinc-400">
                            This panel will later show the FAA airport diagram
                            PDF or image for the selected airport. The same
                            airport data layer will also feed the runway and
                            crosswind widget.
                        </p>

                        <a
                            href="https://www.faa.gov/airports/runway_safety/diagrams"
                            target="_blank"
                            rel="noreferrer"
                            className="mt-5 inline-flex rounded-xl border border-[#d6b35a]/50 bg-[#d6b35a]/10 px-5 py-3 text-sm font-bold text-[#e6c76f] transition hover:bg-[#d6b35a]/20"
                        >
                            Open FAA Diagram Search
                        </a>
                    </div>
                </div>
            </div>
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