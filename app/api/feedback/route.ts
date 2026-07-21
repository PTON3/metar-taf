import { NextResponse } from "next/server";

export const runtime = "nodejs";

const RATE_LIMIT_WINDOW_MS = 30_000;
const recentSubmissions = new Map<string, number>();

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(value: unknown, maxLength: number): string {
    if (typeof value !== "string") return "";

    return value.replace(/\0/g, "").trim().slice(0, maxLength);
}

function safeInlineText(value: string): string {
    return value.replace(/[\r\n]+/g, " ").replace(/`/g, "'");
}

function safeCodeText(value: string): string {
    return value.replace(/```/g, "'''");
}

function getClientKey(request: Request): string {
    const forwardedFor = request.headers.get("x-forwarded-for");
    const firstForwardedAddress = forwardedFor?.split(",")[0]?.trim();

    return (
        firstForwardedAddress ||
        request.headers.get("x-real-ip") ||
        "unknown-client"
    );
}

export async function POST(request: Request) {
    const token = process.env.GITHUB_FEEDBACK_TOKEN;
    const owner = process.env.GITHUB_FEEDBACK_OWNER;
    const repo = process.env.GITHUB_FEEDBACK_REPO;

    if (!token || !owner || !repo) {
        console.error("Feedback environment variables are missing.");

        return NextResponse.json(
            { error: "The feedback service is not configured yet." },
            { status: 503 }
        );
    }

    let rawPayload: unknown;

    try {
        rawPayload = await request.json();
    } catch {
        return NextResponse.json(
            { error: "Invalid feedback request." },
            { status: 400 }
        );
    }

    if (!isRecord(rawPayload)) {
        return NextResponse.json(
            { error: "Invalid feedback request." },
            { status: 400 }
        );
    }

    // Honeypot: bots commonly fill fields that human users never see.
    if (readText(rawPayload.website, 200)) {
        return NextResponse.json({ ok: true, issueNumber: null });
    }

    const type = readText(rawPayload.type, 20);
    const summary = readText(rawPayload.summary, 120);
    const details = readText(rawPayload.details, 4000);
    const station = readText(rawPayload.station, 20).toUpperCase();
    const pageUrl = readText(rawPayload.pageUrl, 1000);
    const userAgent = readText(rawPayload.userAgent, 600);

    if (type !== "bug" && type !== "idea") {
        return NextResponse.json(
            { error: "Choose either an issue report or an idea." },
            { status: 400 }
        );
    }

    if (summary.length < 4 || details.length < 10) {
        return NextResponse.json(
            { error: "Add a little more detail before submitting." },
            { status: 400 }
        );
    }

    const clientKey = getClientKey(request);
    const now = Date.now();

    for (const [key, submittedAt] of recentSubmissions) {
        if (now - submittedAt > RATE_LIMIT_WINDOW_MS) {
            recentSubmissions.delete(key);
        }
    }

    const lastSubmission = recentSubmissions.get(clientKey);

    if (
        typeof lastSubmission === "number" &&
        now - lastSubmission < RATE_LIMIT_WINDOW_MS
    ) {
        return NextResponse.json(
            { error: "Please wait a few seconds before submitting again." },
            { status: 429 }
        );
    }

    const typeLabel = type === "bug" ? "Bug" : "Idea";
    const issueTitle = `[Website ${typeLabel}] ${summary}`;

    const issueBody = [
        "## Anonymous website feedback",
        "",
        `**Type:** ${type === "bug" ? "Problem report" : "Feature suggestion"}`,
        `**Airport / station:** ${station || "Not provided"}`,
        `**Page:** ${pageUrl ? `\`${safeInlineText(pageUrl)}\`` : "Unavailable"}`,
        "",
        "### Summary",
        summary,
        "",
        "### Description",
        details,
        "",
        "### Browser information",
        "```text",
        safeCodeText(userAgent || "Unavailable"),
        "```",
        "",
        "---",
        "Submitted anonymously through the InflightOS Weather feedback widget.",
    ].join("\n");

    try {
        const githubResponse = await fetch(
            `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
            {
                method: "POST",
                headers: {
                    Accept: "application/vnd.github+json",
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                    "User-Agent": "InflightOS-Weather-Feedback",
                    "X-GitHub-Api-Version": "2026-03-10",
                },
                body: JSON.stringify({
                    title: issueTitle,
                    body: issueBody,
                }),
                cache: "no-store",
            }
        );

        const githubResponseText = await githubResponse.text();

        if (!githubResponse.ok) {
            console.error(
                "GitHub issue creation failed:",
                githubResponse.status,
                githubResponseText.slice(0, 1200)
            );

            return NextResponse.json(
                { error: "Unable to submit feedback right now." },
                { status: 502 }
            );
        }

        let issueNumber: number | null = null;

        try {
            const issueData = JSON.parse(githubResponseText) as {
                number?: unknown;
            };

            if (typeof issueData.number === "number") {
                issueNumber = issueData.number;
            }
        } catch {
            // The issue was created even if its response could not be parsed.
        }

        recentSubmissions.set(clientKey, now);

        return NextResponse.json({
            ok: true,
            issueNumber,
        });
    } catch (error) {
        console.error("Feedback submission failed:", error);

        return NextResponse.json(
            { error: "Unable to submit feedback right now." },
            { status: 502 }
        );
    }
}
