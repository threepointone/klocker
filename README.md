# GitHub profile weekly line-churn graph

This project includes a TypeScript script that estimates a user's **weekly lines changed**
(`additions + deletions`) over the last 12 months (or any window you choose).

By default, changes in files named `package-lock.json` are excluded from totals.

## What it does

1. Tries to read repositories from the user's contribution graph (GraphQL).
2. Falls back to repositories owned by the user if GraphQL is unavailable.
3. Fetches commits authored by that user in each repo for the time range.
4. Fetches commit stats and aggregates by week.
5. Writes:
   - `weekly_churn.csv`
   - `weekly_churn.png` (line + area chart)

## Usage

```bash
bun install
```

Run:

```bash
bun start -- <github_username> 
```

Recommended (to avoid strict rate limits):

```bash
export GITHUB_TOKEN=ghp_your_token_here
bun start -- <github_username> 
```

Useful flags:

```bash
bun start -- <github_username> \
  --months 6 \
  --csv weekly_out.csv \
  --plot weekly_out.png \
  --max-repos 100 \
  --sleep-between-calls 0.05
```

Skip PNG output:

```bash
bun start -- <github_username> --no-plot
```

## Notes / limitations

- This is an estimate based on commit stats from the GitHub API, grouped by week (week start = Monday, UTC).
- Large histories can consume API quota quickly because commit stats require per-commit detail calls.
- Without `GITHUB_TOKEN`, the script is likely to hit rate limits.
- For heavy users with many repos/commits, you may need to reduce scope or run with pauses.
