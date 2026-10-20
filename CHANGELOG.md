# Changelog

All notable changes to **LiteLLM Router for GitHub Copilot** are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-10-20

First public release.

### Added

- Local forwarder that rewrites Copilot's auth header to the LiteLLM proxy key, advertises mapped model names, and synthesizes the Copilot-native `GET /models` list.
- One-shot fallback when the proxy rejects a model, and one-shot transport retry on connection errors, first-byte timeout, and upstream 429/5xx.
- SecretStorage for the proxy API key, a recent-requests view, status-bar health, and a doctor command.
- Export of a LiteLLM `config.yml` from the model map.

[0.2.0]: https://github.com/nuanst-one/vscode-litellm/releases/tag/v0.2.0
