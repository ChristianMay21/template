# Project guide

This document is aimed at the human developer. Not any AI agents that may work on this codebase.

## Starting Up
1. Run `sbx login` to make sure you are logged in to docker
2. To start a new sandbox: Run `sbx run pi --name pi-sandbox`. Note that `pi-sandbox` is an arbitrary name.
3. To resume previous sandbox: `sbx run pi-sandbox`
4. Select 'open' (allow network traffic)

## Removing a sandbox
`sbx rm pi-sandbox`

## Cloning a sandbox
`sbx run --clone <sandbox-to-be-cloned> --name <name-of-clone>`

## Setting secrets
Setting a secret: `sbx secret set -g <varName>`. This token is stored outside of the sandbox.

## Changing sandbox permissions (for fetching web content)
See network policies: `sbx policy network`
See full list of network policies: `sbx policy ls network`
Add a whitelisted domain: `sbx policy allow network -g site.com` - replace `-g` with sandbox name if you prefer non-global
Remove a whitelisted domain: `sbx policy rm -g --resource site.com` - see above

## Sandboxes and git
The code within a specific sandbox receives the worktree name `sandbox-<sandbox-name>`