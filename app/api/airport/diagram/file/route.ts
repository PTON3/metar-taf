export const runtime = "nodejs";

const ALLOWED_HOSTS = new Set(["aeronav.faa.gov", "www.faa.gov", "faa.gov"]);

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const rawUrl = searchParams.get("url");

    if (!rawUrl) {
        return Response.json(
            { error: "Missing PDF url." },
            { status: 400 }
        );
    }

    let upstreamUrl: URL;

    try {
        upstreamUrl = new URL(rawUrl);
    } catch {
        return Response.json(
            { error: "Invalid PDF url." },
            { status: 400 }
        );
    }

    if (!ALLOWED_HOSTS.has(upstreamUrl.hostname)) {
        return Response.json(
            { error: "Host not allowed." },
            { status: 403 }
        );
    }

    // Fragment is not needed to fetch the PDF file itself.
    upstreamUrl.hash = "";

    try {
        const response = await fetch(upstreamUrl.toString(), {
            next: {
                revalidate: 86_400,
            },
        });

        if (!response.ok) {
            return Response.json(
                { error: "Unable to fetch FAA PDF." },
                { status: 502 }
            );
        }

        const pdfBytes = await response.arrayBuffer();

        return new Response(pdfBytes, {
            headers: {
                "Content-Type": "application/pdf",
                "Cache-Control": "public, max-age=86400, s-maxage=86400",
            },
        });
    } catch (error) {
        return Response.json(
            {
                error:
                    error instanceof Error
                        ? error.message
                        : "Unexpected error fetching PDF.",
            },
            { status: 500 }
        );
    }
}