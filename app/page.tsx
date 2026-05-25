"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { FlightCategory, NormalizedMetar } from "@/lib/metar/types";

type ApiResponse = {
    raw?: string;
    normalized?: NormalizedMetar;
    error?: string;
};

type DecoderTab = "lookup" | "raw";

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

            setMetar(data.normalized ?? null);
            setRawMetar(data.raw ?? null);
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

            setMetar(data.normalized ?? null);
            setRawMetar(data.raw ?? rawInput);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Unexpected error.");
        } finally {
            setLoading(false);
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

                    <p className="mt-4 max-w-2xl text-base leading-7 text-zinc-300">
                        Created by Preston Vaughn
                    </p>
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

                            <label className="mb-2 block text-sm font-medium text-zinc-300">
                                Airport ICAO
                            </label>

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
                                    className="rounded-xl bg-[#d6b35a] px-6 py-3 font-bold text-black transition hover:bg-[#e6c76f] disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    {loading ? "Loading..." : "Fetch"}
                                </button>
                            </div>

                            <p className="mt-3 text-sm text-zinc-500">
                                Default station is KFCM. Try KMSP, KANE, KSTP, or any valid
                                ICAO station.
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

                            <textarea
                                value={rawInput}
                                onChange={(event) => setRawInput(event.target.value)}
                                className="min-h-28 w-full rounded-xl border border-zinc-700 bg-black px-4 py-3 font-mono text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-[#d6b35a]"
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
                    )}
                </section>

                {error && (
                    <div className="mt-6 rounded-2xl border border-red-500/40 bg-red-950/30 p-4 text-red-200">
                        {error}
                    </div>
                )}

                {metar ? (
                    <MetarDashboard metar={metar} rawMetar={rawMetar ?? metar.raw} />
                ) : (
                    <EmptyState />
                )}
            </div>
        </main>
    );
}

function MetarDashboard({
    metar,
    rawMetar,
}: {
    metar: NormalizedMetar;
    rawMetar: string;
}) {
    const categoryStyle = FLIGHT_CATEGORY_STYLES[metar.flightCategory];

    return (
        <section className="mt-8 overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-950/90 shadow-2xl">
            <div className="border-b border-zinc-800 bg-gradient-to-r from-black via-zinc-950 to-[#171307] p-6">
                <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
                    <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#d6b35a]">
                            Decoded Airport Weather
                        </p>

                        <h2 className="mt-2 text-4xl font-bold text-white">
                            {metar.station ?? "Unknown Station"}
                        </h2>

                        <p className="mt-2 text-sm text-zinc-400">
                            Observed on day {metar.observed.day ?? "--"} at{" "}
                            {String(metar.observed.hourUtc ?? "--").padStart(2, "0")}
                            {String(metar.observed.minuteUtc ?? "--").padStart(2, "0")}Z
                        </p>
                    </div>

                    <div
                        className={`rounded-2xl border px-6 py-4 text-center ${categoryStyle}`}
                    >
                        <p className="text-xs font-semibold uppercase tracking-[0.2em]">
                            Flight Category
                        </p>
                        <p className="mt-1 text-4xl font-black">{metar.flightCategory}</p>
                        <p className="mt-1 text-sm">{getFlightCategoryDescription(metar)}</p>
                    </div>
                </div>
            </div>

            <div className="p-6">
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

                <div className="mt-6 rounded-2xl border border-[#d6b35a]/20 bg-[#d6b35a]/10 p-4">
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#e6c76f]">
                        Raw METAR
                    </p>
                    <p className="mt-3 break-words font-mono text-sm leading-6 text-zinc-200">
                        {rawMetar}
                    </p>
                </div>
            </div>
        </section>
    );
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