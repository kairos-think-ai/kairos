---
name: insights
description: Surface relevant ideas and connections from past conversations. Use when the user is working on a topic they've explored before, or when they want to revisit forgotten insights. Calls kairos_recall and kairos_resurface.
---

1. Call `kairos_resurface` to get ideas due for spaced repetition review.
2. Call `kairos_recall` with the current conversation topic to find related past conversations.

Present the results:
- Show resurfaced ideas first (these are prioritized by the spaced repetition algorithm)
- Then show related past conversations with their key ideas and drift patterns
- Highlight connections between current work and past insights
