import { parseMetar } from "metar-taf-parser";
import { normalizeRawMetar } from "@/lib/metar/normalize";

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const raw = body?.raw;

        if (typeof raw !== "string" || raw.trim().length === 0) {
            return Response.json(
                { error: "Provide a raw METAR string in the raw field." },
                { status: 400 }
            );
        }

        const cleanedRaw = raw.trim().replace(/\s+/g, " ");

        // Keeps the official parser output available for debugging.
        const parsed = parseMetar(cleanedRaw);

        // This is our app-friendly version for the future visual decoder.
        const normalized = normalizeRawMetar(cleanedRaw);

        return Response.json({
            raw: cleanedRaw,
            normalized,
            parsed,
        });
    } catch (error) {
        return Response.json(
            {
                error:
                    error instanceof Error
                        ? error.message
                        : "Unable to parse METAR.",
            },
            { status: 400 }
        );
    }
}