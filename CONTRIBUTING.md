# Contributing

Thanks for helping. Keep this sample small, readable and accurate about what the SDK handles and what belongs to the application.

## Set up

Follow the [storefront quickstart](README.md#run-locally): install both apps, complete [tenant setup](docs/tenant-setup.md), then run `npm run dev`. Preview and approve tenant mutations before applying them; do not paste management credentials into shell history or documentation.

Use the [code map](docs/architecture.md#where-code-lives) to find the feature you are changing.

## Before you open a pull request

```bash
npm run check                        # typecheck and tests
node --test "scripts/test/*.test.mjs"  # script tests
node scripts/check-secrets.mjs       # no secrets in tracked files
```

For API behaviour changes, also run `npm run dev:agent` and `npm run smoke`.

## Guidelines

- **Keep Poppy code easy to find.** The point of this repo is that a reader can see what Poppy needs. Put it in the files listed in [docs/adopting.md](docs/adopting.md), and keep the store logic separate.
- **Explain boundaries.** Document non-obvious authorization or compatibility decisions where they occur. Do not add release-status markers or speculative SDK APIs.
- **No secrets, ever.** `.env.local` and `apps/*/poppy.json` are gitignored on purpose. The scripts never print secrets; keep it that way.
- **Scripts stay dependency-free**, non-interactive, and exit non-zero on failure.
- **Update the docs** when you change a command, an env var or a file that a guide mentions.

## Reporting problems

Use the repository's issue templates for bugs and SDK, CLI or platform feedback. To report a security issue, see [SECURITY.md](SECURITY.md).
