# Neuronic CI/CD Pipelines

Mermaid diagrams for the GitHub Actions CI/CD pipelines in the Neuronic Flutter and Neuronic Cloud projects.

---

## Neuronic Flutter

Four workflows in `.github/workflows/`:

| Workflow | Trigger |
|----------|---------|
| `pull-request-check.yaml` | PR opened/updated against `main` |
| `release-development.yaml` | PR merged to `main` or `workflow_dispatch` |
| `flutter-deploy-stage-and-production.yaml` | `workflow_dispatch` on a `release/v*` branch |
| `hotfix-release.yaml` | `workflow_dispatch` (input: release tag to hotfix) |

```mermaid
flowchart TD
    FEAT["Feature Branch (GEN-xxx)"]
    PR["Pull Request → main"]
    MAIN["main branch"]

    subgraph PR_CHECK["① Pull Request Check  •  pull_request → main"]
        VAL["Validate PR Title\n(GEN-\\d+ or chore)"]
        BA_PR["Build Android\n(dev, debug)\nubuntu"]
        BI_PR["Build iOS\n(dev, debug, no codesign)\nself-hosted macOS ARM64"]
        VAL --> BA_PR & BI_PR
    end

    subgraph REL_DEV["② Release Development  •  PR closed+merged | workflow_dispatch"]
        INC["Increment Version\n(bump MINOR, reset PATCH, push pubspec.yaml)"]
        BA_DEV["Build Android\n(dev, release)\nubuntu"]
        BI_DEV["Build iOS\n(dev, release)\nself-hosted macOS ARM64"]
        FAD_DEV[("Firebase App Distribution\n[dev APK]")]
        TF_DEV[("TestFlight\n[dev IPA]")]
        SIM["Simulator Build\n(ios-simulator-app-dev artifact)"]
        POST["Post Deploy\n(GitHub App token)"]
        TAG["Create git tag vX.Y.Z\n+ push release/vX.Y.Z branch"]

        INC --> BA_DEV & BI_DEV
        BA_DEV --> FAD_DEV
        BI_DEV --> TF_DEV
        BI_DEV --> SIM
        BA_DEV & BI_DEV --> POST --> TAG
    end

    subgraph STAGE_PROD["③ Release Production  •  workflow_dispatch on release/vX.Y.Z"]
        subgraph STAGING["Staging  (environment: staging)"]
            BA_STG["Build Android\n(stage, release)"]
            BI_STG["Build iOS\n(stage, release)\nself-hosted macOS ARM64"]
            FAD_STG[("Firebase App Dist\n[stage APK]")]
            TF_STG[("TestFlight\n[stage IPA]")]
            SIM_STG["Simulator Build artifact\n(ios-simulator-app-stage)"]
            BA_STG --> FAD_STG
            BI_STG --> TF_STG & SIM_STG
        end
        subgraph PRODUCTION["Production  (environment: production)  needs staging success"]
            BA_PROD["Build Android\n(prod, release)"]
            BI_PROD["Build iOS\n(prod, release)\nself-hosted macOS ARM64"]
            PLAY[("Google Play\n[prod AAB, internal track]")]
            TF_PROD[("TestFlight\n[prod IPA]")]
            SIM_PROD["Simulator Build artifact\n(ios-simulator-app-prod)"]
            BA_PROD --> PLAY
            BI_PROD --> TF_PROD & SIM_PROD
        end
        STAGING --> PRODUCTION
    end

    subgraph HOTFIX["④ Hotfix Release  •  workflow_dispatch (input: release_tag e.g. v2.73.0)"]
        HF_BR["Create hotfix/vX.Y.Z+1 branch\nbump PATCH in pubspec.yaml"]
        HF_AND["Build Android\n(dev, release)"]
        HF_IOS["Build iOS\n(dev, release)\nself-hosted macOS ARM64"]
        FAD_HF[("Firebase App Dist\n[dev APK]")]
        TF_HF[("TestFlight\n[dev IPA]")]
        HF_TRIG["Create release/vX.Y.Z+1 branch\n+ create tag vX.Y.Z+1"]

        HF_BR --> HF_AND & HF_IOS
        HF_AND --> FAD_HF
        HF_IOS --> TF_HF
        HF_AND & HF_IOS --> HF_TRIG
    end

    FEAT -->|"open PR"| PR
    PR --> PR_CHECK
    PR -->|"merged"| MAIN
    MAIN --> REL_DEV
    TAG -->|"manual dispatch\non release branch"| STAGE_PROD
    HF_TRIG -->|"manual dispatch\non hotfix release branch"| STAGE_PROD
```

---

## Neuronic Cloud

Three workflows in `.github/workflows/`:

| Workflow | Trigger |
|----------|---------|
| `pr-check.yaml` | PR opened/updated against `main` |
| `deploy-dev.yaml` | Push to `main` |
| `deploy-staging-production.yaml` | Push to `release/v*` or `workflow_dispatch` |

```mermaid
flowchart TD
    FEAT["Feature Branch (GEN-xxx)"]
    PR_MAIN["Pull Request → main"]
    MAIN["main"]
    REL_BRANCH["release/vX.Y.Z branch"]

    subgraph PR_CHECK["① Pull Request Check  •  pull_request → main  (concurrency: cancel-in-progress)"]
        LINT["Lint & Format"]
        LINT --> BP["Build: Program"] & BS["Build: Surveys"] & BF["Build: Firmware"] & BU["Build: User"] & TC["TypeCheck: API Server"]
        BP & BS & BU --> BA["Build: Admin\n(needs Program+Surveys+User Prisma clients)"]
        BP --> TP["Test: Program"]
        BS --> TSV["Test: Surveys"]
        BF --> TFW["Test: Firmware"]
        BU --> TU["Test: User"]
        BA --> TA["Test: Admin"]
        DRIFT["Drift Check ×5 (parallel matrix)\nProgram / Surveys / Firmware / User / Admin\nvs AWS dev CloudFormation stacks"]
        TP & TSV & TFW & TU & TA & TC & DRIFT --> READY["PR Ready gate"]
    end

    subgraph DEPLOY_DEV["② Deploy to Dev  •  push → main  (concurrency: no cancel)"]
        direction TB
        DBP["Build: Program"] & DBS["Build: Surveys"] & DBF["Build: Firmware"] & DBU["Build: User"]
        DBP & DBS & DBU --> DBA["Build: Admin"]
        DBOOT["CDK Bootstrap\n(dev account 495599732437)"]

        DBP & DBOOT --> DP["Deploy: Program\n(CDK diff → migrate → cdk deploy)"]
        DBS & DBOOT --> DS["Deploy: Surveys\n(CDK diff → migrate → cdk deploy)"]
        DBF & DBOOT --> DF["Deploy: Firmware\n(CDK diff → migrate → cdk deploy)"]
        DBU & DBOOT --> DU["Deploy: User\n(CDK diff → migrate → cdk deploy)"]
        DBOOT --> DSDI["Deploy: SharedInfra\n(CDK)"]
        DBA & DBOOT --> DADOCK["Docker: Admin\nBuild ARM64 → push ECR dev"]
        DBOOT --> DAPIDOCK["Docker: API Server\nBuild ARM64 → push ECR dev"]
        DADOCK & DSDI --> DADEP["Deploy: Admin\n(ECS Fargate, cdk deploy)"]
        DAPIDOCK & DSDI --> DAPIDEP["Deploy: API Server\n(ECS Fargate, cdk deploy)"]

        DP & DS & DF & DU & DADEP & DAPIDEP --> CREL["Create Release\n(scripts/create-release.js)\n→ tag vX.Y.Z + release/vX.Y.Z branch"]
    end

    subgraph DEPLOY_SP["③ Deploy Staging → Production  •  push release/v* | workflow_dispatch"]
        subgraph STG["STAGING  (AWS 863518425454)"]
            SBP["Build: Program"] & SBS["Build: Surveys"] & SBF["Build: Firmware"] & SBU["Build: User"]
            SBP & SBS & SBU --> SBA["Build: Admin"]
            SBOOT["CDK Bootstrap\n(staging account)"]
            SBP & SBOOT --> SDP["Deploy: Program\n(migrate + CDK -c env=stage)"]
            SBS & SBOOT --> SDS["Deploy: Surveys\n(migrate + CDK)"]
            SBF & SBOOT --> SDF["Deploy: Firmware\n(migrate + CDK)"]
            SBU & SBOOT --> SDU["Deploy: User\n(migrate + CDK)"]
            SBA & SBOOT --> SADOCK["Docker: Admin → ECR stage"]
            SBOOT --> SAPI_D["Docker: API Server → ECR stage"]
            SBOOT --> SSDI["Deploy: SharedInfra"]
            SADOCK & SDU & SSDI --> SADEP["Deploy: Admin (ECS Fargate)"]
            SAPI_D & SSDI --> SAPISRV["Deploy: API Server (ECS Fargate)"]
            SDP & SDS & SDF & SDU & SADEP & SAPISRV --> NOTION["Notion Update\n(tag GEN-xxx tickets\nwith cloud-X.Y.Z version)"]
        end

        STG --> APPROVAL["⏸ Manual Approval Gate\n(GitHub environment: production)\nAll staging deploys must succeed"]

        subgraph PROD["PRODUCTION  (AWS 028262881008)"]
            PBOOT["CDK Bootstrap\n(prod account)"]
            PBP["Build: Program"] & PBS["Build: Surveys"] & PBF["Build: Firmware"] & PBU["Build: User"]
            PBP & PBS & PBU --> PBA["Build: Admin"]
            PBP & PBOOT --> PDP["Deploy: Program\n(migrate + CDK -c env=prod)"]
            PBS & PBOOT --> PDS["Deploy: Surveys"]
            PBF & PBOOT --> PDF["Deploy: Firmware"]
            PBU & PBOOT --> PDU["Deploy: User"]
            PBA & PBOOT --> PADOCK["Docker: Admin → ECR prod"]
            PBOOT --> PAPI_D["Docker: API Server → ECR prod"]
            PBOOT --> PSDI["Deploy: SharedInfra"]
            PADOCK & PDU & PSDI --> PADEP["Deploy: Admin (ECS Fargate)"]
            PAPI_D & PSDI --> PAPISRV["Deploy: API Server (ECS Fargate)"]
            PSDI --> PN8N["Deploy: N8N\n(provision n8n schema + CDK)"]
        end

        APPROVAL --> PROD
    end

    FEAT -->|"open PR"| PR_MAIN
    PR_MAIN --> PR_CHECK
    PR_MAIN -->|"merged"| MAIN
    MAIN --> DEPLOY_DEV
    CREL --> REL_BRANCH
    REL_BRANCH --> DEPLOY_SP
```
