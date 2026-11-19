/**
 * Tailwind 3, not 4.
 *
 * v4 cannot reach an Android e-ink reader: it puts every rule inside `@layer` (Chrome 99) and
 * writes colours as `oklch()` / `color-mix()` (Chrome 111). That device runs a 2018 WebView, so
 * the layout came out as plain buttons in a column. v3 writes plain CSS with physical
 * properties, no cascade layers and no modern colour functions.
 *
 * The colour tokens are the CSS variables in src/styles.css (one set per reading theme). Each
 * one has an `-rgb` twin holding the same colour as channels: Tailwind 3 can only apply an
 * opacity modifier to `rgb(... / <alpha-value>)`, and the app uses `bg-paper/90` and friends in
 * 242 places.
 */
const withAlpha = (name) => `rgb(var(--${name}-rgb) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        paper: withAlpha("paper"),
        card: withAlpha("card"),
        ink: withAlpha("ink"),
        // ink-2: secondary text. faint (ink-3): meta only. line (rule): hairlines. edge: control borders.
        muted: withAlpha("muted"),
        faint: withAlpha("faint"),
        line: withAlpha("line"),
        edge: withAlpha("edge"),
        // sheet: the layer laid on the page (continue card, notices, hover ground). card: the word card.
        sheet: withAlpha("sheet"),
        // Depth (design system v44): raised = surface-2 (hero cards), float = surface-3 (word card,
        // book detail, panels, menus). float-edge is a floating layer's hairline (a light edge at night).
        raised: withAlpha("surface-2"),
        float: withAlpha("surface-3"),
        "float-edge": "var(--edge-3)",
        accent: withAlpha("accent"),
        "accent-ink": withAlpha("accent-ink"),
        "accent-soft": withAlpha("accent-soft"),
        warn: withAlpha("warn"),
        "warn-soft": withAlpha("warn-soft"),
        mark: withAlpha("mark"),
        "mark-active": withAlpha("mark-active"),
        "mark-inverse": withAlpha("mark-inverse"),
      },
      // The stacks themselves live in src/styles.css, because the reader's own rules fall back
      // to `var(--font-display)` and a Tailwind theme key does not emit a CSS variable in v3.
      fontFamily: {
        display: "var(--font-display)",
        sans: "var(--font-sans)",
      },
      // Concentric Apple-grade radii: 4px inline text marks, 12px controls/fields, 20px cards/dialogs,
      // asymmetric 2px-left / 7px-right physical book covers, 24px phone sheets.
      borderRadius: {
        sm: "4px",
        DEFAULT: "12px",
        md: "12px",
        lg: "12px",
        xl: "12px",
        "2xl": "20px",
        "3xl": "20px",
        cover: "2px 7px 7px 2px",
        card: "1.25rem",
        sheet: "1.5rem",
      },
      // v4 renamed these (`shadow-xs` became its `sm`, and `2xs` is new). The class names are
      // used in 81 places, so the keys are defined here rather than renamed in the components.
      boxShadow: {
        "2xs": "0 1px 2px rgb(0 0 0 / 0.04)",
        xs: "0 1px 3px rgb(0 0 0 / 0.05)",
        cover: "0 2px 5px rgb(0 0 0 / 0.10), 0 12px 24px -8px rgb(0 0 0 / 0.22)",
        lift: "var(--elev-3)",
        hero: "var(--elev-2)",
        pop: "var(--elev-3)",
      },
    },
  },
  plugins: [],
};
