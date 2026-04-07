# 🛡️ Squire - The Quality Sentinel

**Validate LLM responses and automatically escalate to better models when quality falls short.**

A transparent proxy for [LiteLLM](https://github.com/BerriAI/litellm) that uses LLM-as-a-judge to ensure every response meets your quality threshold, with automatic model escalation and cost optimization.

Built for the [Round Table](https://github.com/dapperdivers/roundtable) AI knight fleet, works with any OpenAI-compatible client.

---

## ✨ Features

- 🎯 **Quality-aware routing** with configurable thresholds
- ⚡ **Automatic model escalation** (cheap → expensive)
- 💰 **40-60% cost savings** vs always-using premium models
- 🔍 **LLM-as-a-judge validation** using fast, cheap models
- 📊 **Prometheus metrics** and cost tracking
- 🛡️ **Drop-in replacement** for any LiteLLM client
- 🏰 **Round Table themed** with lore-accurate logging

---

## 🚀 Quick Start

### Docker

```bash
docker run -p 4001:4001 -p 9090:9090 \
  -e LITELLM_ENDPOINT=http://litellm:4000 \
  -e LITELLM_API_KEY=your-key \
  ghcr.io/dapperdivers/squire:latest
```

### Node.js

```bash
git clone https://github.com/dapperdivers/squire.git
cd squire
npm install
npm run dev
```

### Kubernetes

```bash
kubectl apply -f https://raw.githubusercontent.com/dapperdivers/squire/main/kubernetes/deployment.yaml
```

---

## 📖 How It Works

**1. Client sends request to Squire**
```typescript
fetch("http://squire:4001/v1/chat/completions", {
  method: "POST",
  body: JSON.stringify({
    model: "smart",  // Uses escalation path
    messages: [{ role: "user", content: "Explain quantum computing" }]
  })
});
```

**2. Squire tries cheapest model first**
- Calls `ollama/gemma4:26b` (free, local)
- Returns: "Quantum computing uses qubits..."

**3. Squire validates with judge**
- Calls `claude-haiku-4-6` to score response 0-100
- Judge returns: `{"score": 65, "reasoning": "Accurate but incomplete"}`

**4. Below threshold? Escalate!**
- Score 65 < threshold 70
- Squire retries with `claude-haiku-4-6`

**5. Judge validates again**
- New score: 88 ✓
- Squire returns response to client

**Cost:** $0.0001 (Gemma) + $0.0002 (2x judge) + $0.001 (Haiku) = **$0.0013**  
**Without Squire:** $0.015 (Sonnet every time) = **91% savings**

---

## ⚙️ Configuration

Create `config/squire.yaml`:

```yaml
server:
  port: 4001
  realm: "roundtable"

litellm:
  endpoint: "http://litellm:4000"
  apiKey: "${LITELLM_API_KEY}"

validation:
  enabled: true
  judgeModel: "anthropic/claude-haiku-4-6"
  threshold: 70

escalation:
  enabled: true
  maxAttempts: 3
  paths:
    smart:
      - model: "ollama/gemma4:26b"
        threshold: 70
      - model: "anthropic/claude-haiku-4-6"
        threshold: 70
      - model: "anthropic/claude-sonnet-4-5"
        threshold: null  # Accept any score
```

**See [config/squire.yaml](./config/squire.yaml) for full example.**

---

## 📊 Metrics

Squire exposes Prometheus metrics on `:9090/metrics`:

```
squire_requests_total{model="smart",result="accepted"} 142
squire_escalations_total{from="haiku",to="sonnet"} 23
squire_validation_score{model="smart"} 85
squire_validation_cost_total 0.042
squire_request_cost_total{model="smart"} 12.50
```

**Grafana dashboard:** Coming soon!

---

## 🏰 Round Table Integration

### Knights

Point knights at Squire instead of LiteLLM:

```yaml
# kubernetes/apps/roundtable/knights/galahad.yaml
spec:
  env:
    - name: OPENAI_BASE_URL
      value: "http://squire.ai.svc.cluster.local:4001/v1"
```

### OpenClaw (molt/munin)

```bash
openclaw config set agents.defaults.providers.anthropic.baseUrl \
  "http://squire.ai.svc.cluster.local:4001/v1"
```

---

## 🎭 Lore-Accurate Logging

Squire speaks in-character:

```
⚔️  [Squire] Attempting with ollama/gemma4:26b
⚖️  [Squire] Response validated (score: 65/100)
⚔️  [Squire] Answer falls short. Demanding a worthier response.
🔥  [Squire] Escalating to stronger ally (claude-haiku-4-6)
🛡️  [Squire] Sir Haiku's answer meets the standard. The king shall hear it.
```

---

## 🧪 Development

```bash
# Install
npm install

# Run locally
npm run dev

# Build
npm run build

# Run tests
npm test

# Format
npm run format
```

---

## 📈 Roadmap

- [x] Basic proxy + validation
- [x] Model escalation
- [x] Prometheus metrics
- [ ] Validation log (JSONL)
- [ ] Selective validation (skip simple queries)
- [ ] Grafana dashboard
- [ ] Custom judge prompts per model
- [ ] Docker image + Kubernetes manifests
- [ ] Public release

---

## 📄 License

MIT

---

## 🙏 Credits

Built by [Derek Mackley](https://github.com/dapperdivers) for the Round Table.

Inspired by:
- [LiteLLM](https://github.com/BerriAI/litellm) - LLM proxy
- [Guardrails.ai](https://guardrailsai.com) - Output validation
- [simple-llm-eval](https://github.com/cyberark/simple-llm-eval) - LLM-as-a-judge

---

**⚔️ May your responses be worthy, your costs be low, and your thresholds be met. ⚔️**
