# Bantay token gaps — neural-networks-study-guide

The roles this tool needed that the brand tokens (`_shared/tokens.css`) didn't
cover have been **added to `_shared/tokens-extended.css`**, and this tool now
references them — it defines no colors of its own.

## Added to tokens-extended.css

| Role | Token | Value |
|---|---|---|
| Border / line | `--bantay-line` | `color-mix(--bantay-muted 20%, transparent)` |
| Strong border | `--bantay-line-strong` | `color-mix(--bantay-muted 42%, transparent)` |
| Faint text | `--bantay-ink-faint` | `color-mix(--bantay-muted 60%, --bantay-background)` |
| Secondary surface | `--bantay-surface-2` | `color-mix(--bantay-muted 8%, --bantay-surface)` |
| Monospace font | `--bantay-mono-font` | platform mono (no web load) |
| Success / done | `--bantay-success` | `var(--bantay-primary)` |
| Emphasis / warning | `--bantay-emphasis` | `#c0573f` (warm) |
| Categorical palette | `--bantay-cat-1..4` | blue / amber / green / purple |

## Still judgment calls (not blocking)

- **Distinct success hue** — `--bantay-success` currently aliases `--bantay-primary`.
  Give it its own green if "done" should read differently from "primary".
- **Final categorical values** — the four hues are placeholders tuned for the
  light theme; refine to taste.
- **Editability** — these live in `tokens-extended.css` (hand-maintained). If you
  want them adjustable in the style-guide editor, that's a follow-up (new
  controls + Publish output); the brand tokens stay the Publish-managed set.
- **Mono font** — uses the platform monospace. Set `--bantay-mono-font` to a web
  font (e.g. JetBrains Mono) + add its `@import` if you want a branded mono.
