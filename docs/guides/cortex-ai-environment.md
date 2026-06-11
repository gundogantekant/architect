# Cortex "ai" Environment — Per-Ticket ECS Sandbox Architecture

**Status**: Architectural contract — pre-implementation  
**Audience**: Cortex project implementers  
**Source session**: 2026-05-25 (ai-team branch)  
**Board review**: All 8 reviewers — verdict `revise` (incorporated below)

---

## 1. Purpose

This document defines the architecture for a personal experimental cloud environment ("ai environment") that provides **isolated, per-ticket HTTPS endpoints** for backend services. Each work ticket gets a fully independent deployment at `w-XXXX.ai.neuronicdev.com`, deployed from a developer's local machine with no CI/CD pipeline involvement.

This serves as the infrastructure contract for the **Cortex project** (7-tier AI SDLC pipeline). Cortex is not yet established — this document provides the architectural decisions that Cortex implementation work items must follow.

---

## 2. Background: N8N in neuronic/cloud

N8N (`n8n.io`) is a self-hosted workflow automation tool (comparable to Zapier/Make) deployed in neuronic/cloud on ECS Fargate, running `n8nio/n8n:2.13.2`, port 5678.

**Why prod-only**: Intentionally restricted to production (commit `1c851290`) to prevent automation workflows from triggering against dev/staging data. The N8N PostgreSQL schema (`n8n`) and ALB rule (priority 30) exist only in prod.

**Relevance to Cortex**: N8N is explicitly out of scope for the "ai" environment. Cortex uses Temporal for workflow orchestration instead.

---

## 3. neuronic/cloud ECS Drift: dev/staging vs prod

Analysis of the current environment gaps (as of 2026-05-25):

| Gap | Severity | Root Cause | Recommendation |
|-----|----------|-----------|----------------|
| **N8N service absent** | Low — intentional | Prod-only gate in `Services/N8N/infrastructure/cdk.ts:19–22` | Enable on staging only if workflow testing is needed; no action required otherwise |
| **DB connection pool** (max=5 dev vs max=10 prod) | Low | `api-server-stack.ts:220` | Increase to 10 on staging before load testing |
| **Auto-scaling ceiling** (2 dev vs 3 prod) | Negligible | `api-server-stack.ts:297` | Increase on staging only if capacity needed |

**Conclusion**: The only meaningful functional gap is N8N, which is intentional. All API routes, admin panel, CloudWatch alarms, and notification workers are equal across environments.

---

## 4. "ai" Environment: Core Design Decisions

### 4.1 Standalone CDK Project (not an extension of neuronic/cloud)

**Decision**: New standalone CDK project (`cortex-infra/`) independent of neuronic/cloud.

**Rationale**:
- eu-central-1 requires its own CDK bootstrap — cross-region additions to neuronic/cloud's `getConfig.ts` add cross-region CDK complexity
- Per-ticket stack lifecycle (frequent create/destroy) must not risk existing dev/staging/prod stacks
- Cortex services (Temporal workers, pgvector, AI tiers) do not map to neuronic/cloud's service structure
- No CDK construct or stack from neuronic/cloud may be imported into cortex-infra — cross-project CDK imports create compile-time coupling. If reuse is needed, extract to an independently versioned npm package.

### 4.2 AWS Configuration

| Property | Value |
|----------|-------|
| Account | `495599732437` (dev) |
| Region | `eu-central-1` (Frankfurt) |
| Environment name | `ai` |
| Conflict with existing | None — neuronic/cloud uses us-east-1 exclusively |

**First-time prerequisite**: CDK must be bootstrapped in eu-central-1 before any deployment:
```bash
cdk bootstrap aws://495599732437/eu-central-1 --profile dev
```
This is a one-time account-level action.

### 4.3 Domain Strategy

| Property | Value |
|----------|-------|
| Base | `ai.neuronicdev.com` (subdomain of existing hosted zone) |
| Wildcard cert | `*.ai.neuronicdev.com` — must be provisioned in **eu-central-1** (ACM certs are region-specific for ALB) |
| Per-ticket subdomain | `{ticket-id-lowercase}.ai.neuronicdev.com` |
| Example | `W-1234` → `w-1234.ai.neuronicdev.com` |
| Route53 | Hosted zone lives in us-east-1 but is global — records point to eu-central-1 ALB without issue |
| ALB canonical hosted zone ID (eu-central-1) | `Z215JYRZR1TBD5` — must be hardcoded in Route53 alias target, not reused from us-east-1 |

**Subdomain normalization**: lowercase, hyphen-safe. `W-1234` → `w-1234`. Strip any characters not matching `[a-z0-9-]` before use as a subdomain.

---

## 5. CDK Stack Architecture

### 5.1 Project Structure

```
cortex-infra/                              ← new standalone project
  package.json                             ← engines: { node: ">=20 <21" } (matches neuronic/cloud)
  cdk.json                                 ← app: "npx ts-node --transpile-only ..."
  tsconfig.json
  Services/
    getConfig.ts                           ← ai env: account, region, domain, secrets paths
    BaseStack.ts
    SharedInfra/
      infrastructure/
        stack/shared-infra-stack.ts        ← VPC, ALB, ACM cert, HTTPS listener, cleanup Lambda
        cdk.ts
    Sandbox/
      infrastructure/
        stack/sandbox-stack.ts             ← per-ticket ECS service, ALB rule, DNS record, TTL rule
        cdk.ts                             ← reads -c ticket=W-1234
  apps/
    api-server/
      Dockerfile                           ← forked from neuronic/cloud, adapted for ai env
  Makefile
  .env.local.ai                            ← gitignored
  .dockerignore                            ← must exclude .env.local.ai
```

### 5.2 SharedInfra Stack (one-time per "ai" environment)

Provisions:
- VPC: use default VPC in eu-central-1 if it exists; create a minimal VPC (2 AZs, public subnets only) if it does not (the default VPC is sometimes deleted as a hardening measure)
- Application Load Balancer (HTTPS only, port 443)
- ACM wildcard certificate: `*.ai.neuronicdev.com` — provisioned in eu-central-1 via `CertificateValidation.fromDns(hostedZone)` where `hostedZone` is looked up by domain name
- ECS Cluster: `cortex-ai` (shared across all ticket sandboxes)
- Shared Postgres (see §6)
- **Cleanup Lambda**: a Lambda function with IAM role scoped to `cloudformation:DeleteStack` on `arn:aws:cloudformation:eu-central-1:495599732437:stack/cortex-sandbox-*`, plus `ecs:UpdateService` to drain tasks before deletion. This Lambda receives stack names from EventBridge and orchestrates ordered teardown.
- SSM parameters written on deploy:
  ```
  /ai/shared-infra/alb-arn
  /ai/shared-infra/alb-sg-id
  /ai/shared-infra/https-listener-arn
  /ai/shared-infra/alb-dns-name
  /ai/shared-infra/alb-hosted-zone-id      ← Z215JYRZR1TBD5 for eu-central-1
  /ai/shared-infra/cluster-arn
  /ai/shared-infra/db-endpoint
  /ai/shared-infra/cleanup-lambda-arn
  ```

**Cross-stack wiring**: Sandbox stacks read SharedInfra values from SSM Parameter Store at deploy time. **Do not use CloudFormation `Fn.importValue`** — cross-stack exports create hard deletion locks that block SharedInfra updates while any Sandbox stack exists.

### 5.3 Sandbox Stack (per ticket)

Each `make deploy TICKET=W-1234` creates a `cortex-sandbox-w-1234` CloudFormation stack containing:

- **ECS Fargate service**: `cortex-w-1234` on the shared `cortex-ai` cluster
  - CPU: 256, Memory: 512 MiB (ARM64, Graviton)
  - `desiredCount: 1`, `maximumPercent: 200`, `minimumHealthyPercent: 100`
  - `enableExecuteCommand: true` for emergency debugging
- **Task definition**: service container
  - Health check: `CMD-SHELL curl -f http://localhost/health || exit 1`, `startPeriod: 60s`, `interval: 30s`, `retries: 3`
  - Log driver: `AwsLogDriver({ streamPrefix: 'cortex-sandbox', logRetention: RetentionDays.THREE_DAYS })`
  - `API_URL` env var injected (server-side, not `NEXT_PUBLIC_*` — see §8)
- **Task security group**: dedicated per ticket, ingress from ALB security group on container port only
- **ALB listener rule**: see §5.4 for priority allocation
- **Route53 A record**: `w-1234.ai.neuronicdev.com` → ALB alias (zone ID: `Z215JYRZR1TBD5`)
- **Auto-destroy TTL**: EventBridge scheduled rule firing 14 days after stack creation → invokes SharedInfra cleanup Lambda with `stackName: cortex-sandbox-w-1234`. The rule lives inside the Sandbox stack (deleted with it on successful cleanup) and targets the cleanup Lambda in SharedInfra.
- **SSM endpoint record**: `StringParameter` written at stack creation: `/ai/sandboxes/w-1234/endpoint-url = https://w-1234.ai.neuronicdev.com`

**Stack naming**: `cortex-sandbox-{ticket-id-lowercase}`. Maximum 63 characters total.

### 5.4 ALB Listener Rule Priority Allocation

**Do not use `hash(ticket_id) mod N`** — hash collisions cause `CloudFormation::deploy` to fail with a non-obvious error, and there is no recovery path short of manual priority cleanup.

**Required approach**: DynamoDB-based atomic priority counter (SSM `put-parameter --overwrite` has no compare-and-swap primitive — two concurrent deploys can read the same value and collide on the same ALB priority, causing a non-recoverable `DuplicatePriorityError`).

Implementation:
1. SharedInfra creates a DynamoDB table `cortex-ai-config` (on-demand, single-item) with an attribute `alb_priority_counter` initialized to `200`.
2. Each Sandbox stack uses a CDK Custom Resource (Lambda-backed) that:
   - Atomically increments the counter via DynamoDB `UpdateItem` with `ADD alb_priority_counter :1` and returns the new value (DynamoDB ADD is atomic — no CAS loop needed)
   - Stores the allocated priority in SSM `/ai/sandboxes/{ticket-id}/alb-priority` for reference
   - Returns the allocated priority to the CDK stack
3. On stack destroy, the Custom Resource `onDelete` handler does not reclaim the priority (priorities are never reused — acceptable ceiling of 49800 total tickets historically given a start of 200 and ALB max of 50000).
4. Custom Resource Lambda timeout: set `timeout: Duration.minutes(5)` — the default CloudFormation timeout for Custom Resources can be up to 1 hour, which will stall deploys if the Lambda hangs.
5. At any one time, only the 99 currently active sandboxes occupy listener rule slots (AWS hard limit: 100 rules per listener, including the default rule).

**Concurrent sandbox limit**: 99 active tickets maximum. Attempting to deploy ticket 100 while 99 are active will fail at ALB limit. Document this as an operational constraint. Add a `make check-capacity` target that counts active sandboxes before deploying.

**Alternative if >99 concurrent tickets are needed**: Replace per-subdomain ALB routing with a single routing service (Nginx/Traefik on ECS) that forwards based on `Host` header. The routing service holds one ALB listener rule; all ticket traffic passes through it.

---

## 6. Database Strategy

> **Superseded for the "ai" environment**: Section 15 replaces the RDS recommendation below with a per-ticket Postgres sidecar. Sections 6.1–6.3 document the shared-RDS alternative and serve as the fallback if persistent data is required long-term. Read §15 first.

### 6.1 Decision: Small RDS Instance (not Fargate Postgres)

**Recommended**: `db.t4g.micro` RDS PostgreSQL 16, `eu-central-1`, single-AZ, no Multi-AZ (dev cost ~$12–15/month).

**Why not Fargate Postgres**: ECS Fargate has no durable block storage. A PostgreSQL container on Fargate loses all data on any task restart, OOM kill, or Fargate rebalance event. This is not documented as a trade-off — it is a data loss guarantee. EFS mounting is possible but adds latency, cost, and operational complexity that exceeds a small RDS instance.

The RDS instance is provisioned by the SharedInfra stack and shared across all ticket sandboxes.

### 6.2 Per-Ticket Schema Isolation

Each ticket gets a dedicated PostgreSQL schema: `cortex_ticket_w1234` (lowercase, alphanumeric + underscore only).

> **Under the sidecar model (§15)**, each ticket owns its own Postgres instance — there is nothing to isolate from. The dynamic-schema ORM requirement and `CREATE/DROP SCHEMA` lifecycle below apply only if the shared RDS fallback path is used. Under the sidecar model, standard Prisma or Drizzle without multiSchema is sufficient.

**Known ORM incompatibility** (shared RDS path only): The existing neuronic/cloud Prisma and Drizzle setup is **not directly compatible** with per-ticket schema switching:
- Prisma services using `multiSchema` (`User`, `Admin`) have hardcoded `@@schema("User")` / `@@schema("Admin")` annotations — they do not respect `?schema=` in the connection URL
- Drizzle uses `pgSchema("Admin")` etc. as hardcoded named schemas

**Resolution for Cortex**: Cortex's own services must be designed with dynamic schema support from the start. Options:
1. Use `?options=--search_path%3D{schema}` in the `DATABASE_URL` — works for standard Prisma (non-multiSchema) services where all tables are in `public`-equivalent schema
2. Use Drizzle with a `drizzle.config.ts` that reads schema name from an env var: `schema: process.env.DB_SCHEMA_NAME` — requires updating all `pgSchema()` calls to use the env var
3. Scope Cortex DB models entirely to a fresh set of schemas with no legacy naming conflicts

**TBD — must be resolved before Cortex DB implementation**: Which ORM approach Cortex uses and how per-ticket schema creation and migration run.

### 6.3 Schema Lifecycle

**On stack creation**: CDK Custom Resource (Lambda) creates the schema and runs migrations:
```sql
CREATE SCHEMA IF NOT EXISTS cortex_ticket_w1234;
```
followed by `prisma migrate deploy` (or equivalent) with `DATABASE_URL` targeting the new schema.

**On stack destroy**: CDK Custom Resource `onDelete` drops the schema:
```sql
DROP SCHEMA IF EXISTS cortex_ticket_w1234 CASCADE;
```

**Connection pooling**: With 99 maximum concurrent tickets and multiple services per ticket, total connections can reach 99 × (connections_per_service). Use PgBouncer in transaction mode, or set a strict `DB_POOL_MAX=2` per service container and document the per-sandbox budget.

---

## 7. Local Deployment Workflow

No changes to any GitHub workflow file. The Makefile is a local-only tool, gitignored from neuronic/cloud's working directory.

### 7.1 Prerequisites

In order:
1. `~/.aws` with `dev` profile configured (IAM user or Identity Center — prefer short-lived credentials; see §7.4)
2. Docker with buildx. Run `docker buildx ls` first — if `linux/arm64` already appears in the driver list, skip `docker buildx create --use`. On Docker Desktop it is usually pre-configured; running `create --use` again creates a duplicate builder silently and may produce confusing output.
3. Node.js >=20 <21, npm, CDK CLI (`npm i -g aws-cdk@2.1033.0`), TypeScript. **The CDK CLI version must match the `aws-cdk-lib` version in `cortex-infra/package.json`** — a version mismatch produces a cryptic `No @aws-cdk/cx-api version` error at synth time. Run `cdk --version` and compare against `aws-cdk-lib` in `package.json` before deploying.
4. `make bootstrap` — one-time CDK bootstrap in eu-central-1
5. `make setup-shared` — one-time SharedInfra deployment (VPC, ALB, cert, RDS, cleanup Lambda)

Steps 4 and 5 must run in order and only once. After this, per-ticket deploys are self-contained.

### 7.2 Makefile

> **See §15.8 for the complete canonical Makefile.** The targets below are a subset shown for reference. The full Makefile including debug targets (`logs`, `exec`, `status`, `db-connect`) and sidecar-specific targets (`seed-ecr`, `deploy-persistent`) lives in §15.8.

```makefile
# cortex-infra/Makefile — partial excerpt, see §15.8 for full version
TICKET       ?= $(error TICKET is required — e.g. make deploy TICKET=W-1234)
AWS_PROFILE  ?= dev
AWS_REGION    = eu-central-1
AWS_ACCOUNT   = 495599732437
ECR_REGISTRY  = $(AWS_ACCOUNT).dkr.ecr.$(AWS_REGION).amazonaws.com
IMAGE_TAG    ?= $(shell echo $(TICKET) | tr '[:upper:]' '[:lower:]')-$(shell git rev-parse --short HEAD)
TICKET_LOWER  = $(shell echo $(TICKET) | tr '[:upper:]' '[:lower:]')
DASHBOARD_URL ?= http://127.0.0.1:3777

.PHONY: help bootstrap setup-shared ecr-login build deploy deploy-only destroy url list check-capacity

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?##' $(MAKEFILE_LIST) | \
	  awk -F'##' '{printf "  %-20s %s\n", $$1, $$2}'

bootstrap: ## One-time: CDK bootstrap in eu-central-1 (run once per account)
	cdk bootstrap aws://$(AWS_ACCOUNT)/$(AWS_REGION) --profile $(AWS_PROFILE)

setup-shared: ## One-time: deploy shared infra (ALB, cert, RDS, cleanup Lambda)
	cdk deploy -c env=ai \
	  --app "npx ts-node --transpile-only Services/SharedInfra/infrastructure/cdk.ts" \
	  --profile $(AWS_PROFILE) --require-approval never

ecr-login: ## Log in to ECR (refreshes every 12h)
	@set -euo pipefail; \
	aws ecr get-login-password --region $(AWS_REGION) --profile $(AWS_PROFILE) \
	  | docker login --username AWS --password-stdin $(ECR_REGISTRY)

build: ecr-login ## Build ARM64 image and push to ECR (slow on Intel Mac — see note)
	# Note: --platform linux/arm64 on Apple Silicon builds natively (~90s).
	# On Intel Mac, QEMU emulation is used (~10–15 min). Consider --platform linux/amd64
	# and changing ECS task CPU architecture to X86_64 for faster local iteration.
	docker buildx build --platform linux/arm64 \
	  -t $(ECR_REGISTRY)/cortex-api-server-ai:$(IMAGE_TAG) \
	  --push apps/api-server/

check-capacity: ## Check how many active sandboxes are deployed (max 99)
	@COUNT=$$(aws cloudformation list-stacks \
	  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE UPDATE_IN_PROGRESS \
	  --region $(AWS_REGION) --profile $(AWS_PROFILE) \
	  --query "length(StackSummaries[?starts_with(StackName,'cortex-sandbox-')])" \
	  --output text); \
	echo "Active sandboxes: $$COUNT / 99"; \
	[ "$$COUNT" -lt 99 ] || (echo "ERROR: ALB listener rule limit reached" && exit 1)

deploy: build check-capacity ## Build, push, and deploy ticket sandbox
	@set -euo pipefail; \
	cdk deploy -c env=ai -c ticket=$(TICKET) -c imageTag=$(IMAGE_TAG) \
	  --app "npx ts-node --transpile-only Services/Sandbox/infrastructure/cdk.ts" \
	  --profile $(AWS_PROFILE) --require-approval never && \
	$(MAKE) register-endpoint

deploy-only: check-capacity ## Deploy using existing ECR image (skip Docker build — for CDK-only changes)
	@set -euo pipefail; \
	cdk deploy -c env=ai -c ticket=$(TICKET) \
	  --app "npx ts-node --transpile-only Services/Sandbox/infrastructure/cdk.ts" \
	  --profile $(AWS_PROFILE) --require-approval never && \
	$(MAKE) register-endpoint

register-endpoint: ## Register deployed endpoint in architect dashboard
	@curl -sf -X PUT $(DASHBOARD_URL)/api/work-items/$(TICKET)/artifacts/endpoint.json \
	  -H "Content-Type: application/json" \
	  -d '{"url":"https://$(TICKET_LOWER).ai.neuronicdev.com"}' \
	  && echo "Endpoint registered: https://$(TICKET_LOWER).ai.neuronicdev.com" \
	  || echo "Warning: dashboard unreachable — endpoint not registered"

url: ## Print the endpoint URL for a ticket
	@echo "https://$(TICKET_LOWER).ai.neuronicdev.com"

destroy: ## Tear down a ticket sandbox
	@set -euo pipefail; \
	cdk destroy -c env=ai -c ticket=$(TICKET) \
	  --app "npx ts-node --transpile-only Services/Sandbox/infrastructure/cdk.ts" \
	  --profile $(AWS_PROFILE) --force

list: ## List all active cortex sandbox stacks
	@aws cloudformation list-stacks \
	  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE UPDATE_IN_PROGRESS \
	  --region $(AWS_REGION) --profile $(AWS_PROFILE) \
	  --query "StackSummaries[?starts_with(StackName,'cortex-sandbox-')].{Stack:StackName,Status:StackStatus,Age:CreationTime}" \
	  --output table
```

### 7.3 Configuration: `.env.local.ai`

Gitignored file on the developer's machine. **These variables are used by the Makefile only** — they are not read by running ECS tasks. ECS task environment variables are injected from AWS Secrets Manager and SSM Parameter Store inside `sandbox-stack.ts` at deploy time.

Contents:
```bash
# AWS (prefer Identity Center short-lived credentials over long-lived keys)
AWS_PROFILE=dev

# Cortex shared Postgres (eu-central-1 RDS endpoint)
DB_HOST=<rds-endpoint>.eu-central-1.rds.amazonaws.com
DB_PORT=5432
DB_NAME=cortex
DB_USER=cortex_admin
# DB_PASSWORD is stored in Secrets Manager at /ai/db/password — not in this file

# Dashboard
DASHBOARD_URL=http://127.0.0.1:3777
```

**Security**:
- Add `.env.local.ai` to `.dockerignore` — it must never enter a Docker build context
- Prefer IAM Identity Center short-lived credentials over long-lived IAM user keys
- The IAM principal must be scoped to minimum permissions (see §7.4)
- Database password is in Secrets Manager (`/ai/db/password`), not in `.env.local.ai`

### 7.4 Required IAM Permissions (minimum scope)

The IAM principal used for local deployments requires:
```json
{
  "cloudformation:*": "arn:aws:cloudformation:eu-central-1:495599732437:stack/cortex-*",
  "ecs:*":            "arn:aws:ecs:eu-central-1:495599732437:cluster/cortex-ai",
  "ecr:*":            "arn:aws:ecr:eu-central-1:495599732437:repository/cortex-*",
  "s3:*":             "<CDK bootstrap bucket ARN>",
  "ssm:GetParameter": "arn:aws:ssm:eu-central-1:495599732437:parameter/ai/*",
  "ssm:PutParameter": "arn:aws:ssm:eu-central-1:495599732437:parameter/ai/*",
  "route53:ChangeResourceRecordSets": "<hosted zone for neuronicdev.com>",
  "acm:RequestCertificate": "*",
  "elasticloadbalancing:*": "<ALB ARN>",
  "rds:*":            "arn:aws:rds:eu-central-1:495599732437:db/cortex-ai-postgres"
}
```
No `iam:*` wildcard. No access to us-east-1 resources.

---

## 8. Endpoint ↔ Ticket Linking

### 8.1 Pattern

1. `make deploy TICKET=W-1234` deploys the sandbox and auto-calls `make register-endpoint`
2. `register-endpoint` writes the endpoint URL to the architect dashboard via `PUT /api/work-items/W-1234/artifacts/endpoint.json`
3. The SSM parameter `/ai/sandboxes/w-1234/endpoint-url` is also written by the CDK stack as the authoritative source of truth
4. Architect dashboard reads the endpoint from the work item artifact for display
5. Frontend uses the endpoint at the service level — **not via `NEXT_PUBLIC_*`** (see §8.2)

### 8.2 Frontend API URL Injection (Critical: Build-Time vs Runtime)

`NEXT_PUBLIC_*` variables in Next.js are **baked into the JavaScript bundle at build time**. Updating `.env.local` on the host machine after a container image is built has zero effect on the running container.

**Correct pattern for Cortex**: Inject the API URL as a server-side environment variable in the ECS task definition:
```typescript
// sandbox-stack.ts
containerDefinition.addEnvironment('API_URL', `https://${ticketLower}.ai.neuronicdev.com`);
// NOT NEXT_PUBLIC_API_URL
```

All data fetching in the admin UI already uses Next.js server components and `"use server"` actions — the API URL is read server-side from `process.env.API_URL`. This is compatible with runtime injection and requires no image rebuild to change the target endpoint.

If client-side fetches are added to Cortex UI in the future, use `/api/config` endpoint (server-returns-config-to-client pattern) rather than `NEXT_PUBLIC_*` to preserve this runtime flexibility.

### 8.3 Shared vs Per-Ticket Admin UI

**Decision: shared admin UI instance** (one ECS task for the ai environment, not per-ticket).

Rationale: The admin UI connects directly to the RDS database via Drizzle ORM (server components, not via a per-ticket API). A per-ticket admin UI would need its own Drizzle connection targeting a different schema, its own Cognito session, and its own ALB listener rule — adding cost and consuming ALB rule slots. The admin UI is not the experimental surface; the backend API services are.

For the shared admin UI to work across ticket schemas: pass the target schema as a session cookie or URL parameter, and use that to set the `search_path` per request.

---

## 9. What Is and Is Not Feasible Per Ticket

| Component | Feasible | Notes |
|-----------|----------|-------|
| API server (Fastify/Node) | ✅ | Container, ARM64 Dockerfile |
| Per-ticket PostgreSQL schema | ✅ | Sidecar Postgres per ticket (§15.2) — ephemeral by default, EFS opt-in for persistence (§15.5). No shared RDS in the ai env. |
| HTTPS endpoint | ✅ | ALB + wildcard ACM cert + Route53 |
| Secrets/config | ✅ | ECS task env vars injected from Secrets Manager |
| Auto-destroy TTL | ✅ | EventBridge rule → SharedInfra cleanup Lambda |
| Shared admin UI | ✅ | One instance, schema-aware via request context |
| **AWS Cognito** | ⚠️ Partial | Create **one shared Cognito User Pool** in eu-central-1 for the ai env; not per-ticket |
| **AWS IoT Core** | ❌ Skip | IoT Core endpoints are us-east-1 hardcoded throughout neuronic/cloud; not applicable to Cortex AI SDLC use case |
| **S3 firmware/env buckets** | ❌ / ⚠️ | Cortex does not need firmware buckets; create eu-central-1 mirror only if specific S3 content is needed |
| **N8N** | ❌ Out of scope | Cortex uses Temporal; N8N is neuronic/cloud prod-only |
| **Per-ticket RDS instance** | ❌ | Cost-prohibitive; use shared RDS + per-ticket schema |
| **>99 concurrent sandboxes** | ❌ | ALB listener hard limit (100 rules/listener); see §5.4 for the routing service alternative |

### 9.1 Cognito for the "ai" Environment — Required Steps

A shared Cognito User Pool in eu-central-1 is required (not the existing neuronic/cloud us-east-1 pools). Required provisioning steps:
1. Create User Pool in eu-central-1 (via SharedInfra CDK stack)
2. Create App Client with `COGNITO_CLIENT_ID` + `COGNITO_CLIENT_SECRET`
3. Configure Cognito Hosted UI domain (e.g., `auth.ai.neuronicdev.com`)
4. Register callback URL: `https://admin.ai.neuronicdev.com/api/auth/callback/cognito`
5. Register Google OAuth redirect URIs in Google Cloud Console pointing to new Cognito domain
6. Update ECS task definition env vars: `COGNITO_ISSUER`, `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, `COGNITO_DOMAIN`, `NEXTAUTH_URL`
7. Update `taskRole` IAM policy — the existing `admin-hosting-stack.ts` hardcodes `us-east-1` in the `cognito-idp:ListUsers` ARN; Cortex must use `eu-central-1`

**TBD**: Decide whether the ai env Cognito pool is isolated (separate user accounts from dev) or federated to the dev pool. Isolated is recommended — avoids test accounts contaminating dev and vice versa.

---

## 10. Auto-Destroy Architecture (14-day TTL)

The auto-destroy mechanism requires an execution target — EventBridge alone cannot destroy a CDK stack.

### Implementation

**SharedInfra** provisions:
- Cleanup Lambda (`cortex-cleanup-fn`) with IAM permissions:
  - `cloudformation:DeleteStack` on `arn:aws:cloudformation:eu-central-1:495599732437:stack/cortex-sandbox-*`
  - `ecs:UpdateService`, `ecs:DescribeServices` on the `cortex-ai` cluster (to set `desiredCount=0` before deletion)
  - `ssm:DeleteParameter` on `/ai/sandboxes/*`
- The Lambda implements ordered teardown:
  1. Scale ECS service `desiredCount` to 0 (drains connections)
  2. Wait for service to stabilize (no running tasks)
  3. Call `CloudFormation.deleteStack(stackName)`
  4. On failure: publish to a CloudWatch Alarm / SNS topic (do not swallow errors)

**Each Sandbox stack** provisions:
- EventBridge scheduled rule: fires once, 14 days after stack creation time
- Target: SharedInfra cleanup Lambda, payload `{ "stackName": "cortex-sandbox-w-1234" }`
- The rule is deleted automatically when the stack is destroyed (by the Lambda or by `make destroy`)

**Cleanup Lambda — ordered teardown with EventBridge rule guard**:
1. **Disable the EventBridge rule first** (before any other action) to prevent re-triggering if the Lambda times out mid-execution: `events.disableRule(ruleName)`
2. Scale ECS service `desiredCount` to 0 (initiates connection drain)
3. Poll `ecs.describeServices` until `runningCount === 0` — poll every 15 seconds. **Do not block the Lambda thread for the full drain period**: if drain takes > 5 minutes, publish a second EventBridge event with a 2-minute delay to re-enter step 3. Lambda timeout is set to 5 minutes.
4. Call `cloudformation.deleteStack(stackName)`
5. On any error: publish to SNS (DLQ + CloudWatch Alarm on DLQ depth > 0)

**Partial failure — zombie stacks**: If CFN delete fails after ECS is drained, the EventBridge rule inside the stack may still exist in a `DELETE_FAILED` state. The cleanup Lambda's first action (disable rule) prevents re-firing even in this case. Zombie stacks must be manually cleaned up: `make destroy TICKET=W-XXXX`.

---

## 11. Observability

Minimum requirements for the ai environment:

- **Container logs**: each ECS task produces two log streams under log group `/ecs/cortex-sandbox-{ticket}`:
  - `cortex-sandbox-app/{task-id}` — application container (set via `streamPrefix: 'cortex-sandbox-app'`)
  - `cortex-sandbox-db/{task-id}` — Postgres sidecar container (set via `streamPrefix: 'cortex-sandbox-db'`)
  - Both retain `THREE_DAYS`. Use `make logs TICKET=W-XXXX` to tail both streams together.
- **ECR lifecycle policy for `cortex-app-ai`**: expire untagged images after 1 day; keep last 5 tagged images per ticket prefix; expire all images 16 days after push (two days post-TTL).
- **ECR lifecycle policy for `cortex-postgres-ai`**: keep 1 image per pinned patch tag indefinitely (never auto-expire — the tag is updated manually via `make seed-ecr` only when intentionally upgrading PostgreSQL).
- **Budget alert**: one-time `aws budgets create-budget` for account 495599732437, tagged `Environment=ai`, alert at 80% and 100% of $50/month
- **No per-ticket alarms required** — this is a dev/experimental environment

---

## 12. Unresolved Decisions (TBD — Must Resolve Before Implementation)

These must be decided before dispatching Cortex implementation work items:

| # | Decision | Options | Notes |
|---|----------|---------|-------|
| 1 | **Shared Postgres provisioning** | SharedInfra CDK stack (RDS `db.t4g.micro`) vs pre-existing | Recommend: SharedInfra owns it |
| 2 | **Cognito pool isolation** | ai-only pool vs federated with dev pool | Recommend: isolated |
| 3 | **ORM for Cortex DB services** | Fresh Drizzle with env-var schema names vs fresh Prisma (non-multiSchema) | Must support dynamic schema; do not inherit neuronic/cloud's `multiSchema` or `pgSchema()` patterns |
| 4 | **Admin UI per-ticket schema switching** | Request-context `search_path` override vs separate DB connection per request | Requires Drizzle transaction-level schema override |
| 5 | **>99 concurrent sandbox limit** | Accept 99 cap vs routing service | For Cortex v1, 99 cap is acceptable |
| 6 | **IAM credential method** | Long-lived IAM user keys vs Identity Center short-lived | Strongly recommend Identity Center |
| 7 | **Makefile repository location** | `cortex-infra/` (its own repo) vs `architect/tools/cortex/` | Recommend: own repo once Cortex is established |
| 8 | **architect dashboard endpoint artifact API** | ✅ RESOLVED — `PUT /api/work-items/:id/artifacts/:filename` confirmed in dashboard; `register-endpoint` Makefile target is implemented with graceful fallback | — |
| 9 | **Postgres patch version to pin** | Decide which `16.x` patch to use as the canonical sidecar version | Run `make seed-ecr` after deciding; update `sandbox-stack.ts` image tag |
| 10 | **DynamoDB table for priority counter** | SharedInfra must provision `cortex-ai-config` DynamoDB table before any sandbox can deploy | First step of SharedInfra implementation |
| 11 | **`check-capacity` race at 98/99** | Two concurrent deploys at count 98 can both pass the check and both attempt to become the 99th (one succeeds, one fails at ALB). | Document as known limitation; operator must serialize the last few deploys near the limit |

---

## 13. Verification Checklist

Before considering the ai environment operational:

```bash
# 1. CDK bootstrap
cdk bootstrap aws://495599732437/eu-central-1 --profile dev
# Expected: CDKToolkit stack created in eu-central-1

# 2. Shared infra
make setup-shared
# Expected: ALB, ACM cert, RDS, cluster, cleanup Lambda all CREATE_COMPLETE

# 3. First ticket deploy
make deploy TICKET=W-0001
# Expected: stack CREATE_COMPLETE, ECS service running, health check passing

# 4. Endpoint reachable
curl https://w-0001.ai.neuronicdev.com/health
# Expected: 200 OK

# 5. Second ticket deploy (simultaneously)
make deploy TICKET=W-0002
# Expected: both w-0001 and w-0002 reachable simultaneously

# 6. CDK-only change (no rebuild)
make deploy-only TICKET=W-0001
# Expected: cdk deploy completes in ~60s without Docker build

# 7. Capacity check
make check-capacity
# Expected: "Active sandboxes: 2 / 99"

# 8. Drift check on shared infra (sandboxes must not mutate it)
cdk diff --app "npx ts-node --transpile-only Services/SharedInfra/infrastructure/cdk.ts" -c env=ai
# Expected: No changes

# 9. Ticket destroy
make destroy TICKET=W-0001
# Expected: stack DELETE_COMPLETE, Route53 record removed, ALB rule removed, schema dropped

# 10. Dashboard registration
curl http://127.0.0.1:3777/api/work-items/W-0002/artifacts/endpoint.json
# Expected: {"url": "https://w-0002.ai.neuronicdev.com"}
```

---

## 14. Runbook: ALB Listener Rule Emergency

If ALB listener rules become misconfigured and multiple sandboxes are unreachable:

```bash
# List all current listener rules
aws elbv2 describe-rules \
  --listener-arn $(aws ssm get-parameter --name /ai/shared-infra/https-listener-arn \
    --query Parameter.Value --output text) \
  --region eu-central-1 --profile dev \
  --query "Rules[*].{Priority:Priority,TargetGroup:Actions[0].TargetGroupArn}" \
  --output table

# Find orphaned rules (target group deleted but rule remains)
# Safe manual delete of an orphaned rule:
aws elbv2 delete-rule --rule-arn <arn> --region eu-central-1 --profile dev

# Redeploy a specific ticket to recreate its rule
make deploy-only TICKET=W-XXXX
```

Rule limit: 100 per listener (99 usable). If at limit, destroy oldest stacks via `make list` then `make destroy`.

---

---

## 15. Full-Container Stack: Containerize Everything

### 15.1 Philosophy

The "ai" environment targets **maximum containerization**: every service a ticket sandbox needs runs inside an ECS Fargate task. The goal is a self-contained per-ticket deployment that requires no external managed services beyond what SharedInfra provisions once.

Trade-off acceptance: containerized Postgres loses data on task restart. For experimental per-ticket work, this is acceptable — tickets are short-lived (14-day TTL) and state is not expected to survive beyond the active session.

### 15.2 Per-Ticket Container Stack

Each `cortex-sandbox-{ticket}` CloudFormation stack provisions one ECS task definition with multiple containers:

```
ECS Task: cortex-{ticket}
├── db           ← PostgreSQL 16 sidecar (port 5432, not exposed externally)
│   Image: ECR cortex-postgres-ai:16-{digest}  ← pinned digest, see §15.3
│   essential: true
│   Memory: 512 MiB (hard limit — prevents runaway queries from OOM-killing the task)
│   Health: pg_isready -U cortex  (interval: 10s, timeout: 5s, retries: 5, startPeriod: 30s)
│   Environment:
│     POSTGRES_DB=cortex
│     POSTGRES_USER=cortex
│   Secrets (ECS native, from Secrets Manager):
│     POSTGRES_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret)
│   Logs: AwsLogDriver({ streamPrefix: 'cortex-sandbox-db', logRetention: THREE_DAYS })
│   Ephemeral storage: 20 GiB (ECS Fargate ephemeral, lost on task restart)
│
└── app          ← main application service (port 3000)
    Image: ECR cortex-app-ai:{image-tag}
    essential: true
    Memory: 1024 MiB (hard limit)
    dependsOn: [{ containerName: "db", condition: "HEALTHY" }]
    Health: GET /health → 200  (startPeriod: 60s — allows migrations to run first)
    Environment:
      DATABASE_URL: postgres://cortex:${POSTGRES_PASSWORD}@localhost:5432/cortex
    Secrets: POSTGRES_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret)
    Logs: AwsLogDriver({ streamPrefix: 'cortex-sandbox-app', logRetention: THREE_DAYS })
```

The two containers share a task-level network namespace — `app` connects to `db` via `localhost:5432`.

**Important — startup ordering**: `dependsOn: HEALTHY` ensures ECS does not start the `app` container until the `db` container passes its health check. Without this, the app will attempt a DB connection before Postgres is ready and fail. The app must additionally implement connection retry with exponential backoff for any path that executes before the health check completes.

**Task restart behavior**: ECS Fargate restarts the entire task (both containers) when any `essential: true` container exits. This means a db OOM kill restarts the app too — all in-flight requests are dropped. This is expected behavior for a short-lived experiment sandbox; the app must not assume its Postgres state survives a restart.

**Migration orchestration**: Migrations must run as part of the app container's entrypoint, after `dependsOn: HEALTHY` ensures the db is ready:
```dockerfile
# apps/app/docker-entrypoint.sh
#!/bin/sh
set -e
npx prisma migrate deploy   # or drizzle-kit migrate
exec node dist/server.js
```
There is no CDK Custom Resource for migrations in the sidecar model — the sidecar Postgres is only reachable from inside the running ECS task, not from a CDK deploy-time Lambda.

**CDK secrets injection snippet**:
```typescript
// sandbox-stack.ts
const dbSecret = secretsmanager.Secret.fromSecretNameV2(this, 'DbSecret', '/ai/db/password');

const dbContainer = taskDef.addContainer('db', {
  image: ecs.ContainerImage.fromEcrRepository(dbRepo, '16-abc123'),  // pinned digest tag
  essential: true,
  memoryLimitMiB: 512,
  secrets: { POSTGRES_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret) },
  environment: { POSTGRES_DB: 'cortex', POSTGRES_USER: 'cortex' },
  healthCheck: { command: ['CMD-SHELL', 'pg_isready -U cortex'], interval: Duration.seconds(10), ... },
  logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'cortex-sandbox-db', logRetention: logs.RetentionDays.THREE_DAYS }),
});

const appContainer = taskDef.addContainer('app', {
  ...
  secrets: { POSTGRES_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret) },
});
appContainer.addContainerDependencies({ container: dbContainer, condition: ecs.ContainerDependencyCondition.HEALTHY });
```

### 15.3 Why ECR for the Postgres Image

Pulling `postgres:16` directly from Docker Hub at deploy time introduces an external dependency that can fail or be rate-limited. Instead:

1. Pull once: `docker pull --platform linux/arm64 postgres:16`
2. Capture the image digest: `docker inspect --format='{{index .RepoDigests 0}}' postgres:16` → e.g. `postgres@sha256:abc123...`
3. Tag with a patch-pinned tag: `docker tag postgres:16 ECR_REGISTRY/cortex-postgres-ai:16.3` (use the actual patch version)
4. Push: `docker push ECR_REGISTRY/cortex-postgres-ai:16.3`
5. Reference the pinned tag (not `:16`) in `sandbox-stack.ts` — prevents silent image changes if `seed-ecr` is re-run after a patch release

**Never use the mutable `:16` tag** in the ECS task definition. If `seed-ecr` is re-run after a PostgreSQL 16.x patch, the tag would silently update and change behavior across existing deployments.

The Makefile provides a one-time `make seed-ecr` target for this.

### 15.4 Container Resource Sizing (per-ticket)

| Container | CPU units | Memory MiB | Notes |
|-----------|-----------|------------|-------|
| app       | 512       | 1024       | Primary workload |
| db        | 256       | 512        | Light Postgres for experiment scope |
| **Total** | **768**   | **1536**   | Within Fargate task limits |

Graviton (ARM64) architecture — consistent with neuronic/cloud.

### 15.5 Persistent Storage Option (EFS — if data loss is unacceptable)

If a specific ticket requires data to survive task restarts:

1. SharedInfra creates one EFS file system in eu-central-1 with mount targets in **all AZs used by ECS tasks** (if the VPC has 2 AZs, create 2 mount targets). EFS mount targets must be in the same AZ as the Fargate task subnet — a missing mount target causes a silent mount failure and the task will not start.
2. SharedInfra creates one EFS access point per ticket at path `/cortex/{ticket}/pgdata` with POSIX UID `999` (postgres user in the official image).
3. The Sandbox stack mounts the access point into the `db` container at `/var/lib/postgresql/data`.
4. Sandbox stack creates the access point on deploy and deletes it (plus the Postgres data) on destroy.

**Additional IAM requirements** when `persistentDb=true` (add to §7.4 scoped ARNs):
```json
"elasticfilesystem:ClientMount": "arn:aws:elasticfilesystem:eu-central-1:495599732437:file-system/<efs-id>",
"elasticfilesystem:ClientWrite": "arn:aws:elasticfilesystem:eu-central-1:495599732437:file-system/<efs-id>",
"elasticfilesystem:DescribeMountTargets": "*"
```
These must be on the **task execution role**, not the task role.

**EFS ordering constraint**: the EFS access point CDK Custom Resource must complete before the ECS task definition is registered — CDK models this automatically if the access point is a direct CDK construct (not a Custom Resource), but if using a Custom Resource for access point creation, add an explicit `node.addDependency`.

**EFS encryption**: enabled at rest by default in CDK (`encrypted: true`). Do not disable.

**When to use EFS**: only if the experiment involves multi-session state. Default is ephemeral. Add `-c persistentDb=true` to the CDK deploy command to opt in.

### 15.6 ECR Repository Strategy

One ECR repository per image type, not per ticket. Tags carry the ticket + git SHA to identify which build a task is running.

| ECR Repository | Content | Tag format |
|----------------|---------|-----------|
| `cortex-app-ai` | Application service image | `{ticket-lower}-{git-sha}`, `latest` |
| `cortex-postgres-ai` | Postgres 16 mirror | `16` (semver pinned) |

Lifecycle policy (both repos):
- Untagged images: expire after 1 day
- Tagged images: keep last 5 per ticket prefix; expire all after 16 days

### 15.7 Updated CDK Project Structure

```
cortex-infra/
  Services/
    getConfig.ts
    BaseStack.ts
    SharedInfra/
      infrastructure/
        stack/shared-infra-stack.ts   ← VPC, ALB, ECS cluster, ECR repos, cleanup Lambda
                                        (no RDS — replaced by db sidecar in §15.2)
        cdk.ts
    Sandbox/
      infrastructure/
        stack/sandbox-stack.ts        ← app + db containers, ALB rule, DNS, TTL rule
        cdk.ts
  apps/
    app/
      Dockerfile                      ← multi-stage, distroless, ARM64
      src/                            ← application source
  Makefile
  .env.local.ai                       ← gitignored
  .dockerignore                       ← must exclude .env.local.ai, .git, node_modules
```

**Removed from SharedInfra**: RDS instance (replaced by per-ticket db sidecar). SharedInfra now provisions only: VPC, ALB, ACM cert, ECS cluster, ECR repositories, cleanup Lambda, SSM parameters.

### 15.8 Canonical Makefile (complete)

This supersedes the partial Makefile in §7.2.

```makefile
# cortex-infra/Makefile
# Usage: make deploy TICKET=W-1234
#        make logs   TICKET=W-1234
#        make exec   TICKET=W-1234
# See: make help

TICKET        ?= $(error TICKET is required — e.g. make deploy TICKET=W-1234)
AWS_PROFILE   ?= dev
AWS_REGION     = eu-central-1
AWS_ACCOUNT    = 495599732437
ECR_REGISTRY   = $(AWS_ACCOUNT).dkr.ecr.$(AWS_REGION).amazonaws.com
IMAGE_TAG     ?= $(shell echo $(TICKET) | tr '[:upper:]' '[:lower:]')-$(shell git rev-parse --short HEAD)
TICKET_LOWER   = $(shell echo $(TICKET) | tr '[:upper:]' '[:lower:]')
DASHBOARD_URL ?= http://127.0.0.1:3777
LOG_GROUP      = /ecs/cortex-sandbox-$(TICKET_LOWER)

.PHONY: help bootstrap setup-shared ecr-login seed-ecr build check-capacity \
        deploy deploy-only deploy-persistent destroy url list status logs exec db-connect \
        register-endpoint

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?##' $(MAKEFILE_LIST) | \
	  awk -F'##' '{printf "  %-24s %s\n", $$1, $$2}'

# ── One-time setup ────────────────────────────────────────────────────────────

bootstrap: ## One-time: CDK bootstrap in eu-central-1 (run once per account)
	cdk bootstrap aws://$(AWS_ACCOUNT)/$(AWS_REGION) --profile $(AWS_PROFILE)

setup-shared: ## One-time: deploy shared infra (ALB, cert, cluster, DynamoDB counter, cleanup Lambda)
	cdk deploy -c env=ai \
	  --app "npx ts-node --transpile-only Services/SharedInfra/infrastructure/cdk.ts" \
	  --profile $(AWS_PROFILE) --require-approval never

ecr-login: ## Log in to ECR (refreshes every 12h)
	@aws ecr get-login-password --region $(AWS_REGION) --profile $(AWS_PROFILE) \
	  | docker login --username AWS --password-stdin $(ECR_REGISTRY)

seed-ecr: ecr-login ## One-time: mirror postgres:16.x into ECR (run once per patch version)
	# Note: capture the patch version before running:  docker pull postgres:16 && docker inspect postgres:16 | grep -i version
	@PATCH_TAG=$$(docker inspect postgres:16 --format '{{index .Config.Labels "org.opencontainers.image.version"}}' 2>/dev/null || echo "16"); \
	docker pull --platform linux/arm64 postgres:16; \
	docker tag postgres:16 $(ECR_REGISTRY)/cortex-postgres-ai:$$PATCH_TAG; \
	docker push $(ECR_REGISTRY)/cortex-postgres-ai:$$PATCH_TAG; \
	echo "Pushed: $(ECR_REGISTRY)/cortex-postgres-ai:$$PATCH_TAG"

# ── Build ─────────────────────────────────────────────────────────────────────

build: ecr-login ## Build ARM64 app image and push to ECR
	# On Apple Silicon: ~90s native. On Intel Mac: ~10–15 min via QEMU.
	# Intel Mac alternative: remove --platform flag and change CpuArchitecture to X86_64 in sandbox-stack.ts
	docker buildx build --platform linux/arm64 \
	  -t $(ECR_REGISTRY)/cortex-app-ai:$(IMAGE_TAG) \
	  --push apps/app/

# ── Capacity check ────────────────────────────────────────────────────────────

check-capacity: ## Check active sandbox count against the 99-slot ALB limit
	@COUNT=$$(aws cloudformation list-stacks \
	  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE UPDATE_IN_PROGRESS \
	  --region $(AWS_REGION) --profile $(AWS_PROFILE) \
	  --query "length(StackSummaries[?starts_with(StackName,'cortex-sandbox-')])" \
	  --output text); \
	echo "Active sandboxes: $$COUNT / 99"; \
	[ "$$COUNT" -lt 99 ] || (echo "ERROR: ALB listener rule limit reached — destroy old sandboxes first" && exit 1)

# ── Deploy ────────────────────────────────────────────────────────────────────

deploy: build check-capacity ## Build, push, and deploy ticket sandbox (ephemeral Postgres)
	@set -euo pipefail; \
	cdk deploy -c env=ai -c ticket=$(TICKET) -c imageTag=$(IMAGE_TAG) \
	  --app "npx ts-node --transpile-only Services/Sandbox/infrastructure/cdk.ts" \
	  --profile $(AWS_PROFILE) --require-approval never && \
	$(MAKE) register-endpoint

deploy-only: check-capacity ## Deploy using existing ECR image (CDK-only changes, no Docker build)
	@set -euo pipefail; \
	cdk deploy -c env=ai -c ticket=$(TICKET) \
	  --app "npx ts-node --transpile-only Services/Sandbox/infrastructure/cdk.ts" \
	  --profile $(AWS_PROFILE) --require-approval never && \
	$(MAKE) register-endpoint

deploy-persistent: build check-capacity ## Deploy with EFS-backed Postgres (survives task restarts)
	@set -euo pipefail; \
	cdk deploy -c env=ai -c ticket=$(TICKET) -c imageTag=$(IMAGE_TAG) -c persistentDb=true \
	  --app "npx ts-node --transpile-only Services/Sandbox/infrastructure/cdk.ts" \
	  --profile $(AWS_PROFILE) --require-approval never && \
	$(MAKE) register-endpoint

destroy: ## Tear down a ticket sandbox (stack + Route53 record + ALB rule)
	@set -euo pipefail; \
	cdk destroy -c env=ai -c ticket=$(TICKET) \
	  --app "npx ts-node --transpile-only Services/Sandbox/infrastructure/cdk.ts" \
	  --profile $(AWS_PROFILE) --force

register-endpoint: ## Register deployed endpoint in architect dashboard (non-fatal if dashboard offline)
	@curl -sf -X PUT $(DASHBOARD_URL)/api/work-items/$(TICKET)/artifacts/endpoint.json \
	  -H "Content-Type: application/json" \
	  -d '{"url":"https://$(TICKET_LOWER).ai.neuronicdev.com"}' \
	  && echo "Endpoint registered: https://$(TICKET_LOWER).ai.neuronicdev.com" \
	  || echo "Warning: architect dashboard unreachable — endpoint not registered"

# ── Introspection ─────────────────────────────────────────────────────────────

url: ## Print the endpoint URL for a ticket
	@echo "https://$(TICKET_LOWER).ai.neuronicdev.com"

list: ## List all active cortex sandbox stacks with age
	@aws cloudformation list-stacks \
	  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE UPDATE_IN_PROGRESS \
	  --region $(AWS_REGION) --profile $(AWS_PROFILE) \
	  --query "StackSummaries[?starts_with(StackName,'cortex-sandbox-')].{Stack:StackName,Status:StackStatus,Age:CreationTime}" \
	  --output table

status: ## Show ECS service status for a ticket (running count, pending, last deploy)
	@aws ecs describe-services \
	  --cluster cortex-ai \
	  --services cortex-$(TICKET_LOWER) \
	  --region $(AWS_REGION) --profile $(AWS_PROFILE) \
	  --query "services[0].{Running:runningCount,Pending:pendingCount,Desired:desiredCount,Status:status,LastDeploy:deployments[0].updatedAt}" \
	  --output table

logs: ## Tail live CloudWatch logs for a ticket (both app and db streams)
	@aws logs tail $(LOG_GROUP) \
	  --follow \
	  --region $(AWS_REGION) --profile $(AWS_PROFILE)

exec: ## Open a shell in the running app container via ECS Exec
	@TASK_ARN=$$(aws ecs list-tasks --cluster cortex-ai \
	  --service-name cortex-$(TICKET_LOWER) \
	  --region $(AWS_REGION) --profile $(AWS_PROFILE) \
	  --query "taskArns[0]" --output text); \
	aws ecs execute-command --cluster cortex-ai \
	  --task $$TASK_ARN \
	  --container app \
	  --interactive \
	  --command "/bin/sh" \
	  --region $(AWS_REGION) --profile $(AWS_PROFILE)

db-connect: ## Connect to the sidecar Postgres via ECS Exec (psql inside the db container)
	@echo "Connecting to Postgres sidecar in ticket $(TICKET) via ECS Exec..."
	@TASK_ARN=$$(aws ecs list-tasks --cluster cortex-ai \
	  --service-name cortex-$(TICKET_LOWER) \
	  --region $(AWS_REGION) --profile $(AWS_PROFILE) \
	  --query "taskArns[0]" --output text); \
	aws ecs execute-command --cluster cortex-ai \
	  --task $$TASK_ARN \
	  --container db \
	  --interactive \
	  --command "psql -U cortex -d cortex" \
	  --region $(AWS_REGION) --profile $(AWS_PROFILE)
```

### 15.9 What Is Fully Containerized vs. What Remains External

| Component | Containerized | Notes |
|-----------|--------------|-------|
| Application service | ✅ ECS Fargate | ARM64, distroless |
| PostgreSQL database | ✅ ECS sidecar | Ephemeral by default; EFS opt-in |
| ECR image storage | ✅ AWS-managed | All images self-hosted in ECR |
| Secrets at runtime | ✅ Secrets Manager → task env | No plaintext in image or config |
| Load balancer | ✅ Shared ALB (SharedInfra) | One per environment, not per ticket |
| TLS termination | ✅ ALB + ACM wildcard cert | `*.ai.neuronicdev.com` |
| DNS | ✅ Route53 A record per ticket | Global, per-ticket subdomain |
| Cognito (auth) | ⚠️ AWS-managed (one shared pool) | Cannot be containerized; one pool per env |
| Cleanup orchestration | ✅ Lambda + EventBridge | Ordered ECS drain → CFN delete |
| VPC / networking | ✅ SharedInfra CDK | Default VPC or minimal 2-AZ VPC |

The only non-containerizable components are AWS primitives that have no self-hosted equivalent in this context (Cognito, Route53, ACM). Everything with a Docker image runs in ECS.

---

## 16. Deployment Blueprint Summary

```
One-time setup (per developer machine):
  cdk bootstrap aws://495599732437/eu-central-1 --profile dev
  make setup-shared        → VPC, ALB, cert, cluster, ECR repos, cleanup Lambda
  make seed-ecr            → mirror postgres:16 into ECR

Per-ticket workflow:
  git pull                 → latest codebase
  <make code changes>
  make deploy TICKET=W-XXXX
    → docker buildx build (ARM64) → push to ECR cortex-app-ai:{ticket}-{sha}
    → cdk deploy cortex-sandbox-{ticket}
        → ECS task: app container + db sidecar
        → ALB listener rule: w-xxxx.ai.neuronicdev.com → task
        → Route53 A record
        → EventBridge TTL rule (14d auto-destroy)
        → SSM /ai/sandboxes/{ticket}/endpoint-url
    → PUT /api/work-items/{ticket}/artifacts/endpoint.json (dashboard)
  curl https://w-xxxx.ai.neuronicdev.com/health   → 200 OK

Teardown:
  make destroy TICKET=W-XXXX   → manual
  (or auto-expires after 14 days via EventBridge + cleanup Lambda)
```

Each ticket's deployment is fully independent: its own ECS task, its own Postgres instance, its own subdomain, its own CloudFormation stack. No shared state between tickets beyond the ALB and ECS cluster (which are infrastructure, not application layer).

---

*Initial review: Architect Technical Review Board (8 agents: swe, arch, pm, systems, prod, dba, dx, frontend) — 2026-05-25.*
*Second review (Sections 15–16, container-first additions): systems, dba, dx, prod — 2026-05-25. All REVISE findings incorporated: SSM counter replaced with DynamoDB atomic CAS, db sidecar spec completed (dependsOn, essential, memory limit, secrets injection, log stream), migration orchestration via entrypoint script, image digest pinning, EFS AZ/IAM requirements, cleanup Lambda EventBridge guard, Makefile consolidated and debug targets added, §6 vs §15 RDS/sidecar conflict resolved, .env.local.ai scope clarified.*
