#!/bin/bash
# Verify Squire + LiteLLM integration

set -euo pipefail

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "🛡️  Verifying Squire Deployment..."
echo ""

# Check namespace
echo -n "📦 Checking namespace... "
if kubectl get namespace ai &>/dev/null; then
    echo -e "${GREEN}✓${NC}"
else
    echo -e "${RED}✗ Namespace 'ai' not found${NC}"
    exit 1
fi

# Check Squire deployment
echo -n "⚔️  Checking Squire deployment... "
if kubectl get deployment squire -n ai &>/dev/null; then
    REPLICAS=$(kubectl get deployment squire -n ai -o jsonpath='{.status.readyReplicas}')
    DESIRED=$(kubectl get deployment squire -n ai -o jsonpath='{.spec.replicas}')
    if [ "$REPLICAS" == "$DESIRED" ]; then
        echo -e "${GREEN}✓ ($REPLICAS/$DESIRED ready)${NC}"
    else
        echo -e "${YELLOW}⚠ ($REPLICAS/$DESIRED ready)${NC}"
    fi
else
    echo -e "${RED}✗ Not found${NC}"
    exit 1
fi

# Check Squire service
echo -n "🌐 Checking Squire service... "
if kubectl get service squire -n ai &>/dev/null; then
    CLUSTER_IP=$(kubectl get service squire -n ai -o jsonpath='{.spec.clusterIP}')
    echo -e "${GREEN}✓ ($CLUSTER_IP:4001)${NC}"
else
    echo -e "${RED}✗ Not found${NC}"
    exit 1
fi

# Check LiteLLM backend service
echo -n "🔄 Checking litellm-backend service... "
if kubectl get service litellm-backend -n ai &>/dev/null; then
    BACKEND_IP=$(kubectl get service litellm-backend -n ai -o jsonpath='{.spec.clusterIP}')
    echo -e "${GREEN}✓ ($BACKEND_IP:4002)${NC}"
else
    echo -e "${YELLOW}⚠ Not found (create with: kubectl apply -f kubernetes/litellm-integration.yaml)${NC}"
fi

# Check ConfigMap
echo -n "📝 Checking Squire config... "
if kubectl get configmap squire-config -n ai &>/dev/null; then
    echo -e "${GREEN}✓${NC}"
else
    echo -e "${RED}✗ Not found${NC}"
    exit 1
fi

# Check LiteLLM secret
echo -n "🔑 Checking LiteLLM secret... "
if kubectl get secret litellm-secret -n ai &>/dev/null; then
    echo -e "${GREEN}✓${NC}"
else
    echo -e "${RED}✗ Secret 'litellm-secret' not found${NC}"
    exit 1
fi

# Test Squire health endpoint
echo -n "🏥 Testing Squire health... "
if kubectl exec -n ai deployment/squire -- curl -sf http://localhost:4001/health &>/dev/null; then
    echo -e "${GREEN}✓${NC}"
else
    echo -e "${RED}✗ Health check failed${NC}"
fi

# Test Squire metrics
echo -n "📊 Testing metrics endpoint... "
if kubectl exec -n ai deployment/squire -- curl -sf http://localhost:9090/metrics | grep -q squire_up &>/dev/null; then
    echo -e "${GREEN}✓${NC}"
else
    echo -e "${YELLOW}⚠ Metrics not available yet${NC}"
fi

# Check LiteLLM config for Squire routing
echo -n "🔍 Checking LiteLLM config for Squire... "
if kubectl get cm litellm-config -n ai -o yaml | grep -q "squire.ai.svc.cluster.local"; then
    echo -e "${GREEN}✓ (Squire routing configured)${NC}"
else
    echo -e "${YELLOW}⚠ LiteLLM not configured to route through Squire${NC}"
    echo "   Run: kubectl apply -f kubernetes/litellm-integration.yaml"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Show recent logs
echo "📜 Recent Squire logs:"
kubectl logs -n ai deployment/squire --tail=10 2>/dev/null || echo "  (no logs yet)"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo -e "${GREEN}✓ Verification complete!${NC}"
echo ""
echo "Next steps:"
echo "  1. Update LiteLLM: kubectl apply -f kubernetes/litellm-integration.yaml"
echo "  2. Restart LiteLLM: kubectl rollout restart deployment litellm -n ai"
echo "  3. Test: scripts/test-integration.sh"
echo ""
