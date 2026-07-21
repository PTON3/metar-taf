"use client";

import { useEffect, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";

type FeedbackType = "bug" | "idea";
type SubmitState = "idle" | "sending" | "success" | "error";

type FeedbackWidgetProps = {
    currentStation?: string;
};

export default function FeedbackWidget({
    currentStation,
}: FeedbackWidgetProps) {
    const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
    const [isOpen, setIsOpen] = useState(false);
    const [feedbackType, setFeedbackType] = useState<FeedbackType>("bug");
    const [summary, setSummary] = useState("");
    const [details, setDetails] = useState("");
    const [reportedStation, setReportedStation] = useState("");
    const [website, setWebsite] = useState("");
    const [submitState, setSubmitState] = useState<SubmitState>("idle");
    const [responseMessage, setResponseMessage] = useState("");

    useEffect(() => {
        function updatePortalTarget() {
            setPortalTarget(
                (document.fullscreenElement as HTMLElement | null) ?? document.body
            );
        }

        updatePortalTarget();
        document.addEventListener("fullscreenchange", updatePortalTarget);

        return () => {
            document.removeEventListener("fullscreenchange", updatePortalTarget);
        };
    }, []);

    useEffect(() => {
        if (!isOpen) return;

        function handleKeyDown(event: KeyboardEvent) {
            if (event.key === "Escape") {
                setIsOpen(false);
            }
        }

        window.addEventListener("keydown", handleKeyDown);

        return () => {
            window.removeEventListener("keydown", handleKeyDown);
        };
    }, [isOpen]);

    async function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();

        if (!summary.trim() || !details.trim()) {
            setSubmitState("error");
            setResponseMessage("Add a short summary and description first.");
            return;
        }

        setSubmitState("sending");
        setResponseMessage("");

        try {
            const response = await fetch("/api/feedback", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    type: feedbackType,
                    summary,
                    details,
                    station: reportedStation.trim() || currentStation || "",
                    pageUrl: window.location.href,
                    userAgent: navigator.userAgent,
                    website,
                }),
            });

            const data = (await response.json().catch(() => ({}))) as {
                error?: string;
                issueNumber?: number | null;
            };

            if (!response.ok) {
                throw new Error(data.error ?? "Unable to submit feedback.");
            }

            setSubmitState("success");
            setResponseMessage(
                typeof data.issueNumber === "number"
                    ? "Submitted successfully."
                    : "Submitted successfully."
            );

            setSummary("");
            setDetails("");
            setReportedStation("");
            setWebsite("");
        } catch (error) {
            setSubmitState("error");
            setResponseMessage(
                error instanceof Error
                    ? error.message
                    : "Unable to submit feedback right now."
            );
        }
    }

    function startAnotherSubmission() {
        setSubmitState("idle");
        setResponseMessage("");
    }

    const widget = (
        <div className="fixed bottom-4 right-4 z-[100] flex flex-col items-end sm:bottom-6 sm:right-6">
            {isOpen && (
                <section
                    role="dialog"
                    aria-label="Website feedback"
                    className="mb-3 w-[min(370px,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-zinc-700 bg-zinc-950/95 shadow-2xl backdrop-blur"
                >

                    {submitState === "success" ? (
                        <div className="p-5 text-center">
                            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-emerald-400/40 bg-emerald-400/10 text-emerald-300">
                                <svg
                                    viewBox="0 0 24 24"
                                    className="h-6 w-6"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2.2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                >
                                    <path d="M5 12l4 4L19 6" />
                                </svg>
                            </div>

                            <p className="mt-4 font-bold text-white">
                                Thanks for the feedback
                            </p>
                            <p className="mt-2 text-sm leading-5 text-zinc-400">
                                {responseMessage}
                            </p>

                            <button
                                type="button"
                                onClick={startAnotherSubmission}
                                className="mt-5 rounded-xl border border-zinc-700 bg-black px-4 py-2 text-sm font-bold text-zinc-200 transition hover:border-[#d6b35a]/50 hover:text-[#e6c76f]"
                            >
                                Send another
                            </button>
                        </div>
                    ) : (
                        <form onSubmit={handleSubmit} className="space-y-4 p-4">
                            <div className="grid grid-cols-2 gap-2 rounded-xl border border-zinc-800 bg-black p-1">
                                <button
                                    type="button"
                                    onClick={() => setFeedbackType("bug")}
                                    className={`rounded-lg px-3 py-2 text-xs font-black uppercase tracking-[0.1em] transition ${
                                        feedbackType === "bug"
                                            ? "bg-red-400/15 text-red-300"
                                            : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200"
                                    }`}
                                >
                                    Report issue
                                </button>

                                <button
                                    type="button"
                                    onClick={() => setFeedbackType("idea")}
                                    className={`rounded-lg px-3 py-2 text-xs font-black uppercase tracking-[0.1em] transition ${
                                        feedbackType === "idea"
                                            ? "bg-[#d6b35a]/15 text-[#e6c76f]"
                                            : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200"
                                    }`}
                                >
                                    Suggest idea
                                </button>
                            </div>

                            <div>
                                <label
                                    htmlFor="feedback-summary"
                                    className="text-xs font-bold text-zinc-300"
                                >
                                    Short summary
                                </label>
                                <input
                                    id="feedback-summary"
                                    value={summary}
                                    onChange={(event) => setSummary(event.target.value)}
                                    maxLength={120}
                                    required
                                    placeholder={
                                        feedbackType === "bug"
                                            ? "Example: TAF cards overlap on iPhone"
                                            : "Example: Add radar imagery"
                                    }
                                    className="mt-2 w-full rounded-xl border border-zinc-800 bg-black px-3 py-2.5 text-sm text-white outline-none placeholder:text-zinc-600 focus:border-[#d6b35a]/60"
                                />
                            </div>

                            <div>
                                <label
                                    htmlFor="feedback-details"
                                    className="text-xs font-bold text-zinc-300"
                                >
                                    Description
                                </label>
                                <textarea
                                    id="feedback-details"
                                    value={details}
                                    onChange={(event) => setDetails(event.target.value)}
                                    maxLength={4000}
                                    required
                                    rows={5}
                                    placeholder={
                                        feedbackType === "bug"
                                            ? "What happened, and what did you expect instead?"
                                            : "What should be added, and why would it be useful?"
                                    }
                                    className="mt-2 w-full resize-none rounded-xl border border-zinc-800 bg-black px-3 py-2.5 text-sm leading-5 text-white outline-none placeholder:text-zinc-600 focus:border-[#d6b35a]/60"
                                />
                            </div>

                            <div>
                                <label
                                    htmlFor="feedback-station"
                                    className="text-xs font-bold text-zinc-300"
                                >
                                    Airport / station
                                    <span className="ml-1 font-normal text-zinc-600">
                                        optional
                                    </span>
                                </label>
                                <input
                                    id="feedback-station"
                                    value={reportedStation}
                                    onChange={(event) =>
                                        setReportedStation(event.target.value.toUpperCase())
                                    }
                                    maxLength={12}
                                    placeholder={currentStation || "KFCM"}
                                    className="mt-2 w-full rounded-xl border border-zinc-800 bg-black px-3 py-2.5 text-sm uppercase text-white outline-none placeholder:text-zinc-600 focus:border-[#d6b35a]/60"
                                />
                                <p className="mt-1.5 text-[11px] text-zinc-600">
                                    Leave blank to use the current station.
                                </p>
                            </div>

                            <div
                                className="absolute -left-[10000px] top-auto h-px w-px overflow-hidden"
                                aria-hidden="true"
                            >
                                <label htmlFor="feedback-website">Website</label>
                                <input
                                    id="feedback-website"
                                    value={website}
                                    onChange={(event) => setWebsite(event.target.value)}
                                    tabIndex={-1}
                                    autoComplete="off"
                                />
                            </div>

                            {submitState === "error" && (
                                <p
                                    role="alert"
                                    className="rounded-xl border border-red-500/30 bg-red-950/30 px-3 py-2 text-xs leading-5 text-red-200"
                                >
                                    {responseMessage}
                                </p>
                            )}

                            <button
                                type="submit"
                                disabled={submitState === "sending"}
                                className="w-full rounded-xl border border-[#d6b35a]/50 bg-[#d6b35a]/10 px-4 py-3 text-sm font-black uppercase tracking-[0.12em] text-[#e6c76f] transition hover:bg-[#d6b35a]/20 disabled:cursor-wait disabled:opacity-60"
                            >
                                {submitState === "sending"
                                    ? "Submitting..."
                                    : "Submit feedback"}
                            </button>

                        </form>
                    )}
                </section>
            )}

            <button
                type="button"
                onClick={() => {
                    setIsOpen((current) => !current);

                    if (submitState === "error") {
                        setSubmitState("idle");
                        setResponseMessage("");
                    }
                }}
                aria-expanded={isOpen}
                aria-label={isOpen ? "Close feedback form" : "Open feedback form"}
                className="inline-flex items-center gap-2 rounded-full border border-[#d6b35a]/50 bg-[#0a0a0a]/95 px-4 py-3 text-xs font-black uppercase tracking-[0.14em] text-[#e6c76f] shadow-2xl backdrop-blur transition hover:scale-[1.03] hover:border-[#e6c76f] hover:bg-[#d6b35a]/10"
            >
                <svg
                    viewBox="0 0 24 24"
                    className="h-4 w-4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                >
                    <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z" />
                    <path d="M8 9h8" />
                    <path d="M8 13h5" />
                </svg>

                {isOpen ? "Close" : "Feedback"}
            </button>
        </div>
    );

    return portalTarget ? createPortal(widget, portalTarget) : null;
}
