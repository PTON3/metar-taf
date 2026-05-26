type AirportDiagramResponse = {
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

const FAA_DTPP_SEARCH_URL =
    "https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/dtpp/search/";

const FAA_AIRPORT_DIAGRAM_PAGE_URL =
    "https://www.faa.gov/airports/runway_safety/diagrams/";

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

function decodeHtml(value: string): string {
    return value
        .replaceAll("&amp;", "&")
        .replaceAll("&quot;", "\"")
        .replaceAll("&#039;", "'")
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">");
}

function stripHtml(value: string): string {
    return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function getPdfName(pdfUrl: string): string | null {
    try {
        const url = new URL(pdfUrl);
        const parts = url.pathname.split("/");
        return parts[parts.length - 1] || null;
    } catch {
        return null;
    }
}

function getCycleFromPdfUrl(pdfUrl: string): string | null {
    const match = pdfUrl.match(/\/d-?tpp\/([^/]+)\//i);
    return match?.[1] ?? null;
}

function getCurrentCycleFromHtml(html: string): string | null {
    const cycleFromLink = html.match(/cycle=(\d{4})/i);

    if (cycleFromLink?.[1]) {
        return cycleFromLink[1];
    }

    const cycleFromText = html.match(/Procedure effective date:[\s\S]*?\((\d{4})\)/i);

    if (cycleFromText?.[1]) {
        return cycleFromText[1];
    }

    return null;
}

function findAirportDiagramPdfUrl(
    html: string,
    searchResultsUrl: string
): string | null {
    const rows = Array.from(html.matchAll(/<tr[\s\S]*?<\/tr>/gi)).map(
        (match) => match[0]
    );

    for (const row of rows) {
        const rowText = stripHtml(row).toUpperCase();

        const looksLikeAirportDiagram =
            rowText.includes("APD") && rowText.includes("AIRPORT DIAGRAM");

        if (!looksLikeAirportDiagram) {
            continue;
        }

        const hrefMatch = row.match(/href=["']([^"']*\.pdf[^"']*)["']/i);

        if (hrefMatch?.[1]) {
            return new URL(decodeHtml(hrefMatch[1]), searchResultsUrl).toString();
        }
    }

    const allPdfLinks = Array.from(
        html.matchAll(/href=["']([^"']*\.pdf[^"']*)["']/gi)
    ).map((match) =>
        new URL(decodeHtml(match[1]), searchResultsUrl).toString()
    );

    const airportDiagramLink = allPdfLinks.find((link) =>
        /ad\.pdf(?:$|[#?])/i.test(link)
    );

    return airportDiagramLink ?? null;
}

function buildSearchUrls(station: string, faaIdent: string, cycle: string | null) {
    const identifiers = [
        station.toLowerCase(),
        station,
        faaIdent.toLowerCase(),
        faaIdent,
    ];

    const urls: string[] = [];

    if (cycle) {
        for (const ident of identifiers) {
            urls.push(
                `${FAA_DTPP_SEARCH_URL}results/?cycle=${encodeURIComponent(
                    cycle
                )}&ident=${encodeURIComponent(ident)}`
            );
        }
    }

    for (const ident of identifiers) {
        urls.push(
            `${FAA_DTPP_SEARCH_URL}results/?ident=${encodeURIComponent(ident)}`
        );
    }

    return Array.from(new Set(urls));
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
        let cycle: string | null = null;

        const searchPageResponse = await fetch(FAA_DTPP_SEARCH_URL, {
            next: {
                revalidate: 86_400,
            },
        });

        if (searchPageResponse.ok) {
            const searchPageHtml = await searchPageResponse.text();
            cycle = getCurrentCycleFromHtml(searchPageHtml);
        }

        const searchUrls = buildSearchUrls(station, faaIdent, cycle);

        let selectedSearchResultsUrl = searchUrls[0];
        let selectedHtml = "";
        let diagramPdfUrl: string | null = null;

        for (const url of searchUrls) {
            const response = await fetch(url, {
                next: {
                    revalidate: 86_400,
                },
            });

            if (!response.ok) {
                continue;
            }

            const html = await response.text();
            const candidateDiagramPdfUrl = findAirportDiagramPdfUrl(html, url);

            if (!selectedHtml) {
                selectedHtml = html;
                selectedSearchResultsUrl = url;
            }

            if (candidateDiagramPdfUrl) {
                selectedHtml = html;
                selectedSearchResultsUrl = url;
                diagramPdfUrl = candidateDiagramPdfUrl;
                break;
            }
        }

        const resolvedCycle =
            diagramPdfUrl !== null
                ? getCycleFromPdfUrl(diagramPdfUrl)
                : cycle ?? getCurrentCycleFromHtml(selectedHtml);

        const result: AirportDiagramResponse = {
            station,
            faaIdent,
            faaSearchUrl: FAA_DTPP_SEARCH_URL,
            faaSearchResultsUrl: selectedSearchResultsUrl,
            faaAirportDiagramPageUrl: FAA_AIRPORT_DIAGRAM_PAGE_URL,
            diagramPdfUrl,
            chartName: diagramPdfUrl ? "Airport Diagram" : null,
            pdfName: diagramPdfUrl ? getPdfName(diagramPdfUrl) : null,
            cycle: resolvedCycle,
            note: diagramPdfUrl
                ? "FAA airport diagram PDF found from FAA d-TPP search results. Use for reference only and verify with official FAA publications."
                : "No FAA airport diagram PDF was found in FAA d-TPP search results for this airport.",
        };

        return Response.json(result);
    } catch (error) {
        return Response.json(
            {
                error:
                    error instanceof Error
                        ? error.message
                        : "Unexpected error fetching FAA airport diagram.",
            },
            { status: 500 }
        );
    }
}