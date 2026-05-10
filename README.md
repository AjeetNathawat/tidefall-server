---
title: Tidefall Server
emoji: 🏝️
colorFrom: red
colorTo: yellow
sdk: docker
app_port: 7860
pinned: false
---

# Tidefall server

Auto-generated flat-layout copy of `apps/server` + `packages/shared`.
Don't edit by hand — run `./scripts/build-glitch-server.sh` from the
parent project to refresh.

## Deploying to Hugging Face Spaces

1. Push this directory's contents to a public GitHub repo.
2. Sign in to huggingface.co.
3. Create a new Space → choose **Docker** as the SDK → link the GitHub repo
   (or duplicate this Space if it's already published).
4. HF Spaces builds the Dockerfile and runs the server on port 7860.
5. Public URL pattern: `https://<user>-<space>.hf.space`.

## Environment

`PORT` — HF sets this to 7860; the server respects it.
