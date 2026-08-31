// Source: Inflight Pilot Training — Inflight Operations Manual, "Weather Minimums" section.
// https://inflightpilottraining.notion.site/Inflight-Operations-Manual-290a40bfb6d58062b48cd05a20575964
// These are Inflight's internal operating minimums; they supplement, and never override, FAR requirements.

export type OperationType =
    | "vfr-rental"
    | "dual-vfr-local"
    | "dual-vfr-cross-country"
    | "dual-ifr"
    | "student-solo-local"
    | "student-solo-cross-country";

export type SnowfallPolicy = "required" | "recommended";

export type OperationalMinimum = {
    operation: OperationType;
    label: string;
    /** Minimum ceiling in feet AGL. Null when there is no flat VFR ceiling minimum (e.g. IFR published minimums). */
    ceilingFtAgl: number | null;
    /** Reduced ceiling minimum that applies while staying in the traffic pattern, if different from ceilingFtAgl. */
    patternCeilingFtAgl?: number;
    /** Minimum visibility in statute miles. Null when there is no flat VFR visibility minimum (e.g. IFR published minimums). */
    visibilitySm: number | null;
    /** Free-form note used in place of a fixed ceiling/visibility value (e.g. IFR published minimums for T/O, approach, landing). */
    ceilingVisibilityOverrideNote?: string;
    maxWindsKt: number;
    /** Numeric crosswind limit in knots, or "aircraft-demonstrated" to defer to the aircraft's demonstrated crosswind component. */
    crosswindKt: number | "aircraft-demonstrated";
    /** Whether operating from towered airports only after snowfall is a hard requirement or a recommendation. */
    afterSnowfallTowerOnly: SnowfallPolicy;
    notes: string;
};

export const OPERATIONAL_MINIMUMS: OperationalMinimum[] = [
    {
        operation: "vfr-rental",
        label: "VFR Rentals",
        ceilingFtAgl: 2500,
        visibilitySm: 5,
        maxWindsKt: 30,
        crosswindKt: "aircraft-demonstrated",
        afterSnowfallTowerOnly: "required",
        notes: "After snowfall: towered airports only.",
    },
    {
        operation: "dual-vfr-local",
        label: "Dual VFR Local",
        ceilingFtAgl: 1500,
        visibilitySm: 3,
        maxWindsKt: 30,
        crosswindKt: "aircraft-demonstrated",
        afterSnowfallTowerOnly: "recommended",
        notes: "After snowfall: towered airports only recommended.",
    },
    {
        operation: "dual-vfr-cross-country",
        label: "Dual VFR Cross-Country",
        ceilingFtAgl: 3000,
        visibilitySm: 3,
        maxWindsKt: 30,
        crosswindKt: "aircraft-demonstrated",
        afterSnowfallTowerOnly: "recommended",
        notes: "After snowfall: towered airports only recommended.",
    },
    {
        operation: "dual-ifr",
        label: "Dual IFR",
        ceilingFtAgl: null,
        visibilitySm: null,
        ceilingVisibilityOverrideNote: "Published minimums for takeoff, approach, and landing.",
        maxWindsKt: 30,
        crosswindKt: "aircraft-demonstrated",
        afterSnowfallTowerOnly: "recommended",
        notes: "After snowfall: towered airports only recommended.",
    },
    {
        operation: "student-solo-local",
        label: "Student Solo Local",
        ceilingFtAgl: 3000,
        patternCeilingFtAgl: 2000,
        visibilitySm: 6,
        maxWindsKt: 15,
        crosswindKt: 7,
        afterSnowfallTowerOnly: "required",
        notes: "After snowfall: towered airports only.",
    },
    {
        operation: "student-solo-cross-country",
        label: "Student Solo Cross-Country",
        ceilingFtAgl: 6000,
        visibilitySm: 10,
        maxWindsKt: 15,
        crosswindKt: 7,
        afterSnowfallTowerOnly: "required",
        notes: "After snowfall: towered airports only.",
    },
];

export const CONVECTIVE_SIGMET_POLICY = {
    /** No student solo flights (local or cross-country) when a convective SIGMET affects the KFCM area. */
    studentSoloBlocked: true,
    /** Radius, in nautical miles, within which a convective SIGMET is considered a high-risk (but not automatic no-go) day. */
    highRiskRadiusNm: 25,
    /** Minimum distance, in statute miles, to avoid severe/mature thunderstorms, per FAA AC 00-24C. */
    thunderstormAvoidanceMilesSm: 20,
    notes:
        "A convective SIGMET over KFCM or within 25 NM is a high-risk day, but not an automatic no-go. " +
        "Pilots must exercise good ADM to make a careful go/no-go decision. If storms cover the local area " +
        "or route and cannot be avoided, delay, divert, or cancel.",
};

export const COLD_WEATHER_LIMITS = {
    /** Below this temperature (°F), no flights or engine starts are permitted. */
    noFlightBelowF: 0,
    /** Official temperature source for cold-weather go/no-go decisions. */
    temperatureSource: "KFCM METAR",
};

export const PREHEAT_POLICY = {
    /** At or below this temperature (°F), the aircraft must be blanketed. */
    blanketAtOrBelowF: 40,
    /** At or below this temperature (°F), the aircraft must be plugged into the Tanis preheat system. */
    plugInAtOrBelowF: 50,
};

// Source: Inflight Pilot Training — "Hangar Parking" (Night Stacking Weather Minimums).
// https://app.notion.com/p/inflightpilottraining/Hangar-Parking-2c7a40bfb6d5803b972ec82c55636c39
// Governs when aircraft may be left on the ramp overnight vs. hangared.

export const NIGHT_STACKING_SEASONAL_DEFAULT = {
    winter: "All based tenant and Flight School aircraft hangared.",
    summer:
        "Plan overnight storage and morning launch using the Next Day Reservation Tracker. Fuel before end of night.",
};

/** Aircraft that must always be hangared overnight, regardless of forecast. */
export const NIGHT_STACKING_ALWAYS_HANGAR: string[] = [
    "Every Cirrus.",
    "Every PM departure (departing after 8:00 AM the next day) — stack toward the front.",
];

export type NightStackingRampEligibility = {
    /** Local time by which every condition below must be true for an aircraft to stay on the ramp. */
    decisionTimeLocal: string;
    /** Maximum sustained wind, in knots, allowed overnight. */
    maxSustainedWindsKt: number;
    /** Maximum overnight precipitation chance, as a percent (0 = none allowed). */
    maxPrecipChancePercent: number;
    /** Radius, in nautical miles, that must be free of thunderstorms/convective activity. */
    thunderstormFreeRadiusNm: number;
    /** Aircraft types that are never eligible to stay on the ramp (see NIGHT_STACKING_ALWAYS_HANGAR). */
    excludedAircraftTypes: string[];
    /** Aircraft must be scheduled to depart before this local time to qualify for staying on the ramp. */
    mustDepartBeforeLocal: string;
    /** Sources the forecast must be cross-checked against before leaving an aircraft on the ramp. */
    forecastSources: string[];
    notes: string;
};

export const NIGHT_STACKING_RAMP_ELIGIBILITY: NightStackingRampEligibility = {
    decisionTimeLocal: "21:00",
    maxSustainedWindsKt: 10,
    maxPrecipChancePercent: 0,
    thunderstormFreeRadiusNm: 25,
    excludedAircraftTypes: ["Cirrus"],
    mustDepartBeforeLocal: "08:00",
    forecastSources: ["aviationweather.gov", "TAFs (KFCM + surrounding)", "consumer apps"],
    notes:
        "May stay on the ramp only if ALL conditions are true by the decision time. If anything looks " +
        "questionable, hangar the plane — better safe than sorry.",
};

/** Securement checklist required for any aircraft left on the ramp overnight. */
export const NIGHT_STACKING_RAMP_SECUREMENT_CHECKLIST: string[] = [
    "Double chocks",
    "Gust lock",
    "Fuel caps sealed",
    "Next Day Reservation Tracker updated",
    "Notes added to the Dashboard",
];

export const NIGHT_STACKING_TIMING = {
    planningTimeLocal: "19:30",
    executionWindowLocal: { start: "19:30", end: "22:00" },
    notes:
        "7:30 PM — pull next-day AM departures from the tracker, check forecast, build the plan. " +
        "7:30–10:00 PM — execute: fuel AM departures, set securement, update tracker and dashboard.",
};

export const HANGAR_HANDLING_STANDARDS = {
    minMoveCrewSize: 2,
    /** Minimum clearance spacing, in inches, by location. */
    spacingInches: {
        ramp: 36,
        hangar1And2: 18,
        hangar3: 4,
    },
    notes: "Unsure of clearance? Stop the tow.",
};

export const HANGAR_3_INFO = {
    middleBay: {
        sides: "Cirrus",
        middle: "Cessna 152s",
    },
    /** In winter, FIKI Cirrus are stacked on top since they're more likely to fly. */
    winterPriorityOnTop: "FIKI Cirrus",
    oilChangeStacking: {
        notFlyingThatDay: "Park on top so MX can pull it for run-up after the change.",
        flyingThatDay: "Park at the back — last out, or first accessible after others are pulled.",
        nightBeforeAndThroughChange: "Engine blanket on, plugged in during winter.",
    },
};

/** Priority order for substituting an accessible aircraft when a customer wants to fly one that's "on top." */
export const DISPATCH_SUBSTITUTION_ORDER: string[] = [
    "172 with Dual G5s",
    "172S",
    "172 without G5s",
    "IFR-capable 152",
];

export const HANGAR_2_INFO = {
    priority: "Based tenants always have priority for Hangar 2 space.",
    wingWalkers: {
        required: 1,
        preferred: 2,
    },
    notes:
        "Move slow. Fit based tenant vehicles inside the hangar when space allows; otherwise park inside the fenced area.",
};
