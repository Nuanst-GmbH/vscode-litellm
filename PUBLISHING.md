# Publishing to the VS Code Marketplace

The public listing is `README.md`. Internal setup stays in `docs-local/` (gitignored)
and is excluded from the VSIX.

## One-time: GitHub

1. Create an empty public repository `nuanst-one/vscode-litellm` (no README, no license — this repo already has both).
2. From this directory:

```bash
git remote add origin https://github.com/nuanst-one/vscode-litellm.git
git push -u origin main
```

`package.json` `repository`, `homepage`, `bugs`, and `qna` already point at that URL.
If the GitHub owner differs, change those four fields before packaging. `vsce` rewrites
relative README links against `repository` and assumes the `main` branch.

## One-time: publisher

1. Open <https://marketplace.visualstudio.com/manage/publishers> and sign in.
2. Create a publisher (or reuse **Nuanst One GmbH**). The `publisher` field must be the
   publisher **ID** (`nuanst-one`), not the display name. The ID cannot be changed later.
3. Confirm the extension name `vscode-litellm` is free under that publisher. Names are
   permanent once a version is published.

## Each release

```bash
npm install
npm test
npm run package          # writes vscode-litellm-<version>.vsix
npx vsce ls              # review exactly what the VSIX contains
```

`vsce package` runs `vscode:prepublish` (`npm run compile`) and checks the manifest:
license file, PNG icon (not SVG), README, description length, and https image URLs.

Bump `version` in `package.json` and add a `CHANGELOG.md` entry before every publish.
The doctor compares the running bundle's baked version with the installed extension,
so a version bump is what makes a stale window detectable.

### Publish

Publishing runs from GitHub Actions with Marketplace Trusted Publishing
(OIDC). No PAT is stored in the repository.
Steps: <https://code.visualstudio.com/api/working-with-extensions/publishing-extension#publish-with-github-actions-and-trusted-publishing>.

One-time, on the publisher (`nuanst-one`):

1. Open <https://marketplace.visualstudio.com/manage/publishers>, select the publisher, then **Trusted Publishing**.
2. Create a policy:
   - **Policy name**: `Release workflow`
   - **Repository owner**: `Nuanst-GmbH` (the GitHub login, exactly)
   - **Repository**: `vscode-litellm`
   - **Workflow**: `publish.yml`
   - **Environment**: leave empty (the workflow does not use a GitHub environment)

Each release: bump `version`, update `CHANGELOG.md`, commit, push, then publish
a GitHub Release whose tag is `v` plus that version (for example `v0.2.0`).
`.github/workflows/publish.yml` checks out that tag, runs `npm test`, and runs
`npx @vscode/vsce publish --oidc`. The workflow needs `id-token: write`. The
Marketplace credential lasts 15 minutes and each GitHub OIDC token can be
exchanged once.

`@vscode/vsce` must stay on 4.1 or newer; `--oidc` is not in 3.x.

A local PAT publish still works until global Azure DevOps PATs are retired on
**1 December 2026**:

```bash
# https://marketplace.visualstudio.com/manage — User settings → Personal access tokens
export VSCE_PAT=...
npm run publish
```

Or upload the `.vsix` by hand on the publisher management page.

## Checklist

- [ ] `publisher` matches the marketplace publisher ID
- [ ] `repository` is the real public GitHub URL
- [ ] `version` bumped and `CHANGELOG.md` updated
- [ ] GitHub Release tag is `v` plus that version (this is what publishes)
- [ ] `LICENSE`, `README.md`, `CHANGELOG.md`, and `icon.png` (128×128 PNG) present
- [ ] README has no internal hostnames, paths, or keys (`docs-local/` stays untracked)
- [ ] `npx vsce ls` shows `dist/extension.js`, not `src/`, `test/`, or `node_modules/`
- [ ] `npm test` is green

## Open VSX (optional)

The same VSIX can be published for VS Code forks:

```bash
npx ovsx publish vscode-litellm-0.2.0.vsix --pat <OPENVSX_PAT>
```

Open VSX accepts the MIT license.
