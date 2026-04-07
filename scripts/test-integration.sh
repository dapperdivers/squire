#!/bin/bash
# Test Squire + LiteLLM integration end-to-end

set -euo pipefail

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo "🧪 Testing Squire + LiteLLM Integration..."
echo ""

# Get LiteLLM key
echo -n "🔑 Fetching LiteLLM API key... "
LITELLM_KEY=$(kubectl get secret -n ai litellm-secret -o jsonpath='{.data.LITELLM_MASTER_KEY}' | base64 -d 2>/dev/null)
if [ -z "$LITELLM_KEY" ]; then
    echo -e "${RED}✗ Failed to get API key${NC}"
    exit 1
fi
echo -e "${GREEN}✓${NC}"

# Port-forward LiteLLM
echo -n "🌐 Setting up port-forward... "
kubectl port-forward -n ai svc/litellm 4000:4000 &>/dev/null &
PF_PID=$!
sleep 2
echo -e "${GREEN}✓${NC}"

# Cleanup on exit
cleanup() {
    echo ""
    echo "🧹 Cleaning up..."
    kill $PF_PID 2>/dev/null || true
}
trap cleanup EXIT

# Test 1: Simple request (should use Gemma, might escalate)
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${BLUE}Test 1: Smart routing (simple question)${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

RESPONSE=$(curl -s -X POST http://localhost:4000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $LITELLM_KEY" \
  -d '{
    "model": "smart",
    "messages": [{"role": "user", "content": "What is 2+2?"}],
    "stream": false
  }')

if echo "$RESPONSE" | jq -e '.choices[0].message.content' &>/dev/null; then
    CONTENT=$(echo "$RESPONSE" | jq -r '.choices[0].message.content')
    echo -e "${GREEN}✓ Response received${NC}"
    echo "  Content: $CONTENT"
else
    echo -e "${RED}✗ Invalid response${NC}"
    echo "$RESPONSE" | jq . 2>/dev/null || echo "$RESPONSE"
fi

# Test 2: Complex request (likely to escalate)
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${BLUE}Test 2: Smart routing (complex question, may escalate)${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

RESPONSE=$(curl -s -X POST http://localhost:4000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $LITELLM_KEY" \
  -d '{
    "model": "smart",
    "messages": [{"role": "user", "content": "Explain the Byzantine Generals Problem and how blockchain solves it"}],
    "stream": false
  }')

if echo "$RESPONSE" | jq -e '.choices[0].message.content' &>/dev/null; then
    CONTENT=$(echo "$RESPONSE" | jq -r '.choices[0].message.content')
    echo -e "${GREEN}✓ Response received${NC}"
    echo "  Content (first 200 chars): ${CONTENT:0:200}..."
else
    echo -e "${RED}✗ Invalid response${NC}"
    echo "$RESPONSE" | jq . 2>/dev/null || echo "$RESPONSE"
fi

# Test 3: Tim routing (should start at Haiku)
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${BLUE}Test 3: Tim routing (starts at Haiku)${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

RESPONSE=$(curl -s -X POST http://localhost:4000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $LITELLM_KEY" \
  -d '{
    "model": "tim",
    "messages": [{"role": "user", "content": "Write a haiku about code quality"}],
    "stream": false
  }')

if echo "$RESPONSE" | jq -e '.choices[0].message.content' &>/dev/null; then
    CONTENT=$(echo "$RESPONSE" | jq -r '.choices[0].message.content')
    echo -e "${GREEN}✓ Response received${NC}"
    echo "  Content:"
    echo "$CONTENT" | sed 's/^/    /'
else
    echo -e "${RED}✗ Invalid response${NC}"
    echo "$RESPONSE" | jq . 2>/dev/null || echo "$RESPONSE"
fi

# Show Squire logs
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${BLUE}Squire Logs (last 20 lines)${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

kubectl logs -n ai deployment/squire --tail=20 2>/dev/null || echo "  (no logs available)"

# Check metrics
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${BLUE}Squire Metrics${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

kubectl exec -n ai deployment/squire -- curl -s http://localhost:9090/metrics 2>/dev/null | grep -E "^squire_" | head -20 || echo "  (metrics not available)"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}✓ Integration test complete!${NC}"
echo ""
echo "Check Squire logs above for validation/escalation activity."
echo ""
