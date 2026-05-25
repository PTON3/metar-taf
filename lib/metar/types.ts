export type FlightCategory = "VFR" | "MVFR" | "IFR" | "LIFR" | "UNKNOWN";

export type CloudLayer = {
    cover: string;
    baseFeetAgl: number | null;
};

export type NormalizedMetar = {
    station: string | null;
    raw: string;

    observed: {
        day: number | null;
        hourUtc: number | null;
        minuteUtc: number | null;
    };

    flightCategory: FlightCategory;

    wind: {
        directionDeg: number | null;
        speedKt: number | null;
        gustKt: number | null;
        variable: boolean;
        raw: string | null;
    };

    visibility: {
        statuteMiles: number | null;
        raw: string | null;
    };

    clouds: CloudLayer[];

    ceiling: {
        feetAgl: number | null;
        cover: string | null;
    };

    temperature: {
        celsius: number | null;
        fahrenheit: number | null;
    };

    dewpoint: {
        celsius: number | null;
        fahrenheit: number | null;
    };

    altimeter: {
        inHg: number | null;
        raw: string | null;
    };

    weather: string[];

    remarks: string | null;
};