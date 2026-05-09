# planq — Design System

A reference for revamping the planq **app** to match the marketing site.
Stack the marketing site is built on: Next.js 15 App Router, Tailwind v4
(`@theme inline`), shadcn/ui (`new-york`, `neutral` base), Inter from
Google Fonts, lucide-react icons.

---

## 1. Design language in one paragraph

planq is a **code-aware** product for design professionals. The visual
language reads as **editorial**, **monochrome**, and **architectural**:
black on white, generous white space, oversized headlines, all-caps
eyebrow labels, monospace for citations and data, full-bleed
photography of real buildings and construction sites. Motion is
scroll-driven and slow — content reveals as you read, never just to
decorate. Nothing on the page is "playful." Treat every UI surface like
a permit drawing: precise, citable, no decorative chrome.

**Rules of thumb:**
- Black, white, and one neutral grey — no incidental color.
- Color appears only to communicate severity (red / amber / blue) or to
  signal a destructive action.
- Type does the work that color usually does.
- Round things only when round is meaningful: pill buttons, image
  cards, badges. Inputs and panels are pill or 2xl-rounded.
- Motion serves comprehension. If it doesn't help you read, cut it.

---

## 2. Color tokens

Defined as CSS variables in `app/globals.css` and exposed to Tailwind
via `@theme inline`. Every token ships in light and dark.

### 2.1 Surface & ink

| Token                  | Light   | Dark    | Use                                                       |
| ---------------------- | ------- | ------- | --------------------------------------------------------- |
| `background`           | #FFFFFF | #0A0A0A | Default page background                                   |
| `foreground`           | #0A0A0A | #FAFAFA | Default text                                              |
| `card`                 | #FFFFFF | #0A0A0A | Card surface                                              |
| `card-foreground`      | #0A0A0A | #FAFAFA | Card text                                                 |
| `popover`              | #FFFFFF | #0A0A0A | Floating menus, tooltips                                  |
| `popover-foreground`   | #0A0A0A | #FAFAFA |                                                           |
| `primary`              | #0A0A0A | #FAFAFA | Primary buttons, focus rings                              |
| `primary-foreground`   | #FFFFFF | #0A0A0A | Text on primary                                           |
| `secondary`            | #F5F5F5 | #171717 | Quiet panels (`bg-secondary/30` is the editorial default) |
| `secondary-foreground` | #0A0A0A | #FAFAFA |                                                           |
| `muted`                | #F5F5F5 | #262626 | Disabled / quiet surfaces                                 |
| `muted-foreground`     | #737373 | #A3A3A3 | Secondary text                                            |
| `accent`               | #0A0A0A | #FAFAFA | Hover/selection (high-contrast inversion)                 |
| `border`               | #E5E5E5 | #262626 | All borders and 1-px dividers                             |
| `input`                | #F5F5F5 | #171717 | Input field background (when filled)                      |
| `ring`                 | #0A0A0A | #FAFAFA | Focus ring                                                |

**Sidebar** has its own dark-leaning token set
(`--sidebar-*`) so a sidebar can stay dark even in light mode.

### 2.2 Severity & state

These are the only colors with semantic meaning. Use them for one
purpose only. Hex values come from `collection-section.tsx` and
`globals.css`:

| Token              | Hex     | Use                              |
| ------------------ | ------- | -------------------------------- |
| `severity-critical` | #EF4444 | Critical violations              |
| `severity-major`    | #F59E0B | Major violations                 |
| `severity-minor`    | #3B82F6 | Minor violations / informational |
| `destructive`       | #DC2626 | Destructive button (delete, etc) |

**Apply to**: left-border accent (3 px) on cards, eyebrow chip text,
icons. Never as a fill behind body copy. In the marketing site every
violation card uses `borderLeftColor` + `borderLeftWidth: 3` rather
than a colored background.

### 2.3 Charts

`chart-1`…`chart-5` are a five-stop greyscale ladder
(`#0A0A0A → #D4D4D4` in light, inverted in dark). Use them for any
data viz before reaching for severity colors.

---

## 3. Typography

```css
--font-sans:    'Inter', 'Inter Fallback', system-ui, sans-serif;
--font-mono:    'JetBrains Mono', monospace;
--font-display: 'PP Editorial New', 'Times New Roman', serif;
```

**Loaded today:** Inter (via `next/font/google` in `app/layout.tsx`).
JetBrains Mono and PP Editorial New are declared but **not loaded** —
if you want the editorial serif in the app, add it to the layout font
loader. Otherwise the platform mono and Times fall through.

### 3.1 Scale (as actually used on the site)

| Role               | Tailwind                                            | Notes                                                                   |
| ------------------ | --------------------------------------------------- | ----------------------------------------------------------------------- |
| Display, marketing | `text-[12vw]` → `text-[8vw]`                        | Section headlines that fade behind sliding cards (`philosophy-section`) |
| Hero word          | `text-[22vw] leading-[0.8] tracking-tighter`        | The "PLANQ" overlay                                                     |
| H2 page            | `text-3xl md:text-4xl lg:text-5xl font-medium`      | Section titles                                                          |
| H2 emphatic        | `text-4xl md:text-5xl lg:text-6xl font-medium`      | CTA section ("Run a sheet through planq")                               |
| Big paragraph      | `text-2xl md:text-3xl lg:text-[2.5rem] leading-snug`| Editorial statements (testimonials section)                             |
| Card title         | `text-2xl md:text-3xl font-medium tracking-tight`   | Feature card heading                                                    |
| H3 list item       | `text-base font-medium`                             | Roadmap items, footer headings                                          |
| Body               | `text-sm md:text-base leading-relaxed`              | Paragraph copy                                                          |
| Small body         | `text-sm`                                           | Card body, helpers                                                      |
| Eyebrow            | `text-xs uppercase tracking-widest text-muted-foreground` | All section labels and column headers — **load-bearing** in this language |
| Caption            | `text-xs text-muted-foreground`                     | Footer copy, disclaimers                                                |
| Citation / data    | `font-mono text-[10px] uppercase tracking-widest`   | Severity tags, ticket numbers                                           |
| Citation body      | `font-mono text-xs text-muted-foreground`           | Section references like `§9.9.6.4`                                      |

**Weights used:** `font-medium` (500) for headings, `font-semibold` (600)
for product card titles, `font-bold` (700) only for the favicon. No
`font-light`. No italics outside the (currently unloaded) display
serif.

**Tracking:** headlines are `tracking-tight` or `tracking-tighter`;
eyebrows and citations are `tracking-widest`. Body is default.

**Leading:** `leading-relaxed` for body, `leading-snug` for big
editorial paragraphs, `leading-[0.8]–leading-[0.95]` for display.

---

## 4. Layout & spacing

### 4.1 Page container

There is **no global container**. Each section sets its own padding.
The pattern is consistent enough to copy:

```tsx
<section className="px-6 py-20 md:px-12 md:py-28 lg:px-20 lg:py-32">
  <div className="mx-auto max-w-5xl">…</div>
</section>
```

| Breakpoint | Horizontal padding | Vertical padding |
| ---------- | ------------------ | ---------------- |
| base       | `px-6`             | `py-20`–`py-24`  |
| `md`       | `px-12`            | `py-28`–`py-32`  |
| `lg`       | `px-20`            | `py-32`–`py-40`  |

### 4.2 Inner widths

Pick the tightest one that fits:

- `max-w-2xl` — single editorial paragraph
- `max-w-3xl` — header bar, CTA card
- `max-w-4xl` — comparison block, scroll-reveal text
- `max-w-5xl` — roadmap grid, big editorial statement

### 4.3 Grids

- 2 / 3 / 4-column responsive grids (`md:grid-cols-2 lg:grid-cols-3`).
- `gap-4` for image cards, `gap-6` for desktop content cards,
  `gap-12` for footer/roadmap sections.
- For "stacked card" effects use `gap-px` with a shared `bg-border` to
  produce a single 1-px hairline between cells (see
  `featured-products-section.tsx`).

### 4.4 Radii

`--radius` is `0rem` by default — the design is **explicitly
square-cornered for panels and inputs in the abstract sense**. Round
corners are reserved:

- `rounded-2xl` — image cards, content cards, dropdowns
- `rounded-full` — buttons, inputs, eyebrow chips
- `rounded-b-2xl` — mobile menu drawer

If you need a card or panel, default to `rounded-2xl`.

### 4.5 Borders & dividers

Every divider is `1px border-border`. There are essentially three
divider patterns:

1. Horizontal section break: `border-t border-border`.
2. Internal cell grid: `gap-px bg-border` on the parent, full
   background color on each child.
3. List item: `border-l border-border pl-4` (roadmap items).

---

## 5. Components

shadcn/ui (`new-york`) primitives are pre-installed under
`components/ui/*` — you have access to `accordion`, `alert`,
`alert-dialog`, `avatar`, `badge`, `breadcrumb`, `button`,
`button-group`, `calendar`, `card`, `carousel`, `chart`, `checkbox`,
`collapsible`, `command`, `context-menu`, `dialog`, `drawer`,
`dropdown-menu`, `empty`, `field`, `form`, `hover-card`, `input`,
`input-group`, `input-otp`, `kbd`, `label`, `menubar`,
`navigation-menu`, `pagination`, `popover`, `progress`, `radio-group`,
`resizable`, `scroll-area`, `select`, `separator`, `sheet`, `sidebar`,
`skeleton`, `slider`, `sonner`, `spinner`, `switch`, `table`, `tabs`,
`textarea`, `toast`, `toggle`, `toggle-group`, `tooltip`. Use those
defaults; the patterns below describe how they should *look* in the
planq UI.

### 5.1 Header / nav

Pill-shaped floating nav, fixed top, centered, max width 3xl.
Two visual states:

- **Top of page** — transparent, white text/links/CTA, no shadow.
- **Scrolled** — `bg-background/80 backdrop-blur-md rounded-full`,
  layered low-opacity blue-grey shadow:
  ```
  rgba(14,63,126,0.04) 0px 0px 0px 1px,
  rgba(42,51,69,0.04) 0px 1px 1px -0.5px,
  rgba(42,51,70,0.04) 0px 3px 3px -1.5px,
  rgba(42,51,70,0.04) 0px 6px 6px -3px,
  rgba(14,63,126,0.04) 0px 12px 12px -6px,
  rgba(14,63,126,0.04) 0px 24px 24px -12px
  ```
  This stack is the canonical "planq elevated surface" shadow. Use it
  whenever a panel needs to float above content (toolbars, modals,
  command palette).

In the planq app the shadow stack should be the default for any
floating chrome (drawing toolbar, violation panel, status banner).

### 5.2 Buttons

- **Primary**: `rounded-full bg-foreground text-background px-6 py-3
  text-sm font-medium hover:opacity-90 disabled:opacity-40`.
- **Inverse** (on dark sections): same shape, `bg-background
  text-foreground`.
- **Ghost link**: `text-sm text-muted-foreground transition-colors
  hover:text-foreground`.
- **Eyebrow chip**: `rounded-full backdrop-blur-md px-4 py-2 text-sm
  bg-[rgba(255,255,255,0.2)] text-white` (used over photography).

Buttons are pill-shaped everywhere except inside data tables. **No
gradients. No drop shadows on buttons.** Disabled = `opacity-40`,
loading = swap label to `Sending…` style ellipsis text rather than a
spinner glyph in primary CTAs.

### 5.3 Inputs

The waitlist form is the reference. Inputs are pill-shaped, semi-
transparent on dark backgrounds, with foreground-tinted placeholders:

```tsx
className="rounded-full border border-background/20 bg-background/5
           px-5 py-3 text-base text-background
           placeholder:text-background/40
           focus:border-background focus:outline-none"
```

For light-background forms, mirror with `border-border bg-input`.
Don't add focus rings — focus is signaled by a 1-px `border-foreground`
swap.

### 5.4 Cards

Three card styles cover everything:

1. **Editorial text card** (feature grid): no border, no shadow, white
   on white, separated from siblings only by a `1px` hairline.
   Eyebrow + headline + body. Generous interior padding (`p-8` →
   `p-12`).
2. **Data card** (violation list): `rounded-2xl border border-border
   bg-secondary/30 p-6`, with `borderLeftWidth: 3` and
   `borderLeftColor: severity` to encode severity. Layout inside:
   eyebrow row (type + severity in mono caps) → title (medium) → body
   (muted) → citation (mono).
3. **Image card** (hero, philosophy, gallery): `rounded-2xl
   overflow-hidden`, fill `<Image>`, optional `bg-black/30` overlay
   for legibility, eyebrow chip + body in the bottom-left.

### 5.5 Tables / comparison blocks

The "Manual review vs. planq" pattern in `editorial-section.tsx` is
the data-table look:

- Outer: `rounded-2xl border border-border overflow-hidden`.
- Header row: `bg-secondary/30`, eyebrow text in each cell.
- Body rows: `border-b border-border last:border-b-0`, `text-sm`
  cells, muted left column, foreground value columns.

Use this for any specs / comparison / settings list in the app.

### 5.6 Stat tile

Quad strip used for "1,953 sections" etc:

```
grid grid-cols-2 md:grid-cols-4
 ├── eyebrow (text-xs uppercase tracking-widest text-muted-foreground)
 └── value   (font-medium text-foreground text-4xl)
```

Border-collapsed via `border-r border-b` with `last:border-r-0`. Reuse
for any KPI strip in the app dashboard.

### 5.7 Severity tags

```tsx
<span className="rounded-full border border-border px-2 py-[2px]
                 font-mono text-[10px] uppercase tracking-widest
                 text-muted-foreground">
  Compliance
</span>
<span className="font-mono text-[10px] uppercase tracking-widest"
      style={{ color: severityColor }}>
  CRITICAL
</span>
```

The two-chip pattern (type + severity) is canonical — **always pair
them**, never use severity alone.

### 5.8 Form / waitlist pattern

For any "tell us about you" form, follow the waitlist:

- Required field on its own row, then optional fields side-by-side.
- Submit is full-width on mobile, inline on `md+`.
- Success state replaces the form with a bordered, semi-transparent
  card containing a confirmation eyebrow, a one-line headline, and a
  follow-up CTA.

---

## 6. Imagery & icons

### 6.1 Photography

Real construction sites and finished buildings, shot wide, often
backlit. **No stock illustrations, no isometric 3D, no people in
hi-vis posing.** Always full-bleed inside a `rounded-2xl` container
with `object-cover`. Add `bg-black/30` only when text sits on top.

For app surfaces, use photography sparingly — empty states, onboarding
screens, billing/upsell. Most of the app is data, not pictures.

### 6.2 Iconography

`lucide-react`, currently `Menu` and `X` only. Default size 24,
`stroke` 1.5–2. Match icon color to surrounding text (`text-foreground`
or `text-muted-foreground`). Never recolor outside the token set.

### 6.3 Logo / favicon

Wordmark `planq` (lowercase, Inter 700, `letter-spacing -2.5`) on a
black/white rounded square (`rx="37"` on a 180×180 viewBox). Adapts
via `prefers-color-scheme`. Never display the wordmark over imagery
without the rounded bg behind it.

---

## 7. Motion

Animations are declared in `globals.css` and used with utility classes
or inline `style`. The patterns:

### 7.1 Scroll-driven (the dominant pattern)

Each scroll-aware section uses `useEffect` + `requestAnimationFrame` to
read `getBoundingClientRect()` and convert it to a 0–1 progress, then
maps that progress to inline `style` (`transform`, `opacity`, `width`,
`borderRadius`). Two staple variants:

- **Sticky bento expansion** (`hero-section`, `technology-section`):
  one centered image starts full-bleed, then as the user scrolls the
  center image shrinks (`width 100% → 42%`, `height → 70%`) while
  flanking columns slide in (`translateX -100% → 0`, `width 0 → 22%`),
  gap and corner radius animate in tandem. Section is `200vh` tall
  with a `sticky top-0 h-screen` container.
- **Slide-in cards** (`philosophy-section`): two cards translate from
  `±100%` to `0%` while a giant H2 fades out behind them. Same
  200vh-sticky scaffolding.
- **Word-by-word color reveal** (`technology-section`
  `ScrollRevealText`): each word's color flips from `#e4e4e7` to
  `var(--foreground)` as scroll progress crosses its index. Use this
  for any "thesis statement" copy in the app onboarding.
- **Word-by-word blur fade**: words exit the hero with
  `filter: blur(0px → 10px)` and `opacity 1 → 0` as scroll progresses.
- **Horizontal-scroll gallery** (`gallery-section`): vertical scroll
  drives a `translate3d(x, …)` on a horizontally laid-out flex
  container. Section height is computed from
  `containerWidth - viewportWidth + viewportHeight`.

For app surfaces: keep the **sticky-progress** technique for any
multi-step view (uploader stages, review walkthrough, results
explanation) but cap the section height around `150vh` so users don't
feel held hostage.

### 7.2 Element entrance

Available helpers in `globals.css`:

| Class | Animation | Duration / Easing |
| ----- | --------- | ----------------- |
| `animate-reveal-up` | `translateY(60px) → 0`, opacity 0→1 | 0.8s ease-out |
| `animate-reveal-left` | `translateX(-60px) → 0` | 0.8s ease-out |
| `animate-reveal-right` | `translateX(60px) → 0` | 0.8s ease-out |
| `animate-scale-in` | `scale(0.9) → 1` | 0.6s ease-out |
| `animate-float` | floats `±20px` | 6s loop (use sparingly) |
| `animate-fade-in` | `scale(1.02)→1` opacity 0→1 | 0.7s ease-out (image load) |

Stagger with `animation-delay-100…600` utilities.

### 7.3 Hover & interaction

- Color: `transition-colors` (~150ms).
- Opacity: `hover:opacity-90` (primary) or `hover:opacity-80`
  (subtle).
- Image hover: `group-hover:scale-105` on the inner `<Image>`,
  `transition-transform`.

Avoid translate-on-hover — it conflicts with the scroll-driven
animations.

### 7.4 Texture

`.grain-overlay::before` adds an SVG fractal-noise overlay at 0.03
opacity, animated 8s. Use **only** on dark hero/CTA panels for an
analog-paper feel. Never on data surfaces.

---

## 8. Voice & copy

This is part of the design — the copy is built in.

- **Eyebrow labels** are nouns or short noun phrases:
  `Beta access`, `Roadmap`, `How planq reviews a package`. Always
  uppercase, widest tracking, muted. Treat them like the H6 of the
  product.
- **Headlines** are full sentences with a period. They are short and
  declarative: "Two passes. One verdict." "Catch the issues before
  the city does."
- **Body copy** is a single voice — second-person, lowercase brand,
  contractions, occasional dashes, very few semicolons. Numbers are
  always concrete (`850 mm`, `1,953 sections`, `$400–$1,200`).
- **Citations** live in monospace and use § symbols when referring to
  code sections. Never narrate a citation — just print it.
- **Disclaimers** are calm and explicit. The footer pattern is the
  template.

When designing app surfaces, keep this voice. A tooltip on a
violation should say "Door D-01: 850 mm — below 900 mm minimum
(§9.9.6.4)" not "Hmm, this door looks small!"

---

## 9. Accessibility & responsiveness

- Mobile-first. Every section in the marketing site collapses to a
  single column at base, then expands.
- Tap targets: pill buttons are `py-3`, never tighter.
- Focus: `outline-ring/50` is set globally on `*`, but most components
  swap a 1-px `border` to indicate focus instead. Don't suppress
  outlines on app surfaces — restore them or add a visible 2-px ring
  on interactive elements that aren't pill-shaped.
- Color contrast: `muted-foreground` (`#737373` on `#FFFFFF`) clears
  4.5:1 for normal text only marginally. **Don't use it for sub-14px
  copy**, and don't use it for any state with semantic meaning.
- Reduced motion: not currently honored. Add a
  `prefers-reduced-motion: reduce` media query that disables the
  scroll-driven animations (set them to their final state) before
  shipping the app.

---

## 10. Mapping to the planq app

Likely app surfaces and the patterns that apply:

| App surface              | Pattern to use                                                    |
| ------------------------ | ----------------------------------------------------------------- |
| Top bar                  | Pill nav, scrolled state default (always elevated)                |
| Sidebar (project list)   | Dark sidebar tokens (`--sidebar-*`); muted dividers; eyebrow group labels |
| File uploader            | Empty-state photography optional; pill buttons; mono filename     |
| Drawing viewer toolbar   | Floating pill bar with the canonical shadow stack (5.1)           |
| Violation list           | Data card pattern (5.4 #2). Severity left border + dual chip      |
| Violation detail panel   | Sheet/drawer; eyebrow → headline → body → mono citation footer    |
| Comparison / spec view   | Comparison-block table (5.5)                                      |
| Dashboard KPIs           | Stat tile strip (5.6)                                             |
| Settings forms           | Pill inputs (5.3); section headers are eyebrows                   |
| Empty / success states   | Bordered, semi-transparent card, eyebrow + headline + CTA         |
| Onboarding / first-run   | Sticky-progress scroll telling (7.1) capped at ~150vh             |

**One thing to avoid bringing across**: marketing-site verticality.
The site uses `200vh` sticky animations that work for browsing but
would be hostile inside an app. Keep the visual language; reduce the
choreography.

---

## 11. Open items / honest notes

- **Display serif** (`PP Editorial New`) is in the token list but not
  loaded — if you want italic editorial pull-quotes in the app, add
  it in `app/layout.tsx` next to Inter, otherwise drop the token.
- **JetBrains Mono** isn't loaded either; mono text currently falls
  back to the system mono. Worth loading via `next/font/google` for
  consistent kerning of citations.
- **Severity colors** are hardcoded in `collection-section.tsx`. Move
  them into `globals.css` (`--severity-critical` etc.) before the app
  picks them up so both surfaces stay in sync.
- **`apple-icon`** is no longer wired (removed from
  `app/layout.tsx`'s `icons` block). If iOS bookmarks matter, restore
  a 180×180 PNG and add it back.
- **Reduced motion** is not respected. Add a guard before shipping the
  app.
