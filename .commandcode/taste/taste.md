# Taste

## Architecture & tooling
- Strongly favors client-side, no-server solutions: code should run entirely in the browser with no backend/remote server. Confidence: 0.7

## Workflow
- Prefers starting with a small, self-contained proof-of-concept (e.g. a simple HTML page) before building out a full integration. Confidence: 0.5
- Wants progress committed as checkpoints before continuing ("commit first then continue"), rather than leaving a pile of uncommitted work while moving on. Confidence: 0.6
- Prefers the agent to keep driving a task to completion autonomously — e.g. continuing to poll/monitor long-running builds until they finish or fail — rather than stopping to check in at each step ("yes, continue"). Confidence: 0.55

## Repo hygiene
- Keeps all changes scoped to the current repo; treats sibling/dependency checkouts as read-only (e.g. "Keep all changes in this repo. Do not modify clang-wasm."). Confidence: 0.7
