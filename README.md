# Squire 🛡️

**Quality-gated LLM escalation for the Round Table.**

Squire validates LLM responses and automatically escalates to stronger models when quality falls short. It's the **simplest possible** middleware between your agents and LiteLLM — just quality gating, escalation logic, and metrics.

---

## Philosophy

**Let LiteLLM do LiteLLM things. Squire only does what LiteLLM can't.**

- ✅ **Judge loop** — Validate response quality with a configurable judge model
- ✅ **Escalation engine** — Walk up a model tier when responses fall short
- ✅ **Skip filters** — Bypass validation for trivial requests
- ✅ **Prometheus metrics** — Escalation rates, validation scores, costs
- ✅ **Validation log** — JSONL log of every decision

Everything else (provider abstraction, key management, rate limiting, cost tracking) is **delegated to LiteLLM**.

**Result:** 600 lines of TypeScript instead of 1000+.

---

##Architecture

```
Knights/Agents → Squire:4001 → LiteLLM:4000 → Providers
                   (quality)     (routing)
```

**Flow:**
1. Knight requests `model: "smart"`
2. Squire tries `gemma-local` → validates response
3. If score < 70, escalates to `claude-haiku`
4. If still < 70, escalates to `claude-sonnet` (terminal, accept anything)
5. Returns validated response

---

## Quick Start

### 1. Configure LiteLLM

Add model aliases to LiteLLM config:

```yaml
model_list:
  - model_name: gemma-local
    litellm_params:
      model: ollama/gemma4:26b
      api_base: http://ollama:11434
  
  - model_name: claude-haiku
    litellm_params:
      model: anthropic/claude-haiku-4-6
      api_key: os.environ/ANTHROPIC_API_KEY
  
  - model_name: claude-sonnet
    litellm_params:
      model: anthropic/claude-sonnet-4-5
      api_key: os.environ/ANTHROPIC_API_KEY
```

### 2. Deploy Squire

```bash
kubectl apply -f kubernetes/deployment.yaml
```

### 3. Point Knights at Squire

```yaml
env:
  - name: OPENAI_BASE_URL
    value: "http://squire.ai.svc.cluster.local:4001/v1"
  - name: OPENAI_API_KEY
    value: "not-needed"  # Squire authenticates to LiteLLM
```

### 4. Send Requests

```bash
curl -X POST http://squire:4001/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "smart",
    "messages": [{"role": "user", "content": "Explain quantum computing"}]
  }'
```

**Expected logs:**
```
⚔️  Attempting with gemma-local
⚖️  Response validated (score: 65/100)
🔥 Escalating to claude-haiku
⚖️  Response validated (score: 85/100)
🛡️  Sir Haiku's answer meets the standard
```

---

## Configuration

### Escalation Paths

Define model tiers in `squire.yaml`:

```yaml
escalation:
  paths:
    smart:
      - model: "gemma-local"
        threshold: 70
      - model: "claude-haiku"
        threshold: 70
      - model: "claude-sonnet"
        threshold: null  # Terminal, accept anything
```

**Models are LiteLLM aliases**, not provider-specific identifiers. Squire doesn't know or care if `gemma-local` is Ollama, vLLM, or a magic 8-ball.

### Skip Filters

Bypass validation for trivial requests:

```yaml
filters:
  validateModels:
    - "smart"
    - "tim"
  
  skipIf:
    questionLengthLessThan: 20
    containsKeywords:
      - "hello"
      - "hi"
      - "thanks"
```

Requests to other models (e.g., `claude-opus`) pass through without validation.

### Judge Prompt

Customize how responses are validated:

```yaml
validation:
  judgeModel: "claude-haiku"
  threshold: 70
  judgePrompt: |
    Rate this response 0-100:
    
    **Accuracy (0-40):** Factually correct?
    **Completeness (0-30):** Fully answers the question?
    **Clarity (0-30):** Clear and well-structured?
    
    Question: {question}
    Response: {response}
    
    Output ONLY JSON: {"score": <number>, "reasoning": "<text>"}
```

---

## Metrics

Squire exports Prometheus metrics on `:9090/metrics`:

```promql
# Total requests by model and result
squire_requests_total{model="smart", result="accepted"}

# Escalation rate
rate(squire_escalations_total{from="gemma-local", to="claude-haiku"}[5m])

# Average validation score
avg(squire_validation_score{model="gemma-local"})

# P95 response time
histogram_quantile(0.95, squire_request_duration_seconds_bucket)

# Total validation cost (judge model calls)
squire_validation_cost_total
```

---

## Validation Log

Every validation decision is logged to `/var/log/squire/validation.jsonl`:

```json
{"timestamp":"2026-04-07T01:00:00Z","model":"smart","attempts":2,"finalScore":85,"question":"Explain quantum computing","response":"Quantum computing uses..."}
```

Use this to tune thresholds, debug escalation behavior, or train better judge prompts.

---

## Development

### Local

```bash
npm install
npm run dev
```

### Build

```bash
npm run build
npm start
```

### Docker

```bash
docker build -t squire:local .
docker run -p 4001:4001 -p 9090:9090 \
  -e LITELLM_API_KEY=your-key \
  squire:local
```

---

## Comparison

| Before (Complex Squire) | After (Slim Squire) |
|-------------------------|---------------------|
| Manages provider API keys | LiteLLM handles keys |
| Provider-specific code | Generic HTTP to LiteLLM |
| Two LiteLLM instances | One LiteLLM instance |
| Split cost tracking | Unified in LiteLLM |
| 1000+ lines of TS | 600 lines of TS |
| New provider = code change | New provider = config change |

---

## Future: LiteLLM Guardrail

LiteLLM has an open feature request ([#7320](https://github.com/BerriAI/litellm/issues/7320)) for **retry-on-guardrail-failure**.

If/when they ship it, Squire can collapse into a LiteLLM custom guardrail:

```python
# Future: Squire as LiteLLM guardrail
class QualityJudgeGuardrail(CustomGuardrail):
    async def async_post_call_success_hook(self, data, response):
        score = await self.judge(data, response)
        if score < self.threshold:
            raise RetryWithEscalation(next_model=...)
```

Monitor that issue. When it lands, Squire disappears and quality gating lives inside LiteLLM.

---

## License

MIT

---

## Credits

Built for the Round Table by **Tim the Enchanter** 🔥

*"Some call me... Tim."*
