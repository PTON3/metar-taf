"use client";

import { useState } from "react";
import type { NormalizedMetar } from "@/lib/metar/types";

type ApiResponse = {
    raw?: string;
    normalized?: NormalizedMetar;
    error?: string;
};

export default function Home() {
    const [station, setStation] = useState("KFCM");
    const [rawInput, setRawInput] = useState(
        "KFCM 251853Z 18012G20KT 10SM FEW040 SCT250 24/14 A2992"
    );

    const [metar, setMetar] = useState<NormalizedMetar | null>(null);
    const [rawMetar, setRawMetar] = useState<string | null>(null);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);

    async function fetchLiveMetar() {
        setLoading(true);
        setError("");

        try {
            const response = await fetch(`/api/metar/live?station=${station}`);
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

    return (
        <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
            <div className="mx-auto max-w-5xl space-y-8">
                <section className="space-y-3">
                    <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-300">
                        METAR Visual Decoder
                    </p>

                    <h1 className="text-4xl font-bold tracking-tight">
                        Airport Weather Decoder
                    </h1>

                    <p className="max-w-2xl text-slate-300">
                        Search live METARs by ICAO airport code or paste a raw METAR string
                        to decode it into a clean app-friendly format.
                    </p>
                </section>

                <section className="grid gap-6 md:grid-cols-2">
                    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5 shadow-lg">
                        <h2 className="mb-4 text-xl font-semibold">Live airport lookup</h2>

                        <label className="mb-2 block text-sm text-slate-300">
                            Airport ICAO
                        </label>

                        <div className="flex gap-3">
                            <input
                                value={station}
                                onChange={(event) => setStation(event.target.value.toUpperCase())}
                                className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-slate-100 outline-none focus:border-sky-400"
                                placeholder="KFCM"
                            />

                            <button
                                onClick={fetchLiveMetar}
                                disabled={loading}
                                className="rounded-xl bg-sky-500 px-5 py-3 font-semibold text-slate-950 transition hover:bg-sky-400 disabled:opacity-50"
                            >
                                Fetch
                            </button>
                        </div>
                    </div>

                    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5 shadow-lg">
                        <h2 className="mb-4 text-xl font-semibold">Decode raw METAR</h2>

                        <label className="mb-2 block text-sm text-slate-300">
                            Raw METAR
                        </label>

                        <textarea
                            value={rawInput}
                            onChange={(event) => setRawInput(event.target.value)}
                            className="min-h-24 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-slate-100 outline-none focus:border-sky-400"
                        />

                        <button
                            onClick={decodeRawMetar}
                            disabled={loading}
                            className="mt-3 rounded-xl bg-sky-500 px-5 py-3 font-semibold text-slate-950 transition hover:bg-sky-400 disabled:opacity-50"
                        >
                            Decode
                        </button>
                    </div>
                </section>

                {error && (
                    <div className="rounded-2xl border border-red-500/40 bg-red-950/40 p-4 text-red-200">
                        {error}
                    </div>
                )}

                {metar && (
                    <section className="rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-lg">
                        <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
                            <div>
                                <h2 className="text-3xl font-bold">
                                    {metar.station ?? "Unknown Station"}
                                </h2>
                                <p className="text-slate-400">
                                    Observed {metar.observed.day ?? "--"} at{" "}
                                    {String(metar.observed.hourUtc ?? "--").padStart(2, "0")}
                                    {String(metar.observed.minuteUtc ?? "--").padStart(2, "0")}Z
                                </p>
                            </div>

                            <span className="rounded-full bg-emerald-400 px-5 py-2 text-lg font-bold text-slate-950">
                                {metar.flightCategory}
                            </span>
                        </div>

                        <div className="grid gap-4 md:grid-cols-3">
                            <WeatherCard
                                label="Wind"
                                value={
                                    metar.wind.variable
                                        ? `VRB at ${metar.wind.speedKt ?? "--"} kt`
                                        : `${metar.wind.directionDeg ?? "--"}° at ${metar.wind.speedKt ?? "--"
                                        } kt`
                                }
                                detail={
                                    metar.wind.gustKt ? `Gusting ${metar.wind.gustKt} kt` : "No gusts"
                                }
                            />

                            <WeatherCard
                                label="Visibility"
                                value={`${metar.visibility.statuteMiles ?? "--"} SM`}
                                detail={metar.visibility.raw ?? "Not reported"}
                            />

                            <WeatherCard
                                label="Ceiling"
                                value={
                                    metar.ceiling.feetAgl
                                        ? `${metar.ceiling.feetAgl.toLocaleString()} ft AGL`
                                        : "No ceiling"
                                }
                                detail={metar.ceiling.cover ?? "Clear or FEW/SCT only"}
                            />

                            <WeatherCard
                                label="Clouds"
                                value={
                                    metar.clouds.length > 0
                                        ? metar.clouds
                                            .map(
                                                (cloud) =>
                                                    `${cloud.cover} ${cloud.baseFeetAgl
                                                        ? cloud.baseFeetAgl.toLocaleString()
                                                        : "---"
                                                    }`
                                            )
                                            .join(", ")
                                        : "CLR"
                                }
                                detail="Cloud layers"
                            />

                            <WeatherCard
                                label="Temperature"
                                value={`${metar.temperature.celsius ?? "--"}°C / ${metar.temperature.fahrenheit ?? "--"
                                    }°F`}
                                detail={`Dewpoint ${metar.dewpoint.celsius ?? "--"}°C / ${metar.dewpoint.fahrenheit ?? "--"
                                    }°F`}
                            />

                            <WeatherCard
                                label="Altimeter"
                                value={`${metar.altimeter.inHg ?? "--"} inHg`}
                                detail={metar.altimeter.raw ?? "Not reported"}
                            />
                        </div>

                        <div className="mt-6 rounded-xl border border-slate-800 bg-slate-950 p-4">
                            <p className="mb-2 text-sm font-semibold uppercase tracking-wider text-slate-400">
                                Raw METAR
                            </p>
                            <p className="font-mono text-sm text-slate-200">
                                {rawMetar ?? metar.raw}
                            </p>
                        </div>
                    </section>
                )}
            </div>
        </main>
    );
}

function WeatherCard({
    label,
    value,
    detail,
}: {
    label: string;
    value: string;
    detail: string;
}) {
    return (
        <div className="rounded-xl border border-slate-800 bg-slate-950 p-4">
            <p className="text-sm font-semibold uppercase tracking-wider text-slate-400">
                {label}
            </p>
            <p className="mt-2 text-2xl font-bold">{value}</p>
            <p className="mt-1 text-sm text-slate-400">{detail}</p>
        </div>
    );
}
