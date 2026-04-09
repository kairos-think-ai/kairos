---
name: coach
description: Analyze the current conversation's engagement patterns and provide coaching. Use when the user seems passive, when the conversation drifts, or when the user asks for feedback on their thinking. Calls kairos_coach with conversation messages.
---

Call the `kairos_coach` MCP tool to analyze the current conversation.

Pass the recent conversation messages (at minimum the last 10-20 turns) so Kairos can:
1. Classify engagement states (deep engagement, passive acceptance, verification, etc.)
2. Detect topic drift from the original intent
3. Compare patterns to the user's historical baseline
4. Generate specific coaching for both you and the user

Present the results clearly:
- Lead with any alerts (e.g., "You've been passively accepting for 5 turns")
- Share the coaching suggestions for the user
- Adjust your own behavior based on the guidance for Claude
