import type {
  EngineeringWallSnapshot,
  WallRepositorySnapshot,
} from "../../shared/wall.js";
import type {
  HealthCheck,
  HealthProbe,
  HealthSnapshot,
  HealthStatus,
  LatencyStats,
} from "../../shared/health.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// Stable, commit-like hex: 40 characters from a multiplicative hash of the seed.
const sha = (seed: number) =>
  Array.from({ length: 5 }, (_, index) =>
    (Math.imul(seed * 31 + index + 1, 2654435761) >>> 0)
      .toString(16)
      .padStart(8, "0"),
  ).join("");

// Healthy variety only: demo data must never raise Attention Mode, which
// would stop the signed-out home page from sliding between scenes.
const PULLS: {
  repo: string;
  number: number;
  title: string;
  author: string;
  ageMs: number;
  checks: "passing" | "running" | "queued";
  review?: { reviewer: string; decision: "approved" | "changes_requested" };
}[] = [
  {
    repo: "platform",
    number: 431,
    title: "Roll out preview environments to every team",
    author: "alexchen",
    ageMs: 5 * HOUR,
    checks: "passing",
    review: { reviewer: "sarahpark", decision: "approved" },
  },
  {
    repo: "design-system",
    number: 191,
    title: "Add density and focus-ring tokens",
    author: "emmarivera",
    ageMs: 9 * HOUR,
    checks: "passing",
    review: { reviewer: "leowang", decision: "approved" },
  },
  {
    repo: "web-app",
    number: 318,
    title: "Speed up first paint on the dashboard",
    author: "sarahpark",
    ageMs: 2 * HOUR,
    checks: "running",
  },
  {
    repo: "platform",
    number: 433,
    title: "Document the preview environment lifecycle",
    author: "leowang",
    ageMs: 40 * MINUTE,
    checks: "queued",
  },
  {
    repo: "api-gateway",
    number: 252,
    title: "Add per-tenant rate limit dashboards",
    author: "minhnguyen",
    ageMs: 26 * HOUR,
    checks: "passing",
  },
  {
    repo: "infrastructure",
    number: 97,
    title: "Autoscale CI runners on queue depth",
    author: "jordanlee",
    ageMs: 3 * 24 * HOUR,
    checks: "passing",
    review: { reviewer: "alexchen", decision: "changes_requested" },
  },
];

const DEPLOYMENTS = [
  {
    repo: "platform",
    environment: "production",
    status: "successful",
    ageMs: 25 * MINUTE,
  },
  {
    repo: "web-app",
    environment: "staging",
    status: "running",
    ageMs: 4 * MINUTE,
  },
  {
    repo: "api-gateway",
    environment: "production",
    status: "successful",
    ageMs: 2 * HOUR,
  },
  {
    repo: "design-system",
    environment: "preview",
    status: "successful",
    ageMs: 6 * HOUR,
  },
] as const;

const SERVICES: {
  name: string;
  probes: [name: string, latencyMs: number][];
  degraded?: boolean;
}[] = [
  {
    name: "Public API",
    probes: [
      ["Health endpoint", 118],
      ["Token exchange", 164],
    ],
  },
  { name: "Web app", probes: [["Home page", 236]] },
  { name: "Webhooks", probes: [["Delivery endpoint", 410]], degraded: true },
  { name: "Search", probes: [["Query endpoint", 92]] },
];

/** Fictional pull requests, checks and deployments for the demo wall. */
export function createDemoWall(now = Date.now()): EngineeringWallSnapshot {
  const at = (ageMs: number) => new Date(now - ageMs).toISOString();
  const repositories = new Map<string, WallRepositorySnapshot>();
  const repository = (name: string) => {
    let item = repositories.get(name);
    if (!item) {
      item = {
        repositoryId: repositories.size + 1,
        repository: name,
        pullRequests: [],
        reviews: [],
        pipelines: [],
        deployments: [],
      };
      repositories.set(name, item);
    }
    return item;
  };
  PULLS.forEach((pull, index) => {
    const repo = repository(pull.repo);
    const headSha = sha(index + 1);
    // Demo rows link nowhere: there is no real pull request to open.
    repo.pullRequests.push({
      number: pull.number,
      title: pull.title,
      url: "",
      author: pull.author,
      headSha,
      state: "open",
      draft: false,
      mergeable: true,
      createdAt: at(pull.ageMs),
      updatedAt: at(Math.min(pull.ageMs, 20 * MINUTE)),
    });
    repo.pipelines.push({
      id: `demo-check-${index}`,
      name: "CI",
      provider: "github-actions",
      headSha,
      status: pull.checks,
      updatedAt: at(Math.min(pull.ageMs, 10 * MINUTE)),
    });
    if (pull.review)
      repo.reviews.push({
        id: index + 1,
        pullRequestNumber: pull.number,
        reviewer: pull.review.reviewer,
        decision: pull.review.decision,
        submittedAt: at(Math.min(pull.ageMs, 30 * MINUTE)),
      });
  });
  DEPLOYMENTS.forEach((deployment, index) =>
    repository(deployment.repo).deployments.push({
      id: `demo-deployment-${index}`,
      environment: deployment.environment,
      headSha: sha(index + 40),
      status: deployment.status,
      updatedAt: at(deployment.ageMs),
    }),
  );
  return {
    repositories: [...repositories.values()],
    updatedAt: new Date(now).toISOString(),
  };
}

/** Population mean and deviation of the demo checks, like the server's figures. */
function latencyStats(history: HealthCheck[]): LatencyStats {
  const values = history.map((check) => check.latencyMs);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const sd = Math.sqrt(
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length,
  );
  return {
    mean: Math.round(mean * 100) / 100,
    sd: Math.round(sd * 100) / 100,
    checks: 1440,
  };
}

function demoProbe(
  now: number,
  serviceId: string,
  id: string,
  name: string,
  latencyMs: number,
  degraded: boolean,
): HealthProbe {
  // Newest first, like health snapshots from the server.
  const history: HealthCheck[] = Array.from({ length: 24 }, (_, index) => {
    const failing = degraded && index < 2;
    return {
      checkedAt: new Date(now - (index + 1) * MINUTE).toISOString(),
      ok: !failing,
      latencyMs: failing
        ? 1480 - index * 90
        : latencyMs + ((index * 37) % 23) - 11,
      statusCode: failing ? 503 : 200,
      reason: failing ? "HTTP 503" : "",
      status: failing ? "degraded" : "healthy",
    };
  });
  return {
    id,
    serviceId,
    name,
    url: "https://status.example.com/health",
    method: "GET",
    intervalSeconds: 60,
    timeoutMs: 10_000,
    statusMin: 200,
    statusMax: 299,
    maxLatencyMs: null,
    jsonPath: "",
    jsonExpected: null,
    failureThreshold: 3,
    recoveryThreshold: 2,
    enabled: true,
    hasHeaders: false,
    status: history[0].status,
    lastCheck: history[0],
    successRate24h: degraded ? 97.8 : latencyMs > 200 ? 99.9 : 100,
    checks24h: 1440,
    history,
    latencyHistory: [],
    latency24h: [],
    latencyStats24h: latencyStats(history),
  };
}

/** Fictional services for the demo wall: healthy, with one degraded. */
export function createDemoHealth(now = Date.now()): HealthSnapshot {
  return {
    updatedAt: new Date(now).toISOString(),
    services: SERVICES.map((service, serviceIndex) => {
      const id = `demo-service-${serviceIndex}`;
      const probes = service.probes.map(([name, latencyMs], probeIndex) =>
        demoProbe(
          now,
          id,
          `demo-probe-${serviceIndex}-${probeIndex}`,
          name,
          latencyMs,
          Boolean(service.degraded),
        ),
      );
      const status: HealthStatus = probes.some(
        (probe) => probe.status === "degraded",
      )
        ? "degraded"
        : "healthy";
      return { id, name: service.name, status, probes };
    }),
  };
}

let demo: { snapshot: EngineeringWallSnapshot; health: HealthSnapshot } | null =
  null;
/** One stable demo data set per page load. */
export function demoSignals() {
  return (demo ??= { snapshot: createDemoWall(), health: createDemoHealth() });
}
