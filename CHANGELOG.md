# Changelog

All notable changes to **LiteLLM Proxy for GitHub Copilot** are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.2] - 2026-10-30

### Added

- **LiteLLM Proxy: Report Issue** opens the GitHub bug-report form with a diagnostics draft. The draft is described in the README and in `PRIVACY.md`. It is not uploaded until you submit the issue.
- GitHub issue form (`.github/ISSUE_TEMPLATE/bug_report.yml`) and a Support link on the new-issue page.

### Fixed

- Marketplace repository, homepage, bug, and Q&A links point at `Nuanst-GmbH/vscode-litellm`.

## [0.2.1] - 2026-10-29

### Changed

- Publisher ID is `Nuanst-GmbH`.
- Marketplace releases publish from GitHub Actions with Trusted Publishing.

## [0.2.0] - 2026-10-20

First public release.

### Added

- Local forwarder that rewrites Copilot's auth header to the LiteLLM proxy key, advertises mapped model names, and synthesizes the Copilot-native `GET /models` list.
- One-shot fallback when the proxy rejects a model, and one-shot transport retry on connection errors, first-byte timeout, and upstream 429/5xx.
- SecretStorage for the proxy API key, a recent-requests view, status-bar health, and a doctor command.
- Export of a LiteLLM `config.yml` from the model map.
- Marketplace icon in the Nuanst green and orange.

[0.2.2]: https://github.com/Nuanst-GmbH/vscode-litellm/releases/tag/v0.2.2
[0.2.1]: https://github.com/Nuanst-GmbH/vscode-litellm/releases/tag/v0.2.1
[0.2.0]: https://github.com/Nuanst-GmbH/vscode-litellm/releases/tag/v0.2.0
