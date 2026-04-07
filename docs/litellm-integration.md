# LiteLLM Integration Guide

## Architecture

```
┌─────────┐
│ Knights │ (pi-knight SDK)
└────┬────┘
     │
     │ model: "smart" or "tim"
     ▼
┌────────────────┐
│ LiteLLM Proxy  │ (port 4000)
│ Public API     │
└────────┬───────┘
         │
         │ routes "smart"/"tim" to Squire
         ▼
    ┌────────┐
    │ Squire │ (port 4001) 🛡️
    └────┬───┘
         │
         │ 1. Attempts with gemma4/haiku
         │ 2. Validates response quality
         │ 3. Escalates if score < threshold
         │ 4. Retries with stronger model
         │
         │ queries actual models via backend
         ▼
┌────────────────────┐
│ LiteLLM Backend    │ (port 4002)
│ Direct model calls │
└─────────┬──────────┘
          │
          ├─▶ Ollama (gemma4:26b)
          ├─▶ Anthropic (haiku/sonnet/opus)
          └─▶ Other providers
```

**Key Design:**
- **Two LiteLLM services** avoid circular dependency
- `litellm:4000` - Public endpoint with Squire routing
- `litellm-backend:4002` - Direct models for Squire to call
- Both point at the same LiteLLM pod, different K8s services

---

## Deployment Steps

### 1. Deploy Squire

```bash
# Apply Squire deployment
kubectl apply -f kubernetes/deployment.yaml

# Verify
kubectl get pods -n ai -l app=squire
kubectl logs -n ai deployment/squire -f
```

### 2. Create Backend Service

The `litellm-backend` service allows Squire to call LiteLLM without circular routing:

```bash
# Apply the backend service
kubectl apply -f kubernetes/litellm-integration.yaml
```

This creates:
- Service: `litellm-backend` on port 4002
- Same selector as main `litellm` service
- Points at same pod, different endpoint name

### 3. Update LiteLLM Config

**Option A: Manual ConfigMap Edit**

```bash
kubectl edit cm litellm-config -n ai
```

Replace the `smart` and `tim` model definitions with:

```yaml
# Smart: Validated general purpose
- model_name: smart
  litellm_params:
    model: openai/smart
    api_base: http://squire.ai.svc.cluster.local:4001/v1
    api_key: not-needed
    timeout: 900
  model_info:
    description: "🛡️ Squire-validated: Gemma → Haiku → Sonnet"

# Tim: Validated premium routing
- model_name: tim
  litellm_params:
    model: openai/tim
    api_base: http://squire.ai.svc.cluster.local:4001/v1
    api_key: not-needed
    timeout: 900
  model_info:
    description: "🛡️ Squire-validated: Haiku → Sonnet → Opus"
```

**Option B: Apply Full Config**

```bash
kubectl apply -f kubernetes/litellm-integration.yaml
```

⚠️ This replaces the entire ConfigMap. Merge carefully if you have local changes!

### 4. Restart LiteLLM

```bash
kubectl rollout restart deployment litellm -n ai
kubectl rollout status deployment litellm -n ai
```

### 5. Verify Integration

```bash
# Test smart routing
curl -X POST http://litellm.ai.svc.cluster.local:4000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -d '{
    "model": "smart",
    "messages": [{"role": "user", "content": "Explain quantum entanglement in simple terms"}]
  }'

# Check Squire logs for validation
kubectl logs -n ai deployment/squire -f
```

**Expected log output:**

```
⚔️  [Squire] Attempting with ollama/gemma4:26b
⚖️  [Squire] Response validated (score: 65/100)
⚔️  [Squire] Answer falls short. Demanding a worthier response.
🔥  [Squire] Escalating to stronger ally (anthropic/claude-haiku-4-6)
⚖️  [Squire] Response validated (score: 85/100)
🛡️  [Squire] Sir Haiku's answer meets the standard. The king shall hear it.
```

---

## Testing the Full Stack

### 1. Port-Forward (Local Testing)

```bash
# Forward LiteLLM public endpoint
kubectl port-forward -n ai svc/litellm 4000:4000

# Forward Squire directly (for debugging)
kubectl port-forward -n ai svc/squire 4001:4001

# Forward metrics
kubectl port-forward -n ai svc/squire 9090:9090
```

### 2. Test Request via LiteLLM

```bash
export LITELLM_KEY=$(kubectl get secret -n ai litellm-secret -o jsonpath='{.data.LITELLM_MASTER_KEY}' | base64 -d)

curl -X POST http://localhost:4000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $LITELLM_KEY" \
  -d '{
    "model": "smart",
    "messages": [
      {"role": "user", "content": "Write a detailed explanation of how neural networks learn through backpropagation"}
    ]
  }'
```

### 3. Watch Logs in Parallel

Terminal 1:
```bash
kubectl logs -n ai deployment/litellm -f
```

Terminal 2:
```bash
kubectl logs -n ai deployment/squire -f
```

Terminal 3:
```bash
kubectl logs -n ai deployment/ollama -f
```

### 4. Check Metrics

```bash
curl http://localhost:9090/metrics | grep squire

# Key metrics:
# squire_requests_total{model="smart",path="...",status="success"}
# squire_validation_scores{model="ollama/gemma4:26b"}
# squire_escalations_total{from="ollama/gemma4:26b",to="anthropic/claude-haiku-4-6"}
# squire_response_time_seconds{model="smart"}
```

---

## Rollback Plan

If something breaks:

### Quick Rollback

```bash
# 1. Revert LiteLLM config to original router models
kubectl edit cm litellm-config -n ai

# Change smart/tim back to:
- model_name: smart
  litellm_params:
    model_list:
      - model_name: ollama/gemma4:26b
        litellm_params:
          model: ollama/gemma4:26b
          api_base: http://ollama.ai.svc.cluster.local:11434
      # ... (rest of original config)

# 2. Restart LiteLLM
kubectl rollout restart deployment litellm -n ai

# 3. Scale down Squire (optional)
kubectl scale deployment squire -n ai --replicas=0
```

### Keep Squire, Disable Validation

Edit Squire ConfigMap:

```bash
kubectl edit cm squire-config -n ai
```

Set:
```yaml
validation:
  enabled: false  # Pass-through mode
escalation:
  enabled: false
```

Restart:
```bash
kubectl rollout restart deployment squire -n ai
```

---

## Monitoring

### Prometheus Queries

```promql
# Escalation rate
rate(squire_escalations_total[5m])

# Average validation scores
avg(squire_validation_scores) by (model)

# Request success rate
rate(squire_requests_total{status="success"}[5m]) / rate(squire_requests_total[5m])

# P95 response time
histogram_quantile(0.95, squire_response_time_seconds_bucket)
```

### Grafana Dashboard

Coming soon! Squire will ship with a Grafana dashboard JSON for:
- Escalation heatmap
- Validation score distribution
- Cost savings (Gemma vs Anthropic usage)
- Response time by model tier

---

## Troubleshooting

### Knights still get low-quality responses

**Check:**
1. Validation is enabled: `kubectl get cm squire-config -n ai -o yaml | grep "enabled: true"`
2. Judge model is working: `kubectl logs -n ai deployment/squire | grep "⚖️"`
3. Threshold isn't too high: Default 70 is reasonable

**Fix:**
- Lower threshold: `validation.threshold: 60`
- Use stronger judge: `validation.judgeModel: "anthropic/claude-sonnet-4-5"`

### Squire always escalates to max tier

**Cause:** Validation threshold too strict or judge model too harsh.

**Fix:**
```yaml
validation:
  threshold: 65  # Lower from 70
  judgePrompt: |
    Rate 0-100. Be generous for correct, complete answers.
    # ... (adjust prompt to be less strict)
```

### Circular dependency errors

**Symptoms:**
- Squire logs: "Error calling LiteLLM: ECONNREFUSED"
- LiteLLM logs: "Error calling Squire: timeout"

**Cause:** Squire is calling `litellm:4000` instead of `litellm-backend:4002`.

**Fix:**
```bash
kubectl edit cm squire-config -n ai

# Change:
litellm:
  endpoint: "http://litellm-backend.ai.svc.cluster.local:4002"
```

### High latency

**Expected behavior:**
- First attempt (Gemma): ~2-5s
- Validation: ~1-2s
- Escalation (Haiku): ~3-5s
- Total: ~6-12s for escalated requests

**If slower:**
1. Check network: `kubectl exec -n ai deployment/squire -- curl -s http://litellm-backend.ai.svc.cluster.local:4002/health`
2. Increase timeouts: `litellm.timeout: 120` in Squire config
3. Check Ollama load: `kubectl top pods -n ai -l app=ollama`

---

## Next Steps

1. **Monitor for 24h** - Watch escalation patterns
2. **Tune thresholds** - Adjust validation scores based on real usage
3. **Add custom paths** - Create escalation paths for specific knights
4. **Enable logging** - Set `logging.validationLog.enabled: true` for detailed analysis

🛡️ **Squire is now guarding the Round Table!** 🔥
