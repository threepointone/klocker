import fs from "node:fs/promises";

const GITHUB_API = "https://api.github.com";
const GITHUB_GRAPHQL = "https://api.github.com/graphql";

type Json = Record<string, unknown> | Array<unknown>;

type CliArgs = {
  username: string;
  months: number;
  token?: string;
  maxRepos: number;
  csv: string;
  plot: string;
  noPlot: boolean;
  sleepBetweenCalls: number;
};

function usage(): string {
  return [
    "Usage:",
    "  bun start -- <github_username> [options]",
    "",
    "Options:",
    "  --months <n>               How many months to look back (default: 12)",
    "  --token <token>            GitHub token (defaults to GITHUB_TOKEN env var)",
    "  --max-repos <n>            Max repos from contribution graph (default: 100)",
    "  --csv <path>               CSV output path (default: weekly_churn.csv)",
    "  --plot <path>              PNG output path (default: weekly_churn.png)",
    "  --no-plot                  Skip generating PNG output",
    "  --sleep-between-calls <n>  Sleep between commit detail calls in seconds",
  ].join("\n");
}

function parseArgs(argv: string[]): CliArgs {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    throw new Error(usage());
  }

  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const username = positional[0];
  if (!username) {
    throw new Error(`Missing username.\n\n${usage()}`);
  }

  const getValue = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    if (idx === -1) return undefined;
    return argv[idx + 1];
  };

  const months = Number(getValue("--months") ?? "12");
  const maxRepos = Number(getValue("--max-repos") ?? "100");
  const sleepBetweenCalls = Number(getValue("--sleep-between-calls") ?? "0");

  return {
    username,
    months: Number.isFinite(months) ? months : 12,
    token: getValue("--token") ?? process.env.GITHUB_TOKEN,
    maxRepos: Number.isFinite(maxRepos) ? maxRepos : 100,
    csv: getValue("--csv") ?? "weekly_churn.csv",
    plot: getValue("--plot") ?? "weekly_churn.png",
    noPlot: argv.includes("--no-plot"),
    sleepBetweenCalls: Number.isFinite(sleepBetweenCalls) ? sleepBetweenCalls : 0,
  };
}

class GitHubClient {
  constructor(private readonly token?: string) {}

  private headers(contentType?: string): HeadersInit {
    const headers: HeadersInit = {
      Accept: "application/vnd.github+json",
      "User-Agent": "github-profile-churn-script",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    if (contentType) {
      headers["Content-Type"] = contentType;
    }
    return headers;
  }

  async getJson(url: string): Promise<Json> {
    const response = await fetch(url, { headers: this.headers() });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`GitHub API error ${response.status} for ${url}: ${text}`);
    }
    return JSON.parse(text) as Json;
  }

  async postGraphql(query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await fetch(GITHUB_GRAPHQL, {
      method: "POST",
      headers: this.headers("application/json"),
      body: JSON.stringify({ query, variables }),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`GitHub GraphQL error ${response.status}: ${text}`);
    }

    const parsed = JSON.parse(text) as {
      data?: Record<string, unknown>;
      errors?: unknown;
    };

    if (parsed.errors) {
      throw new Error(`GitHub GraphQL returned errors: ${JSON.stringify(parsed.errors)}`);
    }

    return parsed.data ?? {};
  }
}

function isoDate(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function weekStart(date: Date): Date {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = start.getUTCDay();
  const daysFromMonday = day === 0 ? 6 : day - 1;
  start.setUTCDate(start.getUTCDate() - daysFromMonday);
  return start;
}

function weekRange(start: Date, end: Date): string[] {
  const out: string[] = [];
  const cursor = weekStart(start);
  const finalWeek = weekStart(end);
  while (cursor <= finalWeek) {
    out.push(dateOnly(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return out;
}

function isPackageLockFile(filename: string): boolean {
  return filename === "package-lock.json" || filename.endsWith("/package-lock.json");
}

async function getContributedRepos(
  client: GitHubClient,
  username: string,
  since: Date,
  until: Date,
  maxRepos: number,
): Promise<Set<string>> {
  const query = `
    query($login: String!, $from: DateTime!, $to: DateTime!, $maxRepos: Int!) {
      user(login: $login) {
        contributionsCollection(from: $from, to: $to) {
          commitContributionsByRepository(maxRepositories: $maxRepos) {
            repository {
              nameWithOwner
            }
          }
        }
      }
    }
  `;

  const data = await client.postGraphql(query, {
    login: username,
    from: isoDate(since),
    to: isoDate(until),
    maxRepos,
  });

  const user = data.user as Record<string, unknown> | undefined;
  if (!user) return new Set();

  const collection = user.contributionsCollection as Record<string, unknown>;
  const reposRaw = (collection.commitContributionsByRepository as Array<Record<string, unknown>>) ?? [];

  const repos = new Set<string>();
  for (const item of reposRaw) {
    const repository = item.repository as Record<string, unknown>;
    const name = repository.nameWithOwner as string;
    if (name) repos.add(name);
  }

  return repos;
}

async function getOwnedRepos(client: GitHubClient, username: string): Promise<Set<string>> {
  const repos = new Set<string>();
  let page = 1;

  while (true) {
    const url = `${GITHUB_API}/users/${encodeURIComponent(username)}/repos?type=owner&per_page=100&page=${page}`;
    const data = await client.getJson(url);
    const items = data as Array<Record<string, unknown>>;
    if (items.length === 0) break;

    for (const repo of items) {
      const fullName = repo.full_name as string;
      if (fullName) repos.add(fullName);
    }

    page += 1;
  }

  return repos;
}

async function getRepoCommits(
  client: GitHubClient,
  repoFullName: string,
  username: string,
  since: Date,
  until: Date,
): Promise<Array<{ sha: string; dateIso: string }>> {
  const commits: Array<{ sha: string; dateIso: string }> = [];
  let page = 1;

  while (true) {
    const url =
      `${GITHUB_API}/repos/${repoFullName}/commits?author=${encodeURIComponent(username)}` +
      `&since=${encodeURIComponent(isoDate(since))}&until=${encodeURIComponent(isoDate(until))}` +
      `&per_page=100&page=${page}`;

    const data = await client.getJson(url);
    const items = data as Array<Record<string, unknown>>;
    if (items.length === 0) break;

    for (const item of items) {
      const sha = item.sha as string;
      const commit = item.commit as Record<string, unknown>;
      const author = commit.author as Record<string, unknown>;
      const dateIso = author.date as string;

      if (sha && dateIso) {
        commits.push({ sha, dateIso });
      }
    }

    page += 1;
  }

  return commits;
}

async function getCommitStats(client: GitHubClient, repoFullName: string, sha: string): Promise<number> {
  const url = `${GITHUB_API}/repos/${repoFullName}/commits/${sha}`;
  const detail = (await client.getJson(url)) as Record<string, unknown>;
  const files = (detail.files as Array<Record<string, unknown>> | undefined) ?? [];

  if (files.length > 0) {
    let churn = 0;
    for (const file of files) {
      const filename = String(file.filename ?? "");
      if (isPackageLockFile(filename)) continue;

      const additions = Number(file.additions ?? 0);
      const deletions = Number(file.deletions ?? 0);
      churn += additions + deletions;
    }
    return churn;
  }

  const stats = (detail.stats as Record<string, unknown>) ?? {};
  return Number(stats.additions ?? 0) + Number(stats.deletions ?? 0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function collectStats(
  client: GitHubClient,
  username: string,
  months: number,
  maxRepos: number,
  sleepBetweenCalls: number,
): Promise<Map<string, number>> {
  const now = new Date();
  const since = new Date(now);
  since.setUTCDate(since.getUTCDate() - months * 30);

  let repos: Set<string>;
  try {
    repos = await getContributedRepos(client, username, since, now, maxRepos);
    if (repos.size > 0) {
      console.log(`Found ${repos.size} repositories from contribution graph.`);
    } else {
      console.log("Contribution graph returned no repositories; falling back to owned repos.");
      repos = await getOwnedRepos(client, username);
    }
  } catch (error) {
    console.log(`GraphQL lookup failed (${String(error)}); falling back to owned repos.`);
    repos = await getOwnedRepos(client, username);
  }

  if (repos.size === 0) {
    throw new Error("No repositories found for this user.");
  }

  const weekly = new Map<string, number>();
  const seenShas = new Set<string>();
  const repoList = [...repos].sort();

  for (let i = 0; i < repoList.length; i += 1) {
    const repo = repoList[i];
    console.log(`[${i + 1}/${repoList.length}] Scanning commits in ${repo} ...`);

    let commits: Array<{ sha: string; dateIso: string }> = [];
    try {
      commits = await getRepoCommits(client, repo, username, since, now);
    } catch (error) {
      console.log(`  Skipping ${repo}: ${String(error)}`);
      continue;
    }

    for (const { sha, dateIso } of commits) {
      if (seenShas.has(sha)) continue;
      seenShas.add(sha);

      try {
        const churn = await getCommitStats(client, repo, sha);
        const week = dateOnly(weekStart(new Date(dateIso)));
        weekly.set(week, (weekly.get(week) ?? 0) + churn);
      } catch (error) {
        console.log(`  Skipping commit ${sha.slice(0, 7)} in ${repo}: ${String(error)}`);
      }

      if (sleepBetweenCalls > 0) {
        await sleep(sleepBetweenCalls * 1000);
      }
    }
  }

  const withZeros = new Map<string, number>();
  for (const week of weekRange(
    new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate())),
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
  )) {
    withZeros.set(week, weekly.get(week) ?? 0);
  }

  return withZeros;
}

async function writeCsv(path: string, daily: Map<string, number>): Promise<void> {
  const rows = ["week_start,lines_changed", ...[...daily.entries()].map(([date, churn]) => `${date},${churn}`)];
  await fs.writeFile(path, `${rows.join("\n")}\n`, "utf8");
}

async function writePlot(path: string, daily: Map<string, number>, username: string): Promise<void> {
  let ChartJSNodeCanvas: typeof import("chartjs-node-canvas").ChartJSNodeCanvas;
  try {
    ({ ChartJSNodeCanvas } = await import("chartjs-node-canvas"));
  } catch {
    throw new Error("chartjs-node-canvas is required for plotting. Run: bun install");
  }

  const labels = [...daily.keys()];
  const values = [...daily.values()];
  const chart = new ChartJSNodeCanvas({ width: 1400, height: 600, backgroundColour: "white" });

  const image = await chart.renderToBuffer({
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Lines changed (additions + deletions)",
          data: values,
          borderColor: "#1f77b4",
          backgroundColor: "rgba(31,119,180,0.2)",
          borderWidth: 2,
          fill: true,
          pointRadius: 0,
          tension: 0.2,
        },
      ],
    },
    options: {
      responsive: false,
      plugins: {
        title: {
          display: true,
          text: `Weekly line churn for @${username} (last ${labels.length} weeks)`,
          font: { size: 18 },
        },
        legend: { display: true },
      },
      scales: {
        x: {
          ticks: {
            maxTicksLimit: 12,
          },
          title: {
            display: true,
            text: "Date",
          },
        },
        y: {
          title: {
            display: true,
            text: "Lines changed",
          },
          beginAtZero: true,
        },
      },
    },
  });

  await fs.writeFile(path, image);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const client = new GitHubClient(args.token);

  if (!args.token) {
    console.warn(
      "Warning: no GitHub token provided. You will likely hit low rate limits. Set GITHUB_TOKEN for reliable results.",
    );
  }

  const daily = await collectStats(client, args.username, args.months, args.maxRepos, args.sleepBetweenCalls);

  await writeCsv(args.csv, daily);
  console.log(`Wrote CSV: ${args.csv}`);

  if (!args.noPlot) {
    await writePlot(args.plot, daily, args.username);
    console.log(`Wrote plot: ${args.plot}`);
  }

  const total = [...daily.values()].reduce((sum, n) => sum + n, 0);
  const activeDays = [...daily.values()].filter((n) => n > 0).length;
  console.log(`Total lines changed: ${total}`);
  console.log(`Active days: ${activeDays} / ${daily.size}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
