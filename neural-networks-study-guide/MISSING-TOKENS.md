# Missing Bantay tokens — neural-networks-study-guide

Roles this tool needed that the Bantay design system (`_shared/tokens.css`)
has no token for. Each is currently **derived** from existing tokens or
**hardcoded** in this tool's `:root`. Add them to the style guide to make this
(and future tools) fully token-driven.

## Derived from existing tokens (works, but ad hoc)

| Role | Used for | Current value | Proposed token |
|---|---|---|---|
| Border / line | card + section borders | `color-mix(--bantay-muted 20%, transparent)` | `--bantay-line` |
| Strong border | hover borders, checkbox outline | `color-mix(--bantay-muted 42%, transparent)` | `--bantay-line-strong` |
| Faint text | meta labels, day numbers | `color-mix(--bantay-muted 60%, --bantay-background)` | `--bantay-ink-faint` |
| Secondary surface | nested boxes (the calc panel) | `color-mix(--bantay-muted 8%, --bantay-surface)` | `--bantay-surface-2` |

## No token at all (hardcoded)

| Role | Used for | Current value | Proposed token |
|---|---|---|---|
| Monospace font | labels, numbers, tags | JetBrains Mono (loaded locally) | `--bantay-mono-font` |
| Success / done | completed checkbox + progress bar | reused `--bantay-primary` | `--bantay-success` |
| Categorical palette | chapter color-coding + tags | `--c1` #2f6f95 · `--c2` #b3701c · `--c3` #2f7d52 · `--c4` #8a4f8a | `--bantay-cat-1..4` |

## Semantic note

`--bantay-accent` is currently **#1e1c1a** (near-black, decorative). This tool's
original design used a warm red (`#d76a5a`) for *emphasis / warning* ("dense"
tag, reset-hover). Mapping those to `--bantay-accent` works but loses that
warm-emphasis meaning — consider a dedicated **emphasis/warning** token
(`--bantay-warning`?) separate from the dark decorative accent.

## Also worth deciding

- The Bantay base size is **13px**; this tool keeps **16px** body for long-form
  reading comfort. If the design system wants one reading size, that's a
  conversation, not a bug.
- This tool is a personal checklist → progress is in `localStorage`, not the
  account (D1) store, by design.
