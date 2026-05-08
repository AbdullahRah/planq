"use client";

const violations = [
  {
    id: 1,
    severity: "CRITICAL",
    severityColor: "#EF4444",
    type: "Compliance",
    title: "Exit door width below minimum",
    description:
      "Exit door 810 mm on Floor 2 — below the 850 mm minimum for the stated occupancy (Group A2).",
    citation: "§3.4.3.2 — Exit Width",
  },
  {
    id: 2,
    severity: "MAJOR",
    severityColor: "#F59E0B",
    type: "Consistency",
    title: "Dimensions disagree between sheets",
    description:
      "Bedroom 1 listed as 3500 × 4000 on A-1 and 3200 × 4000 on A-2.",
    citation: "Sheets: A-1 Floor Plan, A-2 Schedule",
  },
  {
    id: 3,
    severity: "CRITICAL",
    severityColor: "#EF4444",
    type: "Consistency",
    title: "Element missing across sheets",
    description:
      "Stair S-1 appears on A-2 but is not shown on A-1. Verify location and landing.",
    citation: "Sheets: A-1 Floor Plan, A-2 Schedule",
  },
  {
    id: 4,
    severity: "MINOR",
    severityColor: "#3B82F6",
    type: "Compliance",
    title: "Corridor width undimensioned",
    description:
      "Corridor labelled but width not dimensioned. Confirm at the next revision.",
    citation: "§9.9.3.3 — Width of Corridors",
  },
  {
    id: 5,
    severity: "MAJOR",
    severityColor: "#F59E0B",
    type: "Compliance",
    title: "Stair run undersize",
    description:
      "Stair S-2 run measured at 230 mm — below the 235 mm minimum for the stated occupancy.",
    citation: "§9.8.4.2 — Run",
  },
  {
    id: 6,
    severity: "MINOR",
    severityColor: "#3B82F6",
    type: "Consistency",
    title: "Occupancy unstated",
    description:
      "Occupancy classification missing from sheet header. Cited thresholds may shift between Part 3 and Part 9 — confirm before submission.",
    citation: "Sheet: A-1 Floor Plan",
  },
];

export function CollectionSection() {
  return (
    <section id="examples" className="bg-background">
      {/* Section Title */}
      <div className="px-6 py-20 md:px-12 lg:px-20 md:py-10">
        <h2 className="text-3xl font-medium tracking-tight text-foreground md:text-4xl">
          What planq catches
        </h2>
        <p className="mt-4 max-w-2xl text-sm text-muted-foreground md:text-base">
          A look at the kinds of issues planq surfaces. Real format. Real citations.
        </p>
      </div>

      {/* Violation Grid */}
      <div className="pb-24">
        {/* Mobile: Horizontal Carousel */}
        <div className="flex gap-6 overflow-x-auto px-6 pb-4 md:hidden snap-x snap-mandatory scrollbar-hide">
          {violations.map((v) => (
            <div
              key={v.id}
              className="group flex-shrink-0 w-[80vw] snap-center rounded-2xl border border-border bg-secondary/30 p-6"
              style={{ borderLeftColor: v.severityColor, borderLeftWidth: 3 }}
            >
              <div className="mb-3 flex items-center gap-3">
                <span className="rounded-full border border-border px-2 py-[2px] font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  {v.type}
                </span>
                <span
                  className="font-mono text-[10px] uppercase tracking-widest"
                  style={{ color: v.severityColor }}
                >
                  {v.severity}
                </span>
              </div>
              <h3 className="text-lg font-medium leading-snug text-foreground">{v.title}</h3>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{v.description}</p>
              <p className="mt-4 font-mono text-xs text-muted-foreground">{v.citation}</p>
            </div>
          ))}
        </div>

        {/* Desktop: Grid */}
        <div className="hidden md:grid md:grid-cols-3 gap-6 md:px-12 lg:px-20">
          {violations.map((v) => (
            <div
              key={v.id}
              className="group rounded-2xl border border-border bg-secondary/30 p-6"
              style={{ borderLeftColor: v.severityColor, borderLeftWidth: 3 }}
            >
              <div className="mb-3 flex items-center gap-3">
                <span className="rounded-full border border-border px-2 py-[2px] font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  {v.type}
                </span>
                <span
                  className="font-mono text-[10px] uppercase tracking-widest"
                  style={{ color: v.severityColor }}
                >
                  {v.severity}
                </span>
              </div>
              <h3 className="text-lg font-medium leading-snug text-foreground">{v.title}</h3>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{v.description}</p>
              <p className="mt-4 font-mono text-xs text-muted-foreground">{v.citation}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
