"use client";

const specs = [
  { label: "Indexed sections", value: "1,953" },
  { label: "NBC pages ingested", value: "1,489" },
  { label: "Retrieval categories", value: "5" },
  { label: "Severity tiers", value: "3" },
];

export function EditorialSection() {
  return (
    <section className="bg-background">
      {/* Stats Grid */}
      <div className="grid grid-cols-2 border-t border-border md:grid-cols-4">
        {specs.map((spec) => (
          <div
            key={spec.label}
            className="border-b border-r border-border p-8 text-center last:border-r-0 md:border-b-0"
          >
            <p className="mb-2 text-xs uppercase tracking-widest text-muted-foreground">
              {spec.label}
            </p>
            <p className="font-medium text-foreground text-4xl">{spec.value}</p>
          </div>
        ))}
      </div>

      {/* Comparison Block */}
      <div className="px-6 py-20 md:px-12 md:py-28 lg:px-20 lg:py-32">
        <div className="mx-auto max-w-4xl">
          <h2 className="text-3xl font-medium tracking-tight text-foreground md:text-4xl">
            Manual review vs. planq
          </h2>
          <p className="mt-4 max-w-2xl text-sm text-muted-foreground md:text-base">
            What you give up to a senior reviewer's afternoon vs. what planq returns by lunch.
          </p>

          <div className="mt-12 overflow-hidden rounded-2xl border border-border">
            <div className="grid grid-cols-3 border-b border-border bg-secondary/30">
              <div className="px-4 py-4 text-xs uppercase tracking-widest text-muted-foreground md:px-6">
                Dimension
              </div>
              <div className="px-4 py-4 text-xs uppercase tracking-widest text-muted-foreground md:px-6">
                Manual review
              </div>
              <div className="px-4 py-4 text-xs uppercase tracking-widest text-muted-foreground md:px-6">
                planq
              </div>
            </div>
            {[
              ["Time per package", "2–6 hours senior time", "Minutes"],
              ["Section citations", "If they remember", "Every flag"],
              ["Cross-sheet checks", "Eye-balled", "Systematic"],
              ["Consistency across packages", "Reviewer-dependent", "Same every time"],
              ["Cost per review", "$400–$1,200 senior labour", "Early access pricing TBD"],
            ].map(([dim, manual, planq]) => (
              <div
                key={dim}
                className="grid grid-cols-3 border-b border-border last:border-b-0"
              >
                <div className="px-4 py-4 text-sm text-muted-foreground md:px-6">{dim}</div>
                <div className="px-4 py-4 text-sm text-foreground md:px-6">{manual}</div>
                <div className="px-4 py-4 text-sm text-foreground md:px-6">{planq}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
