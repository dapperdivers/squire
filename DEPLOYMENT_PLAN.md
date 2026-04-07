# Squire Deployment Plan

## Pre-flight Checklist

- [x] Docker image building (GHA workflow)
- [x] Kubernetes manifests ready
- [x] Integration docs written
- [x] Verification scripts created
- [ ] Docker image published to GHCR
- [ ] Deployment applied to cluster
- [ ] LiteLLM integration configured
- [ ] End-to-end test passed

---

## Deployment Steps

### 1. Wait for Docker Build (2-3 min)

```bash
gh run watch --repo dapperdivers/squire
```

**Expected:** Image pushed to `ghcr.io/dapperdivers/squire:latest`

---

### 2. Deploy Squire to Cluster

```bash
cd /home/node/molty/repos/squire

# Apply Squire deployment
kubectl apply -f kubernetes/deployment.yaml

# Verify pods
kubectl get pods -n ai -l app=squire

# Check logs
kubectl logs -n ai deployment/squire -f
```

**Expected output:**
```
🛡️  Squire standing ready at the gates...
✓ Config loaded from /etc/squire/squire.yaml
✓ LiteLLM backend: http://litellm-backend.ai.svc.cluster.local:4002
✓ Validation enabled (judge: anthropic/claude-haiku-4-6, threshold: 70)
✓ Escalation enabled (max attempts: 3)
✓ Metrics server listening on :9090
✓ API server listening on :4001
```

---

### 3. Create LiteLLM Backend Service

```bash
# Apply backend service (points at same litellm pod, different name)
kubectl apply -f kubernetes/litellm-integration.yaml

# Verify
kubectl get svc -n ai | grep litellm
```

**Expected:**
```
litellm          ClusterIP   10.96.x.x   <none>   4000/TCP          Xd
litellm-backend  ClusterIP   10.96.y.y   <none>   4002/TCP          Xs
```

---

### 4. Update LiteLLM Config

```bash
# Backup current config
kubectl get cm litellm-config -n ai -o yaml > /tmp/litellm-config-backup.yaml

# Apply updated config (routes smart/tim through Squire)
kubectl apply -f kubernetes/litellm-integration.yaml

# Restart LiteLLM to pick up changes
kubectl rollout restart deployment litellm -n ai
kubectl rollout status deployment litellm -n ai
```

---

### 5. Verify Deployment

```bash
./scripts/verify-deployment.sh
```

**Expected:** All checks pass ✓

---

### 6. Test Integration

```bash
./scripts/test-integration.sh
```

**Watch for:**
- Test 1 (simple): Should use Gemma, pass validation
- Test 2 (complex): Should escalate to Haiku or Sonnet
- Test 3 (tim route): Should start at Haiku

**Check Squire logs for escalation:**
```
⚔️  [Squire] Attempting with ollama/gemma4:26b
⚖️  [Squire] Response validated (score: 65/100)
🔥  [Squire] Escalating to anthropic/claude-haiku-4-6
⚖️  [Squire] Response validated (score: 88/100)
🛡️  [Squire] Sir Haiku's answer meets the standard.
```

---

### 7. Monitor for 1 Hour

```bash
# Watch metrics
kubectl port-forward -n ai svc/squire 9090:9090
curl http://localhost:9090/metrics | grep squire

# Watch logs
kubectl logs -n ai deployment/squire -f --tail=50
```

**Look for:**
- Escalation rate (should be < 30% for smart, < 10% for tim)
- Validation scores (Gemma avg ~65, Haiku avg ~80, Sonnet avg ~90)
- No errors or timeouts

---

### 8. Update Knights (Optional - Phase 2)

Once Squire is proven stable, knights can call Squire directly:

```yaml
# Example: Galahad
spec:
  env:
    - name: OPENAI_BASE_URL
      value: "http://squire.ai.svc.cluster.local:4001/v1"
    - name: OPENAI_API_KEY
      value: "not-needed"  # Squire handles auth
```

**Why optional:** Current flow (LiteLLM → Squire) works fine. Direct routing is just cleaner.

---

## Rollback Plan

If anything breaks:

### Quick Rollback

```bash
# 1. Restore old LiteLLM config
kubectl apply -f /tmp/litellm-config-backup.yaml

# 2. Restart LiteLLM
kubectl rollout restart deployment litellm -n ai

# 3. Scale down Squire
kubectl scale deployment squire -n ai --replicas=0
```

### Gradual Rollback (keep Squire, disable validation)

```bash
# Edit Squire config
kubectl edit cm squire-config -n ai

# Set:
validation:
  enabled: false
escalation:
  enabled: false

# Restart Squire (pass-through mode)
kubectl rollout restart deployment squire -n ai
```

---

## Success Criteria

✅ **Deployment Successful If:**
- Squire pods running (2/2 ready)
- Health endpoint responds 200 OK
- Metrics available on :9090
- LiteLLM routes smart/tim to Squire
- Test requests complete successfully
- Escalation logs appear for complex questions
- No errors in logs for 1 hour

✅ **Quality Goals:**
- 70%+ of Gemma responses pass validation (no escalation needed)
- Haiku responses rarely escalate to Sonnet
- P95 latency < 15s (including escalations)
- Zero timeout errors

---

## Timeline

| Time | Action | Expected Duration |
|------|--------|-------------------|
| T+0  | Wait for Docker build | 2-3 min |
| T+3  | Deploy Squire | 1 min |
| T+4  | Create backend service | 10 sec |
| T+5  | Update LiteLLM config | 1 min |
| T+6  | Verify deployment | 30 sec |
| T+7  | Run integration test | 2 min |
| T+9  | Monitor for stability | 60 min |
| **T+69** | **Deployment complete!** | |

---

## Post-Deployment

### Grafana Dashboard

1. Import `grafana/squire-dashboard.json` (TODO: create)
2. Add to Round Table folder
3. Set as default for Squire monitoring

### Documentation

- [x] Quick start guide
- [x] LiteLLM integration guide
- [ ] Tuning guide (thresholds, judge prompts)
- [ ] Troubleshooting runbook
- [ ] Architecture deep-dive

### Future Enhancements

- [ ] Per-knight custom escalation paths
- [ ] Cost tracking (Gemma vs Anthropic usage)
- [ ] A/B testing framework (Squire on/off comparison)
- [ ] Streaming support
- [ ] Function calling preservation through escalation

---

🛡️ **Ready to deploy!** 🔥
