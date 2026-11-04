# Design Docs

How the engineering skills should consume this repo's design documentation for **UI work**: any ticket or change to something a user sees.

## Before UI work, read these

- **`DESIGN.md`** at the repo root: the design system (tokens, type, layout, components).
- **`PRODUCT.md`** at the repo root: who the product is for and how it should feel.

If either is missing, run `/impeccable init` (new product, nothing built yet) or `/impeccable document` (existing UI to derive it from) before designing. Non-UI work skips both.

## The `ui` label

Tickets that change something a user sees carry the `ui` label (on a local tracker: a `labels: [ui]` frontmatter tag). `/to-tickets` applies it; the runner and audits use it to tell UI tickets apart.
