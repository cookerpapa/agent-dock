# AgentDock deterministic coding evaluation

Generated: 2026-07-20T09:04:33.030Z

This measures the full durable Agent Loop and isolated tool execution with a scripted fake model. It does **not** claim model-intelligence quality.

- Tasks: 10
- Success: 10/10 (100.0%)
- Concurrency: 2
- p50 / p95: 9168 ms / 10224 ms
- Model requests / tokens / cost: 0 / 0 / 0 µUSD

| Task | Result | Run | Attempts | Test sequence | Duration |
| --- | --- | --- | ---: | --- | ---: |
| add | pass | dcbd32dd-5b63-4897-8de9-7627ffbbba8d | 1 | failed → passed | 5823 ms |
| subtract | pass | 19491424-d6dc-4619-ab29-c2bbbd1d637d | 1 | failed → passed | 10224 ms |
| multiply | pass | 580dbaa6-38ff-4e62-b187-dbfd088f5689 | 1 | failed → passed | 9032 ms |
| divide | pass | e5efaf21-1bee-45b1-be05-9dcd3a406b44 | 1 | failed → passed | 9174 ms |
| maximum | pass | 5dfe0fda-228d-417c-90e3-1be1f0fcf835 | 1 | failed → passed | 9474 ms |
| clamp | pass | 0930d7e4-660b-47f3-8df3-caef542b4c95 | 1 | failed → passed | 9440 ms |
| even | pass | 5dfb8bfc-18a0-4add-a01f-751317044260 | 1 | failed → passed | 8943 ms |
| average | pass | fb854fe2-f591-4df2-9384-cbc6666b790a | 1 | failed → passed | 8957 ms |
| factorial | pass | 04eda3f8-cfb0-41f1-8c13-d598556b8534 | 1 | failed → passed | 9168 ms |
| square | pass | 1b157b95-b113-4715-a729-5139e36cf60e | 1 | failed → passed | 9196 ms |
