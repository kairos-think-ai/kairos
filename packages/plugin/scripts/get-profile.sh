#!/bin/bash
# Kairos SessionStart hook — fetches thinking profile and outputs to stdout.
# Claude Code injects stdout as conversation context at session start.
#
# This script calls the Kairos MCP server's kairos_profile tool via a
# lightweight HTTP request to the Kairos API.
#
# Fallback: If the API is unreachable, outputs a minimal reminder that
# Kairos tools are available.

set -e

KAIROS_API_URL="${KAIROS_API_URL:-https://mcp.kairos.app}"
KAIROS_TOKEN="${KAIROS_TOKEN:-}"

# Try to fetch profile from Kairos API
if [ -n "$KAIROS_TOKEN" ]; then
  PROFILE=$(curl -s --max-time 8 \
    -H "Authorization: Bearer $KAIROS_TOKEN" \
    "${KAIROS_API_URL}/api/profile" 2>/dev/null || echo "")

  if [ -n "$PROFILE" ] && [ "$PROFILE" != "null" ]; then
    echo "$PROFILE"
    exit 0
  fi
fi

# Fallback: remind Claude that Kairos tools are available
cat <<'EOF'
## Kairos — Thinking Patterns Coach

Kairos MCP tools are available in this session:
- kairos_profile: Load the user's full thinking profile
- kairos_coach: Analyze current conversation engagement + provide coaching
- kairos_recall: Find related past conversations and ideas
- kairos_reflect: View behavioral patterns and metrics
- kairos_resurface: Get ideas due for spaced repetition review
- kairos_connections: Explore concept connections across conversations

Consider calling kairos_profile at the start to understand this user's patterns.
EOF
