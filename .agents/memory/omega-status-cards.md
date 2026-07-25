---
name: Omega status cards
description: Durable design rules for the WhatsApp status-card generator.
---

The status-card renderer is a procedural composer, not a fixed-template picker. The URL is the primary visual element and must remain centered within an adaptive frame; borders, decorations, title treatments, footers, spacing, and alignment should vary independently while preserving a compact Omega identity.

**Why:** WhatsApp invite URLs vary substantially in length, and fixed layouts either make the link visually secondary or produce unbalanced cards. The product brief explicitly prioritizes optical URL centering and procedural variation.

**How to apply:** Preserve the renderer's stable input/output contract, keep metadata descriptions and arbitrary messages out of generated cards, and validate that the URL appears exactly once. Add new visual variation as composable pools rather than another named template.