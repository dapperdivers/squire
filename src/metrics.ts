import { Registry, Counter, Histogram, Gauge } from 'prom-client';

export function createMetrics(serviceName: string) {
  const register = new Registry();
  
  register.setDefaultLabels({
    service: serviceName,
  });
  
  const requestsTotal = new Counter({
    name: 'squire_requests_total',
    help: 'Total number of requests processed',
    labelNames: ['model', 'result'],
    registers: [register],
  });
  
  const validationScore = new Histogram({
    name: 'squire_validation_score',
    help: 'Distribution of validation scores',
    labelNames: ['model'],
    buckets: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
    registers: [register],
  });
  
  const escalationsTotal = new Counter({
    name: 'squire_escalations_total',
    help: 'Total number of model escalations',
    labelNames: ['from', 'to'],
    registers: [register],
  });
  
  const validationCostTotal = new Counter({
    name: 'squire_validation_cost_total',
    help: 'Total cost of validation requests (USD)',
    registers: [register],
  });
  
  const requestDuration = new Histogram({
    name: 'squire_request_duration_seconds',
    help: 'Request duration in seconds',
    labelNames: ['model', 'result'],
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
    registers: [register],
  });
  
  return {
    register,
    requestsTotal,
    validationScore,
    escalationsTotal,
    validationCostTotal,
    requestDuration,
  };
}

export type Metrics = ReturnType<typeof createMetrics>;
