"use client";

const groups = [
  {
    label: "Soon",
    items: [
      {
        title: "Project history",
        body:
          "A sidebar listing every plan you've analyzed, searchable by project name and date. Click to revisit the full violation list and extracted data.",
      },
      {
        title: "Revision comparison",
        body:
          "Upload a v2 and planq tells you what changed, what you fixed, and what's still open from v1.",
      },
      {
        title: "PDF report export",
        body:
          "A clean review document with violations, citations, and the extracted-data audit. Ready to hand to your team or attach to an RFI.",
      },
      {
        title: "Per-violation comments",
        body:
          "Mark violations as acknowledged, disputed, or fixed. Keep an audit trail across revisions.",
      },
    ],
  },
  {
    label: "Coverage",
    items: [
      {
        title: "Other jurisdictions",
        body:
          "Ontario Building Code, BC Building Code, IBC for U.S. work, NFPA 101, on request.",
      },
      {
        title: "Code book versioning",
        body: "Toggle between NBC editions when reviewing legacy projects.",
      },
      {
        title: "Energy code overlays",
        body: "Section 9.36, NECB, and equivalents.",
      },
    ],
  },
  {
    label: "Workflow",
    items: [
      {
        title: "Multi-user accounts",
        body: "Owner, reviewer, viewer roles. Separate workspaces per project.",
      },
      {
        title: "Slack and email notifications",
        body: "Get pinged when an analysis finishes or a teammate flags a comment.",
      },
      {
        title: "Webhook and API",
        body: "Pipe results into your existing tooling.",
      },
      {
        title: "Revit and AutoCAD plugin",
        body: "Kick off a review without leaving the design tool.",
      },
    ],
  },
  {
    label: "Review depth",
    items: [
      {
        title: "Suggested fixes",
        body:
          "Instead of just flagging \"corridor under 1100 mm\", suggest the minimum-cost change that brings it into compliance.",
      },
      {
        title: "Annotated overlay",
        body:
          "A red-pen view of the original drawing with violations pinned to their location on the sheet.",
      },
      {
        title: "Confidence scores",
        body: "Per violation — so you know which calls are rock-solid and which are best double-checked.",
      },
      {
        title: "Custom rule sets",
        body:
          "Internal QA standards on top of code. Your firm's preferences, client-specific requirements.",
      },
    ],
  },
];

export function RoadmapSection() {
  return (
    <section id="roadmap" className="bg-background">
      <div className="px-6 py-20 md:px-12 md:py-28 lg:px-20 lg:py-32">
        <div className="mx-auto max-w-5xl">
          <p className="text-xs uppercase tracking-widest text-muted-foreground">Roadmap</p>
          <h2 className="mt-4 text-3xl font-medium tracking-tight text-foreground md:text-4xl lg:text-5xl">
            What's coming next.
          </h2>
          <p className="mt-4 max-w-2xl text-sm text-muted-foreground md:text-base">
            What's shipped is the first reviewer. What's coming is everything around it — history,
            comparison, exports, integrations.
          </p>

          <div className="mt-12 grid grid-cols-1 gap-12 md:grid-cols-2">
            {groups.map((g) => (
              <div key={g.label}>
                <p className="mb-4 text-xs uppercase tracking-widest text-muted-foreground">
                  {g.label}
                </p>
                <ul className="space-y-5">
                  {g.items.map((item) => (
                    <li key={item.title} className="border-l border-border pl-4">
                      <h3 className="text-base font-medium text-foreground">{item.title}</h3>
                      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                        {item.body}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
