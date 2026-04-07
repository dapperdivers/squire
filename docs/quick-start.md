# Quick Start Guide

## Local Development

### 1. Clone and Install

```bash
git clone https://github.com/dapperdivers/squire.git
cd squire
npm install
```

### 2. Configure

Create `config/squire.yaml` or copy from the default:

```bash
cp config/squire.yaml config/squire.local.yaml
```

Edit with your LiteLLM endpoint and API key.

### 3. Run

```bash
# Development (with auto-reload)
npm run dev

# Production build
npm run build
npm start
```

### 4. Test

```bash
# Health check
curl http://localhost:4001/health

# Test request
curl -X POST http://localhost:4001/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "smart",
    "messages": [{"role": "user", "content": "Explain quantum computing"}]
  }'
```

---

## Docker

### Build Locally

```bash
docker build -t squire:local .
```

### Run

```bash
docker run -p 4001:4001 -p 9090:9090 \
  -e LITELLM_ENDPOINT=http://litellm:4000 \
  -e LITELLM_API_KEY=your-key \
  ghcr.io/dapperdivers/squire:latest
```

---

## Kubernetes (dapper-cluster)

### 1. Apply Manifests

```bash
kubectl apply -f kubernetes/deployment.yaml
```

This creates:
- ConfigMap: `squire-config`
- Deployment: `squire` (2 replicas)
- Service: `squire` (ClusterIP)

### 2. Verify Deployment

```bash
# Check pods
kubectl get pods -n ai -l app=squire

# Check logs
kubectl logs -n ai deployment/squire -f

# Test health
kubectl port-forward -n ai svc/squire 4001:4001
curl http://localhost:4001/health
```

### 3. Update Knights to Use Squire

Edit knight deployments to point at Squire:

```yaml
# kubernetes/apps/roundtable/knights/app/galahad.yaml
spec:
  env:
    - name: OPENAI_BASE_URL
      value: "http://squire.ai.svc.cluster.local:4001/v1"
```

Apply changes:

```bash
kubectl apply -f kubernetes/apps/roundtable/knights/app/galahad.yaml
```

### 4. Monitor Metrics

```bash
# Port-forward metrics
kubectl port-forward -n ai svc/squire 9090:9090

# View metrics
curl http://localhost:9090/metrics
```

---

## Configuration

### Environment Variables

Squire supports ENV var substitution in config:

```yaml
litellm:
  endpoint: "${LITELLM_ENDPOINT:-http://litellm:4000}"
  apiKey: "${LITELLM_API_KEY}"
```

**Available ENV vars:**
- `LITELLM_ENDPOINT` - LiteLLM proxy URL
- `LITELLM_API_KEY` - LiteLLM API key
- `REALM` - Metrics realm label (default: roundtable)
- `DEPLOYMENT` - Deployment label (default: production)
- `SQUIRE_CONFIG` - Path to config file

### Custom Config Path

```bash
# Via environment variable
export SQUIRE_CONFIG=/path/to/config.yaml
npm start

# Docker
docker run -v /path/to/config.yaml:/etc/squire/squire.yaml squire
```

### Config Priority

Squire searches for config in this order:
1. `--config` CLI argument (not implemented yet)
2. `$SQUIRE_CONFIG` environment variable
3. `/etc/squire/squire.yaml`
4. `./config/squire.yaml`

---

## Testing with Real LLMs

### 1. Point at LiteLLM

Ensure you have LiteLLM running with Anthropic configured.

### 2. Send Test Request

```bash
curl -X POST http://localhost:4001/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "tim",
    "messages": [
      {
        "role": "user",
        "content": "Write a haiku about code quality"
      }
    ]
  }'
```

### 3. Check Logs

Watch for escalation logs:

```
⚔️  [Squire] Attempting with anthropic/claude-haiku-4-6
⚖️  [Squire] Response validated (score: 65/100)
⚔️  [Squire] Answer falls short. Demanding a worthier response.
🔥  [Squire] Escalating to stronger ally (claude-sonnet-4-5)
🛡️  [Squire] Sir Sonnet's answer meets the standard. The king shall hear it.
```

### 4. Check Metrics

```bash
curl http://localhost:9090/metrics | grep squire
```

---

## Troubleshooting

### "No config file found"

**Solution:** Create `config/squire.yaml` or set `SQUIRE_CONFIG` env var.

### "LiteLLM error: 401 Unauthorized"

**Solution:** Check `LITELLM_API_KEY` is set correctly.

### "Connection refused"

**Solution:** Verify LiteLLM endpoint is reachable:

```bash
curl http://litellm:4000/health
```

### Validation always fails

**Solution:** Check judge model is available:

```bash
curl -X POST http://litellm:4000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"anthropic/claude-haiku-4-6","messages":[{"role":"user","content":"test"}]}'
```

---

## Next Steps

- [Configuration Guide](./configuration.md)
- [Architecture Overview](./architecture.md)
- [Metrics Reference](./metrics.md)
- [Round Table Integration](./roundtable-integration.md)
